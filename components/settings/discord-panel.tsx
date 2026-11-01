"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  CheckIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  UnlinkIcon,
  UserPlusIcon,
} from "lucide-react"

import {
  getDiscordPanel,
  newDiscordPairingCode,
  saveDiscordToken,
  unpairDiscordAccount,
  type DiscordPanel,
} from "@/actions/discord"
import { Confirm } from "@/components/confirm"
import { Code, Step } from "@/components/settings/telegram-panel"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"

export function DiscordPanelView({ initial }: { initial: DiscordPanel }) {
  const router = useRouter()
  const [panel, setPanel] = React.useState(initial)
  const [token, setToken] = React.useState("")
  const [saving, setSaving] = React.useState(false)

  const connected = panel.configured && !!panel.bot
  const paired = !!panel.owner

  // While waiting for the DM that pairs, check back every few seconds
  React.useEffect(() => {
    if (!panel.configured || paired) return
    const timer = setInterval(async () => {
      const next = await getDiscordPanel()
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
      const next = await saveDiscordToken(value)
      setPanel(next)
      setToken("")
      if (value) {
        toast.add(
          next.bot
            ? { type: "success", title: `Connected as ${next.bot.username}` }
            : {
                type: "error",
                title: "Saved, but Discord didn't answer yet",
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
    <div className="rounded-xl border bg-surface/50 p-5">
      <ol className="flex flex-col">
        <Step
          n={1}
          title="Create a bot in the Discord Developer Portal"
          done={panel.configured}
          active={!panel.configured}
        >
          <div className="flex flex-col gap-1.5 text-[13px] leading-relaxed text-muted-foreground">
            <p>
              Open the{" "}
              <a
                href="https://discord.com/developers/applications"
                target="_blank"
                rel="noreferrer"
                className="text-rigel hover:underline"
              >
                Developer Portal
              </a>
              , choose <b className="text-foreground">New Application</b> and name it
              (e.g. <Code>My Xiryn</Code>).
            </p>
            <p>
              Under <b className="text-foreground">Bot</b>, press{" "}
              <b className="text-foreground">Reset Token</b> and copy it. That&apos;s the
              only thing Xiryn needs. Treat it like a password. No privileged intents are
              needed: Xiryn only reads direct messages.
            </p>
          </div>
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
                    : "MTI3…"
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
                connected as {panel.bot!.username}
              </span>
            ) : panel.configured ? (
              <span className="flex items-center gap-1.5 text-betelgeuse">
                <span className="size-1.5 rounded-full bg-betelgeuse" />
                {panel.error ?? "connecting…"}
              </span>
            ) : (
              <span className="text-faint">
                or set DISCORD_BOT_TOKEN in .env and restart
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
                title="Disconnect Discord?"
                description="The bot token is removed from Xiryn and the paired account is forgotten. The bot itself keeps existing in Discord."
                action="Disconnect"
                onConfirm={() => save(null)}
              />
            )}
          </div>
        </Step>

        <Step
          n={3}
          title="Pair your Discord account"
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
                title="Unpair this Discord account?"
                description="The bot stops answering it. You can pair again (or pair another account) with a new code."
                action="Unpair"
                onConfirm={async () => setPanel(await unpairDiscordAccount())}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-muted-foreground">
              <p>
                Add the bot to a server you&apos;re in (a private one of your own is
                fine), then open a direct message with it and send{" "}
                <Code>/pair {panel.pairCode ?? "…"}</Code>.
              </p>
              {panel.invite && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    nativeButton={false}
                    render={<a href={panel.invite} target="_blank" rel="noreferrer" />}
                  >
                    <UserPlusIcon data-icon="inline-start" />
                    Add to a server
                    <ExternalLinkIcon className="size-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => setPanel(await newDiscordPairingCode())}
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
            Message the bot in your DM like you would message the agent here.{" "}
            <Code>/agents</Code> switches agent or squad, <Code>/new</Code> starts a fresh
            thread, <Code>/stop</Code> interrupts, and <Code>/code</Code> hands over a
            one-time code without it showing in the chat.{" "}
            {paired && <CheckIcon className="inline size-3.5 text-ok" />}
          </p>
        </Step>
      </ol>
    </div>
  )
}
