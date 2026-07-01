#!/usr/bin/env bash
# Generate ntfy credentials for mobile-approve and patch them into the
# global opencode config.
#
# What it does:
#   1. Generates a random, un-guessable topic name (or accepts --topic)
#   2. Creates a publish-only ntfy user via `docker compose exec ntfy ntfy user add`
#      and captures the one-time token (ntfy v2.x CLI only; v1.x is EOL)
#   3. Patches ~/.config/opencode/opencode.json with topic, user, password
#
# Companion to setup-serve.sh:
#   - setup-serve.sh handles Tailscale Serve + the URL fields
#   - setup-ntfy.sh handles the ntfy credentials
#
# Defaults are sensible for the documented Path A (laptop-only) deployment.
#
# Flags:
#   --compose-file PATH     path to your docker-compose file (auto-detected)
#   --compose-project NAME  docker compose project name (for stacks without compose-file)
#   --topic NAME            override the generated topic name
#   --user NAME             override the default ntfy username (pub-mobile-approve)
#   --config-path PATH      override the opencode config location
#
# Prereqs:
#   - ntfy already deployed as a Docker container named 'ntfy' in some compose
#     project reachable from this directory OR via --compose-file
#   - python3 on PATH (for safe JSON editing)
#   - setup-serve.sh has already been run (URL fields must be set first)

set -euo pipefail

# --- parse args -------------------------------------------------------------

COMPOSE_FILE=""
COMPOSE_PROJECT=""
TOPIC=""
USER="pub-mobile-approve"
CONFIG_PATH="$HOME/.config/opencode/opencode.json"

usage() {
  cat >&2 <<EOF
usage: $(basename "$0") [--compose-file PATH] [--compose-project NAME]
                       [--topic NAME] [--user NAME] [--config-path PATH]

  Populate ntfy.topic, ntfy.user, ntfy.password in the opencode config.

EOF
  exit 64
}

while [ $# -gt 0 ]; do
  case "$1" in
    --compose-file)    COMPOSE_FILE="$2"; shift 2 ;;
    --compose-project) COMPOSE_PROJECT="$2"; shift 2 ;;
    --topic)           TOPIC="$2"; shift 2 ;;
    --user)            USER="$2"; shift 2 ;;
    --config-path)     CONFIG_PATH="$2"; shift 2 ;;
    -h|--help)         usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

# --- preflight --------------------------------------------------------------

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker not found on PATH" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 not found on PATH (required for safe JSON editing)" >&2
  exit 1
fi

# --- locate the docker compose file ----------------------------------------

# If the user passed --compose-file or --compose-project, skip autodetection.
if [ -z "$COMPOSE_FILE" ] && [ -z "$COMPOSE_PROJECT" ]; then
  searched=()

  # 1. current directory
  for f in compose.yaml compose.yml docker-compose.yml docker-compose.yaml; do
    if [ -f "$f" ]; then
      COMPOSE_FILE="$f"
      searched+=("$PWD/$f")
      break
    fi
    searched+=("$PWD/$f")
  done

  # 2. ~/ntfy/ — the path suggested in docs/install.md
  if [ -z "$COMPOSE_FILE" ]; then
    for f in compose.yaml compose.yml docker-compose.yml docker-compose.yaml; do
      candidate="$HOME/ntfy/$f"
      searched+=("$candidate")
      if [ -f "$candidate" ]; then
        COMPOSE_FILE="$candidate"
        break
      fi
    done
  fi

  # 3. walk up from cwd looking for any compose file with an ntfy service
  if [ -z "$COMPOSE_FILE" ]; then
    dir="$PWD"
    while [ "$dir" != "/" ]; do
      for f in compose.yaml compose.yml docker-compose.yml docker-compose.yaml; do
        candidate="$dir/$f"
        if [ -f "$candidate" ] && grep -qE '^[[:space:]]*ntfy:' "$candidate"; then
          COMPOSE_FILE="$candidate"
          break 2
        fi
      done
      dir=$(dirname "$dir")
    done
  fi

  if [ -z "$COMPOSE_FILE" ]; then
    cat >&2 <<EOF
error: could not find a docker compose file with an ntfy service.

  Searched:
EOF
    for s in "${searched[@]}"; do
      echo "    $s" >&2
    done
    cat >&2 <<EOF

  Pass --compose-file /path/to/compose.yaml or --compose-project NAME.
EOF
    # If we're attached to a TTY, offer an interactive prompt as a last resort.
    if [ -t 0 ] && [ -t 1 ]; then
      echo "" >&2
      printf "Or enter the path now (Ctrl-C to abort): " >&2
      read -r reply
      if [ -n "$reply" ] && [ -f "$reply" ]; then
        COMPOSE_FILE="$reply"
      elif [ -n "$reply" ]; then
        echo "error: not a file: $reply" >&2
        exit 1
      fi
    fi
    if [ -z "$COMPOSE_FILE" ]; then
      exit 1
    fi
  fi
  echo "Using compose file: $COMPOSE_FILE"
fi

# Check the ntfy container is up. If not, bring it up.
echo "Checking ntfy container..."
compose_args=()
if [ -n "$COMPOSE_FILE" ]; then compose_args+=(-f "$COMPOSE_FILE"); fi
if [ -n "$COMPOSE_PROJECT" ]; then compose_args+=(-p "$COMPOSE_PROJECT"); fi

ntfy_running() {
  docker compose "${compose_args[@]}" ps --status running ntfy 2>/dev/null \
    | grep -q "ntfy"
}

# Self-heal: if compose.yaml still has the NTFY_BASE_URL placeholder, the
# container is in a crash loop. Read the URL from opencode.json (which
# setup-serve.sh wrote there) and patch the placeholder. This way,
# setup-ntfy.sh works even if the user hasn't re-run setup-serve.sh
# since NTFY_BASE_URL was added to compose.yaml.
repo_root="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." >/dev/null 2>&1 && pwd )"
if [ -f "$repo_root/compose.yaml" ] && \
   grep -q "NTFY_BASE_URL: __NTFY_BASE_URL__" "$repo_root/compose.yaml"; then
  if [ -f "$CONFIG_PATH" ]; then
    echo "compose.yaml has NTFY_BASE_URL placeholder; patching from opencode.json..."
    url_from_config=$(python3 -c "
import json, sys
with open('$CONFIG_PATH') as f: c = json.load(f)
for e in c.get('plugin', []):
    if isinstance(e, list) and len(e) >= 2 and isinstance(e[1], dict):
        n = e[0] if isinstance(e[0], str) else ''
        if 'mobile-approve' in n.lower() or n.endswith('/src/index.ts'):
            t = e[1].get('tunnel', {})
            if isinstance(t, dict) and 'publicBaseUrl' in t:
                print(t['publicBaseUrl']); break
")
    if [ -n "$url_from_config" ]; then
      python3 -c "
import re
p = '$repo_root/compose.yaml'
with open(p) as f: c = f.read()
new_c, n = re.subn(r'^(\s*NTFY_BASE_URL:\s*).*$', r'\g<1>$url_from_config', c, flags=re.MULTILINE)
if n > 0 and new_c != c:
    with open(p, 'w') as f: f.write(new_c)
    print(f'patched NTFY_BASE_URL → $url_from_config')
"
    else
      echo "warning: could not find tunnel.publicBaseUrl in opencode.json; cannot patch NTFY_BASE_URL"
      echo "         run ./bin/setup-serve.sh to set up Tailscale + URLs"
    fi
  else
    echo "warning: $CONFIG_PATH does not exist; cannot patch NTFY_BASE_URL"
    echo "         run ./bin/setup-serve.sh first"
  fi
fi

# Always run `up -d` — it's a no-op if the container is already up to date,
# and it picks up compose.yaml changes (e.g., new env vars like
# NTFY_BASE_URL that we may have just patched). The recreate-if-needed
# semantics are exactly what we want.
echo "Ensuring ntfy container is up to date with compose.yaml..."
if ! docker compose "${compose_args[@]}" up -d ntfy; then
  cat >&2 <<EOF
error: failed to start ntfy container.

  Check the compose file and docker logs:
    docker compose ${compose_args[*]} logs ntfy
EOF
  exit 1
fi

# Poll for up to 30s for the container to reach 'running'. ntfy can be slow
# on first start (image pull, auth DB creation, etc.) and even slower if
# it's in a restart loop and we just patched config.
for _ in $(seq 1 30); do
  if ntfy_running; then break; fi
  sleep 1
done
if ! ntfy_running; then
  echo "error: ntfy container did not reach 'running' state within 30s" >&2
  echo "       check: docker compose ${compose_args[*]} ps" >&2
  echo "       logs:  docker compose ${compose_args[*]} logs ntfy" >&2
  exit 1
fi

# --- generate topic ---------------------------------------------------------
#
# Topic must be stable across runs: the phone subscribes once to a specific
# topic name and stays subscribed. Generating a new random topic on every
# run would silently break the phone subscription. So:
#   - If --topic is passed, use it (explicit override).
#   - Else if opencode.json already has a topic, reuse it.
#   - Else generate a new random one (first run only).
if [ -z "$TOPIC" ] && [ -f "$CONFIG_PATH" ]; then
  TOPIC=$(python3 -c "
import json, sys
try:
    with open('$CONFIG_PATH') as f: c = json.load(f)
    for e in c.get('plugin', []):
        if isinstance(e, list) and len(e) >= 2 and isinstance(e[1], dict):
            n = e[0] if isinstance(e[0], str) else ''
            if 'mobile-approve' in n.lower() or n.endswith('/src/index.ts'):
                t = e[1].get('ntfy', {})
                if isinstance(t, dict) and t.get('topic'):
                    print(t['topic']); break
except Exception:
    pass
" 2>/dev/null || true)
fi
if [ -z "$TOPIC" ]; then
  TOPIC="oc-$(head -c 9 /dev/urandom | base32 | tr -d =)"
fi
echo "Topic: $TOPIC"

# --- create ntfy user -------------------------------------------------------

echo "Creating ntfy user '$USER'..."

# Generate the password in the script. We pass it to ntfy via --password so
# we know exactly what it is and don't have to parse it from output (which
# is fragile: the error message "password cannot be empty" would otherwise
# match a naive regex).
#   192 bits of entropy, URL-safe characters, 32 chars long.
PASSWORD=$(head -c 24 /dev/urandom | base64 | tr -d '+/=' | head -c 32)
echo "Generated password (length: ${#PASSWORD})"

# ntfy v2.x is required. The CLI uses `ntfy user add`. (v1.x's flat `ntfy
# useradd` is end-of-life and not supported.) Confirm the subcommand is
# available by running --help; an unknown subcommand returns a non-zero
# exit code with a "No help topic" error.
if ! docker compose "${compose_args[@]}" exec -T ntfy \
     ntfy user add --help >/dev/null 2>&1; then
  cat >&2 <<EOF
error: this ntfy image doesn't support 'ntfy user add'.

  The 'binwiederhier/ntfy:latest' tag is fine; if you pinned to an older
  tag, switch to:

    image: binwiederhier/ntfy:latest

  The user-management CLI requires ntfy v2.x AND that auth is enabled.
  The compose.yaml in this repo sets auth-default-access: deny-all; if you
  use a different compose file, ensure that or an equivalent option is set.

  Run 'docker compose exec ntfy ntfy --help' to confirm the CLI shape.
EOF
  exit 1
fi

useradd_out=$(docker compose "${compose_args[@]}" exec -T \
  -e NTFY_PASSWORD="$PASSWORD" ntfy \
  ntfy user add --role=user "$USER" 2>&1) || true

echo "$useradd_out" >&2

# Self-heal: if the running container was started before compose.yaml had
# NTFY_AUTH_FILE, the user-add fails with "auth-file not set". Recreate
# the container to pick up the new env var, then retry once.
#
# The `|| true` on the assignment protects against set -e when grep finds no
# match in the pipeline (a normal case now that ntfy doesn't echo back the
# password we set via NTFY_PASSWORD).
self_heal_check=$(echo "$useradd_out" | grep -oE 'password:[[:space:]]+[A-Za-z0-9_-]+' | head -1) || true
if [ -z "$self_heal_check" ] \
   && echo "$useradd_out" | grep -qiE 'auth-file not set|database-url not set'; then
  echo ""
  echo "ntfy container is missing NTFY_AUTH_FILE; recreating to pick up env var..."
  docker compose "${compose_args[@]}" up -d ntfy
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ntfy_running; then break; fi
    sleep 1
  done
  echo "Retrying user creation..."
  useradd_out=$(docker compose "${compose_args[@]}" exec -T \
    -e NTFY_PASSWORD="$PASSWORD" ntfy \
    ntfy user add --role=user "$USER" 2>&1) || true
  echo "$useradd_out" >&2
fi

# Extract token. Prefer the password ntfy printed (in older versions) but
# fall back to the password we generated, which is what we passed via
# NTFY_PASSWORD anyway. The `|| true` on the assignment protects against
# set -e when the pipeline's grep finds no match.
TOKEN=$(echo "$useradd_out" \
  | grep -oE 'password:[[:space:]]+[A-Za-z0-9_-]+' \
  | head -1 \
  | sed 's/^password:[[:space:]]*//') || true
[ -n "$TOKEN" ] || TOKEN="$PASSWORD"

# Detect whether the user was actually created this run, or already
# existed. If the user already exists, we don't know its real password
# (ntfy doesn't echo it), and we MUST NOT overwrite the working password
# already in opencode.json. We still want to grant ACL and update the
# topic (if it changed), but not the password.
user_already_existed=false
if echo "$useradd_out" | grep -qiE 'already exists|user.*does not exist|user not found'; then
  user_already_existed=true
  echo ""
  echo "user '$USER' already exists in ntfy; will not change its password."
  echo "(re-run with --user <name> to create a different user instead.)"
fi

if [ "$user_already_existed" = false ] && [ -z "$TOKEN" ]; then
  cat >&2 <<EOF

error: failed to determine ntfy password.

  Raw output is shown above.
EOF
  exit 1
fi

if [ "$user_already_existed" = false ]; then
  echo "Token captured (length: ${#TOKEN})"
fi

# --- grant ACL access to the topic --------------------------------------
#
# With auth-default-access: deny-all (required for the setup to be private),
# even authenticated users have no access to any topic by default. The
# ntfy Android app authenticates successfully, but ntfy then refuses the
# subscribe with "user not authorized" until we grant explicit ACL.
# This is idempotent: re-running adds the same access.
#
# We use the wildcard pattern so future topics the script generates are
# covered too. The script always names topics "oc-<random>", so the
# pattern is precise to the script's output.
echo ""
echo "Granting ACL: $USER → oc-* (read-write)..."
acl_out=$(docker compose "${compose_args[@]}" exec -T \
  ntfy ntfy access "$USER" "oc-*" read-write 2>&1) || true
if echo "$acl_out" | grep -qiE '^error|^fatal|denied|cannot'; then
  echo "warning: ntfy access grant may have failed:"
  echo "$acl_out"
else
  echo "ACL granted"
fi

# --- patch opencode.json ----------------------------------------------------

if [ ! -f "$CONFIG_PATH" ]; then
  cat >&2 <<EOF
error: $CONFIG_PATH does not exist.

  Run ./bin/setup-serve.sh first to create the config and set the URL fields.
EOF
  exit 1
fi

echo "Patching $CONFIG_PATH..."

# Backup existing config.
ts=$(date +%Y%m%d-%H%M%S)
backup="${CONFIG_PATH}.bak.${ts}"
cp "$CONFIG_PATH" "$backup"

# When the user already existed, we don't know the real password and must
# not overwrite the working one in opencode.json. The python heredoc
# receives password="" in that case and skips writing the field.
password_arg="$TOKEN"
if [ "$user_already_existed" = true ]; then
  password_arg=""
fi

topic="$TOPIC" user="$USER" password="$password_arg" config_path="$CONFIG_PATH" python3 <<'PYEOF'
import json, os, sys

config_path = os.environ["config_path"]
topic = os.environ["topic"]
user = os.environ["user"]
password = os.environ["password"]

with open(config_path, "r") as f:
    try:
        config = json.load(f)
    except json.JSONDecodeError as e:
        print(f"error: {config_path} is not valid JSON: {e}", file=sys.stderr)
        sys.exit(1)

plugins = config.get("plugin", [])
if not isinstance(plugins, list):
    print("error: 'plugin' field is not a list", file=sys.stderr)
    sys.exit(1)

# Find the mobile-approve plugin entry.
mobile = None
for entry in plugins:
    if not (isinstance(entry, list) and len(entry) >= 2):
        continue
    name = entry[0] if isinstance(entry[0], str) else ""
    is_mobile = (
        "mobile-approve" in name.lower()
        or name.endswith("mobile-approve")
        or name == "./src/index.ts"
        or name.endswith("/src/index.ts")
    )
    if is_mobile:
        mobile = entry
        break

if mobile is None:
    print("error: no mobile-approve plugin entry found in opencode.json", file=sys.stderr)
    print("       run ./bin/setup-serve.sh first to register it", file=sys.stderr)
    sys.exit(1)

opts = mobile[1]
if not isinstance(opts, dict):
    print("error: mobile-approve entry has non-dict options", file=sys.stderr)
    sys.exit(1)

ntfy = opts.setdefault("ntfy", {})
ntfy["topic"] = topic
ntfy["user"] = user
if password:
    ntfy["password"] = password
    print(f"patched ntfy.topic, ntfy.user, ntfy.password")
else:
    # User already existed in ntfy; we don't know its real password,
    # so leave the existing one in opencode.json alone.
    print(f"patched ntfy.topic, ntfy.user (kept existing ntfy.password)")

with open(config_path, "w") as f:
    json.dump(config, f, indent=2)
    f.write("\n")
PYEOF

echo "Backup at: $backup"
echo ""
echo "Done. Configured:"
echo "  topic:    $TOPIC"
echo "  user:     $USER"
if [ "$user_already_existed" = true ]; then
  echo "  password: (kept existing — we don't know it)"
else
  echo "  password: ${TOKEN:0:6}… (length ${#TOKEN})"
fi
echo ""
echo "To use a different password: ntfy supports changing it via"
echo "'ntfy user change-pass', or run this script again with --user <name>."