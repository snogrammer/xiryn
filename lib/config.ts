import { eq } from "drizzle-orm"

import { db } from "@/db"
import { settings } from "@/db/schema"
import { providers, type ProviderId } from "@/lib/providers/catalog"

// Every value Xiryn reads from its environment. A value saved from the
// Settings screen wins over the same value in .env, so the UI is always the
// source of truth once something has been set there.

type SettingDef = {
  env: string | null
  secret?: boolean
  fallback?: string
  // Written by Xiryn itself, never through the Settings form
  internal?: boolean
}

const integrationSettings = {
  "model.default": { env: "XIRYN_DEFAULT_MODEL" },
  "agent.maxSteps": { env: "XIRYN_MAX_STEPS", fallback: "40" },
  // Minutes a turn may run before it's stopped as failed; 0 means no limit
  "agent.turnTimeout": { env: "XIRYN_TURN_TIMEOUT_MINUTES", fallback: "30" },
  // US dollars a month; once reached, turns on paid models wait for next month
  "usage.monthlyBudget": { env: "XIRYN_MONTHLY_BUDGET" },
  // Operating-system notifications when no Xiryn tab is open: "on" or "off"
  "notify.desktop": { env: "XIRYN_DESKTOP_NOTIFY", fallback: "on" },
  // JSON: prices the person set for models Xiryn doesn't know, by model spec
  "pricing.custom": { env: null, internal: true },
  // Limits for each agent's workstation container
  "workstation.cpus": { env: "XIRYN_WORKSTATION_CPUS", fallback: "2" },
  "workstation.memory": { env: "XIRYN_WORKSTATION_MEMORY_GB", fallback: "4" },
  // Idle minutes before a workstation stops itself; 0 keeps it running
  "workstation.autoStop": { env: "XIRYN_WORKSTATION_AUTO_STOP_MINUTES", fallback: "15" },
  // Unset keeps workstations until you reset or delete the agent
  "workstation.autoDelete": { env: "XIRYN_WORKSTATION_AUTO_DELETE_MINUTES" },
  // "off" leaves the phone link out of Telegram hand-off notices
  "workstation.phoneLinks": { env: "XIRYN_PHONE_TAKEOVER", fallback: "on" },
  "workstation.installId": { env: null, internal: true },
  // Days a screenshot is kept on disk; 0 keeps them as long as their thread
  "screens.retentionDays": { env: "XIRYN_SCREENSHOT_DAYS", fallback: "30" },
  // When screenshots saved inside messages were moved to disk
  "screens.migrated": { env: null, internal: true },
  // "off" stops the update check and star count (the only request Xiryn makes
  // on its own, to GitHub's public API)
  "updates.check": { env: "XIRYN_UPDATE_CHECK", fallback: "on" },
  "firecrawl.apiKey": { env: "FIRECRAWL_API_KEY", secret: true },
  "firecrawl.apiUrl": { env: "FIRECRAWL_API_URL", fallback: "https://api.firecrawl.dev" },
  "telegram.botToken": { env: "TELEGRAM_BOT_TOKEN", secret: true },
  // Only for self-hosted Bot API servers
  "telegram.apiUrl": { env: "TELEGRAM_API_URL", fallback: "https://api.telegram.org" },
  // Numeric Telegram user id allowed to talk to the bot; set by pairing
  "telegram.ownerId": { env: "TELEGRAM_OWNER_ID" },
  // Finished tasks started in the app: "long" (a minute or more), "all" or "off"
  "telegram.notify": { env: "XIRYN_TELEGRAM_NOTIFY", fallback: "long" },
  "telegram.ownerName": { env: null, internal: true },
  "telegram.pairCode": { env: null, internal: true },
  // When the pairing code was made (it expires) and wrong guesses since
  "telegram.pairCodeAt": { env: null, internal: true },
  "telegram.pairFailures": { env: null, internal: true },
  // The next update to ask Telegram for, so a restart doesn't replay any
  "telegram.offset": { env: null, internal: true },
  // JSON: which agent/squad and thread Telegram messages go to
  "telegram.target": { env: null, internal: true },
} satisfies Record<string, SettingDef>

const providerSettings = Object.fromEntries(
  providers.flatMap((p) => [
    [`provider.${p.id}.apiKey`, { env: p.keyEnv, secret: true }],
    [
      `provider.${p.id}.baseUrl`,
      { env: p.baseUrlEnv, fallback: p.defaultBaseUrl || undefined },
    ],
  ])
) as Record<`provider.${ProviderId}.${"apiKey" | "baseUrl"}`, SettingDef>

const definitions: Record<string, SettingDef> = {
  ...integrationSettings,
  ...providerSettings,
}

export type SettingKey = keyof typeof integrationSettings | keyof typeof providerSettings
export type SettingSource = "local" | "env" | "default" | null

export function isSettingKey(key: string): key is SettingKey {
  return key in definitions
}

// Keys the Settings screen may write
export function isWritableSetting(key: string): key is SettingKey {
  return isSettingKey(key) && !definitions[key].internal && key !== "telegram.ownerId"
}

export function isSecretSetting(key: SettingKey) {
  return !!definitions[key].secret
}

function envValue(key: SettingKey) {
  const name = definitions[key].env
  const value = name ? process.env[name]?.trim() : undefined
  return value || undefined
}

function storedValue(key: SettingKey) {
  const row = db.select().from(settings).where(eq(settings.key, key)).get()
  return row?.value || undefined
}

export function getSetting(key: SettingKey): string | undefined {
  return storedValue(key) ?? envValue(key) ?? definitions[key].fallback
}

export function getSettingSource(key: SettingKey): SettingSource {
  if (storedValue(key)) return "local"
  if (envValue(key)) return "env"
  if (definitions[key].fallback) return "default"
  return null
}

// Null or "" removes the saved value, so .env (or the default) applies again
export function setSetting(key: SettingKey, value: string | null) {
  const trimmed = value?.trim()
  if (!trimmed) {
    db.delete(settings).where(eq(settings.key, key)).run()
    return
  }
  db.insert(settings)
    .values({ key, value: trimmed, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: trimmed, updatedAt: new Date() },
    })
    .run()
}

// Enough of a secret to recognise it, never enough to use it
export function maskSecret(value: string | undefined) {
  if (!value) return null
  if (value.length <= 8) return "••••"
  return `${value.slice(0, 3)}…${value.slice(-4)}`
}

export function describeSetting(key: SettingKey) {
  const value = getSetting(key)
  const source = getSettingSource(key)
  return {
    key,
    env: definitions[key].env,
    source,
    set: source === "local" || source === "env",
    value: isSecretSetting(key) ? maskSecret(value) : (value ?? null),
  }
}

export type SettingView = ReturnType<typeof describeSetting>

export function getMaxSteps() {
  const value = Number.parseInt(getSetting("agent.maxSteps") ?? "", 10)
  return Number.isFinite(value) && value > 0 ? Math.min(value, 200) : 40
}

// How long a turn may run, in minutes; null when there's no limit
export function getTurnTimeoutMinutes() {
  const value = Number.parseInt(getSetting("agent.turnTimeout") ?? "", 10)
  if (value === 0) return null
  return Number.isFinite(value) && value > 0 ? Math.min(value, 1440) : 30
}
