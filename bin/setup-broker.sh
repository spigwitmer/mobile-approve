#!/usr/bin/env bash
# Idempotently install and start the mobile-approve-broker.
#
# Two deployment paths, autodetected:
#
#   Path A (systemd user service, recommended for daily use)
#     - writes a systemd unit at ~/.config/systemd/user/mobile-approve-broker.service
#     - generates an env file at ~/.config/mobile-approve/broker.env
#       from ~/.config/opencode/opencode.json (the existing mobile-approve
#       plugin entry's tunnel.publicBaseUrl and ntfy.* fields)
#     - systemctl --user enable --now mobile-approve-broker
#     - journalctl --user -u mobile-approve-broker -f for logs
#
#   Path B (docker alongside ntfy)
#     - adds a "broker" service to compose.yaml with the right env vars
#     - leaves starting it to the user (docker compose up -d)
#
# Selection rules:
#   --path=auto  (default) picks A if the user has systemd-run/user available
#                 and no docker compose with a broker service; otherwise B.
#   --path=systemd forces A.
#   --path=docker forces B.
#
# This script is safe to re-run.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
PLUGIN_DIR="$( cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd )"
OPENCODE_CONFIG="${MOBILE_APPROVE_OPENCODE_CONFIG:-$HOME/.config/opencode/opencode.json}"
ENV_DIR="$HOME/.config/mobile-approve"
ENV_FILE="$ENV_DIR/broker.env"
SYSTEMD_DIR="$HOME/.config/systemd/user"
SYSTEMD_FILE="$SYSTEMD_DIR/mobile-approve-broker.service"
COMPOSE_FILE="$PLUGIN_DIR/compose.yaml"
SERVICE_TEMPLATE="$PLUGIN_DIR/packaging/mobile-approve-broker.service"
BROKER_WRAPPER="$PLUGIN_DIR/bin/mobile-approve-broker"

DESIRED_PATH="auto"
while [ $# -gt 0 ]; do
  case "$1" in
    --path=*)      DESIRED_PATH="${1#--path=}" ;;
    --config=*)    OPENCODE_CONFIG="${1#--config=}" ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 64 ;;
  esac
  shift
done

# --- preflight ------------------------------------------------------------

if [ ! -f "$OPENCODE_CONFIG" ]; then
  echo "error: opencode config not found at $OPENCODE_CONFIG" >&2
  echo "  Set MOBILE_APPROVE_OPENCODE_CONFIG or run setup-serve.sh first." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 not found (required for safe JSON editing)" >&2
  exit 1
fi

# --- read opencode.json ---------------------------------------------------

# Read the mobile-approve plugin entry from opencode.json via python3.
read_opencode() {
  config_path="$1"
  OPENCODE_CONFIG="$config_path" python3 - <<PYEOF
import json, os, sys

config_path = os.environ["OPENCODE_CONFIG"]
with open(config_path) as f:
    config = json.load(f)

plugins = config.get("plugin") or []
mobile = None
for entry in plugins:
    if not (isinstance(entry, list) and len(entry) >= 2):
        continue
    name = entry[0] if isinstance(entry[0], str) else ""
    if ("mobile-approve" in name
        or name.endswith("/src/index.ts")
        or name.endswith("/bin/../src/index.ts")):
        mobile = entry
        break

if mobile is None:
    print("ERROR: no mobile-approve plugin entry in", config_path, file=sys.stderr)
    sys.exit(1)

opts = mobile[1] if isinstance(mobile[1], dict) else {}
tunnel = opts.get("tunnel") or {}
ntfy = opts.get("ntfy") or {}
public_url = tunnel.get("publicBaseUrl")
ntfy_base = ntfy.get("baseUrl")
ntfy_topic = ntfy.get("topic")
ntfy_user = ntfy.get("user")
ntfy_pass = ntfy.get("password")

if not (public_url and ntfy_base and ntfy_topic and ntfy_user and ntfy_pass):
    print("ERROR: mobile-approve plugin entry missing tunnel.publicBaseUrl or one of ntfy.{baseUrl,topic,user,password}", file=sys.stderr)
    sys.exit(1)

print(f"PUBLIC_URL={public_url}")
print(f"NTFY_BASE_URL={ntfy_base}")
print(f"NTFY_TOPIC={ntfy_topic}")
print(f"NTFY_USER={ntfy_user}")
print(f"NTFY_PASSWORD={ntfy_pass}")
PYEOF
}

opencode_values=$(read_opencode "$OPENCODE_CONFIG") \
  || { echo "error: failed to parse $OPENCODE_CONFIG" >&2; exit 1; }

PUBLIC_URL=$(echo "$opencode_values" | sed -n 's/^PUBLIC_URL=//p')
NTFY_BASE_URL=$(echo "$opencode_values" | sed -n 's/^NTFY_BASE_URL=//p')
NTFY_TOPIC=$(echo "$opencode_values" | sed -n 's/^NTFY_TOPIC=//p')
NTFY_USER=$(echo "$opencode_values" | sed -n 's/^NTFY_USER=//p')
NTFY_PASSWORD=$(echo "$opencode_values" | sed -n 's/^NTFY_PASSWORD=//p')

# --- pick path ------------------------------------------------------------

have_systemd_user() {
  # Check if systemd --user is available. On most Linux desktops with
  # systemd-logind, `systemctl --user` works even without lingering.
  systemctl --user status >/dev/null 2>&1
}

have_docker() {
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
}

compose_has_broker() {
  [ -f "$COMPOSE_FILE" ] && grep -q "^[ ]*broker:" "$COMPOSE_FILE"
}

case "$DESIRED_PATH" in
  auto)
    if have_docker && compose_has_broker; then
      PATH_CHOSEN="docker"
    elif have_docker; then
      # docker is available, no broker service yet -> set up Path B
      PATH_CHOSEN="docker"
    elif have_systemd_user; then
      PATH_CHOSEN="systemd"
    else
      echo "error: no systemd --user and no docker compose available." >&2
      echo "  Run on a system with one of them, or use --path=systemd explicitly." >&2
      exit 1
    fi
    ;;
  systemd|docker) PATH_CHOSEN="$DESIRED_PATH" ;;
  *)
    echo "error: --path must be auto, systemd, or docker" >&2
    exit 64
    ;;
esac

echo "Installing mobile-approve-broker via: $PATH_CHOSEN"
echo ""

# --- common: write env file ----------------------------------------------

mkdir -p "$ENV_DIR"
cat > "$ENV_FILE" <<EOF
# Generated by bin/setup-broker.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Do not edit by hand — re-run setup-broker.sh to regenerate.
MOBILE_APPROVE_PUBLIC_URL=$PUBLIC_URL
MOBILE_APPROVE_NTFY_BASE_URL=$NTFY_BASE_URL
MOBILE_APPROVE_NTFY_TOPIC=$NTFY_TOPIC
MOBILE_APPROVE_NTFY_USER=$NTFY_USER
MOBILE_APPROVE_NTFY_PASSWORD=$NTFY_PASSWORD
MOBILE_APPROVE_OPENCODE_CONFIG=$OPENCODE_CONFIG
MOBILE_APPROVE_LOG_LEVEL=info
EOF
chmod 600 "$ENV_FILE"
echo "Wrote $ENV_FILE"
echo ""

# --- Path A: systemd -------------------------------------------------------

install_systemd() {
  if ! have_systemd_user; then
    echo "error: systemd --user is not available on this system." >&2
    exit 1
  fi

  mkdir -p "$SYSTEMD_DIR"

  # Generate the unit file with the absolute plugin path.
  # The template at $SERVICE_TEMPLATE uses /home/pat/mobile-approve; we
  # substitute with whatever $PLUGIN_DIR is.
  sed "s|/home/pat/mobile-approve|$PLUGIN_DIR|g" \
    "$SERVICE_TEMPLATE" > "$SYSTEMD_FILE"

  echo "Wrote $SYSTEMD_FILE"
  systemctl --user daemon-reload
  systemctl --user enable mobile-approve-broker.service
  systemctl --user restart mobile-approve-broker.service

  sleep 1
  if systemctl --user is-active --quiet mobile-approve-broker.service; then
    echo ""
    echo "mobile-approve-broker is running."
    echo ""
    echo "Useful commands:"
    echo "  systemctl --user status mobile-approve-broker"
    echo "  journalctl --user -u mobile-approve-broker -f"
    echo "  systemctl --user restart mobile-approve-broker"
  else
    echo "warning: service did not start. Last 20 log lines:" >&2
    journalctl --user -u mobile-approve-broker -n 20 --no-pager >&2 || true
    exit 1
  fi
}

# --- Path B: docker compose -----------------------------------------------

install_docker() {
  if ! have_docker; then
    echo "error: docker compose not available" >&2
    exit 1
  fi

  if ! [ -f "$COMPOSE_FILE" ]; then
    echo "error: $COMPOSE_FILE not found. Run setup-ntfy.sh first to create it." >&2
    exit 1
  fi

  if compose_has_broker; then
    echo "compose.yaml already has a 'broker:' service. Skipping compose patch."
  else
    # Write the project-root .env file so docker compose can read
    # sensitive values without committing them to compose.yaml. This file
    # is gitignored (see the .env rule in .gitignore).
    if [ ! -f "$PLUGIN_DIR/.env" ]; then
      if [ -f "$PLUGIN_DIR/.env.example" ]; then
        cp "$PLUGIN_DIR/.env.example" "$PLUGIN_DIR/.env"
      else
        # Fallback if .env.example is missing
        cat > "$PLUGIN_DIR/.env" <<EOF
# Generated by bin/setup-broker.sh
MOBILE_APPROVE_PUBLIC_URL=$PUBLIC_URL
MOBILE_APPROVE_NTFY_BASE_URL=$NTFY_BASE_URL
MOBILE_APPROVE_NTFY_TOPIC=$NTFY_TOPIC
MOBILE_APPROVE_NTFY_USER=$NTFY_USER
MOBILE_APPROVE_NTFY_PASSWORD=$NTFY_PASSWORD
EOF
      fi
    fi
    # Overwrite sensitive values (idempotent — keeps .env in sync with opencode.json)
    sed -i.bak \
      -e "s|^MOBILE_APPROVE_PUBLIC_URL=.*|MOBILE_APPROVE_PUBLIC_URL=$PUBLIC_URL|" \
      -e "s|^MOBILE_APPROVE_NTFY_BASE_URL=.*|MOBILE_APPROVE_NTFY_BASE_URL=$NTFY_BASE_URL|" \
      -e "s|^MOBILE_APPROVE_NTFY_TOPIC=.*|MOBILE_APPROVE_NTFY_TOPIC=$NTFY_TOPIC|" \
      -e "s|^MOBILE_APPROVE_NTFY_USER=.*|MOBILE_APPROVE_NTFY_USER=$NTFY_USER|" \
      -e "s|^MOBILE_APPROVE_NTFY_PASSWORD=.*|MOBILE_APPROVE_NTFY_PASSWORD=$NTFY_PASSWORD|" \
      "$PLUGIN_DIR/.env"
    rm -f "$PLUGIN_DIR/.env.bak"
    chmod 600 "$PLUGIN_DIR/.env"
    echo "Wrote $PLUGIN_DIR/.env (chmod 600, gitignored)"
  fi
    # Append the broker service block before the 'volumes:' section.
    COMPOSE_FILE="$COMPOSE_FILE" \
    ENV_FILE="$ENV_FILE" \
    PUBLIC_URL="$PUBLIC_URL" \
    NTFY_BASE_URL="$NTFY_BASE_URL" \
    NTFY_TOPIC="$NTFY_TOPIC" \
    NTFY_USER="$NTFY_USER" \
    NTFY_PASSWORD="$NTFY_PASSWORD" \
    python3 - <<'PYEOF'
import os, re

compose_path = os.environ["COMPOSE_FILE"]
env_path = os.environ["ENV_FILE"]
new_url = os.environ["PUBLIC_URL"]
new_ntfy_base = os.environ["NTFY_BASE_URL"]
new_ntfy_topic = os.environ["NTFY_TOPIC"]
new_ntfy_user = os.environ["NTFY_USER"]
new_ntfy_password = os.environ["NTFY_PASSWORD"]
public_url_no_scheme = new_url.split("://", 1)[1] if "://" in new_url else new_url

with open(compose_path, "r") as f:
    content = f.read()

broker_block = f"""
  broker:
    # We use node:22-bookworm-slim instead of oven/bun:1 because bun's HTTP
    # server has been observed to reset TCP connections in some environments
    # (the broker starts cleanly, logs "broker ready", but the first HTTP
    # request gets a TCP RST). node's HTTP server is stable.
    image: node:22-bookworm-slim
    command: ["sh", "-c", "npm install --no-save tsx && node --import tsx src/broker-cli.ts"]
    restart: unless-stopped
    working_dir: /app
    ports:
      - "127.0.0.1:7461:7461"
    # Sensitive values (ntfy password, HMAC secret) are read from the
    # project's .env file (which is gitignored). See .env.example for the
    # full list. setup-broker.sh writes this file on first run.
    env_file:
      - .env
    environment:
      MOBILE_APPROVE_PORT: "7461"
      MOBILE_APPROVE_LOG_LEVEL: "info"
      # All MOBILE_APPROVE_* values are pulled from the .env file (set by
      # setup-broker.sh, see below). The :? suffix makes compose fail to
      # start if the variable is missing.
      MOBILE_APPROVE_PUBLIC_URL: "${{MOBILE_APPROVE_PUBLIC_URL:?required}}"
      MOBILE_APPROVE_NTFY_BASE_URL: "${{MOBILE_APPROVE_NTFY_BASE_URL:?required}}"
      MOBILE_APPROVE_NTFY_TOPIC: "${{MOBILE_APPROVE_NTFY_TOPIC:?required}}"
      MOBILE_APPROVE_NTFY_USER: "${{MOBILE_APPROVE_NTFY_USER:?required}}"
      MOBILE_APPROVE_NTFY_PASSWORD: "${{MOBILE_APPROVE_NTFY_PASSWORD:?required}}"
    volumes:
      - ./src:/app/src
      - ./package.json:/app/package.json
      - ./tsconfig.json:/app/tsconfig.json
    depends_on:
      - ntfy
"""

# Insert before the trailing 'volumes:' top-level key if present,
# otherwise append at the end.
if re.search(r"^volumes:\n", content, re.MULTILINE):
    content = re.sub(
        r"^volumes:\n",
        broker_block.lstrip("\n") + "\nvolumes:\n",
        content,
        count=1,
        flags=re.MULTILINE,
    )
else:
    content = content.rstrip() + "\n" + broker_block

# Ensure file ends with a newline.
if not content.endswith("\n"):
    content += "\n"

with open(compose_path, "w") as f:
    f.write(content)
print(f"patched {compose_path}")
PYEOF
  fi

  # Run docker compose up to start the broker.
  (cd "$PLUGIN_DIR" && docker compose up -d broker)

  echo ""
  echo "broker service is starting. Check with: docker compose ps"
}

# --- dispatch -------------------------------------------------------------

case "$PATH_CHOSEN" in
  systemd) install_systemd ;;
  docker)  install_docker ;;
esac

echo ""
echo "Done. Restart opencode so the plugin picks up the broker."