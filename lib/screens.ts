import fs from "node:fs"
import path from "node:path"

import { eq, like } from "drizzle-orm"

import { DATA_DIR, db } from "@/db"
import { messages, threads } from "@/db/schema"
import { getSetting, setSetting } from "@/lib/config"

// Screenshots are the heaviest thing a thread holds (100–250 KB each). Kept
// inside messages.parts they were parsed on every load and shipped to the
// browser with every render, so a saved reply keeps a reference instead:
// `screen: "<threadId>/<screenId>"`, a JPEG under data/screens/. The page
// loads them from /api/screens/…; the model and Telegram read them from disk.

const SCREENS_DIR = path.join(DATA_DIR, "screens")
const SAFE = /^[A-Za-z0-9_-]{1,80}$/

type ScreenOutput = { image?: string | null; screen?: string | null }

function fileFor(ref: string) {
  const [threadId, screenId, ...rest] = ref.split("/")
  if (rest.length || !SAFE.test(threadId ?? "") || !SAFE.test(screenId ?? "")) return null
  return path.join(SCREENS_DIR, threadId, `${screenId}.jpg`)
}

export function readScreenFile(ref: string) {
  const file = fileFor(ref)
  if (!file) return null
  try {
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

// The picture behind a tool output, inline or on disk, as base64
export function screenOf(output: ScreenOutput) {
  if (output.image) return output.image
  if (!output.screen) return null
  return readScreenFile(output.screen)?.toString("base64") ?? null
}

function hasInlineScreen(part: unknown): part is { output: ScreenOutput } {
  const output = (part as { output?: unknown }).output
  return (
    typeof output === "object" &&
    output !== null &&
    typeof (output as ScreenOutput).image === "string" &&
    !!(output as ScreenOutput).image
  )
}

// Moves a message's screenshots to disk, leaving references in their place
export function externalizeScreens<T extends { id: string; parts: unknown[] }>(
  threadId: string,
  message: T
): T {
  if (!message.parts.some(hasInlineScreen)) return message
  const parts = message.parts.map((part, index) => {
    if (!hasInlineScreen(part)) return part
    const ref = `${threadId}/${message.id}-${index}`
    const file = fileFor(ref)
    if (!file) return part
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(part.output.image!, "base64"), { mode: 0o600 })
    return { ...part, output: { ...part.output, image: null, screen: ref } }
  })
  return { ...message, parts }
}

// Before screenshots lived on disk they were saved inline; move those out
// once, then give the space back
export function migrateInlineScreens() {
  if (getSetting("screens.migrated")) return
  const rows = db
    .select({ id: messages.id, threadId: messages.threadId, parts: messages.parts })
    .from(messages)
    .where(like(messages.parts, '%"image":"%'))
    .all()
  let moved = 0
  for (const row of rows) {
    const next = externalizeScreens(row.threadId, row)
    if (next === row) continue
    db.update(messages).set({ parts: next.parts }).where(eq(messages.id, row.id)).run()
    moved++
  }
  if (moved) {
    console.log(
      `[xiryn] moved screenshots out of ${moved} messages; compacting the database…`
    )
    db.$client.exec("VACUUM")
  }
  setSetting("screens.migrated", new Date().toISOString())
}

// Days a screenshot is kept; null keeps them as long as their thread
function retentionDays() {
  const value = Number.parseInt(getSetting("screens.retentionDays") ?? "", 10)
  if (value === 0) return null
  return Number.isFinite(value) && value > 0 ? value : 30
}

// Drops the screenshots of deleted threads, and those past the retention
export function sweepScreens() {
  let dirs: string[] = []
  try {
    dirs = fs.readdirSync(SCREENS_DIR)
  } catch {
    return
  }
  const days = retentionDays()
  const before = days ? Date.now() - days * 24 * 60 * 60_000 : null
  for (const threadId of dirs) {
    const dir = path.join(SCREENS_DIR, threadId)
    const exists = db
      .select({ id: threads.id })
      .from(threads)
      .where(eq(threads.id, threadId))
      .get()
    if (!exists) {
      fs.rmSync(dir, { recursive: true, force: true })
      continue
    }
    if (before === null) continue
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name)
      try {
        if (fs.statSync(file).mtimeMs < before) fs.rmSync(file, { force: true })
      } catch {}
    }
  }
}
