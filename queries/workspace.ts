import { cache } from "react"
import { format } from "date-fns"
import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm"
import type { SQLiteTable } from "drizzle-orm/sqlite-core"

import { db, DB_PATH } from "@/db"
import {
  agents,
  memories,
  messages,
  routineRuns,
  routines,
  squadMembers,
  squads,
  threads,
  turns,
} from "@/db/schema"
import { activeThreadIds, loadMessages } from "@/lib/agent/runtime"
import { describeSetting, getSetting } from "@/lib/config"
import { providers } from "@/lib/providers/catalog"
import {
  estimateCost,
  findPrice,
  fromMicros,
  isFree,
  PRICES_AS_OF,
  type CustomPrices,
} from "@/lib/providers/pricing"
import { configuredProviders, resolveModelSpec } from "@/lib/providers/registry"
import { engineSnapshot } from "@/lib/docker"
import { isRoutineRunning, threadHref } from "@/lib/routines"
import { describeSchedule } from "@/lib/schedule"
import { getCustomPrices, getMonthlyBudget, startOfMonth } from "@/lib/spend"
import { isWebConfigured } from "@/lib/web"
import { getUpdateInfo, updateChecksEnabled } from "@/lib/updates"
import { desktopNotificationsEnabled } from "@/lib/desktop-notify"
import { isWorkstationConfigured } from "@/lib/workstation"
import { version } from "@/package.json"

/* ───────────────────────────── sidebar ──────────────────────────── */

export function getAgents() {
  return db.select().from(agents).orderBy(asc(agents.createdAt)).all()
}

export function getSquads() {
  return db.query.squads
    .findMany({
      orderBy: asc(squads.createdAt),
      with: {
        members: { orderBy: asc(squadMembers.position), with: { agent: true } },
      },
    })
    .sync()
    .map(({ members, ...squad }) => ({ ...squad, agents: members.map((m) => m.agent) }))
}

export type SquadWithAgents = ReturnType<typeof getSquads>[number]

export function getRecentThreads(limit = 40) {
  return db.query.threads
    .findMany({
      orderBy: desc(threads.activeAt),
      limit,
      with: {
        agent: true,
        squad: {
          with: {
            members: { orderBy: asc(squadMembers.position), with: { agent: true } },
          },
        },
      },
    })
    .sync()
}

export type RecentThread = ReturnType<typeof getRecentThreads>[number]

// Everything the shell needs: who exists, where their latest thread is,
// and which of them are working right now
export function getNavigation() {
  const agentRows = getAgents()
  const squadRows = getSquads()
  const threadRows = db
    .select({
      id: threads.id,
      agentId: threads.agentId,
      squadId: threads.squadId,
      title: threads.title,
      preview: threads.preview,
      activeAt: threads.activeAt,
    })
    .from(threads)
    .orderBy(desc(threads.activeAt))
    .limit(60)
    .all()

  // The newest thread of every agent and squad, however old it is; the list
  // above only holds the 60 most recent overall
  const latest = new Map<string, string>()
  for (const row of db.all<{ id: string; owner: string }>(sql`
    SELECT id, owner FROM (
      SELECT id, COALESCE(agent_id, squad_id) AS owner,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(agent_id, squad_id) ORDER BY active_at DESC
        ) AS rn
      FROM threads
      WHERE agent_id IS NOT NULL OR squad_id IS NOT NULL
    ) WHERE rn = 1
  `)) {
    latest.set(row.owner, row.id)
  }

  const running = new Set(activeThreadIds())
  const busy = new Set<string>()
  if (running.size > 0) {
    const owners = db
      .select({ agentId: threads.agentId, squadId: threads.squadId })
      .from(threads)
      .where(inArray(threads.id, [...running]))
      .all()
    for (const row of owners) {
      const owner = row.agentId ?? row.squadId
      if (owner) busy.add(owner)
    }
  }

  return {
    agents: agentRows.map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      glyph: agent.glyph,
      model: agent.model,
      instructions: agent.instructions,
      latestThreadId: latest.get(agent.id) ?? null,
      busy: busy.has(agent.id),
    })),
    squads: squadRows.map((squad) => ({
      id: squad.id,
      name: squad.name,
      agentIds: squad.agents.map((agent) => agent.id),
      glyphs: squad.agents.map((agent) => agent.glyph),
      latestThreadId: latest.get(squad.id) ?? null,
      busy: busy.has(squad.id),
    })),
    threads: threadRows.map((thread) => ({
      ...thread,
      activeAt: thread.activeAt.toISOString(),
      busy: running.has(thread.id),
    })),
  }
}

export type Navigation = ReturnType<typeof getNavigation>
export type NavAgent = Navigation["agents"][number]
export type NavSquad = Navigation["squads"][number]
export type NavThread = Navigation["threads"][number]

/* ───────────────────────────── threads ──────────────────────────── */

// Memoised per request: a thread page reads it for its metadata and again
// for its body, and every message's JSON is parsed on the way
export const getThread = cache(function getThread(threadId: string) {
  const thread = db.query.threads
    .findFirst({
      where: eq(threads.id, threadId),
      with: {
        agent: true,
        squad: {
          with: {
            members: { orderBy: asc(squadMembers.position), with: { agent: true } },
          },
        },
      },
    })
    .sync()
  if (!thread) return null
  const members = thread.squad
    ? thread.squad.members.map((m) => m.agent)
    : thread.agent
      ? [thread.agent]
      : []
  if (members.length === 0) return null
  return { ...thread, members, messages: loadMessages(threadId) }
})

export type ThreadView = NonNullable<ReturnType<typeof getThread>>

export function getThreadsFor(owner: { agentId?: string; squadId?: string }) {
  const where = owner.agentId
    ? eq(threads.agentId, owner.agentId)
    : eq(threads.squadId, owner.squadId ?? "")
  return db
    .select({
      id: threads.id,
      title: threads.title,
      preview: threads.preview,
      activeAt: threads.activeAt,
    })
    .from(threads)
    .where(where)
    .orderBy(desc(threads.activeAt))
    .limit(50)
    .all()
}

export function getLatestThreadId(owner: { agentId?: string; squadId?: string }) {
  return getThreadsFor(owner)[0]?.id ?? null
}

export function getMemories(agentId: string) {
  return db
    .select()
    .from(memories)
    .where(eq(memories.agentId, agentId))
    .orderBy(desc(memories.createdAt))
    .all()
}

/* ───────────────────────────── system ───────────────────────────── */

export function getSystemStatus() {
  const configured = configuredProviders().map((p) => p.id)
  const defaultModel = resolveModelSpec(null)
  return {
    version,
    // Newer Xiryn on GitHub, and its star count (null until first checked)
    updates: getUpdateInfo(),
    // Filled in per request by the layout
    host: null as string | null,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    dbPath: DB_PATH,
    providers: configured,
    defaultModel,
    defaultModelSource: describeSetting("model.default").source,
    workstation: isWorkstationConfigured(),
    // missing · stopped · ready (null until Docker has been looked at once)
    docker: engineSnapshot()?.state ?? null,
    web: isWebConfigured(),
    ready: !!defaultModel && configured.length > 0,
    running: activeThreadIds(),
    providerOptions: providers.map((p) => ({
      id: p.id,
      name: p.name,
      local: !!p.local,
      configured: configured.includes(p.id),
      suggested: p.suggested,
    })),
  }
}

export type SystemStatus = ReturnType<typeof getSystemStatus>

export function getSettingsView() {
  return {
    providers: providers.map((p) => ({
      ...p,
      apiKey: describeSetting(`provider.${p.id}.apiKey`),
      baseUrl: describeSetting(`provider.${p.id}.baseUrl`),
    })),
    defaultModel: describeSetting("model.default"),
    resolvedDefaultModel: resolveModelSpec(null),
    maxSteps: describeSetting("agent.maxSteps"),
    turnTimeout: describeSetting("agent.turnTimeout"),
    workstation: {
      cpus: describeSetting("workstation.cpus"),
      memory: describeSetting("workstation.memory"),
      autoStop: describeSetting("workstation.autoStop"),
      autoDelete: describeSetting("workstation.autoDelete"),
      phoneLinks: describeSetting("workstation.phoneLinks"),
    },
    firecrawl: {
      apiKey: describeSetting("firecrawl.apiKey"),
      apiUrl: describeSetting("firecrawl.apiUrl"),
    },
    dbPath: DB_PATH,
    allowedHosts: process.env.XIRYN_ALLOWED_HOSTS ?? null,
    counts: {
      agents: countRows(agents),
      squads: countRows(squads),
      threads: countRows(threads),
      messages: countRows(messages),
      memories: countRows(memories),
    },
    maxStepsValue: getSetting("agent.maxSteps"),
    updateChecks: updateChecksEnabled(),
    desktopNotify: desktopNotificationsEnabled(),
  }
}

export type SettingsData = ReturnType<typeof getSettingsView>

// db.$count() is a promise even on SQLite, so count synchronously instead
function countRows(table: SQLiteTable) {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(table)
      .get()?.n ?? 0
  )
}

/* ────────────────────────────── ledger ──────────────────────────── */

type CostRow = {
  model: string
  input: number
  output: number
  cached: number
  steps: number
  costMicros: number | null
  createdAt: Date
}

// Dollars for one turn: what it was priced at when it ran, or, for turns
// recorded before costs were, an estimate at the price for its date
function turnCost(row: CostRow, custom: CustomPrices) {
  if (row.costMicros !== null)
    return { usd: fromMicros(row.costMicros), estimated: false }
  const usd = estimateCost(
    row.model,
    { input: row.input, output: row.output, cached: row.cached, calls: row.steps },
    { at: row.createdAt, custom }
  )
  return usd === null ? null : { usd, estimated: true }
}

export function getUsage(days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const window = gte(turns.createdAt, since)

  const totals = db
    .select({
      turns: sql<number>`count(*)`,
      input: sql<number>`coalesce(sum(${turns.inputTokens}), 0)`,
      output: sql<number>`coalesce(sum(${turns.outputTokens}), 0)`,
      reasoning: sql<number>`coalesce(sum(${turns.reasoningTokens}), 0)`,
      cached: sql<number>`coalesce(sum(${turns.cachedTokens}), 0)`,
      toolCalls: sql<number>`coalesce(sum(${turns.toolCalls}), 0)`,
      durationMs: sql<number>`coalesce(sum(${turns.durationMs}), 0)`,
      failed: sql<number>`coalesce(sum(case when ${turns.status} = 'failed' then 1 else 0 end), 0)`,
    })
    .from(turns)
    .where(window)
    .get()!

  const byModel = db
    .select({
      model: turns.model,
      turns: sql<number>`count(*)`,
      input: sql<number>`sum(${turns.inputTokens})`,
      output: sql<number>`sum(${turns.outputTokens})`,
    })
    .from(turns)
    .where(window)
    .groupBy(turns.model)
    .orderBy(desc(sql`sum(${turns.inputTokens}) + sum(${turns.outputTokens})`))
    .all()

  const byAgent = db
    .select({
      agentId: turns.agentId,
      name: agents.name,
      glyph: agents.glyph,
      turns: sql<number>`count(*)`,
      input: sql<number>`sum(${turns.inputTokens})`,
      output: sql<number>`sum(${turns.outputTokens})`,
      toolCalls: sql<number>`sum(${turns.toolCalls})`,
    })
    .from(turns)
    .leftJoin(agents, eq(turns.agentId, agents.id))
    .where(and(window, isNotNull(turns.agentId)))
    .groupBy(turns.agentId)
    .orderBy(desc(sql`sum(${turns.inputTokens}) + sum(${turns.outputTokens})`))
    .all()

  // Day buckets in local time, oldest first
  const daily = db
    .select({
      day: sql<string>`strftime('%Y-%m-%d', ${turns.createdAt} / 1000, 'unixepoch', 'localtime')`,
      tokens: sql<number>`sum(${turns.inputTokens} + ${turns.outputTokens})`,
      turns: sql<number>`count(*)`,
    })
    .from(turns)
    .where(window)
    .groupBy(sql`1`)
    .orderBy(sql`1`)
    .all()

  const recent = db
    .select({
      id: turns.id,
      model: turns.model,
      status: turns.status,
      input: turns.inputTokens,
      output: turns.outputTokens,
      steps: turns.steps,
      toolCalls: turns.toolCalls,
      durationMs: turns.durationMs,
      error: turns.error,
      createdAt: turns.createdAt,
      threadId: turns.threadId,
      agentName: agents.name,
      agentGlyph: agents.glyph,
    })
    .from(turns)
    .leftJoin(agents, eq(turns.agentId, agents.id))
    .orderBy(desc(turns.createdAt))
    .limit(25)
    .all()

  // Costs, worked out per turn so each is priced for its own model and date
  const custom = getCustomPrices()
  const monthStart = startOfMonth()
  const from = new Date(Math.min(since.getTime(), monthStart.getTime()))
  const costRows = db
    .select({
      id: turns.id,
      model: turns.model,
      agentId: turns.agentId,
      input: turns.inputTokens,
      output: turns.outputTokens,
      cached: turns.cachedTokens,
      steps: turns.steps,
      costMicros: turns.costMicros,
      createdAt: turns.createdAt,
    })
    .from(turns)
    .where(gte(turns.createdAt, from))
    .all()

  const spend = { total: 0, month: 0, estimated: false, unpriced: 0 }
  const modelCost = new Map<string, number>()
  const agentCost = new Map<string, number>()
  const dayCost = new Map<string, number>()
  const turnCosts = new Map<string, number | null>()
  for (const row of costRows) {
    const cost = turnCost(row, custom)
    turnCosts.set(row.id, cost?.usd ?? null)
    if (row.createdAt >= monthStart && cost) spend.month += cost.usd
    if (row.createdAt < since) continue
    if (!cost) {
      spend.unpriced++
      continue
    }
    spend.total += cost.usd
    if (cost.estimated && cost.usd > 0) spend.estimated = true
    modelCost.set(row.model, (modelCost.get(row.model) ?? 0) + cost.usd)
    if (row.agentId)
      agentCost.set(row.agentId, (agentCost.get(row.agentId) ?? 0) + cost.usd)
    const day = format(row.createdAt, "yyyy-MM-dd")
    dayCost.set(day, (dayCost.get(day) ?? 0) + cost.usd)
  }

  return {
    days,
    totals,
    byModel: byModel.map((row) => {
      const price = findPrice(row.model, { custom })
      return {
        ...row,
        cost: price ? (modelCost.get(row.model) ?? 0) : null,
        local: price?.kind === "local",
        priceSource: price?.kind === "priced" ? price.source : null,
      }
    }),
    byAgent: byAgent.map((row) => ({
      ...row,
      cost: row.agentId ? (agentCost.get(row.agentId) ?? 0) : 0,
    })),
    daily: daily.map((row) => ({ ...row, cost: dayCost.get(row.day) ?? 0 })),
    recent: recent.map((row) => ({ ...row, cost: turnCosts.get(row.id) ?? null })),
    spend,
    budget: getMonthlyBudget(),
    pricesAsOf: PRICES_AS_OF,
  }
}

export type UsageData = ReturnType<typeof getUsage>

/* ──────────────────────────── routines ──────────────────────────── */

const RUNS_SHOWN = 20

// A routine's latest runs, with what each cost from the ledger
function routineHistory(routineId: string) {
  return db
    .select({
      id: routineRuns.id,
      trigger: routineRuns.trigger,
      status: routineRuns.status,
      detail: routineRuns.detail,
      dueAt: routineRuns.dueAt,
      startedAt: routineRuns.startedAt,
      finishedAt: routineRuns.finishedAt,
      turnId: routineRuns.turnId,
      model: turns.model,
      costMicros: turns.costMicros,
    })
    .from(routineRuns)
    .leftJoin(turns, eq(turns.id, routineRuns.turnId))
    .where(eq(routineRuns.routineId, routineId))
    .orderBy(desc(routineRuns.startedAt))
    .limit(RUNS_SHOWN)
    .all()
    .map((run) => ({
      id: run.id,
      trigger: run.trigger,
      status: run.status,
      detail: run.detail,
      // A missed run is shown at the time it was due
      at: (run.status === "skipped" && run.dueAt
        ? run.dueAt
        : run.startedAt
      ).toISOString(),
      durationMs:
        run.status !== "skipped" && run.finishedAt
          ? run.finishedAt.getTime() - run.startedAt.getTime()
          : null,
      cost: run.turnId
        ? {
            usd: run.costMicros === null ? null : fromMicros(run.costMicros),
            free: !!run.model && isFree(run.model),
          }
        : null,
    }))
}

export function getRoutines() {
  const totals = new Map(
    db
      .select({
        routineId: routineRuns.routineId,
        runs: sql<number>`sum(${routineRuns.status} != 'skipped')`,
        skipped: sql<number>`sum(${routineRuns.status} = 'skipped')`,
        costMicros: sql<number | null>`sum(${turns.costMicros})`,
      })
      .from(routineRuns)
      .leftJoin(turns, eq(turns.id, routineRuns.turnId))
      .groupBy(routineRuns.routineId)
      .all()
      .map((row) => [row.routineId, row])
  )
  return db
    .select()
    .from(routines)
    .orderBy(asc(routines.createdAt))
    .all()
    .map((routine) => ({
      id: routine.id,
      name: routine.name,
      agentId: routine.agentId,
      squadId: routine.squadId,
      prompt: routine.prompt,
      schedule: routine.schedule,
      when: describeSchedule(routine.schedule),
      enabled: routine.enabled,
      nextRunAt: routine.nextRunAt?.toISOString() ?? null,
      lastRunAt: routine.lastRunAt?.toISOString() ?? null,
      lastStatus: isRoutineRunning(routine.id)
        ? ("running" as const)
        : routine.lastStatus === "running"
          ? null
          : routine.lastStatus,
      lastError: routine.lastError,
      href: threadHref(routine),
      history: routineHistory(routine.id),
      totals: {
        runs: totals.get(routine.id)?.runs ?? 0,
        skipped: totals.get(routine.id)?.skipped ?? 0,
        usd: fromMicros(totals.get(routine.id)?.costMicros ?? 0),
      },
    }))
}

export type RoutineView = ReturnType<typeof getRoutines>[number]
