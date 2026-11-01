// The Host and Origin rules shared by proxy.ts and the desktop websocket
// (lib/vnc.ts): Xiryn answers on loopback, plus any hostnames listed in
// XIRYN_ALLOWED_HOSTS (comma separated) when it's deliberately exposed.

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]", "::1"]

function allowedHosts() {
  const extra = (process.env.XIRYN_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
  return new Set([...LOOPBACK, ...extra])
}

function hostname(value: string) {
  // Strip the port, keeping IPv6 brackets intact
  const match = value.toLowerCase().match(/^(\[[^\]]+\]|[^:]+)(?::\d+)?$/)
  return match?.[1] ?? value.toLowerCase()
}

export function hostAllowed(host: string | null): host is string {
  return !!host && allowedHosts().has(hostname(host))
}

// A page on another port of this machine (another dev server, a stray local
// app) is a different origin too, so Origin has to match Host exactly, port
// included, not just land on the allow-list
export function originMatches(origin: string, host: string) {
  let originHost: string | null = null
  try {
    originHost = new URL(origin).host.toLowerCase()
  } catch {}
  return (
    !!originHost &&
    allowedHosts().has(hostname(originHost)) &&
    originHost === host.toLowerCase()
  )
}
