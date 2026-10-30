// Runs once when the Xiryn server boots
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return

  // The access key every browser needs (made on first run), and the link
  // that hands it over
  const { signInUrl } = await import("./lib/access")
  console.log(`[xiryn] sign in: ${signInUrl()}`)

  // Open the database (and apply pending migrations) before the first request
  const { connect } = await import("./db")
  connect()

  // One-time vault entries (codes, a card for one payment) are cleared once
  // they can't be used
  const { sweepVault } = await import("./lib/vault")
  sweepVault()
  const shared = globalThis as { __xirynVaultSweep?: NodeJS.Timeout }
  shared.__xirynVaultSweep ??= setInterval(sweepVault, 10 * 60_000)
  shared.__xirynVaultSweep.unref()

  // Screenshots live on disk: move any still inside messages, and drop those
  // of deleted threads or past their retention
  const { migrateInlineScreens, sweepScreens } = await import("./lib/screens")
  try {
    migrateInlineScreens()
  } catch (error) {
    console.error("[xiryn] moving screenshots to disk:", error)
  }
  sweepScreens()
  const screens = globalThis as { __xirynScreenSweep?: NodeJS.Timeout }
  screens.__xirynScreenSweep ??= setInterval(sweepScreens, 60 * 60_000)
  screens.__xirynScreenSweep.unref()

  // Resume the Telegram bridge if a bot token is configured
  const { syncTelegram } = await import("./lib/telegram/bridge")
  syncTelegram()

  // Routines: tasks agents run on their own, on a schedule
  const { startRoutines } = await import("./lib/routines")
  startRoutines()

  // Workstations: see whether Docker is there, tidy up after deleted agents,
  // and get the workstation image ready so the first task doesn't wait for it
  const { probeEngine } = await import("./lib/docker")
  const { startWorkstationJanitor } = await import("./lib/workstation")
  const { buildImage, getImageState } = await import("./lib/workstation-image")
  const engine = await probeEngine().catch(() => null)
  startWorkstationJanitor()
  if (engine?.state === "ready") {
    getImageState()
      .then((image) => {
        if (image.state === "absent") {
          console.log("[xiryn] building the agent workstation image (first run only)…")
          return buildImage().then((tag) =>
            console.log(`[xiryn] workstation image ready: ${tag}`)
          )
        }
      })
      .catch((error) => console.error("[xiryn] workstation image:", error))
  }
}
