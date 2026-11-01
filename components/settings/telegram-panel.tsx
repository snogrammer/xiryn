"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LinkIcon,
  RefreshCwIcon,
  SendIcon,
  UnlinkIcon,
} from "lucide-react"

import {
  getTelegramPanel,
  newPairingCode,
  saveTelegramToken,
  unpair,
  type TelegramPanel,
} from "@/actions/telegram"
import { Confirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { cn } from "@/lib/utils"

export function Step({
  n,
  title,
  done,
  active,
  children,
}: {
  n: number
  title: string
  done: boolean
  active: boolean
  children: React.ReactNode
}) {
  return (
    <li className="group/step relative flex gap-4 pb-7 last:pb-0">
      <span className="absolute top-7 bottom-0 left-[13px] w-px bg-border group-last/step:hidden" />
      <span
        className={cn(
          "relative grid size-7 shrink-0 place-items-center rounded-full border font-mono text-[11px]",
          done
            ? "border-ok/40 bg-ok/10 text-ok"
            : active
              ? "border-rigel/50 bg-rigel-soft text-rigel"
              : "bg-background text-muted-foreground"
        )}
      >
        {done ? <CheckIcon className="size-3.5" /> : n}
      </span>
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-2 pt-0.5",
          !active && !done && "opacity-60"
        )}
      >
        <h3 className="text-[14px] font-semibold">{title}</h3>
        {children}
      </div>
    </li>
  )
}

export function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-sm bg-muted px-1 py-px font-mono text-[12px] text-foreground">
      {children}
    </code>
  )
}

export function TelegramPanelView({ initial }: { initial: TelegramPanel }) {
  const router = useRouter()
  const [panel, setPanel] = React.useState(initial)
  const [token, setToken] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  const connected = panel.configured && !!panel.bot
  const paired = !!panel.owner

  // While waiting for the phone to pair, check back every few seconds
  React.useEffect(() => {
    if (!panel.configured || paired) return
    const timer = setInterval(async () => {
      const next = await getTelegramPanel()
      setPanel(next)
      if (next.owner) {
        toast.add({ type: "success", title: `Paired with ${next.owner.name}` })
        router.refresh()
      }
    }, 3000)
    return () => clearInterval(timer)
  }, [panel.configured, paired, router])

  const save = async (value: string | null) => {
    setSaving(true)
    try {
      const next = await saveTelegramToken(value)
      setPanel(next)
      setToken("")
      if (value) {
        toast.add(
          next.bot
            ? { type: "success", title: `Connected as @${next.bot.username}` }
            : {
                type: "error",
                title: "Saved, but Telegram didn't answer yet",
                description: next.error ?? undefined,
              }
        )
      }
    } catch (error) {
      toast.add({
        type: "error",
        title: "Couldn't save the token",
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid gap-6 rounded-xl border bg-surface/50 p-5 xl:grid-cols-[1fr_220px]">
      <ol className="flex flex-col">
        <Step
          n={1}
          title="Create a bot with @BotFather"
          done={panel.configured}
          active={!panel.configured}
        >
          <div className="flex flex-col gap-1.5 text-[13px] leading-relaxed text-muted-foreground">
            <p>
              In Telegram, open{" "}
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noreferrer"
                className="text-rigel hover:underline"
              >
                @BotFather
              </a>{" "}
              (the official one has a blue check) and tap{" "}
              <b className="text-foreground">Start</b>.
            </p>
            <p>
              Send <Code>/newbot</Code>. Give it a display name (e.g.{" "}
              <Code>My Xiryn</Code>
              ), then a username that ends in <Code>bot</Code> (e.g.{" "}
              <Code>my_xiryn_bot</Code>).
            </p>
            <p>
              BotFather replies with a token like <Code>123456789:AAH…</Code>. That&apos;s
              the only thing Xiryn needs. Treat it like a password.
            </p>
          </div>
          <a
            href="https://t.me/BotFather"
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-1.5 font-mono text-[11.5px] text-muted-foreground hover:text-foreground"
          >
            open @BotFather <ExternalLinkIcon className="size-3" />
          </a>
        </Step>

        <Step n={2} title="Paste the token" done={connected} active={!connected}>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (token.trim()) save(token)
            }}
            className="flex flex-col gap-2 sm:flex-row"
          >
            <div className="relative flex-1">
              <KeyRoundIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  panel.configured
                    ? "Token saved — paste a new one to replace it"
                    : "123456789:AAH…"
                }
                className="h-8 w-full rounded-lg border border-input bg-transparent pr-2.5 pl-8 font-mono text-[12px] outline-none placeholder:text-faint focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 dark:bg-input/30"
              />
            </div>
            <Button type="submit" size="sm" disabled={saving || !token.trim()}>
              {saving && <Spinner data-icon="inline-start" />}
              Connect
            </Button>
          </form>
          <div className="flex flex-wrap items-center gap-3 font-mono text-[11.5px]">
            {connected ? (
              <span className="flex items-center gap-1.5 text-ok">
                <span className="size-1.5 rounded-full bg-ok" />
                polling as @{panel.bot!.username}
              </span>
            ) : panel.configured ? (
              <span className="flex items-center gap-1.5 text-betelgeuse">
                <span className="size-1.5 rounded-full bg-betelgeuse" />
                {panel.error ?? "connecting…"}
              </span>
            ) : (
              <span className="text-faint">
                or set TELEGRAM_BOT_TOKEN in .env and restart
              </span>
            )}
            {panel.configured && (
              <Confirm
                trigger={
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    disconnect
                  </button>
                }
                title="Disconnect Telegram?"
                description="The bot token is removed from Xiryn and the paired account is forgotten. The bot itself keeps existing in Telegram."
                action="Disconnect"
                onConfirm={() => save(null)}
              />
            )}
          </div>
          {connected && panel.error && (
            <p className="font-mono text-[11.5px] text-betelgeuse">{panel.error}</p>
          )}
        </Step>

        <Step
          n={3}
          title="Pair your Telegram account"
          done={paired}
          active={connected && !paired}
        >
          {paired ? (
            <div className="flex flex-wrap items-center gap-3 text-[13px]">
              <span className="text-muted-foreground">
                Paired with <b className="text-foreground">{panel.owner!.name}</b>. Only
                this account can use the bot.
              </span>
              <Confirm
                trigger={
                  <Button size="xs" variant="ghost" className="text-muted-foreground">
                    <UnlinkIcon data-icon="inline-start" />
                    Unpair
                  </Button>
                }
                title="Unpair this Telegram account?"
                description="The bot stops answering it. You can pair again (or pair another account) with a new code."
                action="Unpair"
                onConfirm={async () => setPanel(await unpair())}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-muted-foreground">
              <p>
                Scan the code with your phone, or open the link — Telegram opens your bot;
                tap <b className="text-foreground">Start</b>. Prefer typing? Send{" "}
                <Code>/pair {panel.pairCode ?? "…"}</Code> to the bot.
              </p>
              {panel.link && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    nativeButton={false}
                    render={<a href={panel.link} target="_blank" rel="noreferrer" />}
                  >
                    <SendIcon data-icon="inline-start" />
                    Open in Telegram
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await navigator.clipboard.writeText(panel.link!)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    }}
                  >
                    {copied ? (
                      <CheckIcon data-icon="inline-start" />
                    ) : (
                      <CopyIcon data-icon="inline-start" />
                    )}
                    Copy link
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => setPanel(await newPairingCode())}
                  >
                    <RefreshCwIcon data-icon="inline-start" />
                    New code
                  </Button>
                </div>
              )}
            </div>
          )}
        </Step>

        <Step n={4} title="Talk from anywhere" done={paired} active={paired}>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Message the bot like you would message the agent here. <Code>/agents</Code>{" "}
            switches agent or squad, <Code>/new</Code> starts a fresh thread,{" "}
            <Code>/stop</Code> interrupts. Threads started from Telegram show up in this
            app too. Xiryn has to be running on this computer for the bot to answer.
          </p>
        </Step>
      </ol>

      <div className="flex flex-col items-center gap-3 xl:border-l xl:pl-6">
        {panel.qr && !paired ? (
          <>
            <div
              className="size-[180px] rounded-lg bg-white p-3 [&_svg]:size-full"
              // Generated locally by the qrcode package from our own link
              dangerouslySetInnerHTML={{ __html: panel.qr }}
            />
            <span className="font-mono text-[11px] text-muted-foreground">
              code <span className="text-foreground">{panel.pairCode}</span>
            </span>
          </>
        ) : (
          <div className="grid size-[180px] place-items-center rounded-lg border border-dashed text-center">
            <span className="flex flex-col items-center gap-2 px-4 font-mono text-[11px] text-faint">
              {paired ? (
                <>
                  <CheckIcon className="size-5 text-ok" />
                  remote access on
                </>
              ) : (
                <>
                  <LinkIcon className="size-5" />
                  pairing code appears once the bot is connected
                </>
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
