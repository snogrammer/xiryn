import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  Partials,
  type Interaction,
  type Message,
  type MessageCreateOptions,
  type SendableChannels,
} from "discord.js"

import { getSetting } from "@/lib/config"
import {
  getPairCode as pairCodeFor,
  onButton,
  onMessage,
  ownerName,
  ownerOf,
  regeneratePairCode as newPairCode,
  registerChannel,
  unpair,
  type Button,
  type Channel,
  type Sent,
} from "@/lib/remote/core"
import { reportError } from "@/lib/report"

/* ────────────────────────────────────────────────────────────────────
 * Remote access over Discord.
 *
 * Xiryn connects out to Discord's gateway from this machine, like Telegram's
 * long polling: no public URL, no webhook, no tunnel. The bot works in
 * direct messages only, with the one Discord account that paired. This
 * file is the Discord side: the connection, slash commands, buttons and
 * Discord's message limits. Everything else is lib/remote/core.ts.
 * ──────────────────────────────────────────────────────────────────── */

type BridgeState = {
  generation: number
  token: string | null
  client: Client | null
  bot: { id: string; username: string } | null
  error: string | null
  rejected: string | null
}

const state = ((globalThis as { __xirynDiscord?: BridgeState }).__xirynDiscord ??= {
  generation: 0,
  token: null,
  client: null,
  bot: null,
  error: null,
  rejected: null,
})

// Typed in Discord's command picker; each becomes the same "/name args"
// text the core reads from Telegram
const COMMANDS = [
  { name: "agents", description: "Pick the agent or squad to talk to" },
  { name: "new", description: "Start a fresh thread" },
  { name: "stop", description: "Stop the turn in progress" },
  { name: "status", description: "What Xiryn is running" },
  { name: "help", description: "How this works" },
  { name: "pair", description: "Pair this account with Xiryn", option: "code" },
  {
    name: "code",
    description: "Give an agent the one-time code it asked for",
    option: "code",
  },
  { name: "cancel", description: "Stop waiting for a code" },
]

/* ───────────────────────────── state ──────────────────────────── */

export const getPairCode = () => pairCodeFor("discord")
export const regeneratePairCode = () => newPairCode("discord")
export const unpairDiscord = () => unpair("discord")

export function discordStatus() {
  const token = getSetting("discord.botToken")
  const owner = ownerOf("discord")
  return {
    configured: !!token,
    running: !!state.client?.isReady() && state.token === token,
    bot: state.bot,
    error: state.error,
    owner: owner ? { id: owner, name: ownerName("discord") ?? owner } : null,
    pairCode: owner ? null : token ? getPairCode() : null,
    // Adds the bot to a server you're in, so you can message it
    invite: state.bot
      ? `https://discord.com/oauth2/authorize?client_id=${state.bot.id}&scope=bot+applications.commands&permissions=0`
      : null,
  }
}

export type DiscordStatus = ReturnType<typeof discordStatus>

/* ─────────────────────────── lifecycle ────────────────────────── */

// Connects, reconnects or disconnects so it matches the configured token.
// Safe to call any number of times.
export function syncDiscord() {
  registerChannel(discord)
  const token = getSetting("discord.botToken") ?? null
  if (token === state.token && (state.client || !token || state.rejected === token))
    return

  state.generation++
  void state.client?.destroy()
  state.client = null
  state.token = token
  state.bot = null
  state.error = null
  state.rejected = null
  if (!token) return
  void connect(state.generation, token)
}

async function connect(generation: number, token: string) {
  const client = new Client({
    // Direct messages only: no server message content, no privileged intents
    intents: [GatewayIntentBits.DirectMessages],
    // DM channels aren't cached until something happens in them
    partials: [Partials.Channel],
  })
  state.client = client
  const live = () => state.generation === generation

  client.once(Events.ClientReady, async (ready) => {
    if (!live()) return
    state.bot = { id: ready.user.id, username: ready.user.username }
    state.error = null
    console.log(`[xiryn] discord: connected as ${ready.user.tag}`)
    await ready.application.commands
      .set(
        COMMANDS.map((command) => ({
          name: command.name,
          description: command.description,
          contexts: [InteractionContextType.BotDM],
          ...(command.option && {
            options: [
              {
                name: command.option,
                description: command.option,
                type: ApplicationCommandOptionType.String,
                required: true,
              },
            ],
          }),
        }))
      )
      .catch((error) => reportError("discord commands", error))
  })

  client.on(Events.MessageCreate, (message) => {
    if (!live()) return
    void handleMessage(message).catch((error) => reportError("discord message", error))
  })
  client.on(Events.InteractionCreate, (interaction) => {
    if (!live()) return
    void handleInteraction(interaction).catch((error) =>
      reportError("discord interaction", error)
    )
  })
  client.on(Events.Error, (error) => {
    state.error = `Discord: ${error.message}`
  })

  try {
    await client.login(token)
  } catch (error) {
    if (!live()) return
    const message = error instanceof Error ? error.message : String(error)
    state.error = /token/i.test(message)
      ? "Discord rejected the bot token. Copy it again from the Developer Portal (Bot → Reset Token)."
      : `Can't reach Discord: ${message}`
    state.rejected = token
    state.client = null
    void client.destroy()
  }
}

/* ─────────────────────────── incoming ─────────────────────────── */

async function handleMessage(message: Message) {
  // Direct messages from people only
  if (message.author.bot || message.channel.type !== ChannelType.DM) return
  await onMessage(discord, {
    chat: message.channelId,
    userId: message.author.id,
    userName: message.author.username,
    text: message.content,
    message: { chat: message.channelId, id: message.id },
  })
}

async function handleInteraction(interaction: Interaction) {
  if (interaction.isChatInputCommand()) {
    const code = interaction.options.getString("code")
    // Only the person sees this; the answer comes as messages in the DM
    await interaction.reply({ content: "…", flags: "Ephemeral" })
    await onMessage(discord, {
      chat: interaction.channelId,
      userId: interaction.user.id,
      userName: interaction.user.username,
      text: `/${interaction.commandName}${code ? ` ${code}` : ""}`,
    })
    await interaction.deleteReply().catch(() => {})
    return
  }
  if (interaction.isButton()) {
    const ack = await onButton(discord, {
      chat: interaction.channelId,
      userId: interaction.user.id,
      data: interaction.customId,
      message: { chat: interaction.channelId, id: interaction.message.id },
    })
    await interaction
      .reply({ content: ack ?? "✓", flags: "Ephemeral" })
      .catch(() => interaction.deferUpdate().catch(() => {}))
  }
}

/* ──────────────────────────── sending ─────────────────────────── */

const LIMIT = 2000

// Discord's message limit, breaking at paragraphs, then lines, then anywhere
export function splitForDiscord(markdown: string) {
  const parts: string[] = []
  let rest = markdown.trim()
  while (rest.length > LIMIT) {
    const window = rest.slice(0, LIMIT)
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"))
    const at = cut > LIMIT / 2 ? cut : LIMIT
    parts.push(rest.slice(0, at).trimEnd())
    rest = rest.slice(at).trimStart()
  }
  if (rest) parts.push(rest)
  return parts
}

// Up to 5 buttons a row and 5 rows a message: the core's rows are packed
// into that, spilling into more messages when there are many agents
export function buttonMessages(buttons: Button[][]) {
  const flat = buttons.flat()
  const messages: ActionRowBuilder<ButtonBuilder>[][] = []
  for (let i = 0; i < flat.length; i += 25) {
    const page = flat.slice(i, i + 25)
    const rows: ActionRowBuilder<ButtonBuilder>[] = []
    for (let j = 0; j < page.length; j += 5) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          page.slice(j, j + 5).map((button) =>
            new ButtonBuilder()
              .setCustomId(button.data.slice(0, 100))
              .setLabel(button.label.slice(0, 80))
              .setStyle(
                button.data.endsWith(":decline")
                  ? ButtonStyle.Secondary
                  : ButtonStyle.Primary
              )
          )
        )
      )
    }
    messages.push(rows)
  }
  return messages
}

async function sendable(chat: string): Promise<SendableChannels> {
  const client = state.client
  if (!client?.isReady()) throw new Error("Discord isn't connected.")
  const channel = await client.channels.fetch(chat)
  if (!channel?.isSendable()) throw new Error("Can't send to that Discord channel.")
  return channel
}

// The Discord side of lib/remote/core.ts
const discord: Channel = {
  id: "discord",
  name: "Discord",
  ready: () => !!state.client?.isReady() && !!state.bot,
  handle: () => state.bot?.username,

  async send(chat, markdown, options = {}) {
    const channel = await sendable(chat)
    const texts = splitForDiscord(markdown)
    const keyboards = options.buttons ? buttonMessages(options.buttons) : []
    let last: Message | null = null
    for (const [index, content] of texts.entries()) {
      const payload: MessageCreateOptions = {
        content,
        // No pings and no link cards: a preview is a request Discord makes
        allowedMentions: { parse: [] },
        flags: options.silent
          ? ["SuppressEmbeds", "SuppressNotifications"]
          : ["SuppressEmbeds"],
        ...(index === texts.length - 1 && keyboards[0] && { components: keyboards[0] }),
      }
      last = await channel.send(payload)
    }
    // More buttons than one message holds
    for (const rows of keyboards.slice(1)) {
      last = await channel.send({ content: "…", components: rows })
    }
    return last ? { chat, id: last.id } : null
  },

  async edit(message: Sent, markdown, options = {}) {
    const channel = await sendable(message.chat)
    const existing = await channel.messages.fetch(message.id)
    await existing.edit({
      content: splitForDiscord(markdown)[0] ?? "…",
      components: options.buttons ? (buttonMessages(options.buttons)[0] ?? []) : [],
      allowedMentions: { parse: [] },
    })
  },

  async remove(message) {
    // Discord doesn't let bots delete what someone wrote in a DM; /code
    // never posts the code, so this only matters for a code typed plainly
    const channel = await sendable(message.chat)
    const existing = await channel.messages.fetch(message.id)
    if (existing.author.id === state.bot?.id) await existing.delete()
  },

  async photo(chat, image, caption) {
    const channel = await sendable(chat)
    const extension = image.mediaType.split("/")[1] ?? "jpg"
    await channel.send({
      ...(caption && { content: caption }),
      files: [
        { attachment: Buffer.from(image.base64, "base64"), name: `screen.${extension}` },
      ],
      allowedMentions: { parse: [] },
    })
  },

  async typing(chat) {
    await (await sendable(chat)).sendTyping()
  },
}
