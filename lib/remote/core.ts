import { randomBytes } from "node:crypto"

import { and, desc, eq } from "drizzle-orm"
import { nanoid } from "nanoid"

import { db } from "@/db"
import { agents, messages, squadMembers, squads, threads, type Agent } from "@/db/schema"
import {
  getActiveRun,
  startTurn,
  stopRun,
  subscribe,
  TurnError,
} from "@/lib/agent/runtime"
import type { SecretRequest, XirynMessage } from "@/lib/agent/tools"
import { getSetting, setSetting, type SettingKey } from "@/lib/config"
import { resolveModelSpec } from "@/lib/providers/registry"
import { reportError } from "@/lib/report"
import { screenOf } from "@/lib/screens"
import {
  approvalScreen,
  getApproval,
  type Approval,
  type VaultItemView,
} from "@/lib/vault"
import {
  answerLogin,
  answerPayment,
  answerSecret,
  type VaultMarker,
} from "@/lib/vault-requests"
import { getTakeoverLink } from "@/lib/workstation"

/* ────────────────────────────────────────────────────────────────────
 * Remote control from a chat app, whichever one.
 *
 * Telegram (lib/telegram/bridge.ts) and Discord (lib/discord/bridge.ts)
 * each connect outbound from this machine and hand what arrives to this
 * module; it does the rest the same way for both: pairing one person,
 * picking an agent, running turns with a live list of steps, and the
 * payment, secret, code and take-over hand-offs. A channel only knows how
 * to send, edit and delete messages with buttons in its own app.
 * ──────────────────────────────────────────────────────────────────── */

export type ChannelId = "telegram" | "discord"

export type Button = { label: string; data: string }
export type Sent = { chat: string; id: string }

export interface Channel {
  id: ChannelId
  // As shown to the person: "Telegram"
  name: string
  // Connected and able to send
  ready(): boolean
  // Markdown in; each channel formats and splits it for its app
  send(
    chat: string,
    markdown: string,
    options?: { buttons?: Button[][]; silent?: boolean }
  ): Promise<Sent | null>
  // Rewrites a message; buttons are removed unless given again
  edit(message: Sent, markdown: string, options?: { buttons?: Button[][] }): Promise<void>
  remove(message: Sent): Promise<void>
  photo(
    chat: string,
    image: { base64: string; mediaType: string },
    caption?: string
  ): Promise<void>
  typing(chat: string): Promise<void>
  // Shown on the phone take-over page
  handle?(): string | undefined
}

const channels = ((
  globalThis as { __xirynChannels?: Map<ChannelId, Channel> }
).__xirynChannels ??= new Map<ChannelId, Channel>())

export function registerChannel(channel: Channel) {
  channels.set(channel.id, channel)
}

/* ───────────────────────────── state ──────────────────────────── */

// Each channel keeps its own pairing and target, under its own settings
const key = (channel: ChannelId, name: string) => `${channel}.${name}` as SettingKey

// A pairing code is good for 15 minutes; Settings shows a fresh one after
const PAIR_CODE_MS = 15 * 60_000

function pairCodeExpired(channel: ChannelId) {
  const at = Number(getSetting(key(channel, "pairCodeAt")) ?? 0)
  return !at || Date.now() - at > PAIR_CODE_MS
}

export function getPairCode(channel: ChannelId) {
  let code = getSetting(key(channel, "pairCode"))
  if (!code || pairCodeExpired(channel)) code = regeneratePairCode(channel)
  return code
}

export function regeneratePairCode(channel: ChannelId) {
  // Unambiguous characters only, so it can be typed from a phone
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const code = [...randomBytes(8)]
    .map((byte) => alphabet[byte % alphabet.length])
    .join("")
  setSetting(key(channel, "pairCode"), code)
  setSetting(key(channel, "pairCodeAt"), String(Date.now()))
  setSetting(key(channel, "pairFailures"), null)
  return code
}

export function ownerOf(channel: ChannelId) {
  return getSetting(key(channel, "ownerId")) ?? null
}

// Where notices go: the chat pairing happened in (a Telegram private chat
// has the person's own id)
function ownerChat(channel: ChannelId) {
  return getSetting(key(channel, "ownerChat")) ?? ownerOf(channel)
}

export function ownerName(channel: ChannelId) {
  return getSetting(key(channel, "ownerName"))
}

export function unpair(channel: ChannelId) {
  for (const name of ["ownerId", "ownerName", "ownerChat", "target"]) {
    setSetting(key(channel, name), null)
  }
  regeneratePairCode(channel)
}

type Target = { agentId?: string; squadId?: string; threadId?: string }

function getTarget(channel: ChannelId): Target {
  try {
    return JSON.parse(getSetting(key(channel, "target")) ?? "{}") as Target
  } catch {
    return {}
  }
}

function setTarget(channel: ChannelId, target: Target) {
  setSetting(key(channel, "target"), JSON.stringify(target))
}

// A code an agent asked for: the next reply on any channel is stored, not sent
type AwaitingCode = {
  threadId: string
  agentId: string
  squadId: string | null
  expires: number
}
const shared = ((
  globalThis as { __xirynRemote?: { awaitingCode: AwaitingCode | null } }
).__xirynRemote ??= { awaitingCode: null })

// When each stranger's chat last got the "private instance" reply
const strangers = new Map<string, number>()

// Channels that are connected and paired, with where their notices go
function paired() {
  return [...channels.values()].flatMap((channel) => {
    const chat = channel.ready() ? ownerChat(channel.id) : null
    return chat ? [{ channel, chat }] : []
  })
}

/* ─────────────────────────── incoming ─────────────────────────── */

export type Incoming = {
  chat: string
  userId: string
  userName: string
  text: string
  message?: Sent
}

// A message from the app. Commands start with "/", as typed in Telegram; a
// channel with its own command UI (Discord's slash commands) passes them in
// the same form.
export async function onMessage(channel: Channel, incoming: Incoming) {
  const { chat, userId, userName } = incoming
  const text = incoming.text.trim()
  const owner = ownerOf(channel.id)

  if (owner !== userId) {
    // Pairing: /pair CODE (or /start CODE from Telegram's deep link)
    const match = text.match(/^\/(?:start|pair)(?:@\w+)?\s+([A-Za-z0-9_-]+)/)
    const code = pairCodeExpired(channel.id)
      ? null
      : getSetting(key(channel.id, "pairCode"))
    if (!owner && match && code && match[1].toUpperCase() === code) {
      setSetting(key(channel.id, "ownerId"), userId)
      setSetting(key(channel.id, "ownerName"), userName)
      setSetting(key(channel.id, "ownerChat"), chat)
      setSetting(key(channel.id, "pairCode"), null)
      setSetting(key(channel.id, "pairFailures"), null)
      await channel.send(
        chat,
        `**Paired.** This ${channel.name} account now controls your Xiryn.\n\nJust write a message to talk to your agent. Use /agents to switch agents or squads, /new for a fresh thread, /stop to interrupt.`
      )
      await sendAgentPicker(channel, chat)
      return
    }
    // Guessing is pointless: a few wrong codes and the code changes. The
    // count survives restarts.
    if (!owner && match) {
      const failures = Number(getSetting(key(channel.id, "pairFailures")) ?? 0) + 1
      if (failures >= 5) regeneratePairCode(channel.id)
      else setSetting(key(channel.id, "pairFailures"), String(failures))
    }
    // Strangers hear back once an hour at most; the rest is dropped
    const seen = `${channel.id}:${chat}`
    const last = strangers.get(seen) ?? 0
    if (Date.now() - last < 60 * 60_000) return
    if (strangers.size > 1000) strangers.clear()
    strangers.set(seen, Date.now())
    await channel.send(
      chat,
      owner
        ? "🔒 This is a private Xiryn instance."
        : "🔒 This Xiryn isn't paired yet. Open **Settings → Remote access** on the computer running Xiryn and use the pairing link or code shown there."
    )
    return
  }

  if (!text) {
    await channel.send(chat, "I can only read text messages for now.")
    return
  }

  // A code an agent asked for goes into the vault, not into the conversation.
  // A plain reply counts only if it looks like a code (it has a digit), so
  // "ok" or "done" isn't swallowed; "/code …" always counts.
  const awaiting = shared.awaitingCode
  const live = awaiting && Date.now() < awaiting.expires
  if (live && /^\/cancel(?:@\w+)?$/i.test(text)) {
    shared.awaitingCode = null
    await channel.send(chat, "Stopped waiting for the code.")
    return
  }
  const explicit = text.match(/^\/code(?:@\w+)?\s+(.+)$/i)?.[1]?.trim()
  const candidate = explicit ?? (/\d/.test(text) ? text : null)
  if (live && candidate && /^[A-Za-z0-9][A-Za-z0-9 -]{2,15}$/.test(candidate)) {
    shared.awaitingCode = null
    const answer = answerSecret(
      "code",
      { code: candidate.replace(/\s/g, "") },
      { save: false }
    )
    if (incoming.message) await channel.remove(incoming.message).catch(() => {})
    await channel.send(
      chat,
      "🔐 Code received and stored in your vault. It's used once, then deleted."
    )
    setTarget(
      channel.id,
      awaiting.squadId
        ? { squadId: awaiting.squadId, threadId: awaiting.threadId }
        : { agentId: awaiting.agentId, threadId: awaiting.threadId }
    )
    return converse(channel, chat, answer.text, answer.marker)
  }

  const command = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/)
  if (command) {
    switch (command[1].toLowerCase()) {
      case "start":
      case "help":
        await channel.send(chat, helpText())
        return
      case "agents":
      case "use":
        return sendAgentPicker(channel, chat)
      case "new":
        return newThread(channel, chat)
      case "stop": {
        const target = getTarget(channel.id)
        const stopped = target.threadId ? stopRun(target.threadId) : false
        await channel.send(chat, stopped ? "⏹ Stopped." : "Nothing is running.")
        return
      }
      case "status":
        await channel.send(chat, statusText(channel.id))
        return
      case "code":
      case "cancel":
        await channel.send(chat, "No agent is waiting for a code.")
        return
    }
  }

  await converse(channel, chat, text)
}

// A button the person pressed. Returns a short line for the app to show
// as an acknowledgement (Telegram's toast, Discord's ephemeral reply).
export async function onButton(
  channel: Channel,
  press: { chat: string; userId: string; data: string; message?: Sent }
): Promise<string | null> {
  if (press.userId !== ownerOf(channel.id)) return "Private"
  const decision = press.data.match(/^(pay|login):([\w-]+):([\w-]+)$/)
  if (decision) return handleApproval(channel, press, decision[2], decision[3])
  const use = press.data.match(/^use:(a|s):(.+)$/)
  if (!use) return null
  const [, kind, id] = use

  let label: string | null = null
  if (kind === "a") {
    const agent = db.select().from(agents).where(eq(agents.id, id)).get()
    if (agent) {
      setTarget(channel.id, {
        agentId: agent.id,
        threadId: latestThread({ agentId: agent.id }),
      })
      label = `${agent.name} — ${agent.role}`
    }
  } else {
    const squad = db.select().from(squads).where(eq(squads.id, id)).get()
    if (squad) {
      setTarget(channel.id, {
        squadId: squad.id,
        threadId: latestThread({ squadId: squad.id }),
      })
      label = `squad ${squad.name}`
    }
  }
  if (label && press.message) {
    await channel.edit(
      press.message,
      `Now talking to **${label}**. Continuing its latest thread — /new starts a fresh one.`
    )
  }
  return label ? `Talking to ${label}` : "That one no longer exists"
}

function helpText() {
  return [
    "**Xiryn — remote**",
    "Write a message and your current agent answers, working on its own workstation while your computer keeps running Xiryn.",
    "",
    "/agents — pick an agent or squad",
    "/new — start a fresh thread",
    "/stop — interrupt the agent",
    "/status — what's running",
    "",
    "In a squad, start with `@Name` to address a specific member.",
    "Threads you start here also appear in the Xiryn app on your computer.",
  ].join("\n")
}

function statusText(channel: ChannelId) {
  const target = getTarget(channel)
  const agent = target.agentId
    ? db.select().from(agents).where(eq(agents.id, target.agentId)).get()
    : null
  const squad = target.squadId
    ? db.select().from(squads).where(eq(squads.id, target.squadId)).get()
    : null
  const busy = target.threadId ? !!getActiveRun(target.threadId) : false
  return [
    "**Status**",
    `talking to: ${agent ? `${agent.name} (${agent.role})` : squad ? `squad ${squad.name}` : "nobody yet — /agents"}`,
    `model: \`${resolveModelSpec(agent?.model) ?? "not configured"}\``,
    `turn: ${busy ? "running" : "idle"}`,
  ].join("\n")
}

async function sendAgentPicker(channel: Channel, chat: string) {
  const agentRows = db.select().from(agents).orderBy(agents.createdAt).all()
  const squadRows = db.select().from(squads).orderBy(squads.createdAt).all()
  if (agentRows.length === 0) {
    await channel.send(
      chat,
      "You have no agents yet. Create one in the Xiryn app on your computer, then come back."
    )
    return
  }
  const target = getTarget(channel.id)
  await channel.send(chat, "Who do you want to talk to?", {
    buttons: [
      ...agentRows.map((agent) => [
        {
          label:
            `${target.agentId === agent.id ? "● " : ""}${agent.name} — ${agent.role}`.slice(
              0,
              60
            ),
          data: `use:a:${agent.id}`,
        },
      ]),
      ...squadRows.map((squad) => [
        {
          label: `${target.squadId === squad.id ? "● " : ""}⧉ ${squad.name}`.slice(0, 60),
          data: `use:s:${squad.id}`,
        },
      ]),
    ],
  })
}

function latestThread(owner: { agentId?: string; squadId?: string }) {
  const row = db
    .select({ id: threads.id })
    .from(threads)
    .where(
      owner.agentId
        ? eq(threads.agentId, owner.agentId)
        : eq(threads.squadId, owner.squadId!)
    )
    .orderBy(desc(threads.activeAt))
    .get()
  return row?.id
}

async function newThread(channel: Channel, chat: string) {
  const target = resolveTarget(channel.id)
  if (!target) return sendAgentPicker(channel, chat)
  const [thread] = db
    .insert(threads)
    .values({ agentId: target.agentId ?? null, squadId: target.squadId ?? null })
    .returning({ id: threads.id })
    .all()
  setTarget(channel.id, { ...target, threadId: thread.id })
  await channel.send(chat, "🆕 Fresh thread. What's next?")
}

// The current target, falling back to the only agent when there is one
function resolveTarget(channel: ChannelId): Target | null {
  const target = getTarget(channel)
  if (
    target.agentId &&
    db.select({ id: agents.id }).from(agents).where(eq(agents.id, target.agentId)).get()
  ) {
    return target
  }
  if (
    target.squadId &&
    db.select({ id: squads.id }).from(squads).where(eq(squads.id, target.squadId)).get()
  ) {
    return target
  }
  const all = db.select({ id: agents.id }).from(agents).limit(2).all()
  if (all.length === 1) {
    const fallback = {
      agentId: all[0].id,
      threadId: latestThread({ agentId: all[0].id }),
    }
    setTarget(channel, fallback)
    return fallback
  }
  return null
}

/* ──────────────────────────── turns ───────────────────────────── */

// How each tool reads in the live list of steps
const TOOL_LABELS: Record<string, (input: Record<string, unknown>) => string> = {
  shell: (i) => `$ ${String(i.command ?? "")}`,
  fs_read: (i) => `read ${String(i.path ?? "")}`,
  fs_write: (i) => `write ${String(i.path ?? "")}`,
  fs_list: (i) => `ls ${String(i.path ?? ".")}`,
  screen_capture: () => "looking at the screen",
  screen_share: () => "sharing the screen",
  pointer_click: (i) => `click ${i.x},${i.y}`,
  pointer_move: (i) => `move ${i.x},${i.y}`,
  pointer_drag: () => "drag",
  pointer_scroll: (i) => `scroll ${String(i.direction ?? "")}`,
  key_type: () => "typing",
  key_press: (i) => `key ${String(i.key ?? "")}`,
  web_search: (i) => `search “${String(i.query ?? "")}”`,
  web_fetch: (i) => `read ${String(i.url ?? "").replace(/^https?:\/\//, "")}`,
  memory_write: () => "saving to memory",
  memory_forget: () => "forgetting a note",
  routine_create: (i) => `scheduling “${String(i.name ?? "a routine")}”`,
  routine_list: () => "checking routines",
  routine_delete: () => "removing a routine",
  request_takeover: () => "handing you the screen",
  vault_list: () => "checking your vault",
  vault_fill: (i) =>
    `filling ${String(i.field ?? "a field").replace(/_/g, " ")} from your vault`,
  request_payment_approval: (i) =>
    `asking you to approve ${String(i.amount ?? "a payment")}`,
  request_login_approval: () => "asking you to approve a sign-in",
  request_secret: () => "asking you for a detail",
  delegate: () => "delegating",
}

async function converse(
  channel: Channel,
  chat: string,
  text: string,
  vault?: VaultMarker
) {
  const target = resolveTarget(channel.id)
  if (!target) {
    await sendAgentPicker(channel, chat)
    return
  }

  // Squad members are addressed with a leading @Name
  let agentId: string | undefined
  let body = text
  if (target.squadId) {
    const members = db
      .select({ agent: agents })
      .from(squadMembers)
      .innerJoin(agents, eq(squadMembers.agentId, agents.id))
      .where(eq(squadMembers.squadId, target.squadId))
      .all()
      .map((row) => row.agent as Agent)
    const mention = text.match(/^@(\S+)\s+([\s\S]+)$/)
    const named =
      mention && members.find((m) => m.name.toLowerCase() === mention[1].toLowerCase())
    if (named && mention) {
      agentId = named.id
      body = mention[2]
    }
  }

  // Keep using the current thread unless it was deleted
  let threadId = target.threadId
  if (
    !threadId ||
    !db.select({ id: threads.id }).from(threads).where(eq(threads.id, threadId)).get()
  ) {
    const [thread] = db
      .insert(threads)
      .values({ agentId: target.agentId ?? null, squadId: target.squadId ?? null })
      .returning({ id: threads.id })
      .all()
    threadId = thread.id
    setTarget(channel.id, { ...target, threadId })
  }

  const message = {
    id: nanoid(),
    role: "user",
    parts: [{ type: "text", text: body }],
    ...(vault && { metadata: { vault } }),
  } as XirynMessage

  let run
  try {
    run = await startTurn({ threadId, message, agentId, channel: channel.id })
  } catch (error) {
    const reason =
      error instanceof TurnError ? error.message : "Xiryn couldn't start the turn."
    await channel.send(
      chat,
      `⚠️ ${reason}${error instanceof TurnError && error.status === 409 ? " Send /stop to interrupt it." : ""}`
    )
    return
  }

  const typing = () => channel.typing(chat).catch(() => {})
  void typing()
  const typingTimer = setInterval(typing, 4_500)

  // A single status message lists what the agent is doing, edited as it goes
  const steps: string[] = []
  let statusMessage: Sent | null = null
  let lastEdit = 0
  let pendingEdit: ReturnType<typeof setTimeout> | null = null
  let responseId: string | null = null
  let streamError: string | null = null
  const started = Date.now()

  const renderSteps = (done = false) =>
    [
      `\`${done ? "✓" : "⋯"} ${steps.length} step${steps.length === 1 ? "" : "s"}${done ? ` · ${((Date.now() - started) / 1000).toFixed(1)}s` : ""}\``,
      ...steps.slice(-6).map((step) => `\`${step.slice(0, 90).replace(/`/g, "'")}\``),
    ].join("\n")

  const flush = async () => {
    pendingEdit = null
    lastEdit = Date.now()
    if (!statusMessage) {
      statusMessage = await channel
        .send(chat, renderSteps(), { silent: true })
        .catch(() => null)
    } else {
      await channel.edit(statusMessage, renderSteps()).catch(() => {})
    }
  }

  try {
    const reader = subscribe(run).getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.type === "start" && value.messageId) responseId = value.messageId
      if (value.type === "error") streamError = value.errorText
      if (value.type === "tool-input-available") {
        const label =
          TOOL_LABELS[value.toolName]?.((value.input ?? {}) as Record<string, unknown>) ??
          value.toolName
        steps.push(label)
        // Chat apps rate-limit edits; batch them
        if (!pendingEdit)
          pendingEdit = setTimeout(flush, Math.max(0, 1_500 - (Date.now() - lastEdit)))
      }
    }
  } finally {
    clearInterval(typingTimer)
    if (pendingEdit) clearTimeout(pendingEdit)
  }

  if (statusMessage) await channel.edit(statusMessage, renderSteps(true)).catch(() => {})

  // The finished reply, as saved to the thread
  const saved = responseId
    ? db
        .select()
        .from(messages)
        .where(and(eq(messages.id, responseId), eq(messages.threadId, threadId)))
        .get()
    : null
  const reply = saved
    ? ({ ...saved, metadata: saved.metadata ?? undefined } as unknown as XirynMessage)
    : null

  let sentSomething = false
  if (reply) {
    const memberNames = new Map(
      db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .all()
        .map((a) => [a.id, a.name])
    )
    let buffer = ""
    const flushText = async () => {
      if (buffer.trim()) {
        await channel.send(chat, buffer.trim())
        sentSomething = true
      }
      buffer = ""
    }
    for (const part of reply.parts) {
      if (part.type === "text") buffer += `${part.text}\n\n`
      if (part.type === "tool-delegate" && part.state === "output-available") {
        await flushText()
        await channel.send(
          chat,
          `↳ _handed to **${memberNames.get(part.output.agentId) ?? part.output.name}**_`
        )
      }
      // The hand-off notice itself was already sent by notifyTakeover
      if (
        (part.type === "tool-request_takeover" ||
          part.type === "tool-request_payment_approval" ||
          part.type === "tool-request_login_approval" ||
          part.type === "tool-request_secret") &&
        part.state === "output-available"
      ) {
        await flushText()
        sentSomething = true
      }
      if (part.type === "tool-screen_share" && part.state === "output-available") {
        const image = screenOf(part.output)
        if (image) {
          await flushText()
          await channel
            .photo(chat, { base64: image, mediaType: part.output.mediaType })
            .catch((error) => reportError(`${channel.id} photo`, error))
          sentSomething = true
        }
      }
    }
    await flushText()
  }

  if (streamError) {
    await channel.send(chat, `⚠️ ${streamError}`)
  } else if (!sentSomething) {
    await channel.send(
      chat,
      "_(no reply — the turn was stopped or produced only tool calls)_"
    )
  }
}

/* ──────────────────────────── hand-offs ───────────────────────── */

// Where the app is reachable on this computer, for links in notices
const APP_URL = (process.env.XIRYN_URL || "http://127.0.0.1:6796").replace(/\/+$/, "")

function threadLink(threadId: string, agentId: string, squadId: string | null) {
  return squadId
    ? `${APP_URL}/s/${squadId}/${threadId}`
    : `${APP_URL}/a/${agentId}/${threadId}`
}

// Markdown links take the text literally; keep brackets out of it
const plain = (text: string) => text.replace(/[[\]]/g, "")

// Sent when an agent pauses and hands its desktop to the person, for any
// turn, whether it started in the app or remotely. Their reply goes to the
// same thread, so the agent picks up with full context.
export async function notifyTakeover({
  agent,
  threadId,
  squadId,
  reason,
}: {
  agent: Agent
  threadId: string
  squadId: string | null
  reason: string
}) {
  const targets = paired()
  if (!targets.length) return
  const inApp = squadId
    ? `${APP_URL}/s/${squadId}/${threadId}`
    : `${APP_URL}/a/${agent.id}/${threadId}?takeover=1`

  for (const { channel, chat } of targets) {
    // Replies continue this exact thread
    setTarget(
      channel.id,
      squadId ? { squadId, threadId } : { agentId: agent.id, threadId }
    )
    const link = await getTakeoverLink(agent.id, {
      agent: agent.name,
      bot: channel.handle?.(),
    }).catch((error) => {
      reportError("phone link for the hand-off", error)
      return null
    })
    await channel.send(
      chat,
      [
        `🖐 **${agent.name} needs you**`,
        "",
        reason,
        "",
        link &&
          `📱 [Take over from this device](${link.url}) — opens the live desktop (link expires in ${link.minutes} min).`,
        `💻 At your computer: [open in Xiryn](${inApp}) and press **Take over**.`,
        "",
        `When you're done, reply here — just "done", or anything ${agent.name} should know — and it carries on.`,
      ]
        .filter((line): line is string => typeof line === "string")
        .join("\n")
    )
  }
}

function spoken(ms: number) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// Sent when a task started in the app finishes, so you hear about it on your
// phone while you're away from the computer. Short exchanges are skipped
// unless notices are set to "all". Replying continues the thread.
export async function notifyFinished({
  name,
  agentId,
  squadId,
  threadId,
  reply,
  error,
  durationMs,
  always = false,
  except,
}: {
  name: string
  agentId: string
  squadId: string | null
  threadId: string
  reply: string
  error: string | null
  durationMs: number
  // Routines report every run, however short, unless notices are off
  always?: boolean
  // The channel the turn came from already has the answer
  except?: string
}) {
  const mode = getSetting("telegram.notify")
  if (mode === "off" || (mode !== "all" && !always && durationMs < 60_000)) return
  const body = reply.length > 3000 ? `${reply.slice(0, 3000).trimEnd()}…` : reply
  for (const { channel, chat } of paired()) {
    if (channel.id === except) continue
    setTarget(channel.id, squadId ? { squadId, threadId } : { agentId, threadId })
    await channel.send(
      chat,
      [
        error
          ? `⚠️ **${name}** stopped after ${spoken(durationMs)}: ${error}`
          : `✅ **${name}** finished · ${spoken(durationMs)}`,
        body,
        `[Open in Xiryn](${threadLink(threadId, agentId, squadId)}) · reply here to continue`,
      ]
        .filter(Boolean)
        .join("\n\n")
    )
  }
}

/* ───────────────────────── payments & secrets ───────────────────── */

// Messages asking for a payment or sign-in decision, so a decision made
// elsewhere can take their buttons away
const approvalNotices = ((
  globalThis as {
    __xirynApprovalNotices?: Map<string, { channel: ChannelId; message: Sent }[]>
  }
).__xirynApprovalNotices ??= new Map())

const approvalIcon = (approval: Approval | null) =>
  approval?.kind === "login" ? "🔑" : "💳"

// An agent wants to pay: the person approves with a saved method, pays
// themselves, or declines, with one tap
export async function notifyPayment({
  agent,
  squadId,
  approval,
  methods,
}: {
  agent: Agent
  squadId: string | null
  approval: Approval
  methods: VaultItemView[]
}) {
  const inApp = threadLink(approval.threadId, agent.id, squadId)
  const text = [
    `💳 **${agent.name} wants to pay**`,
    "",
    `**${approval.amount}** to ${approval.merchant}`,
    approval.purpose,
    approval.host && `on \`${approval.host}\``,
    "",
    methods.length
      ? "Approve with a saved method, pay yourself, or decline. Nothing is paid until you choose."
      : `Nothing is saved to pay with yet. [Add a card or UPI ID in Xiryn](${inApp}) to let ${plain(agent.name)} pay, or pay yourself.`,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n")
  const buttons: Button[][] = [
    ...methods.slice(0, 6).map((method) => [
      {
        label: `✓ Pay with ${method.hint}`.slice(0, 64),
        data: `pay:${approval.id}:${method.id}`,
      },
    ]),
    [
      { label: "🖐 I'll pay myself", data: `pay:${approval.id}:takeover` },
      { label: "✕ Decline", data: `pay:${approval.id}:decline` },
    ],
  ]
  // What its screen showed, so the person can check it's the right checkout
  const screen = approvalScreen(approval.id)

  const sent: { channel: ChannelId; message: Sent }[] = []
  for (const { channel, chat } of paired()) {
    setTarget(
      channel.id,
      squadId
        ? { squadId, threadId: approval.threadId }
        : { agentId: agent.id, threadId: approval.threadId }
    )
    if (screen) {
      await channel
        .photo(
          chat,
          { base64: screen, mediaType: "image/jpeg" },
          `${agent.name}'s screen at checkout`
        )
        .catch((error) => reportError(`${channel.id} photo`, error))
    }
    const message = await channel.send(chat, text, { buttons })
    if (message) sent.push({ channel: channel.id, message })
  }
  if (sent.length) approvalNotices.set(approval.id, sent)
}

// An agent wants to sign in with a saved login: the person approves, signs
// in themselves, or declines
export async function notifyLogin({
  agent,
  squadId,
  approval,
  login,
}: {
  agent: Agent
  squadId: string | null
  approval: Approval
  login: VaultItemView
}) {
  const text = [
    `🔑 **${agent.name} wants to sign in**`,
    "",
    `to \`${approval.host}\` with ${login.hint}`,
    "",
    "Check the screenshot shows the sign-in page you expect. Nothing is typed until you approve.",
  ].join("\n")
  const buttons: Button[][] = [
    [{ label: "✓ Approve sign-in", data: `login:${approval.id}:approve` }],
    [
      { label: "🖐 I'll sign in myself", data: `login:${approval.id}:takeover` },
      { label: "✕ Decline", data: `login:${approval.id}:decline` },
    ],
  ]
  const screen = approvalScreen(approval.id)

  const sent: { channel: ChannelId; message: Sent }[] = []
  for (const { channel, chat } of paired()) {
    setTarget(
      channel.id,
      squadId
        ? { squadId, threadId: approval.threadId }
        : { agentId: agent.id, threadId: approval.threadId }
    )
    if (screen) {
      await channel
        .photo(
          chat,
          { base64: screen, mediaType: "image/jpeg" },
          `${agent.name}'s screen at sign-in`
        )
        .catch((error) => reportError(`${channel.id} photo`, error))
    }
    const message = await channel.send(chat, text, { buttons })
    if (message) sent.push({ channel: channel.id, message })
  }
  if (sent.length) approvalNotices.set(approval.id, sent)
}

export async function closeApprovalNotice(approvalId: string, outcome: string) {
  const notices = approvalNotices.get(approvalId)
  if (!notices) return
  approvalNotices.delete(approvalId)
  const icon = approvalIcon(getApproval(approvalId))
  for (const notice of notices) {
    await channels
      .get(notice.channel)
      ?.edit(notice.message, `${icon} **${outcome}** · decided in Xiryn`)
      .catch(() => {})
  }
}

// A payment or sign-in decided with a button
async function handleApproval(
  channel: Channel,
  press: { chat: string; message?: Sent },
  approvalId: string,
  choice: string
) {
  const approval = getApproval(approvalId)
  const login = approval?.kind === "login"
  let outcome: ReturnType<typeof answerPayment>
  try {
    outcome = login
      ? answerLogin(
          approvalId,
          choice === "takeover"
            ? "takeover"
            : choice === "decline"
              ? "decline"
              : "approve"
        )
      : answerPayment(
          approvalId,
          choice === "takeover"
            ? "takeover"
            : choice === "decline"
              ? "decline"
              : { itemId: choice }
        )
  } catch (error) {
    return (error instanceof Error ? error.message : String(error)).slice(0, 190)
  }
  const decided =
    outcome.marker.action === "approved"
      ? `✅ Approved · ${outcome.marker.summary}`
      : outcome.marker.action === "declined"
        ? `✕ Declined · ${outcome.marker.summary}`
        : `🖐 You're ${login ? "signing in" : "paying"} · ${outcome.marker.summary}`
  const icon = approvalIcon(approval)

  // This message, and the same request on other channels, lose their buttons
  const others = approvalNotices.get(approvalId) ?? []
  approvalNotices.delete(approvalId)
  for (const notice of others) {
    if (
      press.message &&
      notice.channel === channel.id &&
      notice.message.id === press.message.id
    )
      continue
    await channels
      .get(notice.channel)
      ?.edit(notice.message, `${icon} **${decided}** · decided on ${channel.name}`)
      .catch(() => {})
  }
  if (press.message)
    await channel.edit(press.message, `${icon} **${decided}**`).catch(() => {})

  const owner = db
    .select({ agentId: threads.agentId, squadId: threads.squadId })
    .from(threads)
    .where(eq(threads.id, approval!.threadId))
    .get()
  const agentId = approval!.agentId ?? owner?.agentId
  if (!owner || !agentId) return decided
  setTarget(
    channel.id,
    owner.squadId
      ? { squadId: owner.squadId, threadId: approval!.threadId }
      : { agentId, threadId: approval!.threadId }
  )
  if (outcome.text) {
    void converse(channel, press.chat, outcome.text, outcome.marker).catch((error) =>
      reportError(`${channel.id} turn`, error)
    )
    return decided
  }
  // Doing it themselves: hand over the desktop with the page on it
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get()
  if (agent) {
    await notifyTakeover({
      agent: agent as Agent,
      threadId: approval!.threadId,
      squadId: owner.squadId,
      reason: login
        ? `You chose to sign in to ${approval!.host} yourself. The sign-in page is open on ${agent.name}'s desktop.`
        : `You chose to pay ${approval!.amount} to ${approval!.merchant} yourself. The checkout is open on ${agent.name}'s desktop.`,
    })
  }
  return decided
}

const SECRET_LABEL: Record<SecretRequest["kind"], string> = {
  login: "a login",
  card: "card details",
  upi: "a UPI ID",
  identity: "some personal details",
  code: "a code",
}

// An agent needs something only the person has. Codes can be replied with
// in the chat (they never reach the agent); anything else is entered in
// the app
export async function notifySecret({
  agent,
  threadId,
  squadId,
  request,
}: {
  agent: Agent
  threadId: string
  squadId: string | null
  request: SecretRequest
}) {
  const targets = paired()
  if (!targets.length) return
  const inApp = threadLink(threadId, agent.id, squadId)
  if (request.kind === "code") {
    shared.awaitingCode = {
      threadId,
      agentId: agent.id,
      squadId,
      expires: Date.now() + 10 * 60_000,
    }
  }
  const text = (
    request.kind === "code"
      ? [
          `🔐 **${agent.name} needs a code**`,
          "",
          request.reason,
          "",
          `Reply here with just the code (or \`/code 123456\`). It goes straight into your vault, is used once and deleted, and ${agent.name} never sees it. /cancel if there's no code.`,
        ]
      : [
          `🔐 **${agent.name} needs ${SECRET_LABEL[request.kind]}${request.site ? ` for ${request.site}` : ""}**`,
          "",
          request.reason,
          "",
          `For your safety, enter it in Xiryn on your computer, not in this chat: [open the thread](${inApp}). It goes into your encrypted vault, and ${plain(agent.name)} only ever sees a masked hint.`,
        ]
  ).join("\n")
  for (const { channel, chat } of targets) {
    setTarget(
      channel.id,
      squadId ? { squadId, threadId } : { agentId: agent.id, threadId }
    )
    await channel.send(chat, text)
  }
}
