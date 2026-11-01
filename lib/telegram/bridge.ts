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
import { getSetting, setSetting } from "@/lib/config"
import { reportError } from "@/lib/report"
import {
  callTelegram,
  sendPhoto,
  TelegramError,
  type InlineKeyboard,
  type TgCallbackQuery,
  type TgMessage,
  type TgUpdate,
  type TgUser,
} from "@/lib/telegram/api"
import { markdownToTelegramHtml, plainText, splitMarkdown } from "@/lib/telegram/format"

/* ────────────────────────────────────────────────────────────────────
 * Remote access over Telegram.
 *
 * Xiryn long-polls the Bot API from this machine, so it works behind any
 * router or firewall: no public URL, no webhook, no tunnel. This file is
 * the Telegram side only: polling, and sending in Telegram's formatting.
 * What a message means (pairing, commands, turns, hand-offs) is shared
 * with the other chat apps in lib/remote/core.ts.
 * ──────────────────────────────────────────────────────────────────── */

type BridgeState = {
  generation: number
  token: string | null
  controller: AbortController | null
  bot: { id: number; username: string; name: string } | null
  error: string | null
  lastPollAt: number | null
  queues: Map<number, Promise<void>>
  // A token Telegram refused; not retried until it changes
  rejected: string | null
}

const globalForBridge = globalThis as unknown as { __xirynTelegram?: BridgeState }
const state = (globalForBridge.__xirynTelegram ??= {
  generation: 0,
  token: null,
  controller: null,
  bot: null,
  error: null,
  lastPollAt: null,
  queues: new Map(),
  rejected: null,
} as BridgeState)

const COMMANDS = [
  { command: "agents", description: "Pick the agent or squad to talk to" },
  { command: "new", description: "Start a fresh thread" },
  { command: "stop", description: "Stop the turn in progress" },
  { command: "status", description: "What Xiryn is running" },
  { command: "help", description: "How this works" },
]

/* ───────────────────────────── state ──────────────────────────── */

export const getPairCode = () => pairCodeFor("telegram")
export const regeneratePairCode = () => newPairCode("telegram")
export const unpairTelegram = () => unpair("telegram")

export function telegramStatus() {
  const token = getSetting("telegram.botToken")
  const owner = ownerOf("telegram")
  return {
    configured: !!token,
    running: !!state.controller && state.token === token,
    bot: state.bot,
    error: state.error,
    lastPollAt: state.lastPollAt,
    owner: owner ? { id: Number(owner), name: ownerName("telegram") ?? owner } : null,
    pairCode: owner ? null : token ? getPairCode() : null,
  }
}

export type TelegramStatus = ReturnType<typeof telegramStatus>

/* ─────────────────────────── lifecycle ────────────────────────── */

// Starts, restarts or stops polling so it matches the configured token.
// Safe to call any number of times.
export function syncTelegram() {
  registerChannel(telegram)
  const token = getSetting("telegram.botToken") ?? null
  if (token === state.token && (state.controller || !token || state.rejected === token))
    return

  state.generation++
  state.controller?.abort()
  state.controller = null
  state.token = token
  state.bot = null
  state.error = null
  state.rejected = null

  if (!token) return
  const controller = new AbortController()
  state.controller = controller
  void poll(state.generation, token, controller.signal)
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    })
  })

async function poll(generation: number, token: string, signal: AbortSignal) {
  const live = () => state.generation === generation && !signal.aborted

  // Introduce ourselves; a bad token stops here
  while (live()) {
    try {
      const me = await callTelegram<TgUser>(token, "getMe", undefined, { signal })
      state.bot = { id: me.id, username: me.username ?? "", name: me.first_name }
      // Polling and webhooks are exclusive; make sure no webhook is left over
      await callTelegram(
        token,
        "deleteWebhook",
        { drop_pending_updates: false },
        { signal }
      )
      await callTelegram(
        token,
        "setMyCommands",
        { commands: COMMANDS },
        { signal }
      ).catch(() => {})
      state.error = null
      console.log(`[xiryn] telegram: polling as @${state.bot.username}`)
      break
    } catch (error) {
      if (!live()) return
      if (error instanceof TelegramError && (error.code === 401 || error.code === 404)) {
        state.error = "Telegram rejected the bot token. Copy it again from @BotFather."
        state.rejected = token
        state.controller = null
        return
      }
      state.error = `Can't reach Telegram: ${error instanceof Error ? error.message : error}`
      await sleep(10_000, signal)
    }
  }

  // Carried over restarts, so updates already handled aren't handed back
  let offset = Number(getSetting("telegram.offset") ?? 0) || 0
  // Waits longer after each failure in a row, up to five minutes
  let backoff = 5_000
  while (live()) {
    try {
      const updates = await callTelegram<TgUpdate[]>(
        token,
        "getUpdates",
        { offset, timeout: 50, allowed_updates: ["message", "callback_query"] },
        { signal, timeoutMs: 65_000 }
      )
      state.lastPollAt = Date.now()
      state.error = null
      backoff = 5_000
      for (const update of updates) {
        offset = update.update_id + 1
        enqueue(token, update)
      }
      if (updates.length) setSetting("telegram.offset", String(offset))
    } catch (error) {
      if (!live()) return
      if (error instanceof TelegramError && error.code === 409) {
        state.error =
          "Another program is using this bot token (another Xiryn, or a webhook). Only one can poll at a time."
        await sleep(15_000, signal)
      } else if (error instanceof TelegramError && error.code === 401) {
        state.error = "Telegram rejected the bot token. Copy it again from @BotFather."
        state.rejected = token
        state.controller = null
        return
      } else {
        state.error = `Lost contact with Telegram: ${error instanceof Error ? error.message : error}`
        await sleep(
          error instanceof TelegramError && error.retryAfter
            ? error.retryAfter * 1000
            : backoff,
          signal
        )
        backoff = Math.min(backoff * 2, 5 * 60_000)
      }
    }
  }
}

// Updates from one chat are handled in order; different chats in parallel
function enqueue(token: string, update: TgUpdate) {
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? 0
  const previous = state.queues.get(chatId) ?? Promise.resolve()
  const next: Promise<void> = previous
    .then(async () => {
      await handle(token, update)
    })
    .catch((error: unknown) => reportError("telegram update", error))
  state.queues.set(chatId, next)
  void next.finally(() => {
    if (state.queues.get(chatId) === next) state.queues.delete(chatId)
  })
}

async function handle(token: string, update: TgUpdate) {
  if (update.callback_query) return handleCallback(token, update.callback_query)
  const message = update.message
  if (!message?.from || message.chat.type !== "private") return
  const from = message.from
  await onMessage(telegram, {
    chat: String(message.chat.id),
    userId: String(from.id),
    userName: from.username
      ? `@${from.username}`
      : [from.first_name, from.last_name].filter(Boolean).join(" "),
    text: message.text ?? "",
    message: { chat: String(message.chat.id), id: String(message.message_id) },
  })
}

async function handleCallback(token: string, query: TgCallbackQuery) {
  const chat = query.message?.chat.id
  const ack = await onButton(telegram, {
    chat: String(chat ?? query.from.id),
    userId: String(query.from.id),
    data: query.data ?? "",
    message: query.message
      ? { chat: String(query.message.chat.id), id: String(query.message.message_id) }
      : undefined,
  })
  await callTelegram(token, "answerCallbackQuery", {
    callback_query_id: query.id,
    ...(ack && { text: ack.slice(0, 190) }),
  }).catch(() => {})
}

/* ──────────────────────────── sending ─────────────────────────── */

const keyboard = (
  buttons?: Button[][]
): { inline_keyboard: InlineKeyboard } | undefined =>
  buttons && {
    inline_keyboard: buttons.map((row) =>
      row.map((button) => ({ text: button.label, callback_data: button.data }))
    ),
  }

const token = () => {
  const value = state.token
  if (!value) throw new Error("Telegram isn't connected.")
  return value
}

// The Telegram side of lib/remote/core.ts
const telegram: Channel = {
  id: "telegram",
  name: "Telegram",
  ready: () => !!state.token && !!state.bot,
  handle: () => state.bot?.username,

  async send(chat, markdown, options = {}) {
    const chunks = splitMarkdown(markdown)
    let last: TgMessage | null = null
    for (const [index, chunk] of chunks.entries()) {
      const extra = {
        // Buttons go on the last part of a long message
        ...(index === chunks.length - 1 &&
          options.buttons && { reply_markup: keyboard(options.buttons) }),
        ...(options.silent && { disable_notification: true }),
        // A preview is a request Telegram makes to the URL, unasked
        link_preview_options: { is_disabled: true },
      }
      try {
        last = await callTelegram<TgMessage>(token(), "sendMessage", {
          chat_id: chat,
          text: markdownToTelegramHtml(chunk),
          parse_mode: "HTML",
          ...extra,
        })
      } catch (error) {
        // Formatting Telegram can't parse: send it plain rather than not at all
        if (!(error instanceof TelegramError && error.code === 400)) throw error
        last = await callTelegram<TgMessage>(token(), "sendMessage", {
          chat_id: chat,
          text: plainText(chunk).slice(0, 4096),
          ...extra,
        })
      }
    }
    return last ? { chat, id: String(last.message_id) } : null
  },

  async edit(message: Sent, markdown, options = {}) {
    await callTelegram(token(), "editMessageText", {
      chat_id: message.chat,
      message_id: Number(message.id),
      text: markdownToTelegramHtml(markdown).slice(0, 4096),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(options.buttons && { reply_markup: keyboard(options.buttons) }),
    }).catch(() => {})
  },

  async remove(message) {
    await callTelegram(token(), "deleteMessage", {
      chat_id: message.chat,
      message_id: Number(message.id),
    })
  },

  async photo(chat, image, caption) {
    await sendPhoto(token(), Number(chat), image, caption)
  },

  async typing(chat) {
    await callTelegram(token(), "sendChatAction", { chat_id: chat, action: "typing" })
  },
}
