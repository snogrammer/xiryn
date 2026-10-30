# Running Xiryn with Portainer

Run Xiryn on a home server or NAS as a Portainer stack, from the image CI
publishes to GitHub Container Registry. Updating is a matter of pulling a newer
image.

**What you get.** One `xiryn` container serving the app on port `6796`. It talks
to the host's Docker to build the agents' desktop image and to start each
agent's workstation as a **sibling container** on the same host.

> **Read this first.** Xiryn has **no login**: anyone who can reach it can drive
> your agents, read their files and use your keys. The stack publishes it on
> the host's loopback (`127.0.0.1`) by default. To reach it from other devices,
> put it behind something that authenticates you — Tailscale, a VPN, or a
> reverse proxy with auth (Traefik / Caddy / nginx + forward-auth, Cloudflare
> Access…). Never publish it on `0.0.0.0` on its own.
>
> The stack also mounts `/var/run/docker.sock`, which is root-equivalent on the
> host. Run it on a machine you're happy to give Xiryn that much power over.

---

## 1 · The image

CI (`.github/workflows/publish.yml`) builds `linux/amd64` and `linux/arm64` and
pushes them to `ghcr.io/<owner>/xiryn`:

| Tag              | When                              |
| ---------------- | --------------------------------- |
| `latest`         | every push to `main`              |
| `sha-<short>`    | every build — pin to an exact one |
| `1.2.3`, `1.2`   | a `v1.2.3` git tag                |

New GHCR packages are **private**. Either make it public (GitHub → your profile
→ **Packages** → `xiryn` → **Package settings** → **Change visibility**) or give
Portainer credentials: **Registries → Add registry → Custom registry**, URL
`ghcr.io`, your GitHub username, and a
[personal access token](https://github.com/settings/tokens) with `read:packages`.

## 2 · Create the stack

In Portainer: **Stacks → Add stack**, name it `xiryn`, then either

- **Web editor:** paste [`deploy/portainer-stack.yml`](../deploy/portainer-stack.yml), or
- **Repository:** this repo's URL, compose path `deploy/portainer-stack.yml`
  (turn on GitOps updates if you like).

Under **Environment variables**, set what you use. Everything can also be set
later in the app under **Settings**.

| Variable              | What it's for                                                           |
| --------------------- | ----------------------------------------------------------------------- |
| `XIRYN_IMAGE`         | Image to run (default `ghcr.io/snogrammer/xiryn:latest`)                |
| `XIRYN_BIND`          | Host address to publish on (default `127.0.0.1`)                        |
| `XIRYN_PORT`          | Host port (default `6796`)                                              |
| `XIRYN_URL`           | The address you open Xiryn at, e.g. `https://xiryn.home.example`        |
| `XIRYN_ALLOWED_HOSTS` | Hostnames Xiryn answers on besides localhost, comma separated           |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, … | Model providers — at least one, here or in Settings |
| `TELEGRAM_BOT_TOKEN`  | Remote control from Telegram ([docs/telegram.md](telegram.md))          |

For any other setting in [`.env.example`](../.env.example), add it to the
`environment:` block of the stack.

**Deploy the stack.** On first start Xiryn builds the agents' desktop image on
the host — a few minutes, once. Follow it in the container's logs:

```
[xiryn] building the agent workstation image (first run only)…
[xiryn] workstation image ready: xiryn-workstation:…
```

## 3 · Reaching it

Xiryn refuses requests whose `Host` isn't localhost or listed in
`XIRYN_ALLOWED_HOSTS` (this also stops DNS-rebinding attacks), so set both
together. For example, behind a reverse proxy on the same host serving
`xiryn.home.example`:

```
XIRYN_BIND=127.0.0.1
XIRYN_URL=https://xiryn.home.example
XIRYN_ALLOWED_HOSTS=xiryn.home.example
```

…and proxy `https://xiryn.home.example` to `http://127.0.0.1:6796`, with
WebSocket upgrades allowed. Over Tailscale, use the machine's MagicDNS name (or
Tailscale IP) as the allowed host and `XIRYN_BIND` to its Tailscale IP.

## Known limitation · the live desktop on another machine

Agents work fine from anywhere — they drive their workstation through Docker on
the server. But the **live desktop view** (watching and **Take over**) connects
your browser straight to the workstation's VNC port, which is published on the
**server's** loopback only (`ws://127.0.0.1:<port>`). From a browser on another
device that view won't connect. Workarounds until Xiryn proxies it itself:

- Telegram hand-offs' phone takeover link (`XIRYN_PHONE_TAKEOVER`, on by
  default) goes through a temporary Cloudflare tunnel and works from anywhere.
- An SSH tunnel to the server, forwarding both `6796` and the workstation's
  port (`docker port xiryn-ws-<agent>` on the server shows it).

## Updating

Pull the newer image and recreate the container: in Portainer open the stack →
**Update the stack** with **Re-pull image and redeploy** turned on (or let
GitOps / a webhook do it). Your data — database, vault key and the agents' home
folders — lives in the `xiryn-data` volume and the workstation volumes, and is
kept across updates.

## Backups

Back up the `xiryn-data` volume. It holds `xiryn.db` and the vault key
(`vault-*.key`); the vault can't be decrypted without that key. To keep the key
out of the volume, set `XIRYN_VAULT_KEY` to 32 random bytes in base64
(`openssl rand -base64 32`) **before the first start** — changing it later
locks you out of anything already in the vault.
