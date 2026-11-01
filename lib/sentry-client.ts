import { DATA_COLLECTION, scrubBreadcrumb, scrubEvent } from "@/lib/sentry-scrub"

// The browser half of error reporting. The root layout writes the settings
// into the page only when SENTRY_DSN is set (so one published image works
// either way); without them the SDK is never loaded.

type ClientConfig = {
  dsn: string
  environment: string
  release?: string
  tracesSampleRate: number
}

let started: Promise<typeof import("@sentry/nextjs") | null> | null = null

function config(): ClientConfig | null {
  const element = document.getElementById("xiryn-sentry")
  if (!element?.textContent) return null
  try {
    return JSON.parse(element.textContent) as ClientConfig
  } catch {
    return null
  }
}

export function startClientReporting() {
  started ??= (async () => {
    const options = config()
    if (!options) return null
    const Sentry = await import("@sentry/nextjs")
    Sentry.init({
      ...options,
      dataCollection: DATA_COLLECTION,
      // Reports go through Xiryn (app/api/monitoring), not straight to the DSN
      tunnel: "/api/monitoring",
      beforeSend: scrubEvent,
      beforeBreadcrumb: scrubBreadcrumb,
    })
    return Sentry
  })()
  return started
}

export function reportClientError(error: unknown) {
  void startClientReporting().then((Sentry) => Sentry?.captureException(error))
}
