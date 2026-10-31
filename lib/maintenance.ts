import { lt } from "drizzle-orm"

import { db } from "@/db"
import { routineRuns } from "@/db/schema"

// Housekeeping for a server that runs for months. SQLite asks long-lived
// connections to run `PRAGMA optimize` now and then; the WAL file only
// shrinks when it's checkpointed; and a routine's history would otherwise
// keep a line for every run forever.

// Days of routine history kept; the turns (and what they cost) stay
const ROUTINE_HISTORY_DAYS = 90

function hourly() {
  db.$client.pragma("optimize")
}

function daily() {
  const before = new Date(Date.now() - ROUTINE_HISTORY_DAYS * 24 * 60 * 60_000)
  db.delete(routineRuns).where(lt(routineRuns.startedAt, before)).run()
  db.$client.pragma("wal_checkpoint(TRUNCATE)")
}

export function startMaintenance() {
  const shared = globalThis as {
    __xirynMaintenance?: { hourly: NodeJS.Timeout; daily: NodeJS.Timeout }
  }
  if (shared.__xirynMaintenance) return
  const safely = (task: () => void, name: string) => () => {
    try {
      task()
    } catch (error) {
      console.error(`[xiryn] maintenance (${name}):`, error)
    }
  }
  safely(daily, "daily")()
  shared.__xirynMaintenance = {
    hourly: setInterval(safely(hourly, "hourly"), 60 * 60_000),
    daily: setInterval(safely(daily, "daily"), 24 * 60 * 60_000),
  }
  shared.__xirynMaintenance.hourly.unref()
  shared.__xirynMaintenance.daily.unref()
}
