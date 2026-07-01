# mobile-approve

OpenCode plugin that intercepts `permission.ask` and routes the decision to your phone via a self-hosted [ntfy.sh](https://ntfy.sh) broker and a tunnel-protected callback.

The plugin is a transparent proxy: **opencode's permission config decides what needs approval**; this plugin just delivers the prompt to your phone and feeds the answer back. The web UI mirrors the opencode TUI's three options: **once / always (this pattern) / reject**. Rich extras (modified command, agent hint) are tucked under a "More options" disclosure.

## Status

| Phase | Description | State |
| ----- | ----------- | ----- |
| 0     | ntfy + Caddy deploy guide (`docs/install.md`) | done |
| 1     | Repo scaffold + tsconfig + opencode.json    | done |
| 2     | `src/types.ts` config resolution             | done |
| 3     | `src/security.ts` HMAC + nonce store + Whitelist | done |
| 4     | `src/server.ts` local HTTP server (`GET /review/:id`, `POST /decide/:id`) | done |
| 5     | `src/webui.ts` self-contained HTML page mirroring the TUI | done |
| 6     | `src/ntfy.ts` notification publish            | done |
| 7     | `src/index.ts` plugin entry                   | done |

## Prerequisites

- OpenCode ≥ the version that ships `@opencode-ai/plugin`'s `permission.ask` hook (currently `1.17.12`).
- A reachable ntfy server (see `docs/install.md`).
- A way for your phone to reach `127.0.0.1:7461` on the workstation. If the phone and workstation share a Tailscale tailnet, `tailscale serve` is the simplest option (see `docs/install.md` Path A).
- An HMAC secret exported as `MOBILE_APPROVE_SECRET` in the shell that starts opencode.

After pulling the repo, run `./bin/setup-serve.sh` once on the laptop to configure Tailscale Serve. The rules persist across reboots via the `tailscaled` daemon. Use `./bin/status.sh` to verify the full deployment is up.

## Install

```sh
cd /path/to/mobile-approve
npm install
```

OpenCode loads `./src/index.ts` directly under Bun — no build step required.

## Configuration

The plugin lives in the **global** opencode config (`~/.config/opencode/opencode.json`), not in any project's local config — it's a system-level concern, so it should apply to every project you run opencode in.

> **Do not put a mobile-approve plugin entry in a project-local `opencode.json`.** If you run `opencode` from a directory that has its own `opencode.json` with a mobile-approve entry, opencode prefers the local one and ignores the global — and a partial local entry (missing `ntfy.topic` etc.) will cause the plugin to fail to load with a silent error. If a project-local `opencode.json` exists for other reasons, just don't include the mobile-approve plugin there.

ntfy ships in this repo as `compose.yaml` + `server.yml` at the root. You don't need to start it manually — `setup-ntfy.sh` brings up the container if it isn't already running.

Two scripts in `bin/` register the plugin and populate the credentials. Run them in this order:

1. **`./bin/setup-serve.sh`** — configures Tailscale Serve (path-routed to plugin + ntfy on port 443), and patches `opencode.json` with the URL fields. Run once after cloning. Requires Tailscale signed in and HTTPS enabled in the admin console.
2. **`./bin/setup-ntfy.sh`** — brings up the ntfy container (if needed), generates a topic name, creates the ntfy user via `docker compose exec ntfy ntfy useradd`, and patches the topic/user/password into `opencode.json`. Run once after step 1.

If you already run ntfy elsewhere (e.g. a homelab stack), pass `--compose-file /path/to/your/compose.yaml` to `setup-ntfy.sh` to point at it.

Both scripts are idempotent. After running both, the global config looks like:

```json
{
  "plugin": [
    [
      "/home/you/mobile-approve/src/index.ts",
      {
        "callbackPort": 7461,
        "defaultTimeoutMs": 300000,
        "hmacSecretEnv": "MOBILE_APPROVE_SECRET",
        "nonceTtlMs": 600000,
        "ntfy": {
          "baseUrl": "https://<laptop>.<tailnet>.ts.net",
          "topic": "oc-patsbox-abc123def",
          "user": "pub-mobile-approve",
          "password": "tk_xxxxxxxxxxxxxxxxx"
        },
        "tunnel": {
          "publicBaseUrl": "https://<laptop>.<tailnet>.ts.net"
        }
      }
    ]
  ]
}
```

All fields except `ntfy.*` and `tunnel.publicBaseUrl` are optional and have safe defaults.

Generate the HMAC secret once per workstation (recommended for stable behavior across opencode restarts):

```sh
export MOBILE_APPROVE_SECRET="$(head -c 32 /dev/urandom | base64)"
```

Persist it in your shell rcfile. If the env var is unset when opencode starts, the plugin generates a random per-session secret and logs a warning — phone approvals still work within the session, but URLs from previous opencode sessions won't verify.

Restart opencode. The plugin logs `decision server listening` at INFO on startup.

## End-to-end flow

1. opencode triggers `permission.ask` for some tool call.
2. Plugin:
   - Checks the per-session whitelist for `{tool, pattern}`. On hit, sets `output.status = "allow"` and returns immediately (this is how "always" persists for the rest of the session — see [Whitelist semantics](#whitelist-semantics) below).
   - Otherwise generates a `requestId` and HMAC token, snapshots the `Permission`, registers it in the nonce store.
   - POSTs to your ntfy topic with a single `view` action pointing at `/review/:id?t=<token>`.
3. Phone receives the notification. Tapping opens `https://<your-laptop>.<your-tailnet>.ts.net/review/:id?t=<token>` (or whatever `tunnel.publicBaseUrl` you configured).
4. The page shows tool, pattern, metadata, and the three primary buttons.
5. User picks an action; page POSTs to `/decide/:id`.
6. Plugin resolves `output.status` for the opencode hook. If `scope: "always"`, the pattern is added to the whitelist.

## Web UI

The default view mirrors the opencode TUI:

```
┌─────────────────────────────────────────────┐
│ opencode wants to act                       │
│ delete build artifacts                      │
│                                             │
│ tool:    bash                               │
│ pattern: rm -rf build/                      │
│                                             │
│ [ Allow once              ]                 │
│ [ Reject                  ]                 │
│                                             │
│ Allow always — pattern                      │
│ [ rm -rf build/                          ]  │
│ [ Allow always this pattern ]               │
│                                             │
│ ▶ More options                              │
└─────────────────────────────────────────────┘
```

The "More options" disclosure (collapsed by default) adds:

- **Approve modified** — edits the command, denies the original, sends a hint to the agent to run the modified command on its next turn.
- **Deny with a hint** — sends free-form guidance to the agent as a new user message in the same session via `client.session.prompt(...)`.

Default timeout: 300s. On expiry, the permission resolves as `deny`.

## Whitelist semantics

The "always this pattern" button sets `scope: "always"` and stores the pattern in an in-memory `Whitelist` keyed by `input.sessionID`. Subsequent `permission.ask` calls for the same `{sessionID, tool, pattern}` short-circuit to `output.status = "allow"` without bothering the phone.

Patterns support `*` wildcards. If you whitelist `git *`, future `git status`, `git diff`, etc. all match.

The whitelist is **per-session**:

- Whitelisting `git status` in session A does not affect session B.
- When opencode emits a `session.deleted` event for session X, the plugin drops X's whitelist. Listen log line: `session deleted; whitelist cleared`.
- Restarting opencode clears all whitelists.

Persistent cross-session whitelisting is left to opencode's own `permission` config — edit `opencode.json` for those.

## Smoke test

```sh
npm run smoke
```

Exercises the local server + web UI + decision round-trip + whitelist matching without needing opencode or ntfy. Last line should read `ALL OK`.

## Manual end-to-end test

1. Set `MOBILE_APPROVE_SECRET` and restart opencode.
2. Confirm the plugin logs `decision server listening` and `ntfy notification published`.
3. Trigger a permission ask — e.g. `permission.bash: ask`, then ask the agent to run a new command.
4. Phone buzzes. Tap the notification.
5. The web page opens. Tap any button.
6. The opencode TUI resolves immediately. Next time the same pattern fires, no notification — it auto-allows.

## Known limitations

- The whitelist is in-memory. It does not persist across opencode restarts, and it does not push into opencode's own permission ruleset (no SDK API for that exists today).
- ntfy topic names are public on a public ntfy server. Use a self-hosted ntfy with auth so only your subscribed phone sees the notifications.
- The `agentHint` is sent as a new user message via `client.session.prompt(...)`. The next time the agent thinks, it sees your hint. If the agent has already finished its turn by the time the hint arrives, opencode still picks it up.
- `output.status = "allow"` only resolves the current `permission.ask`. There is no plugin API to push a permanent rule into opencode's permission engine — that has to be done by editing `opencode.json` and restarting.
- **Multi-machine opencode hosts**: the default laptop-local deployment (Path A in `docs/install.md`) scopes each ntfy to one host. If you run opencode on multiple machines that should all push to the same phone, deploy ntfy on a shared remote host (Path B in `docs/install.md`).
