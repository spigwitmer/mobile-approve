# Install guide

This is the high-level install order. The plugin needs four pieces to
work end-to-end; each is documented in detail in its own doc:

1. **ntfy** (push-notification server) — see [§ntfy](#ntfy-self-hosted-push-server)
2. **broker** (the long-running daemon) — see [§broker](#broker-long-running-daemon)
3. **HTTPS tunnel** (so the phone can reach the broker) — see [`docs/tailscale.md`](tailscale.md) (or any of the alternatives)
4. **plugin** (this repo, loaded by opencode) — see [§plugin](#plugin-this-repo-loaded-by-opencode)

The phone just needs the ntfy Android app and the right topic — that's
the last step.

```
        ┌─────────┐                              ┌────────┐
        │  ntfy   │ ──── push notification ────▶ │ phone  │
        │ :8090   │                              │ (ntfy  │
        └─────────┘                              │  app + │
             ▲                                   │  web)  │
             │ publish                           └────┬───┘
        ┌────┴────┐                                  │ tap
        │ broker  │ ◀─── review page over HTTPS ────┘
        │  :7461  │
        └────┬────┘
             ▲ loopback HTTP
        ┌────┴────┐
        │ plugin  │ ◀── permission.asked event ──▶
        │(opencode│
        │   TUI)  │
        └─────────┘
```

The four pieces run as follows:

| Piece | Where it runs | Default port | Install |
|---|---|---|---|
| ntfy | docker container on the laptop | `127.0.0.1:8090` | `bin/setup-ntfy.sh` |
| broker | systemd user service (or docker) on the laptop | `127.0.0.1:7461` | `bin/setup-broker.sh` |
| HTTPS tunnel | varies (Tailscale Serve is the default) | public 443 | `bin/setup-serve.sh` (Tailscale) or alternatives in [`docs/tailscale.md`](tailscale.md) |
| plugin | inside the running opencode process | — | one-line entry in `~/.config/opencode/opencode.json` |

---

## Prerequisites

- A working opencode install. Test with `opencode --version` — needs `1.17.12` or later (this is when the runtime started emitting `permission.asked` events for plugins to consume).
- `python3` on `PATH` (used by all the setup scripts to safely edit JSON).
- `docker` (for ntfy) — or point `bin/setup-ntfy.sh` at an existing ntfy with `--compose-file` / `--config-path`.
- One of: Tailscale (with HTTPS enabled), Cloudflare Tunnel, ngrok, or your own HTTPS reverse proxy. See [`docs/tailscale.md`](tailscale.md).
- A smartphone with the [ntfy Android app](https://ntfy.sh/docs/subscribe/phone/) (F-Droid or Play Store). Add the server URL (your HTTPS tunnel URL) when prompted.

## Install order

### 1. ntfy (self-hosted push server)

The broker publishes a push notification to ntfy for every permission
ask. ntfy then forwards the push to your phone.

```sh
./bin/setup-ntfy.sh
```

What it does:

- Brings up the ntfy container if it isn't already running.
- Generates a random topic name (`oc-<9 random chars>`).
- Creates a `pub-mobile-approve` user via `docker compose exec ntfy ntfy useradd`.
- Captures the one-time token (becomes the ntfy password).
- Patches `ntfy.topic`, `ntfy.user`, `ntfy.password` into
  `~/.config/opencode/opencode.json` (in the mobile-approve plugin
  entry).
- Backs up the config before any edit.

Useful flags:

- `--compose-file PATH` — point at an existing ntfy deployment.
- `--topic NAME` — use a specific topic instead of the generated one.
- `--user NAME` — override the default `pub-mobile-approve`.

If you'd rather fill these in by hand, see
[§filling in ntfy config by hand](#filling-in-ntfy-config-by-hand) at the
bottom of this doc.

### 2. broker (long-running daemon)

The broker owns the ntfy creds, the pending-decision store, the
session whitelist, and the review-page rendering. The plugin talks to
it over loopback HTTP.

```sh
./bin/setup-broker.sh
```

What it does:

- Reads `~/.config/opencode/opencode.json` and extracts the mobile-approve
  plugin entry's `tunnel.publicBaseUrl` and `ntfy.*` fields.
- Writes `~/.config/mobile-approve/broker.env` (chmod 600).
- Autodetects the install path:
  - **systemd user service** (default) — writes
    `~/.config/systemd/user/mobile-approve-broker.service` and enables it.
  - **docker compose** (fallback) — patches `compose.yaml` with a
    `broker` service and runs `docker compose up -d broker`. The broker
    reads sensitive values from the project-root `.env` file (which
    is gitignored; `setup-broker.sh` writes it for you).
- Starts the broker.

Verify:

```sh
bin/status.sh
```

You should see all green checks, including a "Broker" section showing
the broker is running and `/v1/health` returns ok.

Useful commands:

```sh
# Logs (systemd path)
journalctl --user -u mobile-approve-broker -f

# Logs (docker path)
docker compose logs -f broker

# Restart
systemctl --user restart mobile-approve-broker
# or
docker compose restart broker
```

### 3. HTTPS tunnel (Tailscale Serve, or alternatives)

The phone needs a public HTTPS URL to reach the broker's review page
(`/review/<id>?t=<token>` and `/decide/<id>` POST). The phone is on
your tailnet (Tailscale) or the public internet (Cloudflare, ngrok,
your own reverse proxy, etc.).

**Tailscale Serve** (the default — see [`docs/tailscale.md`](tailscale.md) for
others):

```sh
./bin/setup-serve.sh
```

What it does:

- Configures three Tailscale Serve rules (persisted by `tailscaled`):
  - `/<id>` and `/review/<id>` → `http://127.0.0.1:7461/review`
  - `/decide/<id>` → `http://127.0.0.1:7461/decide`
  - `/` (catch-all) → `http://127.0.0.1:8090` (ntfy)
- Detects the MagicDNS URL and patches `tunnel.publicBaseUrl` and
  `ntfy.baseUrl` into `~/.config/opencode/opencode.json`.

Verify:

```sh
sudo tailscale serve status
```

You should see the three rules. To test the path routing, the broker
must be running (step 2).

**Other tunnels** (Cloudflare, ngrok, your own reverse proxy, etc.) —
see [`docs/tailscale.md`](tailscale.md#alternatives-to-tailscale-serve) for
the full list.

### 4. plugin (this repo, loaded by opencode)

The plugin is a thin client — the broker does the heavy lifting. The
plugin file is loaded directly by opencode; no build step.

The `bin/setup-serve.sh` and `bin/setup-ntfy.sh` scripts have already
patched the mobile-approve plugin entry into
`~/.config/opencode/opencode.json`. The entry looks like:

```json
{
  "plugin": [
    [
      "/home/you/mobile-approve/src/index.ts",
      {
        "brokerBaseUrl": "http://127.0.0.1:7461",
        "tunnel": { "publicBaseUrl": "https://<your-host>.tailnet.ts.net" },
        "ntfy": {
          "baseUrl": "https://<your-host>.tailnet.ts.net",
          "topic": "oc-CHANGEME",
          "user": "pub-mobile-approve",
          "password": "tk_CHANGEME"
        }
      }
    ]
  ]
}
```

If you'd rather fill it in by hand, the only required fields are
`brokerBaseUrl` (default `http://127.0.0.1:7461`), `tunnel.publicBaseUrl`,
and the four `ntfy.*` fields.

#### Generate the HMAC secret

The HMAC secret signs review URLs. The plugin reads it from
`MOBILE_APPROVE_SECRET` in the shell that starts opencode:

```sh
export MOBILE_APPROVE_SECRET="$(head -c 32 /dev/urandom | base64)"
```

Persist it in your shell rcfile so every opencode launch sees the same
value. **The broker reads the same env var**, so when the broker runs
under systemd the secret must also be visible to the user session
(e.g. set it in `~/.config/environment.d/` or in the systemd unit's
`EnvironmentFile`).

If the env var is not set, the broker generates a random secret at
startup and logs a warning. In that case, phone approvals won't
survive a broker restart (the new secret won't match the old review
URL tokens).

#### Allow agent to continue after a deny

For **deny-with-hint** to actually resume the agent loop, the user
needs `experimental.continue_loop_on_deny: true` in
`~/.config/opencode/opencode.json`. Without it, the loop breaks on
the rejection and the synthetic hint sits in the message history
without being acted on.

```json
{
  "experimental": {
    "continue_loop_on_deny": true
  }
}
```

### 5. phone setup (last)

Install [ntfy Android](https://ntfy.sh/docs/subscribe/phone/) (F-Droid
or Play Store). When prompted for the server URL, use the **public
HTTPS URL** from step 3 (e.g. `https://<your-host>.tailnet.ts.net`).
Log in with the `pub-mobile-approve` user and the token from step 1.

Subscribe to the topic from step 1. The phone will now buzz for every
permission ask.

### 5b. Toggling phone notifications (optional)

Sometimes you don't want the phone to buzz — e.g. you're AFK and don't
want a backlog, or you're doing non-sensitive work and the in-TUI
prompt is enough.

The plugin registers a tool called **`mobile-approve`** in opencode.
Invoke it from opencode's command palette:

- The keybind varies by surface (Ctrl+Shift+P in the desktop/web TUI
  is the typical keybind; check opencode's settings).
- Search for `mobile-approve` (or `phone`, or `approve`).
- Pick an action: `enable`, `disable`, `toggle`, or `status`.
- The tool returns a short status string ("phone notifications: ON" /
  "OFF") and logs the change at INFO level to opencode's `mobile-approve`
  service log.

When phone notifications are off, the plugin bails out before calling
the broker — opencode's in-TUI permission prompt takes over. No phone
buzz, no review page, no broker roundtrip. The in-TUI prompt behaves
exactly the way it would without the plugin installed.

For a session-wide default, set `phoneNotifications: false` in the
mobile-approve plugin entry in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    [
      "/path/to/mobile-approve/src/index.ts",
      {
        "phoneNotifications": false,
        "..."
      }
    ]
  ]
}
```

State is per-session (in-memory). Restarting opencode reverts to the
default. The `mobile-approve` tool toggles the runtime state; the
`opencode.json` option only sets the initial value.

### 6. Smoke test

```sh
./bin/status.sh
```

All green checks = full stack is up. Then:

1. **Test the ntfy path**:
   ```sh
   curl -u pub-mobile-approve:<token> \
        -d "hello from curl" \
        https://<your-host>.tailnet.ts.net/oc-CHANGEME
   ```
   The phone should buzz.

2. **Test the broker path** (broker is on `127.0.0.1:7461`):
   ```sh
   curl -s http://127.0.0.1:7461/v1/health
   ```
   Should return `{"ok":true,...}`.

3. **Test the full flow**: restart opencode (`opencode` from a shell
   that has `MOBILE_APPROVE_SECRET` set), trigger a permission ask
   (e.g. set `"bash": "ask"` and try to run a `ls` command). The
   phone should buzz with the review URL.

4. **Test multi-session** (optional): start a second opencode session
   in a different terminal. The phone should be able to approve
   permission asks from both sessions, sharing the same whitelist.

---

## Filling in ntfy config by hand

If you'd rather not use `bin/setup-ntfy.sh`, the config goes into the
`mobile-approve` plugin entry in
`~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    [
      "/path/to/mobile-approve/src/index.ts",
      {
        "callbackPort": 7461,
        "defaultTimeoutMs": 300000,
        "hmacSecretEnv": "MOBILE_APPROVE_SECRET",
        "nonceTtlMs": 600000,
        "ntfy": {
          "baseUrl": "https://<your-host>.tailnet.ts.net",
          "topic": "oc-CHOOSE-A-TOPIC",
          "user": "pub-mobile-approve",
          "password": "tk_THE-NTFY-USER-PASSWORD"
        },
        "tunnel": {
          "publicBaseUrl": "https://<your-host>.tailnet.ts.net"
        }
      }
    ]
  ]
}
```

`brokerBaseUrl` is optional and defaults to `http://127.0.0.1:7461`
(use only if the broker is on a different port or host).

---

## Uninstalling

```sh
# Stop the broker
systemctl --user disable --now mobile-approve-broker  # or: docker compose stop broker

# Stop ntfy
docker compose stop ntfy

# Remove Tailscale Serve rules
sudo tailscale serve reset

# Remove the plugin entry
python3 -c "
import json
p = '$HOME/.config/opencode/opencode.json'
with open(p) as f: c = json.load(f)
c['plugin'] = [e for e in c.get('plugin', []) if not (isinstance(e, list) and 'mobile-approve' in (e[0] if e else ''))]
with open(p, 'w') as f: json.dump(c, f, indent=2)
"
```

---

## Multi-host setup (advanced)

The broker is per-machine. To have multiple opencode hosts share the
same broker:

- On the broker host: `bin/setup-broker.sh` (once). The broker listens
  on `127.0.0.1:7461`.
- On each opencode host: same plugin code, but with `brokerBaseUrl`
  pointing at the broker host (`http://<broker-host>:7461`, possibly
  via a Tailscale address or other tunnel). Same `ntfy.*` config.

Whitelist is shared on the broker host. Each opencode host gets its
own phone reviews (different Tailscale URLs).

Path B in this doc (the original "shared remote ntfy on a VM" setup)
is now covered by just running the broker on the VM with the same
config; ntfy and the broker are independent. You can put either or
both in docker. See the docker compose approach in `bin/setup-broker.sh`.
