# Security Policy

Xiryn runs AI agents with real capabilities — shell access in sandboxed containers, web access, a remote-control bridge — on people's own machines. Security reports are taken seriously.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` | ✅ |
| Latest release | ✅ |
| Older releases | ❌ — please upgrade |

## Reporting a vulnerability

**Please do not open a public issue.**

Use GitHub's private reporting: **Security → Report a vulnerability** on [the repository](https://github.com/SouravBeraAkaSpeed/xiryn/security/advisories/new). If that isn't possible, contact the maintainer through <https://souravbera.vercel.app>.

Include what you can:

- A description of the issue and its impact
- Steps to reproduce, or a proof of concept
- Affected version or commit
- Any suggested fix

You'll get an acknowledgement within **72 hours** and a first assessment within **7 days**. Fixes are released as soon as they're ready, and reporters are credited unless they prefer otherwise.

## Security model

Understanding what Xiryn protects — and what it doesn't — helps you judge a finding.

**What Xiryn defends**

- **Network exposure.** Run with npm, the server binds to `127.0.0.1`. Run in Docker, it listens on all interfaces inside its own container and the compose and Portainer files publish the port on `127.0.0.1` only. Requests whose `Host` isn't loopback (or listed in `XIRYN_ALLOWED_HOSTS`), or whose `Origin` doesn't match the `Host`, are refused, which blocks DNS-rebinding attacks from websites you visit and cross-origin requests from pages on other local ports. That check only defends against browsers, since any other client can set its own headers, so every request must also carry a per-install access key. Xiryn makes the key on first start and keeps it in `data/access.key`, which is never mounted into a workstation. A browser receives it as an `HttpOnly` cookie by opening the sign-in link Xiryn prints at startup (`npm run link` prints it again). Without the cookie, every page, server action and API route answers 401. That includes an agent's own workstation reaching the host through `host.docker.internal`. To sign every browser out, delete `data/access.key` and restart.
- **Secret handling.** API keys and the Telegram token are read only on the server. The browser receives masked values; server-action argument logging is disabled.
- **Remote access.** The Telegram bridge answers exactly one paired account. Pairing codes are single-use and rotate after repeated wrong guesses.
- **Host isolation.** Agent tools execute inside each agent's own Docker container. The agent's user has passwordless `sudo` there, so the boundary is Docker's isolation, not the user account: nothing from your machine is mounted into the container, and it has no access to your files, desktop or other containers' volumes. Workstations currently share Docker's default bridge network, so one can reach another's network ports (and anything else reachable from your computer); isolating them from each other is tracked from the audit in #6.
- **The vault.** Logins, cards, UPI IDs and personal details are encrypted with AES-256-GCM, each entry bound to its id. The key is kept by the operating system (macOS Keychain, Windows DPAPI, the Linux Secret Service), or, where none is available, in a file readable only by you in `~/.xiryn`, outside the data folder; when Xiryn itself runs in Docker the file lives in the data volume, next to the database. The browser receives masked hints only. Values reach a page by being typed into the agent's browser from stdin — never through a model, a log or a tool result — and the field is then shown as dots. A login only fills when the focused window is Chromium and exactly one tab carries its title, on the login's own site; when that can't be established nothing is filled. A card or UPI ID only fills after the person approved that payment in that thread, on the site it was approved on, for 20 minutes. The approval shows a screenshot of the agent's screen taken when it asked, so you can check it's the checkout you expect.
- **Live desktops.** Each container's noVNC port is published on `127.0.0.1` only and protected by a random per-container password that the Xiryn server hands to your browser. The password is also in the container's environment, so processes inside the workstation, the agent included, can read it; it protects the desktop from other things on your computer, not from its own agent. Phone take-over links (Telegram hand-offs) open a temporary Cloudflare quick tunnel to that one desktop; it closes after 30 minutes, and the link carries the password — treat it as a secret, or turn the feature off with `XIRYN_PHONE_TAKEOVER=off`.

**What is out of scope or your responsibility**

- **No authentication by design.** If you expose Xiryn beyond localhost, put it behind your own authenticating proxy. Doing so without one is a misconfiguration, not a vulnerability.
- **Model behavior.** Agents act on instructions, and content they read (web pages, files) can contain prompt injections. Workstations limit the blast radius to the agent's container — which can still reach the internet, from your connection — but treat agent output — and anything it does with credentials you give it — with care.
- **Third-party services.** Prompts go to the model provider you configure; Telegram messages pass through Telegram; phone take-over links pass through Cloudflare. Their security is governed by those providers.
- **What the vault can't do.** A value typed into a page is in that page, and the agent controls the browser it's in. What the vault guarantees is that values never enter the model's context or Xiryn's records, and that their use is deliberate and approved. It doesn't make a compromised agent harmless. The site check and the approval screenshot are both measured inside the agent's own workstation, where the agent has root. A prompt-injected agent could forge them, or read a typed value back from the page through Chromium's debugging port. Treat the screenshot as a guide for your judgement, not proof, and approve payments you recognise.
- **Container isolation itself.** Workstations rely on Docker's isolation. A container escape is a Docker issue — report it to Docker — unless Xiryn's configuration (mounts, capabilities, published ports) made it possible.
- **Local data at rest.** `data/xiryn.db`, the screenshots in `data/screens/`, `.env` and the agents' home-folder volumes are protected by your operating system's account security.

## Hardening tips

- Keep Xiryn updated.
- Use a dedicated, scoped API key per provider and set spending limits in their dashboards.
- Set `XIRYN_WORKSTATION_AUTO_DELETE_MINUTES` if you want workstations to be disposable.
- Don't give agents credentials they don't need.
