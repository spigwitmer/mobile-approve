# mobile-approve

OpenCode plugin that intercepts `permission.ask` events and routes them
to your phone via a self-hosted [ntfy.sh](https://ntfy.sh) push server
and a tunnel-protected review URL. You tap Allow / Deny / Always on
the phone, the decision flows back, opencode resumes.

The architecture has four pieces:

| Piece | Where it runs | Install |
|---|---|---|
| **ntfy** | docker container on your laptop | `bin/setup-ntfy.sh` |
| **broker** | systemd user service (or docker) on your laptop | `bin/setup-broker.sh` |
| **HTTPS tunnel** | Tailscale Serve, Cloudflare Tunnel, ngrok, etc. | `bin/setup-serve.sh` (Tailscale), or any alternative |
| **plugin** | inside your running opencode process | one-line entry in `~/.config/opencode/opencode.json` |

Read [`docs/architecture.md`](docs/architecture.md) for the full picture
and data flow. Read [`docs/install.md`](docs/install.md) for the install
order. Read [`docs/tailscale.md`](docs/tailscale.md) for the public
HTTPS piece (and alternatives to Tailscale).

## Quick start

```sh
# 1. ntfy (brings up container, creates user, patches opencode.json)
./bin/setup-ntfy.sh

# 2. broker (long-running daemon, systemd user service or docker)
./bin/setup-broker.sh

# 3. HTTPS tunnel (Tailscale Serve is the default; alternatives in docs/tailscale.md)
./bin/setup-serve.sh

# 4. Set the HMAC secret in your shell, then start opencode
export MOBILE_APPROVE_SECRET="$(head -c 32 /dev/urandom | base64)"
opencode
```

Then on your phone, install the [ntfy Android app](https://ntfy.sh/docs/subscribe/phone/),
log in with the user + token from step 1, and subscribe to the topic.
Trigger any permission ask in opencode — the phone buzzes.

Verify the full stack with `./bin/status.sh` — all green checks = ready.

## What the review UI looks like

The phone gets a push notification, taps it, and sees a review page
with three core actions and a few extras under "More options":

- **Allow once**
- **Allow always** (this pattern — e.g. `git status`)
- **Reject**
- (more options)
  - **Approve modified** — suggest a different command, e.g. `rm -rf build/.cache` instead of `rm -rf build/`
  - **Deny + send hint** — tell the agent what to do instead, e.g. "use `npm prune --production` instead"

The phone-side page is served by the broker (which generates the HTML
and validates the HMAC token in the URL). The plugin never sees the
phone-side rendering.

## Configuration

The mobile-approve plugin entry lives in
`~/.config/opencode/opencode.json` (the **global** config — project-local
configs are ignored). The plugin needs:

- `brokerBaseUrl` (default `http://127.0.0.1:7461`) — where the
  broker listens. Only override if the broker is on a different
  port or host.
- `tunnel.publicBaseUrl` — the public HTTPS URL of the tunnel (e.g.
  `https://<your-host>.tailnet.ts.net`).
- `ntfy.*` — `baseUrl`, `topic`, `user`, `password` for the publish-only
  ntfy user. Set by `bin/setup-ntfy.sh`.
- `phoneNotifications` (default `true`) — when `false`, the plugin
  bails out before calling the broker and the in-TUI prompt handles
  the ask instead. Can be toggled at runtime via the `mobile-approve`
  tool (invoke from opencode's command palette, e.g. Ctrl+Shift+P).

Plus the shell env `MOBILE_APPROVE_SECRET` — a base64-encoded random
32-byte string used to sign review URLs. Both the plugin and the
broker read this.

The `bin/setup-serve.sh` and `bin/setup-ntfy.sh` scripts write all of
the above for you. Run them in order from the repo root.

## Status

The end-to-end flow works on a single opencode session. Multi-session
sharing via the broker daemon works (each opencode host can have
its own plugin instance and share one broker). Whitelist currently
lives in broker memory (lost on broker restart); persistence to
`~/.config/mobile-approve/whitelist.json` is a planned follow-up.

| Workstream | State |
|---|---|
| Broker architecture refactor (WS1) | done |
| Fix deny-with-hint (WS2) | done |
| Broker deployment: systemd + docker (WS5) | done |
| Single-session E2E (WS6) | done |
| Repo hygiene + .gitignore (WS7) | done |
| Diffs in review UI (WS3) | pending |
| Model reasoning in UI (WS4) | pending |
| Whitelist persistence to disk | pending |

For a deep dive, see [`docs/architecture.md`](docs/architecture.md).
For the install steps, see [`docs/install.md`](docs/install.md). For the
HTTPS tunnel piece (and alternatives to Tailscale), see
[`docs/tailscale.md`](docs/tailscale.md).
