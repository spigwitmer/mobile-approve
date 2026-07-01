#!/usr/bin/env bash
# Idempotently configure Tailscale Serve for mobile-approve AND register the
# plugin in ~/.config/opencode/opencode.json (the global config).
#
# mobile-approve is a system-level concern (it's about how opencode interacts
# with the user, not project-specific), so it lives in the global config so
# every project picks it up. Project-local opencode.json files are left alone.
#
# This script is safe to run multiple times. Tailscale's `--bg` flag updates
# existing rules rather than duplicating them, and the configuration is
# persisted by tailscaled — it survives reboots and `tailscaled` restarts
# automatically.
#
# What it configures (all on Tailscale HTTPS port 443, path-routed):
#   /review/* → 127.0.0.1:7461  (plugin's review HTML page)
#   /decide/* → 127.0.0.1:7461  (plugin's decision callback)
#   /*        → 127.0.0.1:8090  (ntfy)
#
# What it writes to ~/.config/opencode/opencode.json:
#   - new plugin entry: [absolute-path-to-mobile-approve/src/index.ts, {...}]
#     (absolute path so the plugin loads regardless of cwd)
#   - tunnel.publicBaseUrl → MagicDNS URL
#   - ntfy.baseUrl         → same MagicDNS URL (Path A uses both)
#
# What it does NOT touch (you fill these in yourself, see docs/install.md):
#   - ntfy.topic, ntfy.user, ntfy.password
#   - hmacSecretEnv / MOBILE_APPROVE_SECRET (in your shell rcfile, not the config)
#
# Prereqs:
#   - Tailscale installed and signed in: https://tailscale.com/download
#   - Tailscale HTTPS enabled in the admin console (one-time per tailnet)
#   - python3 on PATH (for safe JSON editing)

set -euo pipefail

# --- preflight --------------------------------------------------------------

if ! command -v tailscale >/dev/null 2>&1; then
  cat >&2 <<EOF
error: tailscale CLI not found.

  Install Tailscale first: https://tailscale.com/download
  Then sign in:           sudo tailscale up
EOF
  exit 1
fi

if ! tailscale status --json >/dev/null 2>&1; then
  cat >&2 <<EOF
error: tailscale is not running.

  Start it with:  sudo tailscale up
EOF
  exit 1
fi

backend_state=$(tailscale status --json | grep -o '"BackendState": *"[^"]*"' | head -1 | grep -o '"[^"]*"$' | tr -d '"')
if [ "$backend_state" != "Running" ] && [ -n "$backend_state" ]; then
  cat >&2 <<EOF
error: tailscale is connected but not in 'Running' state (got '$backend_state').

  Check:  tailscale status
EOF
  exit 1
fi

# --- tailscale serve --------------------------------------------------------

echo "Configuring Tailscale Serve rules for mobile-approve..."
echo ""

# Target URL includes the upstream path so Tailscale Serve preserves the
# matched prefix when forwarding (otherwise the plugin server only sees the
# post-prefix portion and returns 404 "not found" on /review/* and /decide/*).
sudo tailscale serve --bg --https=443 /review http://127.0.0.1:7461/review
sudo tailscale serve --bg --https=443 /decide http://127.0.0.1:7461/decide
sudo tailscale serve --bg --https=443 /        http://127.0.0.1:8090

echo ""
echo "Tailscale Serve state:"
echo ""
tailscale serve status

echo ""

# --- detect MagicDNS URL ----------------------------------------------------

url=$(tailscale serve status 2>/dev/null \
  | grep -oE 'https://[a-zA-Z0-9.-]+\.ts\.net(:[0-9]+)?' \
  | head -1 || true)

if [ -z "$url" ]; then
  cat >&2 <<EOF
error: could not parse MagicDNS URL from 'tailscale serve status'.

  The rules may be misconfigured. Try:
    sudo tailscale serve reset
    ./bin/setup-serve.sh
EOF
  exit 1
fi

echo "MagicDNS URL: $url"
echo ""

# --- patch ~/.config/opencode/opencode.json -------------------------------

if ! command -v python3 >/dev/null 2>&1; then
  cat >&2 <<EOF
error: python3 not found on PATH.

  opencode.json editing requires python3 to safely modify the JSON.
  Install python3 or edit ~/.config/opencode/opencode.json manually:

    tunnel.publicBaseUrl: "$url"
    ntfy.baseUrl:         "$url"
EOF
  exit 1
fi

config_path="$HOME/.config/opencode/opencode.json"
config_dir=$(dirname "$config_path")

# Compute the absolute path to the plugin entrypoint from this script's location.
script_dir="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
abs_plugin_path="$script_dir/../src/index.ts"

# Backup existing config if present.
if [ -f "$config_path" ]; then
  ts=$(date +%Y%m%d-%H%M%S)
  backup="${config_path}.bak.${ts}"
  cp "$config_path" "$backup"
  echo "Patching $config_path (backup at $backup)..."
else
  echo "Creating $config_path (didn't exist)..."
fi

mkdir -p "$config_dir"

# Use python3 for safe JSON editing.
url="$url" \
  config_path="$config_path" \
  abs_plugin_path="$abs_plugin_path" \
  python3 <<'PYEOF'
import json, os, sys

config_path = os.environ["config_path"]
url = os.environ["url"]
abs_plugin_path = os.environ["abs_plugin_path"]

# Load existing config or create a minimal one.
if os.path.exists(config_path):
    with open(config_path, "r") as f:
        try:
            config = json.load(f)
        except json.JSONDecodeError as e:
            print(f"error: {config_path} is not valid JSON: {e}", file=sys.stderr)
            sys.exit(1)
    created = False
else:
    config = {"$schema": "https://opencode.ai/config.json"}
    created = True

plugins = config.setdefault("plugin", [])
if not isinstance(plugins, list):
    print("error: existing 'plugin' field is not a list", file=sys.stderr)
    sys.exit(1)

# Find the mobile-approve plugin entry.
mobile_entry = None
for entry in plugins:
    if not (isinstance(entry, list) and len(entry) >= 2):
        continue
    name = entry[0] if isinstance(entry[0], str) else ""
    opts = entry[1] if isinstance(entry[1], dict) else {}
    is_mobile = (
        "mobile-approve" in name.lower()
        or name.endswith("mobile-approve")
        or name == "./src/index.ts"
        or name.endswith("/src/index.ts")
    )
    if is_mobile:
        mobile_entry = entry
        break

if mobile_entry is None:
    # No existing entry — append one with an absolute path.
    mobile_entry = [abs_plugin_path, {}]
    plugins.append(mobile_entry)
    print(f"added new mobile-approve plugin entry → {abs_plugin_path}")
else:
    # Existing entry: rewrite relative paths to absolute so the plugin
    # loads regardless of cwd.
    old_name = mobile_entry[0]
    if not os.path.isabs(old_name) and (
        old_name in ("./src/index.ts", "src/index.ts")
        or old_name.endswith("/src/index.ts")
    ):
        print(f"rewriting path {old_name!r} → {abs_plugin_path}")
        mobile_entry[0] = abs_plugin_path

# Patch the URL fields (Path A uses the same URL for both).
opts = mobile_entry[1]
if not isinstance(opts, dict):
    print("error: existing mobile-approve entry has non-dict options", file=sys.stderr)
    sys.exit(1)

opts.setdefault("tunnel", {})["publicBaseUrl"] = url
opts.setdefault("ntfy", {})["baseUrl"] = url

with open(config_path, "w") as f:
    json.dump(config, f, indent=2)
    f.write("\n")

print(f"patched tunnel.publicBaseUrl and ntfy.baseUrl → {url}")
print(f"config file: {config_path}{' (newly created)' if created else ''}")
PYEOF

# --- patch compose.yaml: NTFY_BASE_URL placeholder ----------------------

# compose.yaml has NTFY_BASE_URL: __NTFY_BASE_URL__ as a sentinel. Patch it
# with the real MagicDNS URL so the ntfy container knows its public address
# (needed for attachment URLs and proper Host header handling).
# Idempotent: no-op if the URL is already correct.
repo_root="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." >/dev/null 2>&1 && pwd )"
echo ""
echo "Patching compose.yaml NTFY_BASE_URL..."
url="$url" compose_file="$repo_root/compose.yaml" python3 <<'PYEOF'
import os, re, sys

compose_path = os.environ["compose_file"]
new_url = os.environ["url"]

if not os.path.exists(compose_path):
    print(f"warning: {compose_path} not found; skipping NTFY_BASE_URL patch",
          file=sys.stderr)
    sys.exit(0)

with open(compose_path, "r") as f:
    content = f.read()

new_content, n = re.subn(
    r'^(\s*NTFY_BASE_URL:\s*).*$',
    rf'\g<1>{new_url}',
    content,
    flags=re.MULTILINE,
)

if n == 0:
    print("warning: no NTFY_BASE_URL line found in compose.yaml", file=sys.stderr)
    sys.exit(0)

if new_content == content:
    print("NTFY_BASE_URL already set correctly")
else:
    with open(compose_path, "w") as f:
        f.write(new_content)
    print(f"patched NTFY_BASE_URL → {new_url}")
PYEOF

echo ""
echo "Next step: run ./bin/setup-ntfy.sh"
echo ""
echo "  That script generates the ntfy topic, creates the publish-only user via"
echo "  'docker compose exec ntfy ntfy user add', and patches topic/user/password"
echo "  into the same opencode config. It expects ntfy to already be deployed."
echo ""
echo "Still manual:"
echo "  - MOBILE_APPROVE_SECRET in your shell rcfile (one random base64 string):"
echo "      export MOBILE_APPROVE_SECRET=\"\$(head -c 32 /dev/urandom | base64)\""
echo ""
echo "Reminder: Tailscale Serve rules persist across reboots via tailscaled."
echo "To remove them:  sudo tailscale serve reset"