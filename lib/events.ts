import { notifyDesktop } from "@/lib/desktop-notify"

// Things worth telling the person about, wherever they are in the app. The
// browser follows them over /api/events and turns them into a sound, a
// desktop notification and a notification card.

type Common = {
  threadId: string
  href: string
  // Who answered (the last agent to hold the turn) and their glyph
  name: string
  glyph: string
  // Where the message that started the turn came from
  via: "web" | "telegram" | "discord"
}

export type XirynEvent =
  | (Common & {
      // A turn began (from the app, Telegram or an answered request): a page
      // showing the thread follows it live
      type: "turn-started"
    })
  | (Common & {
      type: "turn-finished"
      preview: string
      ok: boolean
      // The model the turn started on, as provider/model
      model?: string
      error?: string
      durationMs: number
    })
  | (Common & {
      // The agent handed over its screen, wants a payment or a sign-in
      // approved, or needs a detail only the person has
      type: "takeover" | "payment" | "login" | "secret"
      reason: string
    })

type Listener = (event: XirynEvent) => void

const globalForEvents = globalThis as unknown as { __xirynEvents?: Set<Listener> }
const listeners = (globalForEvents.__xirynEvents ??= new Set())

export function emit(event: XirynEvent) {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (error) {
      console.error("[xiryn] event listener failed:", error)
    }
  }
  // Every open Xiryn tab listens; with none open, the operating system
  // shows it instead (Telegram turns are already on the person's phone)
  if (listeners.size === 0 && event.via === "web") desktopNotice(event)
}

function desktopNotice(event: XirynEvent) {
  switch (event.type) {
    case "turn-finished":
      return notifyDesktop(
        event.ok ? `${event.name} finished` : `${event.name} stopped`,
        event.ok ? event.preview || "Done." : (event.error ?? "Something went wrong.")
      )
    case "takeover":
      return notifyDesktop(`${event.name} needs you at the screen`, event.reason)
    case "payment":
      return notifyDesktop(`${event.name} wants to make a payment`, event.reason)
    case "login":
      return notifyDesktop(`${event.name} wants to sign in`, event.reason)
    case "secret":
      return notifyDesktop(`${event.name} needs a detail from you`, event.reason)
  }
}

export function subscribe(listener: Listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// A reply's Markdown as one clean line of text for a notification
export function previewText(markdown: string, max = 240) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    // A table's header row and the rule under it
    .replace(/^[ \t]*\|.*\|[ \t]*\r?\n[ \t]*\|?[ \t]*:?-{3,}.*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(
      /^[ \t]*\|(.*)\|[ \t]*$/gm,
      (_, row: string) =>
        `${row
          .split("|")
          .map((cell) => cell.trim())
          .filter(Boolean)
          .join(" · ")};`
    )
    .replace(/\s+/g, " ")
    .trim()
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}
