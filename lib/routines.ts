import { and, eq, lte } from "drizzle-orm"
import { nanoid } from "nanoid"

import { db } from "@/db"
import {
  routineRuns,
  routines,
  threads,
  turns,
  type Routine,
  type RoutineRun,
} from "@/db/schema"
import { startTurn, subscribe, TurnError } from "@/lib/agent/runtime"
import type { XirynMessage } from "@/lib/agent/tools"
import { nextRun } from "@/lib/schedule"
import { reportError } from "@/lib/report"

// Runs routines when they're due. Xiryn has to be running for that: a run
// missed by a few hours (the computer was asleep) still happens when it's
// back; older ones are skipped until the next time.

const TICK = 30_000
const CATCH_UP = 6 * 3_600_000
const RETRY_BUSY = 5 * 60_000

const globalForRoutines = globalThis as unknown as {
  __xirynRoutines?: { timer: ReturnType<typeof setInterval> | null; running: Set<string> }
}
const state = (globalForRoutines.__xirynRoutines ??= { timer: null, running: new Set() })

function update(id: string, values: Partial<Routine>) {
  db.update(routines).set(values).where(eq(routines.id, id)).run()
}

// A line in the routine's history
function logRun(values: typeof routineRuns.$inferInsert) {
  const [row] = db
    .insert(routineRuns)
    .values(values)
    .returning({ id: routineRuns.id })
    .all()
  return row.id
}

function updateRun(id: string, values: Partial<RoutineRun>) {
  db.update(routineRuns).set(values).where(eq(routineRuns.id, id)).run()
}

// The routine's own thread, made again if it was deleted
function threadFor(routine: Routine) {
  if (
    routine.threadId &&
    db
      .select({ id: threads.id })
      .from(threads)
      .where(eq(threads.id, routine.threadId))
      .get()
  ) {
    return routine.threadId
  }
  const [thread] = db
    .insert(threads)
    .values({ agentId: routine.agentId, squadId: routine.squadId, title: routine.name })
    .returning({ id: threads.id })
    .all()
  update(routine.id, { threadId: thread.id })
  return thread.id
}

export function threadHref(routine: Pick<Routine, "agentId" | "squadId" | "threadId">) {
  if (!routine.threadId) return null
  return routine.squadId
    ? `/s/${routine.squadId}/${routine.threadId}`
    : `/a/${routine.agentId}/${routine.threadId}`
}

// Starts a run and returns its thread once the agent is on it; the run
// itself carries on in the background
export async function runRoutine(routine: Routine, { manual = false } = {}) {
  if (state.running.has(routine.id)) {
    throw new TurnError("This routine is already running.", 409)
  }
  const now = new Date()
  const entry = {
    routineId: routine.id,
    trigger: manual ? ("manual" as const) : ("schedule" as const),
    dueAt: manual ? null : routine.nextRunAt,
    startedAt: now,
  }
  // Scheduled runs move on first, so a slow or failed run never repeats; a
  // one-off routine switches itself off
  if (!manual) {
    const next = nextRun(routine.schedule, now)
    update(routine.id, { nextRunAt: next, ...(!next && { enabled: false }) })
  }

  const threadId = threadFor(routine)
  const message = {
    id: nanoid(),
    role: "user",
    parts: [{ type: "text", text: routine.prompt }],
  } as XirynMessage

  let run
  try {
    run = await startTurn({
      threadId,
      message,
      routine: { id: routine.id, name: routine.name },
    })
  } catch (error) {
    if (!manual && error instanceof TurnError && error.status === 409) {
      // Someone's talking to the agent in this thread: try again shortly. A
      // one-off routine stays on until it gets its turn.
      const detail = "The agent was busy in this thread; trying again in 5 minutes."
      update(routine.id, {
        enabled: true,
        nextRunAt: new Date(Date.now() + RETRY_BUSY),
        lastStatus: "skipped",
        lastError: detail,
      })
      logRun({ ...entry, threadId, status: "skipped", detail, finishedAt: new Date() })
      return null
    }
    const detail = error instanceof Error ? error.message : String(error)
    update(routine.id, { lastRunAt: now, lastStatus: "failed", lastError: detail })
    logRun({ ...entry, threadId, status: "failed", detail, finishedAt: new Date() })
    throw error
  }

  update(routine.id, { lastRunAt: now, lastStatus: "running", lastError: null })
  const runId = logRun({ ...entry, threadId, status: "running" })
  state.running.add(routine.id)
  // Follow the run to its end to record how it went
  void (async () => {
    let failure: string | null = null
    try {
      const reader = subscribe(run).getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value.type === "error") failure = value.errorText
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    } finally {
      state.running.delete(routine.id)
      // The turn's ledger row is written before its stream ends
      const turn = db
        .select({ id: turns.id, status: turns.status, error: turns.error })
        .from(turns)
        .where(eq(turns.id, run.id))
        .get()
      const status =
        failure || turn?.status === "failed"
          ? ("failed" as const)
          : turn?.status === "stopped"
            ? ("stopped" as const)
            : ("ok" as const)
      const detail = failure ?? turn?.error ?? null
      update(routine.id, { lastStatus: status, lastError: detail })
      updateRun(runId, {
        status,
        detail,
        turnId: turn?.id ?? null,
        finishedAt: new Date(),
      })
    }
  })()
  return { threadId }
}

export function isRoutineRunning(id: string) {
  return state.running.has(id)
}

async function tick() {
  const now = new Date()
  const due = db
    .select()
    .from(routines)
    .where(and(eq(routines.enabled, true), lte(routines.nextRunAt, now)))
    .all()
  for (const routine of due) {
    if (state.running.has(routine.id)) continue
    const late = now.getTime() - (routine.nextRunAt?.getTime() ?? now.getTime())
    if (late > CATCH_UP) {
      const next = nextRun(routine.schedule, now)
      const detail = "Xiryn wasn't running at the scheduled time."
      update(routine.id, {
        nextRunAt: next,
        ...(!next && { enabled: false }),
        lastStatus: "skipped",
        lastError: detail,
      })
      logRun({
        routineId: routine.id,
        trigger: "schedule",
        dueAt: routine.nextRunAt,
        threadId: routine.threadId,
        status: "skipped",
        detail,
        startedAt: now,
        finishedAt: now,
      })
      continue
    }
    runRoutine(routine).catch((error) =>
      reportError("routine", error, { routineId: routine.id })
    )
  }
}

export function startRoutines() {
  if (state.timer) return
  // Runs cut short the last time Xiryn stopped
  const interrupted = "Xiryn stopped during this run."
  db.update(routineRuns)
    .set({ status: "failed", detail: interrupted, finishedAt: new Date() })
    .where(eq(routineRuns.status, "running"))
    .run()
  db.update(routines)
    .set({ lastStatus: "failed", lastError: interrupted })
    .where(eq(routines.lastStatus, "running"))
    .run()
  state.timer = setInterval(() => {
    tick().catch((error) => reportError("routines", error))
  }, TICK)
  state.timer.unref?.()
  tick().catch((error) => reportError("routines", error))
}
