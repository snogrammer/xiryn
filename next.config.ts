import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  // Server action arguments can contain API keys; keep them out of the terminal
  logging: { serverFunctions: false },
  // Xiryn ships its own contributor guide; don't let `next dev` write one
  agentRules: false,
  // Native or Node-only packages that must not be bundled
  serverExternalPackages: ["better-sqlite3", "ws", "discord.js"],
}

export default nextConfig
