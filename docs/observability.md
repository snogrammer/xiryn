# Error reporting (optional)

Xiryn can report errors to [Sentry](https://sentry.io) or to a self-hosted
[Bugsink](https://www.bugsink.com/), which speaks the same protocol. Then a
failure on a long-running server (a routine, the Telegram bridge, a workstation
build, a turn, a page that breaks in your browser) shows up somewhere other
than the container's logs.

It's **off unless `SENTRY_DSN` is set**. Without a DSN the SDK isn't even
loaded, on the server or in the browser, and nothing is sent anywhere.

## Settings

| Variable | |
| --- | --- |
| `SENTRY_DSN` | Where to send reports. Unset: reporting is off |
| `SENTRY_ENVIRONMENT` | Shown with each report (default `production`) |
| `SENTRY_RELEASE` | Defaults to the image's commit (`XIRYN_IMAGE_SHA`) or the package version |
| `SENTRY_TRACES_SAMPLE_RATE` | Performance tracing, `0` to `1` (default `0`; Bugsink ignores it) |

Put them in `.env`, or in the `environment:` block of the Portainer stack, and
restart Xiryn.

## What a report contains

The error's type, message and stack trace, which part of Xiryn it came from
(`routine`, `turn failed`, `telegram update`, …) and ids such as the thread or
routine id. Before anything is sent, Xiryn removes (`lib/sentry-scrub.ts`):

- request bodies, cookies, headers and query strings, and user details;
- anything that looks like a key or token (provider keys, the Telegram bot
  token, long base64 strings such as the VNC password or images);
- values under names like `key`, `token`, `secret`, `password`, `code`, `card`;
- console breadcrumbs and local variables in stack frames.

A model provider's error message is dropped entirely (it can quote the
request, i.e. the prompt); only the error's type and stack are kept. Reports
from the browser go to Xiryn first (`/api/monitoring`), which forwards them to
your DSN and nowhere else, so the page only ever talks to Xiryn.

It also turns off the SDK's own collection of headers, bodies and AI inputs
and outputs. Prompts, messages, tool output and vault contents are never part
of a report.

## A minimal self-hosted Bugsink

```yaml
services:
  bugsink:
    image: bugsink/bugsink:latest
    restart: unless-stopped
    ports: ["127.0.0.1:8000:8000"]
    environment:
      SECRET_KEY: change-me-to-a-long-random-string
      CREATE_SUPERUSER: admin:change-me
      PORT: 8000
    volumes: ["bugsink:/data"]
volumes:
  bugsink:
```

Open http://127.0.0.1:8000, create a project, copy its DSN into
`SENTRY_DSN`, and restart Xiryn. Bugsink stores errors; it doesn't do tracing,
so leave `SENTRY_TRACES_SAMPLE_RATE` at `0`.

## Not yet

Source maps aren't uploaded, so browser stack traces point at the built
JavaScript. Xiryn doesn't ship browser source maps either.
