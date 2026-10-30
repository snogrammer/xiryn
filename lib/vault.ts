import { spawnSync } from "node:child_process"
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { and, desc, eq } from "drizzle-orm"
import { z } from "zod"

import { db, DATA_DIR, DB_PATH } from "@/db"
import { vaultApprovals, vaultItems } from "@/db/schema"

// The person's vault: saved logins, cards, UPI IDs and personal details.
//
// Values are encrypted with AES-256-GCM. The key never sits next to the
// database: the operating system keeps it (macOS Keychain, Windows DPAPI,
// the Linux Secret Service), or, where none of those exist, a file readable
// only by you outside the data folder. Agents see labels and hints; when a
// value is needed, Xiryn types it into the page itself.

export type VaultKind = "card" | "upi" | "login" | "identity" | "code"

/* ───────────────────────────── the key ───────────────────────────── */

const SERVICE = "xiryn-vault"
// One key per installation, so two copies of Xiryn don't share one
const ACCOUNT = createHash("sha256").update(DB_PATH).digest("hex").slice(0, 16)

export type KeySource = "env" | "keychain" | "dpapi" | "secret-service" | "file"

export class VaultLockedError extends Error {
  name = "VaultLockedError"
  constructor() {
    super(
      "The vault's key is missing, so saved items can't be opened. If you moved Xiryn to another computer or user account, add them again."
    )
  }
}

const run = (
  command: string,
  args: string[],
  input?: string,
  env?: Record<string, string>
) =>
  spawnSync(command, args, {
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    env: env ? { ...process.env, ...env } : process.env,
  })

const keyFileDir =
  process.env.XIRYN_VAULT_KEY_DIR ||
  // In a container the home folder doesn't survive; the data volume does
  (fs.existsSync("/.dockerenv") ? DATA_DIR : path.join(os.homedir(), ".xiryn"))
const keyFile = path.join(keyFileDir, `vault-${ACCOUNT}.key`)
const dpapiFile = path.join(DATA_DIR, "vault.key.dpapi")

type Store = {
  source: KeySource
  read: () => string | null
  write: (base64: string) => boolean
}

const PS_DPAPI = (verb: "Protect" | "Unprotect") =>
  `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String($env:XIRYN_VAULT_IN); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${verb}($b,$null,'CurrentUser'))`

const stores: Store[] = [
  {
    source: "env",
    read: () => process.env.XIRYN_VAULT_KEY?.trim() || null,
    write: () => false,
  },
  ...(process.platform === "darwin"
    ? [
        {
          source: "keychain" as const,
          read: () => {
            const result = run("security", [
              "find-generic-password",
              "-s",
              SERVICE,
              "-a",
              ACCOUNT,
              "-w",
            ])
            return result.status === 0 ? result.stdout.trim() || null : null
          },
          write: (base64: string) =>
            run("security", [
              "add-generic-password",
              "-U",
              "-s",
              SERVICE,
              "-a",
              ACCOUNT,
              "-l",
              "Xiryn vault",
              "-w",
              base64,
            ]).status === 0,
        },
      ]
    : []),
  ...(process.platform === "win32"
    ? [
        {
          source: "dpapi" as const,
          read: () => {
            if (!fs.existsSync(dpapiFile)) return null
            const result = run(
              "powershell",
              ["-NoProfile", "-NonInteractive", "-Command", PS_DPAPI("Unprotect")],
              undefined,
              {
                XIRYN_VAULT_IN: fs.readFileSync(dpapiFile, "utf8").trim(),
              }
            )
            return result.status === 0 ? result.stdout.trim() || null : null
          },
          write: (base64: string) => {
            const result = run(
              "powershell",
              ["-NoProfile", "-NonInteractive", "-Command", PS_DPAPI("Protect")],
              undefined,
              {
                XIRYN_VAULT_IN: base64,
              }
            )
            if (result.status !== 0 || !result.stdout.trim()) return false
            fs.mkdirSync(path.dirname(dpapiFile), { recursive: true })
            fs.writeFileSync(dpapiFile, result.stdout.trim(), { mode: 0o600 })
            return true
          },
        },
      ]
    : []),
  ...(process.platform === "linux"
    ? [
        {
          source: "secret-service" as const,
          read: () => {
            const result = run("secret-tool", [
              "lookup",
              "service",
              SERVICE,
              "account",
              ACCOUNT,
            ])
            return result.status === 0 ? result.stdout.trim() || null : null
          },
          write: (base64: string) =>
            run(
              "secret-tool",
              ["store", "--label=Xiryn vault", "service", SERVICE, "account", ACCOUNT],
              base64
            ).status === 0,
        },
      ]
    : []),
  {
    source: "file",
    read: () =>
      fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8").trim() || null : null,
    write: (base64: string) => {
      fs.mkdirSync(keyFileDir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(keyFile, base64, { mode: 0o600 })
      return true
    },
  },
]

const globalForVault = globalThis as unknown as {
  __xirynVault?: { key: Buffer; source: KeySource } | null
}

function decodeKey(base64: string) {
  const key = Buffer.from(base64, "base64")
  return key.length === 32 ? key : null
}

// The vault key, created on first use. Never recreated while items exist:
// that would make them unreadable instead of revealing the problem.
function vaultKey(): { key: Buffer; source: KeySource } {
  if (globalForVault.__xirynVault) return globalForVault.__xirynVault
  for (const store of stores) {
    const found = store.read()
    const key = found ? decodeKey(found) : null
    if (key) return (globalForVault.__xirynVault = { key, source: store.source })
  }
  if (db.select({ id: vaultItems.id }).from(vaultItems).limit(1).get()) {
    throw new VaultLockedError()
  }
  const fresh = randomBytes(32)
  for (const store of stores) {
    if (store.write(fresh.toString("base64"))) {
      return (globalForVault.__xirynVault = { key: fresh, source: store.source })
    }
  }
  throw new Error("Couldn't store the vault key anywhere on this computer.")
}

export function vaultKeySource(): KeySource | null {
  try {
    return vaultKey().source
  } catch {
    return null
  }
}

/* ──────────────────────────── sealing ───────────────────────────── */

type Fields = Record<string, string>

function seal(id: string, kind: VaultKind, fields: Fields) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", vaultKey().key, iv)
  // Binds the ciphertext to its row: it can't be swapped onto another item
  cipher.setAAD(Buffer.from(`${id}:${kind}`))
  const body = Buffer.concat([
    cipher.update(JSON.stringify(fields), "utf8"),
    cipher.final(),
  ])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")
}

function unseal(id: string, kind: VaultKind, secret: string): Fields {
  const raw = Buffer.from(secret, "base64")
  const decipher = createDecipheriv("aes-256-gcm", vaultKey().key, raw.subarray(0, 12))
  decipher.setAAD(Buffer.from(`${id}:${kind}`))
  decipher.setAuthTag(raw.subarray(12, 28))
  const body = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()])
  return JSON.parse(body.toString("utf8")) as Fields
}

/* ───────────────────────────── items ────────────────────────────── */

const digits = (value: string) => value.replace(/\D/g, "")

function luhn(number: string) {
  let sum = 0
  for (let i = 0; i < number.length; i++) {
    let digit = Number(number[number.length - 1 - i])
    if (i % 2 === 1) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
  }
  return sum % 10 === 0
}

export function siteOf(input: string) {
  const value = input.trim().toLowerCase()
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname.replace(
      /^www\./,
      ""
    )
  } catch {
    return value.replace(/^www\./, "")
  }
}

const optional = z.string().trim().max(200).optional().default("")

export const vaultInputSchemas = {
  card: z.object({
    number: z
      .string()
      .transform(digits)
      .refine(
        (n) => n.length >= 12 && n.length <= 19 && luhn(n),
        "That card number isn't valid."
      ),
    expiry: z
      .string()
      .trim()
      .regex(/^(0[1-9]|1[0-2])\s*\/\s*(\d{2}|\d{4})$/, "Expiry looks like MM/YY.")
      .transform((value) => {
        const [month, year] = value.split("/").map((part) => part.trim())
        return `${month}/${year.slice(-2)}`
      }),
    cvv: z
      .string()
      .trim()
      .regex(/^(\d{3,4})?$/, "The security code is 3 or 4 digits.")
      .optional()
      .default(""),
    name: optional,
  }),
  upi: z.object({
    id: z
      .string()
      .trim()
      .regex(/^[\w.-]{2,}@[a-z][\w.-]+$/i, "A UPI ID looks like name@bank."),
  }),
  login: z.object({
    site: z.string().trim().min(3, "Which site is this login for?").transform(siteOf),
    username: z
      .string()
      .trim()
      .min(1, "Add the email, phone number or username.")
      .max(320),
    password: z.string().min(1, "Add the password.").max(1000),
  }),
  identity: z.object({
    name: optional,
    email: optional,
    phone: optional,
    address_line1: optional,
    address_line2: optional,
    city: optional,
    state: optional,
    postcode: optional,
    country: optional,
  }),
  code: z.object({ code: z.string().trim().min(3).max(32) }),
} satisfies Record<VaultKind, z.ZodType>

// What can be typed for each kind, including values derived from others
export const VAULT_FIELDS: Record<VaultKind, readonly string[]> = {
  card: [
    "number",
    "expiry",
    "expiry_month",
    "expiry_year",
    "expiry_year_short",
    "cvv",
    "name",
  ],
  upi: ["id"],
  login: ["username", "password"],
  identity: [
    "name",
    "email",
    "phone",
    "address",
    "address_line1",
    "address_line2",
    "city",
    "state",
    "postcode",
    "country",
  ],
  code: ["code"],
}

function brand(number: string) {
  if (/^4/.test(number)) return "Visa"
  if (/^(5[1-5]|2(2[2-9]|[3-6]|7[01]|720))/.test(number)) return "Mastercard"
  if (/^3[47]/.test(number)) return "Amex"
  if (/^(60|65|81|82|508|353|356)/.test(number)) return "RuPay"
  if (/^6(011|4[4-9])/.test(number)) return "Discover"
  return "Card"
}

function maskHandle(value: string) {
  if (value.includes("@")) {
    const [user, domain] = value.split("@")
    return `${user.slice(0, 1)}•••@${domain}`
  }
  const numbers = digits(value)
  if (numbers.length >= 7) return `•••• ${numbers.slice(-4)}`
  return `${value.slice(0, 2)}•••`
}

function hintFor(kind: VaultKind, fields: Fields) {
  switch (kind) {
    case "card":
      return `${brand(fields.number)} ···· ${fields.number.slice(-4)} · ${fields.expiry}`
    case "upi":
      return `UPI ${maskHandle(fields.id)}`
    case "login":
      return `${maskHandle(fields.username)} · ${fields.site}`
    case "identity":
      return (
        [fields.name, fields.phone && maskHandle(fields.phone), fields.city]
          .filter(Boolean)
          .join(" · ") || "Personal details"
      )
    case "code":
      return "one-time code"
  }
}

function defaultLabel(kind: VaultKind, fields: Fields) {
  switch (kind) {
    case "card":
      return `${brand(fields.number)} ${fields.number.slice(-4)}`
    case "upi":
      return "UPI"
    case "login":
      return fields.site
    case "identity":
      return fields.name || "Me"
    case "code":
      return "Code"
  }
}

export type VaultItemView = {
  id: string
  kind: VaultKind
  label: string
  hint: string
  site: string | null
  lastUsedAt: Date | null
  createdAt: Date
}

const view = (row: typeof vaultItems.$inferSelect): VaultItemView => ({
  id: row.id,
  kind: row.kind,
  label: row.label,
  hint: row.hint,
  site: row.site,
  lastUsedAt: row.lastUsedAt,
  createdAt: row.createdAt,
})

// Items without their values. Saved ones by default; with `temporary`, also
// those given for one task (a one-time code is never listed).
export function listVault({ temporary = false } = {}): VaultItemView[] {
  return db
    .select()
    .from(vaultItems)
    .where(temporary ? undefined : eq(vaultItems.ephemeral, false))
    .orderBy(desc(vaultItems.updatedAt))
    .all()
    .filter((row) => row.kind !== "code")
    .map(view)
}

export function getVaultItem(id: string): VaultItemView | null {
  const row = db.select().from(vaultItems).where(eq(vaultItems.id, id)).get()
  return row ? view(row) : null
}

export function addVaultItem(
  kind: VaultKind,
  input: unknown,
  options: { label?: string; ephemeral?: boolean } = {}
) {
  const parsed = vaultInputSchemas[kind].safeParse(input)
  if (!parsed.success)
    throw new Error(parsed.error.issues[0]?.message ?? "Check the details.")
  const fields = Object.fromEntries(
    Object.entries(parsed.data as Record<string, string>).filter(
      ([, value]) => value !== ""
    )
  )
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12)
  db.insert(vaultItems)
    .values({
      id,
      kind,
      label: options.label?.trim().slice(0, 60) || defaultLabel(kind, fields),
      hint: hintFor(kind, fields),
      site: kind === "login" ? fields.site : null,
      secret: seal(id, kind, fields),
      ephemeral: !!options.ephemeral,
    })
    .run()
  return getVaultItem(id)!
}

export function deleteVaultItem(id: string) {
  db.delete(vaultItems).where(eq(vaultItems.id, id)).run()
}

// The value to type for one field. Server only; never sent to a model or a
// browser.
export function vaultValue(id: string, field: string) {
  const row = db.select().from(vaultItems).where(eq(vaultItems.id, id)).get()
  if (!row) throw new Error("That vault item doesn't exist (any more).")
  if (!VAULT_FIELDS[row.kind].includes(field)) {
    throw new Error(
      `A ${row.kind} has no "${field}". Fields: ${VAULT_FIELDS[row.kind].join(", ")}.`
    )
  }
  const fields = unseal(row.id, row.kind, row.secret)
  const [month, year] = (fields.expiry ?? "").split("/")
  const derived: Fields = {
    expiry_month: month ?? "",
    expiry_year: year ? `20${year}` : "",
    expiry_year_short: year ?? "",
    address: [
      fields.address_line1,
      fields.address_line2,
      fields.city,
      fields.state,
      fields.postcode,
      fields.country,
    ]
      .filter(Boolean)
      .join(", "),
  }
  const value = fields[field] ?? derived[field] ?? ""
  if (!value) throw new Error(`"${row.label}" has no ${field.replace(/_/g, " ")} saved.`)
  return value
}

export function markVaultUsed(id: string) {
  const row = db.select().from(vaultItems).where(eq(vaultItems.id, id)).get()
  if (!row) return
  if (row.ephemeral && row.kind === "code") {
    deleteVaultItem(id)
    return
  }
  db.update(vaultItems).set({ lastUsedAt: new Date() }).where(eq(vaultItems.id, id)).run()
}

// Ephemeral items nobody used are cleared after a day
export function sweepVault() {
  const day = Date.now() - 24 * 60 * 60_000
  for (const row of db
    .select()
    .from(vaultItems)
    .where(eq(vaultItems.ephemeral, true))
    .all()) {
    if (row.createdAt.getTime() < day) deleteVaultItem(row.id)
  }
  sweepApprovalScreens(day)
}

/* ─────────────────────────── approvals ──────────────────────────── */

// How long an approved payment can be acted on
const APPROVAL_MS = 20 * 60_000

export type Approval = typeof vaultApprovals.$inferSelect

export function createApproval(input: {
  threadId: string
  agentId: string
  merchant: string
  amount: string
  purpose?: string
  host: string | null
}) {
  const [row] = db
    .insert(vaultApprovals)
    .values({
      threadId: input.threadId,
      agentId: input.agentId,
      merchant: input.merchant.slice(0, 120),
      amount: input.amount.slice(0, 60),
      purpose: input.purpose?.slice(0, 300) || null,
      host: input.host,
    })
    .returning()
    .all()
  return row
}

// What the agent's screen showed when it asked to pay, for the person to
// check it's the checkout they expect. Kept as a file beside the database,
// not in it, and only until the request is a day old.
const SCREENS_DIR = path.join(DATA_DIR, "approvals")
const screenFile = (id: string) => path.join(SCREENS_DIR, `${path.basename(id)}.jpg`)

export function saveApprovalScreen(id: string, base64: string) {
  fs.mkdirSync(SCREENS_DIR, { recursive: true })
  fs.writeFileSync(screenFile(id), Buffer.from(base64, "base64"), { mode: 0o600 })
}

export function approvalScreen(id: string) {
  try {
    return fs.readFileSync(screenFile(id)).toString("base64")
  } catch {
    return null
  }
}

function sweepApprovalScreens(before: number) {
  let files: string[] = []
  try {
    files = fs.readdirSync(SCREENS_DIR)
  } catch {
    return
  }
  for (const file of files) {
    const approval = getApproval(file.replace(/\.jpg$/, ""))
    if (!approval || approval.createdAt.getTime() < before) {
      fs.rmSync(path.join(SCREENS_DIR, file), { force: true })
    }
  }
}

export function getApproval(id: string) {
  return db.select().from(vaultApprovals).where(eq(vaultApprovals.id, id)).get() ?? null
}

export function decideApproval(
  id: string,
  decision: "approved" | "declined" | "taken-over",
  itemId?: string | null
) {
  const approval = getApproval(id)
  if (!approval) throw new Error("That payment request no longer exists.")
  if (approval.status !== "pending") throw new Error("That payment was already decided.")
  if (decision === "approved") {
    const item = itemId ? getVaultItem(itemId) : null
    if (!item || (item.kind !== "card" && item.kind !== "upi")) {
      throw new Error("Choose a saved card or UPI ID to pay with.")
    }
  }
  db.update(vaultApprovals)
    .set({
      status: decision,
      itemId: decision === "approved" ? itemId : null,
      decidedAt: new Date(),
      expiresAt: decision === "approved" ? new Date(Date.now() + APPROVAL_MS) : null,
    })
    .where(eq(vaultApprovals.id, id))
    .run()
  return getApproval(id)!
}

// The approval that lets an agent type this payment method in this thread
export function activeApproval(threadId: string, itemId: string) {
  return (
    db
      .select()
      .from(vaultApprovals)
      .where(
        and(
          eq(vaultApprovals.threadId, threadId),
          eq(vaultApprovals.itemId, itemId),
          eq(vaultApprovals.status, "approved")
        )
      )
      .orderBy(desc(vaultApprovals.decidedAt))
      .all()
      .find(
        (approval) => approval.expiresAt && approval.expiresAt.getTime() > Date.now()
      ) ?? null
  )
}

// Same site, or one of its subdomains
export function hostMatches(host: string | null, site: string | null) {
  if (!host || !site) return false
  const a = host.replace(/^www\./, "")
  const b = site.replace(/^www\./, "")
  return a === b || a.endsWith(`.${b}`)
}

export function describeApproval(approval: Approval) {
  const item = approval.itemId ? getVaultItem(approval.itemId) : null
  return { ...approval, item }
}
