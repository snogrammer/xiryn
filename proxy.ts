import { NextResponse, type NextRequest } from "next/server"

// Xiryn has no accounts: anyone who can reach the server can drive your
// agents. So it only answers on loopback, and refuses requests whose Host or
// Origin point anywhere else (which also defeats DNS-rebinding attacks from
// web pages you visit). Add hostnames to XIRYN_ALLOWED_HOSTS — comma separated —
// if you deliberately expose it, e.g. behind your own authenticating proxy.

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

export function proxy(request: NextRequest) {
  const allowed = allowedHosts()
  const host = request.headers.get("host")
  if (!host || !allowed.has(hostname(host))) {
    return new NextResponse("Xiryn only answers on localhost. See XIRYN_ALLOWED_HOSTS.", {
      status: 403,
    })
  }

  // A page on another port of this machine (another dev server, a stray
  // local app) is a different origin too, so Origin has to match Host
  // exactly, port included, not just land on the allow-list.
  const origin = request.headers.get("origin")
  if (origin && request.method !== "GET" && request.method !== "HEAD") {
    let originHost: string | null = null
    try {
      originHost = new URL(origin).host.toLowerCase()
    } catch {}
    if (
      !originHost ||
      !allowed.has(hostname(originHost)) ||
      originHost !== host.toLowerCase()
    ) {
      return new NextResponse("Cross-origin request refused.", { status: 403 })
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
}
