# Remote access with Telegram

Talk to your Xiryn agents from your phone, from anywhere, while Xiryn keeps
running on your computer.

**How it works.** Xiryn *long-polls* the Telegram Bot API from your machine — it
asks Telegram "any new messages?" and Telegram answers. Because the connection
always goes **out** from your computer, there is nothing to expose: no public
URL, no port forwarding, no tunnel, no webhook, no cloud account. If your
computer can open a website, it can run the bridge.

**Who can use it.** Only the single Telegram account you pair. Anyone else who
finds your bot gets a polite refusal and nothing else.

Setup takes about two minutes.

---

## 1 · Create a bot with @BotFather

BotFather is Telegram's official bot for making bots.

1. Open Telegram (phone or desktop) and search for **`@BotFather`**.
   Pick the one with the **blue verification check**. Or open
   <https://t.me/BotFather> directly.
2. Tap **Start**.
3. Send **`/newbot`**.
4. BotFather asks for a **name** — this is the display name people see, e.g.
   `My Xiryn`. Anything works.
5. BotFather asks for a **username** — it must be unique across Telegram and
   **end in `bot`**, e.g. `myname_xiryn_bot`. If it's taken, try another.
6. BotFather replies with a message containing your **token**, which looks like:

   ```
   123456789:AAHf0x-ExAmPlE_tOkEn_DoNoTuSe-12345
   ```

   Copy it. **Treat it like a password** — anyone with the token can control
   the bot. (If it ever leaks, send `/revoke` to BotFather to get a new one.)

> Optional polish, all in BotFather: `/setuserpic` to give the bot an avatar,
> `/setdescription` for the text people see before pressing Start. You don't
> need `/setcommands` — Xiryn registers its commands automatically.

## 2 · Give the token to Xiryn

Pick one:

- **In the app (recommended):** open **Settings → Remote access**, paste the
  token into step 2 and press **Connect**. Within a second it shows
  `polling as @your_bot`.
- **In `.env`:** add `TELEGRAM_BOT_TOKEN=123456789:AAH…` and restart Xiryn.

## 3 · Pair your Telegram account

Still in **Settings → Remote access**, step 3 shows a **QR code** and a
**pairing code**. Use whichever is easiest:

- **Scan the QR code** with your phone's camera → Telegram opens your bot →
  tap **Start**. Done.
- **Click "Open in Telegram"** on the computer → tap **Start**.
- **Type it:** send `/pair YOURCODE` to your bot.

The code is good for 15 minutes; after that, Settings shows a new one.

The page updates by itself to **Paired with @you** and the bot greets you.
From now on that account is the only one the bot will answer.

## 4 · Use it

Just write to the bot like you'd write to an agent in the app.

| Command   | What it does                                                   |
| --------- | -------------------------------------------------------------- |
| `/agents` | Pick the agent or squad you're talking to (tap a button)       |
| `/new`    | Start a fresh thread with the current agent or squad           |
| `/stop`   | Interrupt the agent mid-task                                   |
| `/status` | Who you're talking to, which model, whether a turn is running |
| `/help`   | Quick reference                                                |

- While an agent works, a small status message lists its steps live
  (`$ git clone …`, `search "…"`), then the answer arrives as a normal message.
- In a **squad**, start a message with `@Name` to address a specific member,
  e.g. `@Vega what changed in the docs this week?`.
- Ask an agent to **show its screen** and the screenshot arrives as a photo.
- Threads you start from Telegram appear in the app on your computer (marked
  *via telegram*), and memory is shared: something you tell an agent on your
  phone, it remembers on your desktop.

### When a task finishes

Start something at your computer and walk away: when a task that took a
minute or more finishes, the bot sends you the agent's answer, with a link to
the thread. Reply and the same thread carries on. Set `XIRYN_TELEGRAM_NOTIFY`
to `all` to hear about every reply, or `off` to stop these notices (hand-offs
always come through).

### Payments and codes

When an agent reaches a checkout, the bot asks before anything is paid:

```
💳 Atlas wants to pay

₹19,062 to MakeMyTrip
Nonstop BLR → LKO, 7 Nov, 1 adult
on makemytrip.com

[ ✓ Pay with Visa ···· 4242 ]
[ 🖐 I'll pay myself ] [ ✕ Decline ]
```

Tap a saved card or UPI ID to let the agent pay with it, **I'll pay myself** to get a live link to its desktop, or **Decline**. Decide in the app instead and the message updates itself. Cards and UPI IDs are saved in **Settings → Vault** on your computer — never send them in this chat.

If a site sends you a one-time code, the bot asks for it: reply with just the code (it must contain a digit, so a reply like "ok" isn't mistaken for one), or send `/code` followed by it; `/cancel` stops waiting. It goes straight into your vault, is used once and deleted, and the message is removed from the chat. The agent never sees it.

### Hand-offs

When an agent reaches a step that's yours — a login, a payment page, a one-time
code, a CAPTCHA — it stops and the bot messages you, even if you started the
task from your computer:

```
🖐 Atlas needs you

The fare is selected and the passenger details are filled in.
The payment page is open and waiting for your card.

📱 Take over from this device — opens the live desktop (link expires in 30 min).
💻 At your computer: open in Xiryn and press Take over.

When you're done, reply here — just "done", or anything Atlas should know — and it carries on.
```

- **📱** opens the agent's desktop in your phone's browser, on a page made for
  phones: tap to click, hold to right-click, two fingers to scroll, and
  **⌨ Keyboard** to type with your phone's keyboard (Enter, Tab, Esc, arrows
  and Ctrl are on the bar under the screen). Finish the payment, enter the
  code, solve the CAPTCHA, then tap **Done**. Turn the phone sideways for a
  bigger screen.
- **💻** opens the thread in Xiryn on your computer, ready for you to take over.
- When you're done, **reply to the bot** (`done`, or anything the agent should
  know — "paid, booking ref is ABC123"). The agent takes a fresh look at the
  screen and carries on from there.

The phone link reaches the agent's desktop on your computer through a
temporary [Cloudflare quick tunnel](https://try.cloudflare.com) that closes
itself after 30 minutes. It carries the desktop's password, so treat it like a
password while it's valid: anyone who has it can see and use that agent's
desktop until it expires. Turn phone links off in Settings → Workstations (or
`XIRYN_PHONE_TAKEOVER=off`) and the notice only points you to your computer.

If Xiryn is reachable at a different address than `http://127.0.0.1:6796`
(another port, or your own authenticating proxy), set `XIRYN_URL` so the 💻 link
points to the right place.

---

## Troubleshooting

**The bot doesn't answer.**
Xiryn must be running and your computer awake and online. Check the status line
in Settings → Remote access.

**"Telegram rejected the bot token."**
The token was mistyped or revoked. Copy it again from BotFather (send `/token`
there and pick your bot) and paste it.

**"Another program is using this bot token."**
Only one program can poll a bot at a time. Stop the other Xiryn (or whatever
else uses the token), or create a separate bot for each machine.

**I want to switch phones / accounts.**
Settings → Remote access → **Unpair**, then pair the new account with the fresh
code.

**I'd rather not pair interactively.**
Set `TELEGRAM_OWNER_ID` in `.env` to your numeric Telegram user id (ask
`@userinfobot`), restart, and skip step 3.

## Security notes

- The token is stored in `.env` or in your local database (`data/xiryn.db`) and
  never sent anywhere except to Telegram.
- Only the paired account is answered. A pairing code is single-use, expires
  after 15 minutes and is replaced after five wrong guesses (counted across
  restarts). Anyone else gets one "private instance" reply an hour at most.
- Messages travel through Telegram's servers like any Telegram chat. Don't send
  through the bot anything you wouldn't send in a regular Telegram message.
- Hand-off links grant access to that agent's desktop until they expire
  (30 minutes). Do your payment or login on the desktop itself — never type a
  password or card number into the Telegram chat.
- To turn remote access off, press **disconnect** in Settings (or remove the
  token from `.env`). To kill the bot entirely, `/deletebot` in BotFather.
