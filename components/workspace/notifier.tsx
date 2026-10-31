"use client"

import * as React from "react"
import { usePathname, useRouter } from "next/navigation"
import { Toast as ToastPrimitive } from "@base-ui/react/toast"
import { ArrowRightIcon, HandIcon, SendIcon, XIcon } from "lucide-react"

import { Glyph } from "@/components/glyph"
import { Button } from "@/components/ui/button"
import {
  createToastManager,
  Toast,
  ToastPortal,
  ToastViewport,
} from "@/components/ui/toast"
import type { XirynEvent } from "@/lib/events"
import { cn } from "@/lib/utils"

// Lets you know when an agent finishes, fails or needs you: a chime, a
// desktop notification when Xiryn isn't the window you're looking at, and a
// toast when you're elsewhere in the app. Turned on or off per browser.

const PREFERENCE = "xiryn.notifications"

type Notifications = {
  enabled: boolean
  permission: NotificationPermission | "unsupported"
  toggle: () => void
  // Hear every event as it arrives (an open thread follows its turns)
  listen: (listener: (event: XirynEvent) => void) => () => void
  // Re-reads the page's server data, at most once per burst of changes
  refresh: () => void
}

const NotificationsContext = React.createContext<Notifications>({
  enabled: false,
  permission: "unsupported",
  toggle: () => {},
  listen: () => () => {},
  refresh: () => {},
})

export const useNotifications = () => React.useContext(NotificationsContext)

function readPreference() {
  try {
    return localStorage.getItem(PREFERENCE) !== "off"
  } catch {
    return true
  }
}

function writePreference(on: boolean) {
  try {
    localStorage.setItem(PREFERENCE, on ? "on" : "off")
  } catch {}
}

// A short chime, synthesized so there's no audio file to ship
let audio: AudioContext | null = null

function unlockAudio() {
  try {
    audio ??= new AudioContext()
    if (audio.state === "suspended") void audio.resume()
  } catch {}
}

function chime(kind: "done" | "attention" | "error") {
  try {
    unlockAudio()
    if (!audio) return
    const notes =
      kind === "attention"
        ? [784, 1047, 784, 1047]
        : kind === "error"
          ? [523, 392]
          : [659, 988]
    const start = audio.currentTime + 0.02
    notes.forEach((frequency, index) => {
      const oscillator = audio!.createOscillator()
      const gain = audio!.createGain()
      oscillator.type = "sine"
      oscillator.frequency.value = frequency
      const at = start + index * 0.13
      gain.gain.setValueAtTime(0.0001, at)
      gain.gain.exponentialRampToValueAtTime(0.2, at + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.6)
      oscillator.connect(gain).connect(audio!.destination)
      oscillator.start(at)
      oscillator.stop(at + 0.65)
    })
  } catch {}
}

function took(ms: number) {
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`
}

type Kind = "done" | "attention" | "error"

function describe(event: Exclude<XirynEvent, { type: "turn-started" }>) {
  if (event.type !== "turn-finished") {
    const status =
      event.type === "payment"
        ? "wants to pay"
        : event.type === "secret"
          ? "needs a detail"
          : "needs you"
    return {
      kind: "attention" as Kind,
      status,
      title: `${event.name} ${status}`,
      body: event.reason,
    }
  }
  return event.ok
    ? {
        kind: "done" as Kind,
        status: `finished · ${took(event.durationMs)}`,
        title: `${event.name} finished · ${took(event.durationMs)}`,
        body: event.preview || "The reply is ready.",
      }
    : {
        kind: "error" as Kind,
        status: `stopped · ${took(event.durationMs)}`,
        title: `${event.name} stopped`,
        body: event.error ?? "Something went wrong.",
      }
}

/* ──────────────────────── notification card ──────────────────────── */

// Cards get their own stack, separate from ordinary toasts
const alerts = createToastManager()

type CardData = {
  kind: Kind
  status: string
  name: string
  glyph: string
  via: "web" | "telegram"
  href: string
  takeoverHref: string | null
  timeout: number
}

const TONE: Record<Kind, { edge: string; text: string; bar: string }> = {
  done: { edge: "bg-rigel", text: "text-rigel", bar: "bg-rigel/50" },
  attention: { edge: "bg-betelgeuse", text: "text-betelgeuse", bar: "bg-betelgeuse/50" },
  error: { edge: "bg-destructive", text: "text-destructive", bar: "bg-destructive/50" },
}

function Cards({ onOpen }: { onOpen: (href: string) => void }) {
  const { toasts } = ToastPrimitive.useToastManager()
  return toasts.map((item) => {
    const data = item.data as CardData | undefined
    if (!data) return null
    const tone = TONE[data.kind]
    return (
      <Toast
        key={item.id}
        toast={item}
        className="group/card overflow-hidden rounded-xl border-border/80 bg-popover/95 backdrop-blur-xl"
      >
        <span className={cn("absolute inset-y-0 left-0 w-[3px]", tone.edge)} />
        <div className="flex flex-col gap-2.5 py-3 pr-3 pl-4">
          <div className="flex items-center gap-2.5">
            <Glyph seed={data.glyph} className="size-7 shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col leading-tight">
              <ToastPrimitive.Title className="truncate text-[13px] font-semibold">
                {data.name}
              </ToastPrimitive.Title>
              <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground">
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    tone.edge,
                    data.kind === "attention" && "animate-pulse-dot text-betelgeuse"
                  )}
                />
                <span className={tone.text}>{data.status}</span>
                {data.via === "telegram" && (
                  <>
                    <span className="text-faint">·</span>
                    <SendIcon className="size-2.5" />
                    via telegram
                  </>
                )}
              </span>
            </div>
            <ToastPrimitive.Close
              aria-label="Dismiss"
              className="grid size-6 shrink-0 place-items-center self-start rounded-md text-faint transition-colors hover:bg-accent hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </ToastPrimitive.Close>
          </div>
          <ToastPrimitive.Description className="line-clamp-3 text-[12.5px] leading-relaxed text-foreground/80" />
          <div className="flex items-center justify-between gap-2 border-t border-dashed pt-2.5">
            <span className="font-mono text-[10px] text-faint">
              {data.kind === "attention" ? "// waiting for you" : "// xiryn"}
            </span>
            <div className="flex items-center gap-1.5">
              {data.takeoverHref && (
                <Button
                  size="xs"
                  onClick={() => {
                    onOpen(data.takeoverHref!)
                    alerts.close(item.id)
                  }}
                >
                  <HandIcon data-icon="inline-start" />
                  Take over
                </Button>
              )}
              <Button
                size="xs"
                variant={data.takeoverHref ? "ghost" : "secondary"}
                onClick={() => {
                  onOpen(data.href)
                  alerts.close(item.id)
                }}
              >
                Open thread
                <ArrowRightIcon data-icon="inline-end" />
              </Button>
            </div>
          </div>
        </div>
        {data.timeout > 0 && (
          <span
            style={{ "--countdown": `${data.timeout}ms` } as React.CSSProperties}
            className={cn(
              "absolute bottom-0 left-0 h-[2px] w-full origin-left animate-countdown group-hover/card:[animation-play-state:paused]",
              tone.bar
            )}
          />
        )}
      </Toast>
    )
  })
}

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [enabled, setEnabled] = React.useState(true)
  const [permission, setPermission] =
    React.useState<Notifications["permission"]>("unsupported")

  // What's on screen right now, read when an event arrives
  const here = React.useRef({ pathname, enabled })
  const listeners = React.useRef(new Set<(event: XirynEvent) => void>())
  const listen = React.useCallback((listener: (event: XirynEvent) => void) => {
    listeners.current.add(listener)
    return () => {
      listeners.current.delete(listener)
    }
  }, [])
  React.useEffect(() => {
    here.current = { pathname, enabled }
  }, [pathname, enabled])

  // One turn sends several events and the thread asks for its own refresh
  // too; each refresh re-renders the layout and the page on the server. So
  // they're gathered into one, and a tab nobody is looking at waits until
  // it's looked at.
  const pending = React.useRef<{ timer: number | null; stale: boolean }>({
    timer: null,
    stale: false,
  })
  const refresh = React.useCallback(() => {
    if (document.visibilityState !== "visible") {
      pending.current.stale = true
      return
    }
    if (pending.current.timer !== null) window.clearTimeout(pending.current.timer)
    pending.current.timer = window.setTimeout(() => {
      pending.current.timer = null
      router.refresh()
    }, 500)
  }, [router])
  React.useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !pending.current.stale) return
      pending.current.stale = false
      refresh()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [refresh])

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEnabled(readPreference())
    if ("Notification" in window) setPermission(Notification.permission)
    // Browsers only allow sound after the page has been interacted with
    const unlock = () => unlockAudio()
    window.addEventListener("pointerdown", unlock, { once: true })
    window.addEventListener("keydown", unlock, { once: true })
    return () => {
      window.removeEventListener("pointerdown", unlock)
      window.removeEventListener("keydown", unlock)
    }
  }, [])

  React.useEffect(() => {
    const source = new EventSource("/api/events")
    source.onmessage = (message) => {
      let event: XirynEvent
      try {
        event = JSON.parse(message.data) as XirynEvent
      } catch {
        return
      }
      refresh()
      for (const listener of listeners.current) listener(event)
      // A turn starting is news only for the page showing it
      if (event.type === "turn-started" || !here.current.enabled) return

      const { kind, status, title, body } = describe(event)
      const looking = document.visibilityState === "visible" && document.hasFocus()
      const onThread = here.current.pathname === event.href.split("?")[0]
      // The thread you're reading already shows its own news
      if (looking && onThread) return

      chime(kind)
      if (looking) {
        const timeout = kind === "attention" ? 0 : 9000
        const data: CardData = {
          kind,
          status,
          name: event.name,
          glyph: event.glyph,
          via: event.via,
          href: event.href,
          takeoverHref:
            event.type === "takeover" && event.href.startsWith("/a/")
              ? `${event.href}?takeover=1`
              : null,
          timeout,
        }
        alerts.add({ title: event.name, description: body, timeout, data })
        return
      }
      if ("Notification" in window && Notification.permission === "granted") {
        const notification = new Notification(title, {
          body: body.slice(0, 300),
          tag: event.threadId,
          icon: "/icon.svg",
          silent: true,
          requireInteraction: kind === "attention",
        })
        notification.onclick = () => {
          window.focus()
          router.push(event.href)
          notification.close()
        }
      }
    }
    return () => source.close()
  }, [router, refresh])

  const toggle = React.useCallback(() => {
    const askable = "Notification" in window && Notification.permission === "default"
    // On, but the browser hasn't been asked yet: ask rather than mute
    const next = enabled && askable ? true : !enabled
    setEnabled(next)
    writePreference(next)
    if (!next) return
    unlockAudio()
    chime("done")
    if (askable) void Notification.requestPermission().then(setPermission)
  }, [enabled])

  const value = React.useMemo(
    () => ({ enabled, permission, toggle, listen, refresh }),
    [enabled, permission, toggle, listen, refresh]
  )
  return (
    <NotificationsContext value={value}>
      {children}
      <ToastPrimitive.Provider toastManager={alerts} limit={4}>
        <ToastPortal>
          <ToastViewport className="bottom-10 sm:right-4">
            <Cards onOpen={(href) => router.push(href)} />
          </ToastViewport>
        </ToastPortal>
      </ToastPrimitive.Provider>
    </NotificationsContext>
  )
}
