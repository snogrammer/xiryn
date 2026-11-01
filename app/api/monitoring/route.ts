import { getSetting } from "@/lib/config"

// The browser's error reports come here (Sentry's `tunnel` option) and are
// forwarded to the configured DSN, so the page only ever talks to Xiryn.
// Only the configured DSN is accepted: this can't relay to anywhere else.
export async function POST(request: Request) {
  const configured = getSetting("sentry.dsn")
  if (!configured) return new Response(null, { status: 404 })

  const body = await request.text()
  if (body.length > 1_000_000) return new Response(null, { status: 413 })
  let dsn: URL
  try {
    dsn = new URL((JSON.parse(body.split("\n")[0]) as { dsn?: string }).dsn ?? "")
  } catch {
    return new Response(null, { status: 400 })
  }
  const target = new URL(configured)
  if (dsn.host !== target.host || dsn.pathname !== target.pathname) {
    return new Response(null, { status: 403 })
  }

  const project = target.pathname.replace(/^\//, "")
  const response = await fetch(
    `${target.protocol}//${target.host}/api/${project}/envelope/`,
    {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body,
      signal: AbortSignal.timeout(10_000),
    }
  ).catch(() => null)
  return new Response(null, { status: response?.status ?? 502 })
}
