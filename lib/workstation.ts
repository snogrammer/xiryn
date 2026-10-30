import { randomBytes } from "node:crypto"

import { eq } from "drizzle-orm"

import { db } from "@/db"
import { agents } from "@/db/schema"
import { getSetting, setSetting } from "@/lib/config"
import {
  docker,
  dockerRaw,
  dockerReason,
  engineSnapshot,
  ensureEngine,
  type RunOptions,
} from "@/lib/docker"
import { ensureImage, imageTag } from "@/lib/workstation-image"

// Each agent owns a workstation: a Docker container on this computer with a
// shell, a home folder that persists, and a graphical desktop with a browser.
// It is fully separate from your own desktop and files. Containers are made
// the first time an agent needs one, stop themselves when idle and start
// again on demand.

export const SCREEN = { width: 1280, height: 800 }
const HOME = "/home/xiryn"
const VNC_PORT = "6080/tcp"

const containerName = (agentId: string) => `xiryn-ws-${agentId}`
const volumeName = (agentId: string) => `xiryn-home-${agentId}`

// Labels this installation's containers, so two copies of Xiryn on one
// computer never clean up each other's machines
function installId() {
  let id = getSetting("workstation.installId")
  if (!id) {
    id = randomBytes(6).toString("hex")
    setSetting("workstation.installId", id)
  }
  return id
}

// True when agents can have a workstation now, or once Docker is started
export function isWorkstationConfigured() {
  const engine = engineSnapshot()
  return engine?.state === "ready" || (engine?.state === "stopped" && engine.canStart)
}

function numberSetting(
  key:
    | "workstation.cpus"
    | "workstation.memory"
    | "workstation.autoStop"
    | "workstation.autoDelete"
) {
  const value = Number.parseFloat(getSetting(key) ?? "")
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function hostnameFor(name: string | undefined) {
  const slug = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return slug || "workstation"
}

/* ─────────────────────────── lifecycle ─────────────────────────── */

type Inspection = {
  status: string
  image: string
  startedAt: string
  finishedAt: string
  cpus: number
  memoryBytes: number
}

async function inspect(name: string): Promise<Inspection | null> {
  const { exitCode, stdout, stderr } = await dockerRaw(
    [
      "inspect",
      "--type",
      "container",
      "--format",
      '{{.State.Status}}\t{{index .Config.Labels "xiryn.image"}}\t{{.State.StartedAt}}\t{{.State.FinishedAt}}\t{{.HostConfig.NanoCpus}}\t{{.HostConfig.Memory}}',
      name,
    ],
    { timeoutMs: 20_000 }
  )
  if (exitCode !== 0) {
    if (/no such (container|object)/i.test(stderr)) return null
    throw new Error(dockerReason(stderr) || "Couldn't look up the workstation.")
  }
  const [status, image, startedAt, finishedAt, nanoCpus, memory] = stdout
    .toString()
    .trim()
    .split("\t")
  return {
    status,
    image,
    startedAt,
    finishedAt,
    cpus: Number(nanoCpus) / 1e9 || 0,
    memoryBytes: Number(memory) || 0,
  }
}

async function create(agentId: string, tag: string) {
  const agent = db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get()
  if (!agent) throw new Error("Agent not found")

  const cpus = numberSetting("workstation.cpus") || 2
  const memory = numberSetting("workstation.memory") || 4
  const idle = Math.round(numberSetting("workstation.autoStop") ?? 15)
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  // Asked for by the desktop viewer; the port is reachable from this computer only
  const password = randomBytes(9).toString("base64url").slice(0, 8)
  const labels = [`xiryn.agent=${agentId}`, `xiryn.install=${installId()}`]

  await docker([
    "volume",
    "create",
    ...labels.flatMap((l) => ["--label", l]),
    volumeName(agentId),
  ])
  await docker(
    [
      "create",
      "--name",
      containerName(agentId),
      "--hostname",
      hostnameFor(agent.name),
      "--label",
      "xiryn.workstation=1",
      ...labels.flatMap((l) => ["--label", l]),
      "--label",
      `xiryn.image=${tag}`,
      "--env",
      `XIRYN_VNC_PASSWORD=${password}`,
      "--env",
      `XIRYN_IDLE_MINUTES=${idle}`,
      "--env",
      `XIRYN_SCREEN=${SCREEN.width}x${SCREEN.height}`,
      "--env",
      `TZ=${timeZone}`,
      "--volume",
      `${volumeName(agentId)}:${HOME}`,
      "--publish",
      `127.0.0.1::${VNC_PORT}`,
      "--shm-size",
      "1g",
      // A runaway process tree stays the agent's problem, not the computer's
      "--pids-limit",
      "4096",
      "--cpus",
      String(cpus),
      "--memory",
      `${Math.round(memory * 1024)}m`,
      tag,
    ],
    { timeoutMs: 60_000 }
  )
}

// Starts a stopped container and waits until its desktop is up
async function boot(name: string) {
  await docker(["start", name], { timeoutMs: 60_000 })
  await docker(["exec", name, "xiryn-ready"], { timeoutMs: 45_000 })
}

type Session = { name: string; at: number; port?: number; password?: string }

const globalForWorkstations = globalThis as unknown as {
  __xirynWorkstations?: {
    pending: Map<string, Promise<Session>>
    recent: Map<string, Session>
    janitor: NodeJS.Timeout | null
    sweeping: boolean
  }
}
const shared = (globalForWorkstations.__xirynWorkstations ??= {
  pending: new Map(),
  recent: new Map(),
  janitor: null,
  sweeping: false,
})

// A machine seen running this recently is used without asking Docker again
const RECENT_MS = 60_000

async function prepare(agentId: string): Promise<Session> {
  await ensureEngine()
  const name = containerName(agentId)
  let found = await inspect(name)

  // A stopped machine on an outdated image is recreated; its home folder,
  // which lives in a volume, carries over
  const current = imageTag()
  if (found && found.status !== "running" && found.image !== current) {
    await docker(["rm", "--force", name])
    found = null
  }

  if (!found) {
    await create(agentId, await ensureImage())
    await boot(name)
  } else if (found.status !== "running") {
    await boot(name)
  }

  // Applies the current auto-stop setting and marks the machine as in use
  const idle = Math.round(numberSetting("workstation.autoStop") ?? 15)
  await docker(
    [
      "exec",
      name,
      "sh",
      "-c",
      'mkdir -p /tmp/xiryn && echo "$1" > /tmp/xiryn/idle-minutes && touch /tmp/xiryn/active',
      "sh",
      String(idle),
    ],
    { timeoutMs: 20_000 }
  )

  db.update(agents)
    .set({ workstationId: name, updatedAt: new Date() })
    .where(eq(agents.id, agentId))
    .run()
  return { name, at: Date.now() }
}

// The agent's workstation, running. Creates it on first use and starts it
// (and Docker Desktop, if needed) when it's stopped.
export async function ensureWorkstation(agentId: string): Promise<string> {
  const cached = shared.recent.get(agentId)
  if (cached && Date.now() - cached.at < RECENT_MS) return cached.name

  let task = shared.pending.get(agentId)
  if (!task) {
    task = prepare(agentId).finally(() => shared.pending.delete(agentId))
    shared.pending.set(agentId, task)
  }
  const session = await task
  shared.recent.set(agentId, session)
  return session.name
}

// The desktop starts with the machine
export const ensureDesktop = ensureWorkstation

const GONE = /is not running|no such container|is restarting/i

// The most a command in a workstation may print before it's stopped. The
// scripts there clip their own output (xiryn-run to 20 KB, readFile to 1 MB),
// but the agent can rewrite them, so the server doesn't rely on that.
const EXEC_MAX_BYTES = 2_000_000

// Runs a command in the agent's machine as its user. If the machine stopped
// since it was last seen, it is started again and the command retried once.
async function execIn(
  agentId: string,
  command: string[],
  options: RunOptions & { cwd?: string } = {}
) {
  const flags = [
    ...(options.input !== undefined ? ["--interactive"] : []),
    ...(options.cwd ? ["--workdir", options.cwd] : []),
  ]
  // Everything read back from the agent's machine is capped (see OutputLimitError)
  options = { maxBytes: EXEC_MAX_BYTES, ...options }
  let name = await ensureWorkstation(agentId)
  let result = await dockerRaw(["exec", ...flags, name, ...command], options)
  if (result.exitCode !== 0 && GONE.test(result.stderr)) {
    shared.recent.delete(agentId)
    name = await ensureWorkstation(agentId)
    result = await dockerRaw(["exec", ...flags, name, ...command], options)
  }
  return result
}

async function execOrThrow(
  agentId: string,
  command: string[],
  options: RunOptions & { cwd?: string } = {}
) {
  const result = await execIn(agentId, command, { timeoutMs: 60_000, ...options })
  if (result.exitCode !== 0) {
    throw new Error(
      dockerReason(result.stderr) ||
        result.stdout.toString().trim().slice(-500) ||
        `${command[0]} failed`
    )
  }
  return result
}

/* ───────────────────────── shell & files ───────────────────────── */

// "~/x" and "x" both mean /home/xiryn/x
export function resolvePath(input: string) {
  const value = input.trim() || "."
  if (value === "~") return HOME
  if (value.startsWith("~/")) return `${HOME}/${value.slice(2)}`
  if (value.startsWith("/")) return value
  return value === "." ? HOME : `${HOME}/${value.replace(/^\.\//, "")}`
}

export async function runCommand(
  agentId: string,
  command: string,
  { cwd, timeoutSeconds = 120 }: { cwd?: string; timeoutSeconds?: number } = {}
) {
  const result = await execIn(agentId, ["xiryn-run", String(timeoutSeconds), command], {
    cwd: cwd ? resolvePath(cwd) : HOME,
    timeoutMs: (timeoutSeconds + 20) * 1000,
  })
  const output = result.stdout.toString("utf8")
  return {
    exitCode: result.exitCode,
    // A failure to even start (a missing directory, say) is reported by Docker
    output: output || (result.exitCode !== 0 ? dockerReason(result.stderr) : ""),
  }
}

const READ_LIMIT = 1_000_000

export async function readFile(agentId: string, path: string) {
  const result = await execOrThrow(agentId, [
    "sh",
    "-c",
    `stat -c %s -- "$1" && head -c ${READ_LIMIT} -- "$1"`,
    "sh",
    resolvePath(path),
  ])
  const newline = result.stdout.indexOf(0x0a)
  return {
    bytes: Number(result.stdout.subarray(0, newline).toString()) || 0,
    content: result.stdout.subarray(newline + 1),
  }
}

export async function writeFile(agentId: string, path: string, content: Buffer) {
  await execOrThrow(
    agentId,
    [
      "sh",
      "-c",
      'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"',
      "sh",
      resolvePath(path),
    ],
    { input: content }
  )
}

export async function listDirectory(agentId: string, path: string) {
  const result = await execOrThrow(
    agentId,
    [
      "find",
      resolvePath(path),
      "-mindepth",
      "1",
      "-maxdepth",
      "1",
      "-printf",
      "%y\\t%s\\t%f\\n",
    ],
    { maxBytes: 512_000 }
  )
  return result.stdout
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [type, size, ...name] = line.split("\t")
      return { name: name.join("\t"), dir: type === "d", size: Number(size) || 0 }
    })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
}

/* ──────────────────────────── desktop ──────────────────────────── */

export async function captureScreen(agentId: string) {
  const result = await execOrThrow(agentId, ["xiryn-shot"], { timeoutMs: 30_000 })
  const image = result.stdout.toString("ascii").trim()
  if (!image) throw new Error("The screenshot came back empty.")
  return { image, mediaType: "image/jpeg", width: SCREEN.width, height: SCREEN.height }
}

const xdotool = (agentId: string, args: string[]) =>
  execOrThrow(agentId, ["xdotool", ...args], { timeoutMs: 60_000 })

const BUTTONS = { left: "1", middle: "2", right: "3" } as const

export function click(
  agentId: string,
  x: number,
  y: number,
  button: keyof typeof BUTTONS,
  double: boolean
) {
  return xdotool(agentId, [
    "mousemove",
    String(x),
    String(y),
    "sleep",
    "0.05",
    "click",
    ...(double ? ["--repeat", "2", "--delay", "80"] : []),
    BUTTONS[button],
  ])
}

export function movePointer(agentId: string, x: number, y: number) {
  return xdotool(agentId, ["mousemove", String(x), String(y)])
}

export function drag(
  agentId: string,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number
) {
  return xdotool(agentId, [
    "mousemove",
    String(fromX),
    String(fromY),
    "sleep",
    "0.05",
    "mousedown",
    "1",
    "sleep",
    "0.1",
    "mousemove",
    String(Math.round((fromX + toX) / 2)),
    String(Math.round((fromY + toY) / 2)),
    "sleep",
    "0.05",
    "mousemove",
    String(toX),
    String(toY),
    "sleep",
    "0.1",
    "mouseup",
    "1",
  ])
}

export function scroll(
  agentId: string,
  x: number,
  y: number,
  direction: "up" | "down",
  amount: number
) {
  return xdotool(agentId, [
    "mousemove",
    String(x),
    String(y),
    "sleep",
    "0.05",
    "click",
    "--repeat",
    String(amount),
    "--delay",
    "40",
    direction === "up" ? "4" : "5",
  ])
}

export function typeText(agentId: string, text: string) {
  return xdotool(agentId, ["type", "--delay", "8", "--clearmodifiers", "--", text])
}

// Types a vault value. It goes in on stdin, so it never shows up in a
// process list, a log or a tool result.
export function typeSecret(agentId: string, value: string) {
  return execOrThrow(
    agentId,
    ["xdotool", "type", "--delay", "12", "--clearmodifiers", "--file", "-"],
    {
      input: value,
      timeoutMs: 60_000,
    }
  )
}

// Shows the focused field as dots, so a value from the vault doesn't appear
// in screenshots or to anyone watching. Best effort: the fill already
// happened either way.
export async function maskFocusedField(agentId: string) {
  await execIn(agentId, ["xiryn-mask"], { timeoutMs: 15_000 }).catch(() => null)
}

// The page in front of the person: the one browser tab whose title is in
// the focused Chromium window, read from Chromium's debugging port inside the
// container. Anything less certain (another window focused, no tab or several
// tabs with that title) is null, so nothing site-bound gets filled. This stops
// a focused terminal or a decoy window; it can't stop an agent that uses root
// in its own container to forge what these commands report.
export async function currentPage(agentId: string) {
  const [targets, focused] = await Promise.all([
    execIn(agentId, ["curl", "-s", "-m", "4", "http://127.0.0.1:9222/json/list"], {
      timeoutMs: 15_000,
      maxBytes: 256_000,
    }),
    // First line: the focused window's WM_CLASS; the rest: its title
    execIn(
      agentId,
      [
        "sh",
        "-c",
        'w=$(xdotool getactivewindow) && xprop -id "$w" WM_CLASS && xdotool getwindowname "$w"',
      ],
      { timeoutMs: 15_000, maxBytes: 4_000 }
    ),
  ])
  let pages: { type: string; url: string; title: string }[] = []
  try {
    pages = (JSON.parse(targets.stdout.toString()) as typeof pages).filter(
      (target) => target.type === "page" && /^https?:/.test(target.url)
    )
  } catch {
    return null
  }
  const [windowClass = "", ...name] = focused.stdout.toString().trim().split("\n")
  if (!/chromium/i.test(windowClass)) return null
  const title = name
    .join("\n")
    .trim()
    .replace(/ - Chromium$/, "")
  const matches = pages.filter((candidate) => candidate.title === title)
  if (matches.length !== 1) return null
  const page = matches[0]
  return {
    url: page.url,
    host: new URL(page.url).hostname.replace(/^www\./, ""),
    title: page.title,
  }
}

// Friendly key names to X keysyms
const KEYS: Record<string, string> = {
  enter: "Return",
  return: "Return",
  escape: "Escape",
  esc: "Escape",
  tab: "Tab",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  space: "space",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
  capslock: "Caps_Lock",
  menu: "Menu",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  shift: "shift",
  cmd: "super",
  super: "super",
  meta: "super",
  win: "super",
  ",": "comma",
  ".": "period",
  "/": "slash",
  "\\": "backslash",
  "-": "minus",
  "=": "equal",
  "+": "plus",
  ";": "semicolon",
  "'": "apostrophe",
  "`": "grave",
  "[": "bracketleft",
  "]": "bracketright",
}

function keysym(key: string) {
  const lower = key.toLowerCase()
  if (KEYS[lower]) return KEYS[lower]
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower.toUpperCase()
  return key
}

export function pressKey(agentId: string, key: string, modifiers: string[]) {
  const combo = [...modifiers.map(keysym), keysym(key)].join("+")
  return xdotool(agentId, ["key", "--clearmodifiers", combo])
}

// Where the browser's VNC client connects. The port is published on this
// computer's loopback interface only, and the desktop asks for a password.
export async function getDesktopAccess(agentId: string) {
  const name = await ensureWorkstation(agentId)
  const session = shared.recent.get(agentId)
  if (!session?.port || !session.password) {
    const [port, env] = await Promise.all([
      docker(["port", name, VNC_PORT]),
      docker([
        "inspect",
        "--type",
        "container",
        "--format",
        "{{json .Config.Env}}",
        name,
      ]),
    ])
    const binding = port.stdout.toString().match(/127\.0\.0\.1:(\d+)/)
    const password = (JSON.parse(env.stdout.toString()) as string[])
      .find((entry) => entry.startsWith("XIRYN_VNC_PASSWORD="))
      ?.slice("XIRYN_VNC_PASSWORD=".length)
    if (!binding || !password) throw new Error("The desktop isn't reachable yet.")
    if (session) Object.assign(session, { port: Number(binding[1]), password })
    return { url: `ws://127.0.0.1:${binding[1]}/websockify`, password }
  }
  return { url: `ws://127.0.0.1:${session.port}/websockify`, password: session.password }
}

export function phoneLinksEnabled() {
  return getSetting("workstation.phoneLinks") !== "off"
}

// A link that opens the agent's live desktop in any browser, a phone
// included, through a temporary Cloudflare quick tunnel. The tunnel closes
// itself after `minutes`; the link carries the desktop's password.
export async function getTakeoverLink(
  agentId: string,
  { minutes = 30, agent, bot }: { minutes?: number; agent?: string; bot?: string } = {}
) {
  if (!phoneLinksEnabled()) return null
  const { password } = await getDesktopAccess(agentId)
  const result = await execOrThrow(agentId, ["xiryn-tunnel", String(minutes)], {
    timeoutMs: 45_000,
    maxBytes: 4_000,
  })
  // The address is read from the agent's own machine, so it is checked to be
  // a quick-tunnel address before the person is sent there with the password
  const base = result.stdout.toString().trim().split("\n").at(-1) ?? ""
  let tunnel: URL | null = null
  try {
    tunnel = new URL(base)
  } catch {}
  if (
    !tunnel ||
    tunnel.protocol !== "https:" ||
    !/^[a-z0-9-]+\.trycloudflare\.com$/.test(tunnel.hostname) ||
    tunnel.username ||
    tunnel.password
  ) {
    throw new Error("The tunnel didn't report a usable address.")
  }
  // Xiryn's phone page (workstation/…/novnc/xiryn.html). Everything it needs
  // rides after the #, which browsers never send to a server, so the
  // password stays out of the tunnel's logs.
  const fragment = new URLSearchParams({
    password,
    until: String(Date.now() + minutes * 60_000),
    ...(agent && { agent }),
    ...(bot && { bot }),
  })
  return { url: `${new URL("/xiryn.html", tunnel.origin)}#${fragment}`, minutes }
}

/* ──────────────────────────── status ──────────────────────────── */

export type WorkstationStatus =
  | { state: "no-docker"; reason: "missing" | "stopped"; detail: string }
  | { state: "unprovisioned" }
  | {
      state: "running" | "stopped" | "starting"
      container: string
      outdated: boolean
      cpus: number
      memoryGb: number
      diskBytes: number | null
      screen: string
      since: string | null
    }

// Looks without starting anything
export async function getWorkstationStatus(agentId: string): Promise<WorkstationStatus> {
  const engine = engineSnapshot() ?? { state: "missing" as const }
  if (engine.state !== "ready") {
    return {
      state: "no-docker",
      reason: engine.state,
      detail:
        engine.state === "missing"
          ? "Docker isn't installed."
          : "Docker isn't running — it starts automatically when an agent needs it.",
    }
  }
  const name = containerName(agentId)
  const found = await inspect(name)
  if (!found) return { state: "unprovisioned" }

  const running = found.status === "running"
  let diskBytes: number | null = null
  if (running) {
    const du = await dockerRaw(["exec", name, "du", "-sxb", HOME], { timeoutMs: 8_000 })
    if (du.exitCode === 0) diskBytes = Number(du.stdout.toString().split("\t")[0]) || null
  }
  return {
    state: running ? "running" : found.status === "restarting" ? "starting" : "stopped",
    container: name,
    outdated: found.image !== imageTag(),
    cpus: found.cpus,
    memoryGb: found.memoryBytes / 1024 ** 3,
    diskBytes,
    screen: `${SCREEN.width}×${SCREEN.height}`,
    since: running ? found.startedAt : found.finishedAt,
  }
}

export async function stopWorkstation(agentId: string) {
  shared.recent.delete(agentId)
  const name = containerName(agentId)
  if (await inspect(name))
    await docker(["stop", "--time", "5", name], { timeoutMs: 60_000 })
}

// Removes the machine and its home folder
export async function deleteWorkstation(agentId: string) {
  shared.recent.delete(agentId)
  await dockerRaw(["rm", "--force", "--volumes", containerName(agentId)], {
    timeoutMs: 60_000,
  })
  await dockerRaw(["volume", "rm", "--force", volumeName(agentId)], { timeoutMs: 60_000 })
  db.update(agents)
    .set({ workstationId: null, updatedAt: new Date() })
    .where(eq(agents.id, agentId))
    .run()
}

// Wipes the machine: the next use starts a fresh one
export const resetWorkstation = deleteWorkstation

export async function checkWorkstationNetwork(agentId: string) {
  const probe = (url: string) =>
    `$(curl -s -o /dev/null -m 8 -w '%{http_code}' ${url} || echo 000)`
  const result = await runCommand(
    agentId,
    `echo ${probe("https://example.com")} ${probe("https://github.com")}`,
    { timeoutSeconds: 30 }
  )
  const [open, essential] = result.output.trim().split(/\s+/)
  const reached = (code?: string) => !!code && !code.startsWith("000")
  return {
    internet: reached(open)
      ? ("full" as const)
      : reached(essential)
        ? ("restricted" as const)
        : ("offline" as const),
  }
}

/* ──────────────────────────── janitor ──────────────────────────── */

// Removes machines whose agent was deleted, and, with auto-delete on,
// machines that have been stopped for longer than that
export async function sweepWorkstations() {
  if (engineSnapshot()?.state !== "ready") return
  const install = installId()
  const known = new Set(
    db
      .select({ id: agents.id })
      .from(agents)
      .all()
      .map((agent) => agent.id)
  )
  const autoDelete = numberSetting("workstation.autoDelete")

  const containers = await docker([
    "ps",
    "--all",
    "--filter",
    `label=xiryn.install=${install}`,
    "--format",
    '{{.Label "xiryn.agent"}}\t{{.State}}',
  ])
  for (const line of containers.stdout.toString().split(/\r?\n/).filter(Boolean)) {
    const [agentId, state] = line.split("\t")
    if (!agentId) continue
    if (!known.has(agentId)) {
      await deleteWorkstation(agentId)
      continue
    }
    if (autoDelete === undefined || state !== "exited") continue
    const found = await inspect(containerName(agentId))
    const stoppedFor = found ? Date.now() - Date.parse(found.finishedAt) : 0
    if (stoppedFor >= autoDelete * 60_000) await deleteWorkstation(agentId)
  }

  const volumes = await docker([
    "volume",
    "ls",
    "--filter",
    `label=xiryn.install=${install}`,
    "--format",
    '{{.Label "xiryn.agent"}}',
  ])
  for (const agentId of volumes.stdout.toString().split(/\r?\n/).filter(Boolean)) {
    if (!known.has(agentId)) await dockerRaw(["volume", "rm", volumeName(agentId)])
  }
}

export function startWorkstationJanitor() {
  if (shared.janitor) return
  // A sweep waits on Docker; when Docker is slow the next tick must not start
  // a second one alongside it
  const sweep = async () => {
    if (shared.sweeping) return
    shared.sweeping = true
    try {
      await sweepWorkstations()
    } catch (error) {
      console.error("[xiryn] workstation cleanup failed:", error)
    } finally {
      shared.sweeping = false
    }
  }
  setTimeout(sweep, 20_000).unref()
  shared.janitor = setInterval(sweep, 5 * 60_000)
  shared.janitor.unref()
}
