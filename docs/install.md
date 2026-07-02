# Install guide

This guide covers the one-time setup of the relay side of `mobile-approve`. The plugin code itself runs alongside opencode — what this document configures is the bridge between your phone and the plugin.

Two deployment paths are documented. Pick one:

- **Path A (laptop-only, recommended)** — opencode, the plugin, and ntfy.sh all run on the same laptop. Best for a single-machine setup.
- **Path B (shared remote ntfy)** — ntfy.sh runs on a remote host so multiple opencode installations can share the same phone approval stream. Use only if you run opencode on multiple machines that need the same phone approvals.

Both paths assume your phone and your opencode workstation(s) are on the same Tailscale tailnet.

---

## Path A — laptop-only (recommended)

Everything runs on the laptop where opencode runs. ntfy.sh is reachable only over the tailnet, so there's no public attack surface.

### A1. Enable Tailscale HTTPS

Tailscale's HTTPS feature auto-provisions a Let's Encrypt cert for your MagicDNS hostname (`<laptop>.<tailnet>.ts.net`). The plugin's review page is served over this cert.

In the [Tailscale admin console](https://login.tailscale.com/admin/dns):

1. Enable MagicDNS (under **DNS**) if not already on.
2. Under **HTTPS Certificates**, click **Enable HTTPS**. Acknowledge the prompt about machine names appearing in the Certificate Transparency public ledger — this only exposes your MagicDNS hostname, not anything sensitive.

### A2. (No action — `bin/setup-ntfy.sh` brings ntfy up automatically)

The repo ships a `compose.yaml` and `server.yml` that bring up ntfy on `127.0.0.1:8090`. You don't need to run `docker compose up` yourself — `bin/setup-ntfy.sh` in step A5 detects whether the container is running and starts it if not.

The `compose.yaml` includes:

- `NTFY_AUTH_DEFAULT_ACCESS: "deny-all"` — required, enables auth so the script can create users.
- `NTFY_AUTH_FILE: /var/cache/ntfy/user.db` — required, points auth at a file inside the named `ntfy-cache` volume.
- `NTFY_BEHIND_PROXY: "true"` — required, tells ntfy to trust the `X-Forwarded-*` headers from Tailscale Serve.
- `NTFY_BASE_URL: __NTFY_BASE_URL__` — a sentinel, automatically patched with your MagicDNS URL by `bin/setup-serve.sh` (so attachments get the right URL and the Host header is preserved).

If you have an existing ntfy deployment (e.g. in a homelab stack), pass `--compose-file /path/to/your/compose.yaml` to `bin/setup-ntfy.sh` to point at it.

User creation and topic generation are handled by `bin/setup-ntfy.sh` in step A5 — you don't need to run `ntfy user add` manually.

### A3. Configure Tailscale Serve (path-based routing)

Both the plugin and ntfy share Tailscale's HTTPS-on-port-443 with cert, and Tailscale Serve's `--set-path` routes URLs to the right backend.

From the `mobile-approve` repo, run:

```sh
./bin/setup-serve.sh
```

The script:

1. Configures the three Tailscale Serve rules. Idempotent — re-running updates existing rules rather than duplicating them. The rules are persisted by `tailscaled` and survive reboots automatically.
2. Detects the MagicDNS URL and **registers the plugin in `~/.config/opencode/opencode.json`** (the global config). It sets both `tunnel.publicBaseUrl` and `ntfy.baseUrl` to that URL. The plugin entry is added with an **absolute path** to the mobile-approve source so it loads regardless of cwd. If the global config doesn't exist, the script creates it; if a mobile-approve entry already exists, it patches that entry in place (and rewrites a relative path to absolute if needed). A timestamped backup is made before any edit.
3. Prints a checklist of the fields you still need to fill in by hand (`ntfy.topic`, `ntfy.user`, `ntfy.password`).

The global config is the canonical home for this plugin because it's a system-level concern (how opencode interacts with the user), not project-specific. Project-local `opencode.json` files are left untouched.

To inspect or reset the Tailscale rules (not the JSON file):

```sh
tailscale serve status        # show current rules
sudo tailscale serve reset    # remove all rules
```

### A4. Install the Android client

Install **ntfy** from F-Droid (preferred — no Google Play Services dependency) or the Play Store. Add your server:

- Server URL: `https://<laptop>.<tailnet>.ts.net`
- Username: `pub-mobile-approve`
- Password: the token from step A2

Subscribe to the topic from step A2.

### A5. Generate ntfy credentials

`bin/setup-serve.sh` already wrote the plugin entry, `tunnel.publicBaseUrl`, and `ntfy.baseUrl` into `~/.config/opencode/opencode.json`. This step fills in the remaining ntfy credentials.

From the mobile-approve repo (or wherever your ntfy compose stack lives):

```sh
./bin/setup-ntfy.sh
```

The script:

1. Generates a random topic name (`oc-<9 random chars>`).
2. Creates the ntfy user via `docker compose exec ntfy ntfy useradd` and captures the one-time token.
3. Patches `~/.config/opencode/opencode.json` with `ntfy.topic`, `ntfy.user`, `ntfy.password`. Backs up the config first.

Flags (all optional):

- `--compose-file PATH` — point at a specific compose file if the script can't auto-detect.
- `--compose-project NAME` — for stacks without a compose file (uses the project name).
- `--topic NAME` — use a specific topic instead of the generated one.
- `--user NAME` — override the default `pub-mobile-approve`.

If you want to fill these in by hand instead, the config looks like:

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

Generate the HMAC secret once per workstation:

```sh
export MOBILE_APPROVE_SECRET="$(head -c 32 /dev/urandom | base64)"
```

Persist it in your shell rcfile so every opencode launch sees it. (The broker also reads this — set it on the workstation where the broker runs, or in the broker's systemd EnvironmentFile.)

### A6. Install the broker

The broker is the long-running daemon that owns the HTTP server, ntfy publish, and the shared whitelist. It listens on `127.0.0.1:7461` and exposes the `/v1/*` API to the plugin. Without the broker, the plugin falls back to the in-TUI prompt (no phone approval).

Two deployment paths; `bin/setup-broker.sh` autodetects:

```sh
./bin/setup-broker.sh
```

- **Path A — systemd user service (recommended)** — if `systemctl --user` works, the script writes `~/.config/systemd/user/mobile-approve-broker.service` and `~/.config/mobile-approve/broker.env` (chmod 600 — contains the ntfy password), then `systemctl --user enable --now mobile-approve-broker.service`. Survives reboots, auto-restarts on crash. Logs go to journald: `journalctl --user -u mobile-approve-broker -f`.
- **Path B — docker alongside ntfy** — if no systemd --user is available, the script appends a `broker` service to `compose.yaml` and runs `docker compose up -d broker`. The broker uses `oven/bun:1` and connects to ntfy via compose's internal DNS.

Re-run `bin/setup-broker.sh` after changing any field in the opencode.json mobile-approve entry — it regenerates the env file / compose patch from the latest config.

If you want a non-default port, set `MOBILE_APPROVE_PORT` in the env file (or change `ports:` in compose.yaml) and add `brokerBaseUrl` to the plugin's opencode.json entry:

```json
"brokerBaseUrl": "http://127.0.0.1:8000"
```

### A7. Smoke test

From the `mobile-approve` repo, run:

```sh
./bin/status.sh
```

Expected output (with everything deployed): all green checks. The script verifies the Tailscale daemon, the three serve rules, the ntfy container, the ntfy local health endpoint, the broker process + /v1/health, and the opencode install.

Then trigger an end-to-end test:

1. From another shell on the laptop (or any tailnet device), publish a test notification:

   ```sh
   curl -u pub-mobile-approve:<token> \
        -d "hello from curl" \
        https://<laptop>.<tailnet>.ts.net/oc-patsbox-abc123def
   ```

   Your phone should buzz.

2. Trigger a permission ask in opencode — set `"bash": "ask"` and run a command. The plugin logs `permission.asked received` (the in-process dedupe + the /v1/ask to the broker). The broker logs `ask -> publishing to phone` and `ntfy notification published`. The phone receives the notification; tapping the body opens `https://<laptop>.<tailnet>.ts.net/review/<id>?t=<token>` in the phone's browser.

3. From a second opencode session (different terminal: `opencode -s <other-session>`), trigger another permission ask. The phone receives the second notification. The whitelist is shared — if you `Allow always` from session A, session B's matching tool calls skip the phone roundtrip.

---

## Path B — shared remote ntfy (multi-machine opencode hosts)

Use this only if you run opencode on multiple machines that all need the same phone approvals. ntfy.sh runs on a remote host (VM) with public HTTPS; each opencode installation has its own Tailscale Serve rule for the plugin's review page.

### B1. Self-host ntfy on a VM

Reference `compose.yaml` on the VM:

```yaml
services:
  ntfy:
    image: binwiederhier/ntfy
    command: serve
    restart: unless-stopped
    environment:
      - NTFY_BASE_URL=https://ntfy.example.com
    volumes:
      - /var/lib/ntfy:/var/cache/ntfy
      - ./server.yml:/etc/ntfy/server.yml:ro

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  caddy_data:
  caddy_config:
```

Reference `server.yml`:

```yaml
base-url: "https://ntfy.example.com"
auth-default-access: "deny-all"
behind-proxy: true
```

Reference `Caddyfile`:

```
ntfy.example.com {
    reverse_proxy ntfy:80
}
```

Deploy:

```sh
mkdir -p /var/lib/ntfy
docker compose up -d
```

Create user and pick a topic (same as in Path A):

```sh
docker compose exec ntfy ntfy useradd --role=user pub-mobile-approve
echo "oc-$(head -c 9 /dev/urandom | base32 | tr -d =)"
```

### B2. Install the Android client

Server URL: `https://ntfy.example.com`. Username: `pub-mobile-approve`. Password: the token from B1.

Subscribe to the topic.

### B3. Configure Tailscale Serve on each opencode host

Each opencode host runs its own plugin instance with its own Tailscale Serve rule:

```sh
sudo tailscale serve --bg --https=443 http://localhost:7461
```

The plugin is reachable at `https://<this-host>.<tailnet>.ts.net` on that host. Each host's MagicDNS name is unique.

### B4. Configure opencode.json per host

On each opencode host, the configuration looks the same for `ntfy.*` but different for `tunnel.*`:

```json
{
  "plugin": [
    [
      "./src/index.ts",
      {
        "callbackPort": 7461,
        "defaultTimeoutMs": 300000,
        "hmacSecretEnv": "MOBILE_APPROVE_SECRET",
        "nonceTtlMs": 600000,
        "ntfy": {
          "baseUrl": "https://ntfy.example.com",
          "topic": "oc-patsbox-abc123def",
          "user": "pub-mobile-approve",
          "password": "tk_xxxxxxxxxxxxxxxxx"
        },
        "tunnel": {
          "publicBaseUrl": "https://<this-host>.<tailnet>.ts.net"
        }
      }
    ]
  ]
}
```

The HMAC secret must be unique per host (since each host's plugin verifies its own callbacks). Generate per-host:

```sh
export MOBILE_APPROVE_SECRET="$(head -c 32 /dev/urandom | base64)"
```

### B5. Smoke test

From any tailnet device:

```sh
curl -u pub-mobile-approve:<token> \
     -d "hello from curl" \
     https://ntfy.example.com/oc-patsbox-abc123def
```

Phone buzzes. Trigger a permission ask on any opencode host; the phone receives the notification with that host's review URL.