import { createUIMessageStreamResponse } from "ai"
import { z } from "zod"

import {
  getActiveRun,
  startTurn,
  stopRun,
  subscribe,
  TurnError,
} from "@/lib/agent/runtime"
import type { XirynMessage } from "@/lib/agent/tools"
import { safeError } from "@/lib/log"
import { verifyMarker } from "@/lib/vault-requests"

const bodySchema = z.object({
  message: z.object({
    id: z.string().min(1).max(64),
    role: z.literal("user"),
    // The composer sends text; anything else is dropped (unknown keys too)
    parts: z
      .array(z.object({ type: z.literal("text"), text: z.string() }))
      .min(1)
      .max(32),
    // Only display markers are accepted; the rest is set by the server
    metadata: z
      .object({
        handback: z.object({ note: z.string().max(4000).optional() }).optional(),
        // Shown as a marker in the transcript. Signed by the server action
        // that recorded the decision; an unsigned or forged one is dropped
        vault: z
          .object({
            action: z.enum(["approved", "declined", "taken-over", "provided"]),
            summary: z.string().max(300),
            sig: z.string().max(100),
          })
          .optional(),
      })
      .optional(),
  }),
  agentId: z.string().max(64).optional(),
})

function fail(message: string, status = 400) {
  return Response.json({ error: message }, { status })
}

// Start a turn and stream it
export async function POST(
  request: Request,
  ctx: { params: Promise<{ threadId: string }> }
) {
  const { threadId } = await ctx.params
  // Browsers send simple (no-preflight) cross-origin posts as text/plain;
  // only the app's own JSON requests are accepted
  const contentType = request.headers.get("content-type") ?? ""
  if (!/^application\/json\b/i.test(contentType)) {
    return fail("Expected application/json.", 415)
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return fail("Malformed message.")

  const { message } = parsed.data
  const text = message.parts.map((part) => part.text).join("")
  if (!text.trim()) return fail("Message is empty.")
  if (text.length > 100_000) return fail("Message is too long.")

  try {
    const run = await startTurn({
      threadId,
      message: {
        ...message,
        metadata: message.metadata && {
          ...message.metadata,
          vault:
            message.metadata.vault && verifyMarker(message.metadata.vault)
              ? message.metadata.vault
              : undefined,
        },
      } as unknown as XirynMessage,
      agentId: parsed.data.agentId,
    })
    return createUIMessageStreamResponse({ stream: subscribe(run) })
  } catch (error) {
    if (error instanceof TurnError) return fail(error.message, error.status)
    console.error("[xiryn] could not start turn:", safeError(error))
    return fail(error instanceof Error ? error.message : "Could not start the turn.", 500)
  }
}

// Re-attach to a turn that is still running (page refresh, reopened tab)
export async function GET(_: Request, ctx: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await ctx.params
  const run = getActiveRun(threadId)
  if (!run) return new Response(null, { status: 204 })
  return createUIMessageStreamResponse({ stream: subscribe(run) })
}

// Stop the running turn. What was produced so far is kept.
export async function DELETE(_: Request, ctx: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await ctx.params
  return Response.json({ stopped: stopRun(threadId) })
}
