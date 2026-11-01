import type { DataCollection } from "@sentry/core"
import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs"

// What may leave the machine in an error report, for the server and the
// browser alike. Sentry (or Bugsink) gets the error's type, message and
// stack, plus ids. Never prompts, messages, tool output, vault values,
// keys, cookies or request bodies.

const SECRET_KEY = /key|token|secret|passw|auth|cookie|session|vnc|dsn|code|card|cvv|otp/i

// Strings that look like credentials, wherever they turn up
const SECRET_VALUE = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic and friends
  /\bxai-[A-Za-z0-9_-]{16,}/g,
  /\bgsk_[A-Za-z0-9]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google
  /\bfc-[A-Za-z0-9]{16,}/g, // Firecrawl
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, // Telegram bot tokens
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}/g, // long base64-ish blobs (keys, images)
]

// Collect nothing beyond the error itself. The SDK's defaults would record
// headers, cookies, bodies, query strings, local variables and the AI SDK's
// prompts and outputs.
export const DATA_COLLECTION: DataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
}

export function scrubText(text: string) {
  let out = text
  for (const pattern of SECRET_VALUE) out = out.replace(pattern, "[redacted]")
  return out.length > 500 ? `${out.slice(0, 500)}…` : out
}

function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubText(value)
  if (depth > 4 || value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrubValue(v, depth + 1))
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) =>
      SECRET_KEY.test(key) ? [key, "[redacted]"] : [key, scrubValue(v, depth + 1)]
    )
  )
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  // No request bodies, cookies, headers or query strings
  if (event.request) {
    event.request = {
      method: event.request.method,
      url: event.request.url?.split("?")[0],
    }
  }
  delete event.user
  if (event.message) event.message = scrubText(event.message)
  for (const exception of event.exception?.values ?? []) {
    // A model provider's error message can quote the request it rejected,
    // i.e. the prompt; for AI SDK errors only the type is kept
    if (exception.type?.startsWith("AI_")) {
      exception.value = "[provider error message removed]"
    } else if (exception.value) exception.value = scrubText(exception.value)
    for (const frame of exception.stacktrace?.frames ?? []) delete frame.vars
  }
  if (event.extra) event.extra = scrubValue(event.extra) as typeof event.extra
  if (event.contexts) event.contexts = scrubValue(event.contexts) as typeof event.contexts
  if (event.tags) event.tags = scrubValue(event.tags) as typeof event.tags
  return event
}

// Console output and fetch/XHR bodies can hold anything; navigation and
// click breadcrumbs (without data) are kept
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === "console") return null
  const { data, ...rest } = breadcrumb
  const url = typeof data?.url === "string" ? data.url.split("?")[0] : undefined
  return {
    ...rest,
    message: rest.message ? scrubText(rest.message) : undefined,
    ...(url && { data: { url, method: data?.method, status_code: data?.status_code } }),
  }
}
