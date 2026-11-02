# Discord

Talk to your agents from Discord, the same way as from [Telegram](telegram.md):
pick an agent, write to it, watch its steps, approve a payment with a button,
and stop a turn. Xiryn connects out to Discord from your computer, so there's
no public URL, no port forwarding and no tunnel. Xiryn has to be running for
the bot to answer.

The bot only works in **direct messages**, and only with the one Discord
account that paired with it. Anyone else gets a single refusal an hour.

## 1 · Create the bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications)
   and choose **New Application**. Name it, e.g. *My Xiryn*.
2. Under **Bot**, press **Reset Token** and copy the token. Treat it like a
   password.
3. No privileged intents are needed (Xiryn reads direct messages only, which
   don't need *Message Content*).

## 2 · Connect it

Paste the token in **Settings → Remote access → Discord**, or set
`DISCORD_BOT_TOKEN` in `.env` (or the Portainer stack) and restart. The panel
shows *connected as …* once Discord accepts it.

## 3 · Pair your account

Discord only lets you message a bot you share a server with. In the panel,
**Add to a server** opens Discord's invite page (scopes `bot` and
`applications.commands`, no permissions). Pick any server you're in; a private
one of your own is fine. Then open a direct message with the bot and send:

```
/pair YOURCODE
```

The code is shown in the panel and is good for 15 minutes. Five wrong guesses
make a new one.

## Using it

| | |
| --- | --- |
| a message | talks to the current agent (in a squad, start with `@Name`) |
| `/agents` | pick an agent or squad (buttons) |
| `/new` | start a fresh thread |
| `/stop` | interrupt the agent |
| `/status` | what's running |
| `/code 123456` | hand over a one-time code an agent asked for |
| `/cancel` | stop waiting for a code |

While an agent works, one message lists its steps and is edited as it goes;
the answer follows. Shared screenshots arrive as images. When an agent wants to
pay, you get the amount, the site, a screenshot of its screen and buttons to
approve with a saved card, pay yourself, or decline. Signing in with a saved
login works the same way: the site, the login's hint and a screenshot, with
buttons to approve, sign in yourself, or decline. Requests for a new login or
card details link to Xiryn on your computer; they're never typed into a chat.

**One-time codes:** use `/code`. Slash commands aren't posted in the
conversation, so the code never shows in your DMs. A code typed as a plain
message is accepted too, but Discord doesn't let bots delete what you wrote, so
it stays in the chat.

Threads you start from Discord appear in the app on your computer, marked
*via discord*. Finished tasks you started in the app are announced in Discord
too (the same setting as Telegram, `XIRYN_TELEGRAM_NOTIFY`).

## Unpair or disconnect

**Unpair** in the panel forgets the account (pair again with a new code).
**Disconnect** removes the token. The bot keeps existing in Discord; delete the
application in the Developer Portal if you no longer want it.
