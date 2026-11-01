import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"

import { eq } from "drizzle-orm"
import { WebSocketServer } from "ws"

import { db } from "@/db"
import { agents } from "@/db/schema"
import { ACCESS_COOKIE, checkKey } from "@/lib/access"
import { dockerRaw, dockerSpawn } from "@/lib/docker"
import { hostAllowed, originMatches } from "@/lib/hosts"

// The live desktop view, through Xiryn's own address. The browser opens a
// websocket to /api/workstations/<agent>/vnc on the page's origin; Xiryn
// checks it like any other request (Host, Origin, access key) and carries
// the VNC bytes to the workstation through `docker exec`. So the view works
// from any device that can open Xiryn, also when Xiryn itself runs in a
// container, and nothing needs a published port or a shared network. The
// desktop's own VNC password still applies, end to end.
//
// Next's route handlers can't take a websocket, so server.mjs hands these
// upgrade requests to handleVncUpgrade, registered from instrumentation.ts.

const PATH = /^\/api\/workstations\/([A-Za-z0-9_-]{1,64})\/vnc$/

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })

function refuse(socket: Duplex, status: number, reason: string) {
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  )
}

function cookie(header: string | undefined, name: string) {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=")
    if (key === name) return decodeURIComponent(value.join("="))
  }
  return null
}

export async function handleVncUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
) {
  const url = new URL(req.url ?? "/", "http://localhost")
  const agentId = url.pathname.match(PATH)?.[1]
  if (!agentId) return refuse(socket, 404, "Not Found")

  // The same checks proxy.ts makes. A browser always sends Origin on a
  // websocket, so it's required here.
  const host = req.headers.host ?? null
  if (!hostAllowed(host)) return refuse(socket, 403, "Forbidden")
  const origin = req.headers.origin
  if (!origin || !originMatches(origin, host)) return refuse(socket, 403, "Forbidden")
  if (!checkKey(cookie(req.headers.cookie, ACCESS_COOKIE))) {
    return refuse(socket, 401, "Unauthorized")
  }

  if (!db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).get()) {
    return refuse(socket, 404, "Not Found")
  }
  const container = `xiryn-ws-${agentId}`
  const running = await dockerRaw(
    ["inspect", "--type", "container", "--format", "{{.State.Running}}", container],
    { timeoutMs: 10_000, maxBytes: 64 }
  ).catch(() => null)
  if (running?.stdout.toString().trim() !== "true") {
    return refuse(socket, 503, "Service Unavailable")
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    void bridge(ws, container)
  })
}

// Bytes both ways between the browser and the workstation's VNC server
async function bridge(ws: import("ws").WebSocket, container: string) {
  const child = await dockerSpawn([
    "exec",
    "--interactive",
    container,
    "bash",
    "-c",
    // bash's /dev/tcp: no extra tools needed in the workstation. When either
    // side ends (the view closed, or the VNC server hung up) both stop, so
    // nothing is left holding the connection. (A background job's stdin is
    // /dev/null in a script, hence the copy of it on fd 4.)
    "exec 3<>/dev/tcp/127.0.0.1/5900 4<&0 || exit 1; cat <&3 & r=$!; cat <&4 >&3 & w=$!; wait -n; kill $r $w 2>/dev/null",
  ])
  const close = () => {
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close()
    child.kill()
  }
  child.stdout?.on("data", (chunk: Buffer) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk)
  })
  child.on("exit", close)
  child.on("error", close)
  child.stdin?.on("error", close)
  ws.on("message", (data: Buffer) => child.stdin?.write(data))
  ws.on("close", close)
  ws.on("error", close)
}
