#!/usr/bin/env node
// Prints the link that signs a browser in to Xiryn (open it once per browser
// or device). The key behind it is made the first time Xiryn starts.
//
//   npm run link              print it
//   npm run link -- --open    print it and open it in your browser

import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const dataDir = path.resolve(root, process.env.XIRYN_DATA_DIR || "data")
const base = (process.env.XIRYN_URL || "http://127.0.0.1:6796").replace(/\/+$/, "")

let key = ""
try {
  key = readFileSync(path.join(dataDir, "access.key"), "utf8").trim()
} catch {}
if (!key) {
  console.log("No access key yet: start Xiryn once (npm run dev) and it makes one.")
  process.exit(1)
}

const url = `${base}/?key=${key}`
console.log(url)

if (process.argv.includes("--open")) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]]
  spawn(command, args, { stdio: "ignore", detached: true }).unref()
}
