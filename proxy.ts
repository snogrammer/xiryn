import { NextResponse, type NextRequest } from "next/server"

import { ACCESS_COOKIE, checkKey } from "@/lib/access"

// Xiryn has no accounts: anyone who can drive the server can drive your
// agents. Two layers keep strangers out:
//
// 1. Host and Origin must be loopback (or listed in XIRYN_ALLOWED_HOSTS —
//    comma separated — if you deliberately expose it). This defeats
//    DNS-rebinding and cross-origin attacks from web pages you visit.
// 2. Every request must carry the per-install access key (lib/access.ts) in a
//    cookie. Headers are easy to forge for anything that isn't a browser, such
//    as an agent's own workstation reaching the host, so this is the actual
//    access control. A browser gets the cookie by opening the sign-in link
//    Xiryn prints when it starts (or `npm run link`).

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

  // Opening the sign-in link: remember the key, then drop it from the
  // address so it stays out of history and Referer headers
  const key = request.nextUrl.searchParams.get("key")
  if (key !== null && checkKey(key)) {
    const target = request.nextUrl.clone()
    target.searchParams.delete("key")
    const response = NextResponse.redirect(target, 303)
    response.cookies.set(ACCESS_COOKIE, key, {
      httpOnly: true,
      // Lax so links from Telegram open signed in; cross-site writes are
      // already refused by the Origin check above
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      path: "/",
      maxAge: 400 * 24 * 60 * 60,
    })
    return response
  }

  if (!checkKey(request.cookies.get(ACCESS_COOKIE)?.value)) {
    if (request.headers.get("accept")?.includes("text/html")) {
      return new NextResponse(SIGN_IN_PAGE, {
        status: 401,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    }
    return new NextResponse("Sign in with the link Xiryn printed when it started.", {
      status: 401,
    })
  }

  return NextResponse.next()
}

const SIGN_IN_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Xiryn</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 15vh auto; padding: 0 1.5rem; }
  h1 { font-size: 1.25rem; font-weight: 600; }
  code { font-size: 0.9em; background: color-mix(in oklab, currentColor 10%, transparent); padding: 0.1em 0.35em; border-radius: 4px; }
  li { margin: 0.35rem 0; }
</style>
<h1>Open your sign-in link</h1>
<p>Xiryn only answers browsers that were given its access key. When it starts, it prints a link like <code>http://127.0.0.1:6796/?key=…</code>. Open that link once in this browser. You can find it:</p>
<ul>
  <li>in the terminal where you ran <code>npm run dev</code>,</li>
  <li>by running <code>npm run link</code> in the Xiryn folder,</li>
  <li>in <code>data/xiryn.log</code> if Xiryn runs in the background,</li>
  <li>or with <code>docker logs xiryn</code> if it runs in Docker.</li>
</ul>
</html>
`

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
}
