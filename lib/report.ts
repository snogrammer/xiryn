import { getSetting } from "@/lib/config"
import { safeError } from "@/lib/log"

// Error reporting is off unless SENTRY_DSN is set (Sentry, or a self-hosted
// Bugsink, which speaks the same protocol). Without it nothing is loaded and
// nothing leaves the machine.

export function sentryEnabled() {
  return !!getSetting("sentry.dsn")
}

export function sentryOptions() {
  const dsn = getSetting("sentry.dsn")
  if (!dsn) return null
  const rate = Number(getSetting("sentry.tracesSampleRate") ?? "0")
  return {
    dsn,
    environment: getSetting("sentry.environment") ?? "production",
    release:
      getSetting("sentry.release") ??
      (process.env.XIRYN_IMAGE_SHA || process.env.npm_package_version || undefined),
    tracesSampleRate: Number.isFinite(rate) ? Math.min(Math.max(rate, 0), 1) : 0,
  }
}

// Logs a failure from background work (routines, Telegram, workstations,
// turns) and reports it when reporting is on. `context` takes ids, never
// content.
export function reportError(
  area: string,
  error: unknown,
  context: Record<string, string | number | null | undefined> = {}
) {
  console.error(`[xiryn] ${area}:`, safeError(error))
  if (!sentryEnabled()) return
  void import("@sentry/nextjs")
    .then((Sentry) => {
      Sentry.captureException(error, { tags: { area }, extra: context })
    })
    .catch(() => {})
}
