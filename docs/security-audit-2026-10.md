# Security and performance audit, October 2026

Findings from the audit requested in [#6](https://github.com/snogrammer/xiryn/issues/6), against Xiryn `v0.6.0` at commit `2084a7f`. Each finding has a severity, where it lives, how it was confirmed, the fix, and where that fix is tracked.

## Threat model

Xiryn has **no authentication**: it relies on binding to loopback and on the `Host`/`Origin` check in `proxy.ts`. It holds the host's **Docker socket**, which is root-equivalent. **LLM agents run arbitrary code** in per-agent Docker workstations and read untrusted content (web pages, files, screenshots, other agents' output), so prompt injection is assumed. A **vault** holds logins, cards and personal details that the agent types into pages without seeing them. A **Telegram bridge** offers remote control, and phone take-over links use Cloudflare quick tunnels.

The question for every finding was therefore: what can a prompt-injected agent, a web page the person visits, a stranger on Telegram, or a process on the same machine do?

## Method

Three read-only passes over the code (access control + Docker + supply chain; agent tools + vault + Telegram + web + XSS; performance), followed by manual verification of every High and Medium candidate against the source and, where practical, against a running instance (`npm run dev` on macOS with Docker Desktop 29.1.3). `npm audit`, action pinning and base-image pinning were checked directly.

Severity: **High**, exploitable by a prompt-injected agent or a local attacker with real impact. **Medium**, a stated defence is materially weaker than claimed. **Low**, hardening and hygiene.

## Security findings

| # | Severity | Finding | Where | Status |
|---|---|---|---|---|
| S1 | High | The Host/Origin check is the only access control and is spoofable by any non-browser client. Confirmed: from a container, `curl -H 'Host: localhost' http://host.docker.internal:6796/` returns 200, and so does a state-changing `DELETE`. Every server action is then callable: approve payments, read any desktop's VNC password, read the Telegram pairing code, change settings. | `proxy.ts`, `actions/*.ts`, `app/api/threads/[threadId]/turn/route.ts` | Fixed for [#12](https://github.com/snogrammer/xiryn/issues/12): per-install access key required on every request (`lib/access.ts`); Origin-must-match-Host and JSON-only turns in [#7](https://github.com/snogrammer/xiryn/pull/7) |
| S2 | High | URL settings (`provider.*.baseUrl`, `firecrawl.apiUrl`, `telegram.apiUrl`) accepted any string; whoever can call `saveSettings` redirects stored API keys and the bot token. | `actions/settings.ts`, `lib/config.ts` | Fixed in [#7](https://github.com/snogrammer/xiryn/pull/7) (http/https only, no credentials); residual closed by the access key ([#12](https://github.com/snogrammer/xiryn/issues/12)) |
| S3 | High | The vault's site check trusts data from the agent's own container (`curl 127.0.0.1:9222`, `xdotool getwindowname`, `pages[0]` fallback) and types into whatever has focus. With sudo and Chromium's debug port the agent can spoof the site and read back any value. | `lib/workstation.ts` `currentPage`, `typeSecret`; `lib/agent/tools.ts` `vault_fill` | Hardened for [#13](https://github.com/snogrammer/xiryn/issues/13): no `pages[0]` fallback, Chromium must be focused with exactly one matching tab, and payment approvals show a checkout screenshot. Residual: detection still runs inside the container; approval binding is in [#17](https://github.com/snogrammer/xiryn/issues/17) |
| S4 | High | Card/UPI host check skipped entirely when `approval.host` was null; the agent can force null by breaking the debug port before asking for approval. | `lib/agent/tools.ts` (`approval.host && …`) | Fixed in [#8](https://github.com/snogrammer/xiryn/pull/8): no fill without a readable site; approvals made without a site are unusable |
| S5 | Medium-High | Take-over link URL read from the container's stdout with only an `https://` prefix check; the phone page is served from the container. The link carries the VNC password. | `lib/workstation.ts` `getTakeoverLink`, `xiryn-tunnel`, `xiryn.html` | Host check (`*.trycloudflare.com`) in [#8](https://github.com/snogrammer/xiryn/pull/8); fixed for [#14](https://github.com/snogrammer/xiryn/issues/14): tunnel and page run in a relay container Xiryn starts, which connects to the workstation's VNC server directly |
| S6 | Medium | Workstations: default bridge with inter-container traffic, default capabilities incl. `NET_RAW`, no `--pids-limit`, no disk quota, websockify on all container interfaces, passwordless sudo, Chromium `--no-sandbox`. | `lib/workstation.ts` `docker create`; `workstation/Dockerfile`; `xiryn-desktop` | `--pids-limit 4096` in [#9](https://github.com/snogrammer/xiryn/pull/9); rest in [#15](https://github.com/snogrammer/xiryn/issues/15) |
| S7 | Medium | Untrusted content is never marked; `memory_write` persists into every system prompt; `routine_create` schedules autonomous runs; `routine_list`/`routine_delete` are workspace-wide; delegate `brief` goes verbatim into the other agent's system prompt; screenshots relayed as user-role messages. | `lib/agent/tools.ts`, `lib/agent/instructions.ts`, `lib/agent/runtime.ts` | Instructions paragraph in [#8](https://github.com/snogrammer/xiryn/pull/8); structural fix [#16](https://github.com/snogrammer/xiryn/issues/16) |
| S8 | Medium | Payment approvals keyed by thread + item, not agent or amount; reusable for 20 min; pending ones never expire; delegated agents inherit them; temporary cards live until the 24 h sweep. | `lib/vault.ts` | Fixed for [#17](https://github.com/snogrammer/xiryn/issues/17): bound to the requesting agent, each field fills once, pending requests expire after 30 min, temporary methods deleted once unusable. The amount isn't enforced at fill time (only the container could report it) |
| S9 | Medium | Remote images in model markdown load automatically (Streamdown `allowedImagePrefixes: ["*"]`): zero-click exfiltration. | `components/thread/markdown.tsx` | [#18](https://github.com/snogrammer/xiryn/issues/18) |
| S10 | Medium | Vault key file sits next to the database when Xiryn runs in Docker; macOS Keychain write passes the key as a command-line argument with no `-T` ACL. | `lib/vault.ts` | [#19](https://github.com/snogrammer/xiryn/issues/19); docs corrected in [#9](https://github.com/snogrammer/xiryn/pull/9) |
| S11 | Medium | Output from `docker exec` is buffered with no size cap; `listDirectory`, `currentPage`, `captureScreen`, `getTakeoverLink` have no bounds. An agent can exhaust server memory. | `lib/docker.ts` `spawnOnce`; `lib/workstation.ts` | [#20](https://github.com/snogrammer/xiryn/issues/20) |
| S12 | Medium-Low | Origin check ignored the port, so any `localhost:<port>` page passed; the turn route parsed `text/plain` posts (no preflight). | `proxy.ts`, turn route | Fixed in [#7](https://github.com/snogrammer/xiryn/pull/7) |
| S13 | Medium-Low | noVNC ports bypass `proxy.ts` and websockify has no Origin check; the 8-character (48-bit) password is the only barrier. | `lib/workstation.ts` | Noted in #12 and #15 |
| S14 | Low-Medium | Telegram: global OTP slot swallows ordinary replies; `offset` resets on boot (replay); no stranger rate limit; pairing code never expires; `escape()` didn't escape `"` inside `href`. | `lib/telegram/bridge.ts` | `"` escaping in [#8](https://github.com/snogrammer/xiryn/pull/8); rest in [#21](https://github.com/snogrammer/xiryn/issues/21) |
| S15 | Low-Medium | Actions pinned to tags; base images by tag; Node and cloudflared downloaded unverified; `curl \| sh` in installers; `.env` default permissions; `:latest` floats; no signing. `npm audit --omit=dev` is clean (4 moderate dev-only esbuild advisories via drizzle-kit). | `.github/workflows/*`, both Dockerfiles, `setup.sh`, `scripts/setup.mjs` | SHA pins, Dependabot, checksums in [#10](https://github.com/snogrammer/xiryn/pull/10); rest in [#22](https://github.com/snogrammer/xiryn/issues/22) |
| S16 | Low | Raw AI SDK errors logged (may include prompts); turn route accepts arbitrary part shapes and a client-set vault marker; workstation actions don't check the agent exists. | `lib/agent/runtime.ts`, turn route, `actions/workstation.ts` | [#23](https://github.com/snogrammer/xiryn/issues/23) |
| S17 | Low | `SECURITY.md` over-promised: unprivileged user (sudo), binds 127.0.0.1 (0.0.0.0 in Docker), key outside the data folder (inside in Docker), password only the server knows (also in container env), isolated containers (shared bridge). | `SECURITY.md` | Fixed in [#9](https://github.com/snogrammer/xiryn/pull/9) |

## Performance findings

| # | Severity | Finding | Where | Status |
|---|---|---|---|---|
| P1 | High | `screen_capture`/`screen_share` images stored as base64 in `messages.parts` forever; parsed on every load and shipped in every thread render. | `lib/agent/runtime.ts` `trimActionScreens` | [#24](https://github.com/snogrammer/xiryn/issues/24) |
| P2 | High | Routine threads grow without bound (history never truncated), so tokens and latency grow linearly for weeks; no wall-clock turn timeout, so a hung provider blocks the thread and makes routines skip forever. | `lib/routines.ts`, `lib/agent/runtime.ts` | [#25](https://github.com/snogrammer/xiryn/issues/25) |
| P3 | Medium | Every SSE event triggers `router.refresh()` in every tab; thread pages parsed the transcript twice per render; the layout selected every thread on every render. | `components/workspace/notifier.tsx`, `queries/workspace.ts`, thread pages | `cache()` on `getThread` and a bounded `getNavigation` in [#11](https://github.com/snogrammer/xiryn/pull/11); refresh storm in [#26](https://github.com/snogrammer/xiryn/issues/26) |
| P4 | Medium | Transcript not virtualised or memoised; `useChat` had no throttle; `data:` URIs rebuilt per render. | `components/thread/*` | Throttle in [#11](https://github.com/snogrammer/xiryn/pull/11); rest in [#26](https://github.com/snogrammer/xiryn/issues/26) |
| P5 | Medium | `run.chunks` keeps every chunk (incl. screenshots) for the run + 30 s and replays all of it per reconnect; no backpressure on SSE or the turn stream. | `lib/agent/runtime.ts`, `app/api/events/route.ts` | SSE dead-client drop in [#11](https://github.com/snogrammer/xiryn/pull/11); buffer cap in [#27](https://github.com/snogrammer/xiryn/issues/27) |
| P6 | Medium | No retention for messages/turns/routine runs; no `PRAGMA optimize`/checkpoint/VACUUM; `data/xiryn.log` never rotates; launchd plist lacks `KeepAlive`; no SIGTERM handling. | `db/index.ts`, `scripts/background.mjs` | [#27](https://github.com/snogrammer/xiryn/issues/27) |
| P7 | Medium-Low | Foreign-key columns without indexes; parent deletes scan child tables. | `db/schema.ts` | Fixed in [#11](https://github.com/snogrammer/xiryn/pull/11) (migration 0005) |
| P8 | Low | Janitor could overlap itself and held timers un-`unref`'d; vault sweep lacked a `globalThis` guard; Telegram backoff fixed. | `lib/workstation.ts`, `instrumentation.ts`, `lib/agent/runtime.ts` | Fixed in [#11](https://github.com/snogrammer/xiryn/pull/11); backoff in #21 |
| P9 | Low | Open VNC tab defeats idle stop; `du` after every turn; `docker info` every 15 s; synchronous fingerprint hashing on the request path; `getRoutines` N+1; shiki and cmdk in every bundle. | various | [#28](https://github.com/snogrammer/xiryn/issues/28) |

## What was not found

- No shell-string construction around `docker`: every call uses `spawn` with an argument array, and agent-supplied strings land in positional arguments, not flags.
- No host paths mounted into workstations; no `--privileged`.
- No raw secret returned by a server action or rendered in a component; `describeSetting()` masks keys; vault plaintext reaches only `typeSecret`'s stdin, never the model, logs, messages or exports.
- No `dangerouslySetInnerHTML` on model output; Streamdown sanitises; React blocks `javascript:` URLs.
- AES-256-GCM with a fresh 12-byte IV per seal, 16-byte tag, AAD bound to the item id and kind.
- Telegram owner checks on both update types that are requested (`message`, `callback_query`).
- `pull_request` (not `pull_request_target`) with `contents: read` in CI.

## Fixes applied directly

| PR | Contents |
|---|---|
| [#7](https://github.com/snogrammer/xiryn/pull/7) | Origin must equal Host (port included); turn route is JSON-only; URL settings validated |
| [#8](https://github.com/snogrammer/xiryn/pull/8) | No vault fill without a readable site; approvals made without a site are unusable; tunnel address must be `*.trycloudflare.com`; untrusted-content instructions; Telegram `"` escaping |
| [#9](https://github.com/snogrammer/xiryn/pull/9) | `--pids-limit 4096` on workstations; `SECURITY.md` matches the code |
| [#10](https://github.com/snogrammer/xiryn/pull/10) | Actions pinned to SHAs; Dependabot; verified Node and cloudflared downloads |
| [#11](https://github.com/snogrammer/xiryn/pull/11) | FK indexes; bounded navigation query; per-request `getThread` cache; `useChat` throttle; janitor overlap guard and timer `unref`; SSE dead-client cleanup |

## Recommendation on authentication

The audit's scope excluded adding authentication, but S1 is the finding everything else amplifies. A per-install secret enforced by `proxy.ts` (an `HttpOnly` cookie set on the first loopback visit) is small to build, changes nothing for the person at the keyboard, and turns the Host check from the only line of defence into a second one. It is filed as [#12](https://github.com/snogrammer/xiryn/issues/12). Since implemented, with one change: on Docker Desktop a workstation's requests through `host.docker.internal` also arrive from loopback, so "first loopback visit" couldn't tell them apart. Instead, the browser receives the cookie from a sign-in link that Xiryn prints at startup.
