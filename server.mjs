// Xiryn's server: Next.js, plus the one thing its route handlers can't do,
// a websocket for the live desktop view (lib/vnc.ts). Everything else,
// including dev mode's hot reload, goes to Next as before.
//
//   node server.mjs [--dev] [--hostname 127.0.0.1] [--port 6796]

import { EventEmitter } from "node:events"
import { createServer } from "node:http"

const flag = (name, fallback) => {
  const at = process.argv.indexOf(name)
  return at > -1 ? process.argv[at + 1] : fallback
}
const dev = process.argv.includes("--dev")
const hostname = flag("--hostname", "127.0.0.1")
const port = Number(flag("--port", "6796"))
if (!dev) process.env.NODE_ENV ??= "production"

const { default: next } = await import("next")
// Next attaches its own upgrade listener to the first server it sees a
// request on; a stand-in keeps it off the real one, which routes below
const app = next({ dev, hostname, port, httpServer: new EventEmitter() })
await app.prepare()
const handle = app.getRequestHandler()
// The router's upgrade handler, the one Next itself would attach: it serves
// dev mode's hot reload (getUpgradeHandler() returns an inner one that doesn't)
const upgrade = (req, socket, head) =>
  (app.upgradeHandler ?? app.getUpgradeHandler())(req, socket, head)

const server = createServer((req, res) => handle(req, res))
server.on("upgrade", (req, socket, head) => {
  if (/^\/api\/workstations\/[^/?]+\/vnc(\?|$)/.test(req.url ?? "")) {
    const vnc = globalThis.__xirynVnc
    if (!vnc) return socket.destroy()
    return void vnc(req, socket, head).catch(() => socket.destroy())
  }
  return void upgrade(req, socket, head)
})
server.listen(port, hostname, () => {
  console.log(`  ▲ Xiryn ${dev ? "(dev) " : ""}on http://${hostname}:${port}`)
})
