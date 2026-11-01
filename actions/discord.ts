"use server"

import { revalidatePath } from "next/cache"

import { setSetting } from "@/lib/config"
import {
  discordStatus,
  regeneratePairCode,
  syncDiscord,
  unpairDiscord,
} from "@/lib/discord/bridge"

// Everything the Discord part of Remote access shows
export async function getDiscordPanel() {
  syncDiscord()
  return discordStatus()
}

export type DiscordPanel = Awaited<ReturnType<typeof getDiscordPanel>>

export async function saveDiscordToken(token: string | null) {
  const value = token?.trim() || null
  if (value && !/^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/.test(value)) {
    throw new Error(
      "That doesn't look like a bot token. Copy it from the Developer Portal: your app → Bot → Reset Token."
    )
  }
  setSetting("discord.botToken", value)
  if (!value) unpairDiscord()
  syncDiscord()
  // Wait for Discord's first answer (or refusal) so the panel can show the
  // bot's name
  let panel = await getDiscordPanel()
  for (
    let waited = 0;
    value && !panel.bot && !panel.error && waited < 15_000;
    waited += 500
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    panel = await getDiscordPanel()
  }
  revalidatePath("/", "layout")
  return panel
}

export async function newDiscordPairingCode() {
  regeneratePairCode()
  return getDiscordPanel()
}

export async function unpairDiscordAccount() {
  unpairDiscord()
  revalidatePath("/", "layout")
  return getDiscordPanel()
}
