"use client"

import * as React from "react"
import type { ChatStatus } from "ai"
import {
  AlarmClockIcon,
  ArrowDownIcon,
  BrainIcon,
  ShieldCheckIcon,
  Undo2Icon,
  ChevronRightIcon,
  CornerDownRightIcon,
  SendIcon,
} from "lucide-react"
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom"

import { Glyph } from "@/components/glyph"
import { Markdown } from "@/components/thread/markdown"
import { ToolCall, toolName, type ToolPart } from "@/components/thread/tool-call"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import type { XirynMessage } from "@/lib/agent/tools"
import { estimateCost, formatUsd, isFree } from "@/lib/providers/pricing"
import { cn } from "@/lib/utils"

export type AgentLite = {
  id: string
  name: string
  role: string
  glyph: string
  model: string | null
}

type Part = XirynMessage["parts"][number]

// One reply can pass through several agents in a squad. It is cut at every
// delegation so each stretch is credited to whoever wrote it.
function segments(message: XirynMessage, members: AgentLite[]) {
  const find = (id?: string) => members.find((member) => member.id === id)
  let current = {
    author: find(message.metadata?.agentId) ?? members[0],
    parts: [] as Part[],
    via: null as AgentLite | null,
  }
  const result = [current]
  for (const part of message.parts) {
    if (part.type === "tool-delegate" && part.state === "output-available") {
      const next = find(part.output.agentId)
      current = { author: next ?? current.author, parts: [], via: current.author }
      result.push(current)
      continue
    }
    current.parts.push(part)
  }
  // An agent that delegated without writing anything is represented by the
  // hand-off line alone; the last segment always stays so streaming shows
  const visible = (segment: (typeof result)[number]) =>
    segment.parts.some((part) => part.type !== "step-start")
  return result.filter((segment, i) => i === result.length - 1 || visible(segment))
}

// What a reply cost: priced when it ran, or estimated from today's prices
// for replies saved before costs were recorded
function ReplyCost({ meta }: { meta: NonNullable<XirynMessage["metadata"]> }) {
  if (!meta.model) return null
  if (isFree(meta.model)) {
    return <span className="text-ok">free · local</span>
  }
  if (typeof meta.cost === "number") {
    return (
      <span title="What this reply cost, at the provider's price">
        {formatUsd(meta.cost)}
      </span>
    )
  }
  if (meta.cost === null || !meta.usage) return null
  const estimate = estimateCost(meta.model, meta.usage)
  if (estimate === null) return null
  return <span title="Estimated at today's prices">≈ {formatUsd(estimate)}</span>
}

function formatTokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
}

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  if (!text.trim() && !streaming) return null
  return (
    <Collapsible className="group/reasoning">
      <CollapsibleTrigger className="flex items-center gap-1.5 font-mono text-[11.5px] text-muted-foreground hover:text-foreground">
        <BrainIcon className="size-3.5" />
        <span className={cn(streaming && "shimmer-text")}>
          {streaming ? "thinking" : "thought"}
        </span>
        <ChevronRightIcon className="size-3 transition-transform group-data-open/reasoning:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 border-l-2 pl-3 text-[12.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
        {text}
      </CollapsibleContent>
    </Collapsible>
  )
}

function Parts({
  parts,
  streaming,
  awaiting = false,
}: {
  parts: Part[]
  streaming: boolean
  awaiting?: boolean
}) {
  // Consecutive tool calls are grouped into one block
  const blocks: (
    { kind: "tools"; parts: ToolPart[] } | { kind: "part"; part: Part; index: number }
  )[] = []
  parts.forEach((part, index) => {
    if (part.type.startsWith("tool-")) {
      const last = blocks[blocks.length - 1]
      if (last?.kind === "tools") last.parts.push(part as ToolPart)
      else blocks.push({ kind: "tools", parts: [part as ToolPart] })
    } else {
      blocks.push({ kind: "part", part, index })
    }
  })

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {blocks.map((block, i) => {
        const isLast = i === blocks.length - 1
        if (block.kind === "tools") {
          return (
            <div key={`tools-${i}`} className="-mx-2 flex flex-col gap-0.5">
              {block.parts.map((part) => (
                <ToolCall
                  key={part.toolCallId}
                  part={part}
                  live={streaming}
                  awaiting={awaiting}
                />
              ))}
            </div>
          )
        }
        const { part, index } = block
        if (part.type === "text") {
          return part.text ? (
            <Markdown key={index} streaming={streaming && isLast}>
              {part.text}
            </Markdown>
          ) : null
        }
        if (part.type === "reasoning") {
          return (
            <Reasoning
              key={index}
              text={part.text}
              streaming={streaming && isLast && part.state === "streaming"}
            />
          )
        }
        return null
      })}
    </div>
  )
}

// Memoised: while a reply streams, only the message that changed re-renders
const UserMessage = React.memo(function UserMessage({
  message,
  addressee,
}: {
  message: XirynMessage
  addressee?: AgentLite
}) {
  const text = message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")

  // Handing the desktop back reads as an event, not a chat bubble
  const handback = message.metadata?.handback
  if (handback) {
    return (
      <div className="flex flex-col items-center gap-1.5">
        <div className="flex w-full items-center gap-3">
          <span className="h-px flex-1 bg-betelgeuse/25" />
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-betelgeuse">
            <Undo2Icon className="size-3.5" />
            you handed the desktop back
          </span>
          <span className="h-px flex-1 bg-betelgeuse/25" />
        </div>
        {handback.note && (
          <p className="max-w-[85%] text-center text-[13px] text-muted-foreground">
            “{handback.note}”
          </p>
        )}
      </div>
    )
  }

  // Answers to a payment approval or a request for a detail
  const vault = message.metadata?.vault
  if (vault) {
    const said = {
      approved: "you approved",
      declined: "you declined",
      "taken-over": "you're paying yourself",
      provided: "you added to the vault",
    }[vault.action]
    return (
      <div className="flex w-full items-center gap-3">
        <span className="h-px flex-1 bg-ok/25" />
        <span
          className={cn(
            "flex items-center gap-1.5 font-mono text-[11px]",
            vault.action === "declined" ? "text-muted-foreground" : "text-ok"
          )}
        >
          <ShieldCheckIcon className="size-3.5" />
          {said} · {vault.summary}
        </span>
        <span className="h-px flex-1 bg-ok/25" />
      </div>
    )
  }

  return (
    <div className="flex justify-end">
      <div className="flex max-w-[85%] flex-col items-end gap-1">
        {(addressee ||
          message.metadata?.via === "telegram" ||
          message.metadata?.routine) && (
          <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground">
            {message.metadata?.routine && (
              <span className="flex items-center gap-1 text-rigel">
                <AlarmClockIcon className="size-3" /> routine ·{" "}
                {message.metadata.routine.name}
              </span>
            )}
            {message.metadata?.via === "telegram" && (
              <span className="flex items-center gap-1 text-rigel">
                <SendIcon className="size-3" /> via telegram
              </span>
            )}
            {addressee && (
              <>
                to <Glyph seed={addressee.glyph} className="size-3.5 rounded-[3px]" />{" "}
                {addressee.name}
              </>
            )}
          </span>
        )}
        <div className="rounded-xl rounded-br-sm border bg-elevated px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap">
          {text}
        </div>
      </div>
    </div>
  )
})

const AgentMessage = React.memo(function AgentMessage({
  message,
  members,
  streaming,
  awaiting = false,
}: {
  message: XirynMessage
  members: AgentLite[]
  streaming: boolean
  // The latest message, finished: its requests can still be answered
  awaiting?: boolean
}) {
  const parts = segments(message, members)
  const meta = message.metadata
  const working =
    streaming &&
    parts.every((segment) => segment.parts.every((p) => p.type === "step-start"))

  return (
    <div className="flex flex-col gap-4">
      {parts.map((segment, i) => (
        <div key={i} className="flex flex-col gap-2.5">
          {segment.via && (
            <div className="flex items-center gap-2 font-mono text-[11px] text-betelgeuse">
              <CornerDownRightIcon className="size-3.5" />
              {segment.via.name} delegated to {segment.author.name}
              <span className="h-px flex-1 bg-betelgeuse/25" />
            </div>
          )}
          <div className="flex items-center gap-2">
            <Glyph seed={segment.author.glyph} className="size-[22px]" />
            <span className="text-[13px] font-semibold">{segment.author.name}</span>
            <span className="truncate font-mono text-[10.5px] text-muted-foreground">
              {segment.author.role}
            </span>
          </div>
          <div className="pl-[30px]">
            {working && i === 0 ? (
              <span className="shimmer-text font-mono text-[12px]">working…</span>
            ) : (
              <Parts
                parts={segment.parts}
                streaming={streaming && i === parts.length - 1}
                awaiting={awaiting && i === parts.length - 1}
              />
            )}
          </div>
        </div>
      ))}
      {!streaming && (meta?.usage || meta?.model) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-[30px] font-mono text-[10.5px] text-faint">
          {meta.model && <span>{meta.model}</span>}
          {meta.usage && (
            <span>
              {formatTokens(meta.usage.input)} in · {formatTokens(meta.usage.output)} out
            </span>
          )}
          <ReplyCost meta={meta} />
          {typeof meta.durationMs === "number" && (
            <span>{(meta.durationMs / 1000).toFixed(1)}s</span>
          )}
        </div>
      )}
    </div>
  )
})

function ScrollToBottom() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()
  if (isAtBottom) return null
  return (
    <button
      type="button"
      onClick={() => scrollToBottom()}
      className="absolute bottom-4 left-1/2 grid size-8 -translate-x-1/2 place-items-center rounded-full border bg-popover text-muted-foreground shadow-md hover:text-foreground"
      aria-label="Scroll to latest"
    >
      <ArrowDownIcon className="size-4" />
    </button>
  )
}

export function Transcript({
  messages,
  members,
  status,
  isSquad,
  empty,
  footer,
}: {
  messages: XirynMessage[]
  members: AgentLite[]
  status: ChatStatus
  isSquad: boolean
  empty: React.ReactNode
  footer?: React.ReactNode
}) {
  const busy = status === "submitted" || status === "streaming"
  const last = messages[messages.length - 1]

  return (
    <StickToBottom className="relative min-h-0 flex-1" resize="smooth" initial="instant">
      <StickToBottom.Content className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 py-8 sm:px-6">
        {messages.length === 0 && empty}
        {messages.map((message) =>
          message.role === "user" ? (
            <UserMessage
              key={message.id}
              message={message}
              addressee={
                isSquad
                  ? members.find((member) => member.id === message.metadata?.agentId)
                  : undefined
              }
            />
          ) : message.role === "assistant" ? (
            <AgentMessage
              key={message.id}
              message={message}
              members={members}
              streaming={busy && message === last}
              awaiting={!busy && message === last}
            />
          ) : null
        )}
        {status === "submitted" && last?.role === "user" && (
          <div className="flex items-center gap-2 pl-[30px] font-mono text-[12px]">
            <span className="size-1.5 animate-pulse-dot rounded-full bg-rigel text-rigel" />
            <span className="shimmer-text">booting turn…</span>
          </div>
        )}
        {footer}
      </StickToBottom.Content>
      <ScrollToBottom />
    </StickToBottom>
  )
}

export { toolName }
