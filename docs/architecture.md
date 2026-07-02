# Architecture

`mobile-approve` is an [opencode](https://github.com/sst/opencode) plugin that intercepts
permission prompts and routes them to your phone via a self-hosted
[ntfy.sh](https://ntfy.sh) push-notification server. The phone renders a
review page; the user's decision flows back to opencode.

This document describes what each piece does and how they fit together.

## Components

```
┌─────────────────────────────────────────────────────────────────┐
│                       Your machine                              │
│                                                                 │
│  ┌──────────┐  event   ┌────────┐    HTTP    ┌──────────────┐  │
│  │ opencode │ ───────▶ │ plugin │ ─────────▶ │   broker     │  │
│  │   TUI    │ ◀─────── │ (src/  │ ◀───────── │   (src/      │  │
│  │          │  reply   │ index) │   reply    │   broker.ts) │  │
│  └──────────┘          └────────┘            └──────┬───────┘  │
│       ▲                                              │         │
│       │ tool execution                               │         │
└───────┼──────────────────────────────────────────────┼─────────┘
        │                                              │
        ▼                                              ▼ HTTP
   ┌─────────┐                                  ┌─────────────┐
   │ opencode│                                  │   ntfy.sh   │
   │ tool    │                                  │  (127.0.0.1:│
   │ result  │                                  │    8090)    │
   └─────────┘                                  └──────┬──────┘
                                                         │
                                                         ▼
                                                ┌────────────────┐
                                                │  your phone    │
                                                │  (ntfy app +   │
                                                │  web browser)  │
                                                └────────────────┘
```

| Component | Source / Path | Role |
|---|---|---|
| **opencode** | external | The AI coding agent. Its permission system triggers `permission.asked` events. |
| **plugin** | `src/index.ts` | Thin client. Listens for `permission.asked` events, talks to the broker over HTTP, replies to opencode with the broker's decision. |
| **broker** | `src/broker.ts` + `src/broker-cli.ts` | The stateful service. Owns the ntfy credentials, the nonce store, the whitelist, and the review-page rendering. Listens on `127.0.0.1:7461`. |
| **ntfy** | `compose.yaml` | Self-hosted push-notification server. Sends a push to the phone when a permission needs approval. |
| **phone** | ntfy Android app + web browser | Receives the push notification, taps it, renders the review page (HTML), taps Allow/Deny/Always. |

## Data flow for a single permission ask

```
1. opencode   → tool call needs approval
2. opencode   → emits permission.asked event (in-process)
3. plugin     → sees the event, calls broker.ask() over HTTP
4. broker     → registers a pending decision in its NonceStore
5. broker     → publishes a push notification to ntfy
6. ntfy       → forwards push to the phone
7. phone      → user taps the notification
8. phone      → opens https://<host>/<id>?t=<token> in browser
9. broker     → renders the review page (HTML)
10. user      → taps Allow once / Allow always / Reject / etc.
11. broker     → resolves the pending decision with the user's choice
12. plugin     → receives the decision (long-poll resolves)
13. plugin     → calls client.postSessionIdPermissionsPermissionId() to reply to opencode
14. opencode   → action allowed or denied, tool runs (or is denied)
```

If the user chose **Deny with a hint**, step 14 is followed by:

```
15. plugin     → calls client.session.promptAsync() with the hint
16. opencode   → injects the hint as a synthetic user message
17. opencode   → the agent loop iterates with the hint as context
```

## File map

```
src/
  index.ts          Plugin entry (default export). ~330 lines.
                    Listens to permission.asked events, calls broker.
  client.ts         BrokerClient. HTTP wrapper the plugin uses to
                    talk to the broker. ~130 lines.
  broker.ts         Broker facade. Owns the HTTP server, ntfy publish,
                    NonceStore, SessionWhitelists, review-page
                    rendering. ~460 lines.
  broker-cli.ts     Standalone entry point for the broker.
                    Reads config from env or opencode.json, handles
                    SIGTERM. ~150 lines.
  ntfy.ts           ntfy publish. ~40 lines.
  server.ts         Low-level HTTP server. Review / decide / health
                    routes plus /v1/* plugin API. ~280 lines.
  webui.ts          Self-contained review-page HTML. ~325 lines.
  security.ts       HMAC, NonceStore, SessionWhitelists, isDecision.
                    ~170 lines. Shared by plugin and broker.
  types.ts          Config / decision types. ~120 lines.

bin/
  setup-serve.sh    Tailscale Serve config. Path-routed HTTPS
                    forwarding (or any HTTPS tunnel of choice).
  setup-ntfy.sh     ntfy container bring-up + user/topic creation.
  setup-broker.sh   Broker install: systemd user service OR docker
                    compose. Reads config from opencode.json.
  status.sh         One-screen health check for the whole stack.
  mobile-approve-broker
                    Shell wrapper that runs bin/../src/broker-cli.ts
                    via bun / tsx / node (auto-detect).
```

packaging/
  mobile-approve-broker.service
                    systemd user unit template.

scripts/
  smoke-test.mjs    Low-level server tests (review, decide, replay).
  integration-test.mjs
                    End-to-end plugin tests (whitelist, hint flow,
                    broker-down fallback).
  broker-smoke.mjs  /v1/* HTTP API tests.

## Deployment topology

The broker is the only stateful long-running process. Everything else is
either the opencode host (one process) or a one-shot tool.

**Standard (recommended)**: All on the same machine.

- broker: systemd user service on `127.0.0.1:7461` (or docker)
- ntfy: docker container on `127.0.0.1:8090`
- opencode + plugin: as usual

**Multi-machine**: The same broker can serve multiple opencode hosts
(separate machines, each with their own opencode + plugin). Each host
gets its own Tailscale URL, but they all talk to the same broker at
the same `~/.config/mobile-approve/` config. Whitelist is shared.

## Config layout

The plugin and broker share the same config (ntfy creds, public URL,
HMAC secret). The `bin/setup-broker.sh` script reads the
mobile-approve plugin entry from `~/.config/opencode/opencode.json` and
generates `~/.config/mobile-approve/broker.env` (chmod 600).

```
~/.config/opencode/opencode.json
  └── plugin: [<abs path to src/index.ts>, { tunnel, ntfy, ... }]
       │                              │              │
       │                              │              └── ntfy creds
       │                              └── public base URL (Tailscale)
       │
       │   (read by the plugin at load, used as the broker's
       │    source of truth. setup-broker.sh mirrors these into
       │    the broker's env file.)
       │
       └── read by the plugin AND the broker

~/.config/mobile-approve/
  ├── broker.env            systemd EnvironmentFile, generated by
  │                         setup-broker.sh. Has the same fields as
  │                         the plugin's opencode.json entry, with
  │                         `MOBILE_APPROVE_*` prefixes. chmod 600.
  └── whitelist.json        (planned, WS8 follow-up) The broker's
                            persisted whitelist.
```

## Why a separate broker?

In v1, the plugin ran the HTTP server, ntfy publish, and shared state
all in-process with opencode. This had two problems:

1. **Multi-session**: only the first opencode session could use the
   plugin (port 7461 was already bound). The whitelist was per-session
   and lost on every opencode restart.

2. **Tailscale as a hard dependency**: the in-process plugin required
   Tailscale Serve to route the public URL to it. With the broker
   decoupled, the plugin is a thin HTTP client; the tunnel just needs
   to forward to the broker. Tailscale is now one of several options
   (see [`docs/tailscale.md`](tailscale.md) for alternatives).

The broker solves both:
- One broker, many opencode sessions (all share the same whitelist
  and ntfy creds).
- The plugin doesn't run any HTTP server — its only network IO is
  loopback HTTP to the broker. If the broker is down, the plugin
  falls back to opencode's in-TUI prompt (no silent auto-denies).

## Security model

- **Tailscale / HTTPS tunnel** (or any alternative): provides TLS to
  the phone. We assume the user picks something with a public CA cert.
- **HMAC on review URLs**: each review URL has `?t=<token>` where
  `token = HMAC(secret, requestId)`. The phone can read the URL but
  can't forge new ones without the secret.
- **Nonce store** (broker-side): each `requestId` is single-use.
  After the phone decides, the entry is consumed. Replay gets 410.
- **Tailscale / loopback bind**: the broker listens on `127.0.0.1:7461`
  only. Not directly reachable from the internet. The HTTPS tunnel
  forwards to loopback, so the phone reaches the broker over TLS.
- **No secrets in the repo**: the ntfy password is in
  `~/.config/opencode/opencode.json` and `~/.config/mobile-approve/broker.env`,
  both outside the repo. `compose.yaml` uses env-var references
  (`${MOBILE_APPROVE_NTFY_PASSWORD:?required}`) so the value
  is read from a gitignored `.env` file at the project root.
- **ntfy ACL**: the publish-only user (`pub-mobile-approve`) has
  `read-write` access to `oc-*` topics only. No admin.

## What's NOT in scope (yet)

- **Whitelist persistence to disk** (WS follow-up): the whitelist
  currently lives in broker memory. Restarting the broker wipes it.
  Coming soon: `~/.config/mobile-approve/whitelist.json`.
- **Diffs in the review page** (WS3): the opencode runtime already
  populates `metadata.diff` for edit/write/apply_patch tool calls. The
  broker just needs to render it. The review page currently shows
  file name + pattern; with WS3, it'll show a colored diff.
- **Model reasoning in the UI** (WS4): the plugin can fetch the
  assistant's text-before-tool-call from `client.session.message(...)`
  and pass it to the broker as a "Why:" blockquote in the review page.
- **Synced whitelist across machines** (out of scope): the whitelist
  is local to the broker. Multi-machine setups share the broker, so
  this is fine in practice.
