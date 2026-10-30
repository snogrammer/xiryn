import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

// Xiryn has no accounts, but it does have one secret: a random key made on
// first run and kept in the data directory, which is never mounted into a
// workstation. A browser proves it was handed the key by carrying it in a
// cookie, so a client that merely reaches the port (an agent's workstation
// through host.docker.internal, a device on the LAN) can't drive Xiryn.
// Delete data/access.key and restart to sign every browser out.

export const ACCESS_COOKIE = "xiryn_key"
// Same directory as db/index.ts, resolved here so the proxy doesn't pull in
// the database driver
const DATA_DIR = path.resolve(
  /*turbopackIgnore: true*/ process.env.XIRYN_DATA_DIR || "data"
)
const KEY_FILE = path.join(DATA_DIR, "access.key")

let cached: string | null = null

export function accessKey() {
  if (cached) return cached
  try {
    cached = fs.readFileSync(KEY_FILE, "utf8").trim() || null
  } catch {}
  if (!cached) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    cached = crypto.randomBytes(32).toString("base64url")
    fs.writeFileSync(KEY_FILE, cached + "\n", { mode: 0o600 })
  }
  return cached
}

export function checkKey(candidate: string | null | undefined) {
  if (!candidate) return false
  const given = Buffer.from(candidate)
  const expected = Buffer.from(accessKey())
  return given.length === expected.length && crypto.timingSafeEqual(given, expected)
}

// The address that signs a browser in: open it once per browser or device
export function signInUrl() {
  const base = (process.env.XIRYN_URL || "http://127.0.0.1:6796").replace(/\/+$/, "")
  return `${base}/?key=${accessKey()}`
}
