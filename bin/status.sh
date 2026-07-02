#!/usr/bin/env bash
# One-screen health check for the mobile-approve deployment.
#
# Checks (in order):
#   1. Tailscale daemon is running
#   2. Tailscale Serve rules are configured (the three path-routed ones)
#   3. ntfy Docker container is running
#   4. ntfy local health endpoint responds (127.0.0.1:8090)
#   5. Broker is running and healthy (127.0.0.1:7461)
#   6. Plugin local health endpoint responds (proxied through the broker)
#
# Exits 0 if all pass, 1 otherwise. Each check is independent — failing checks
# don't prevent later checks from running, so you see everything that's wrong
# at once.

set -uo pipefail

fail=0

print_check() {
  local status="$1" name="$2" detail="$3"
  local marker color
  if [ "$status" = "ok" ]; then
    marker="✓"
    color="\033[32m"
  else
    marker="✗"
    color="\033[31m"
    fail=1
  fi
  printf "  ${color}${marker}\033[0m %-26s %s\n" "$name" "$detail"
}

print_section() {
  printf "\n\033[1m%s\033[0m\n" "$1"
}

print_section "Tailscale"

if ! command -v tailscale >/dev/null 2>&1; then
  print_check fail "tailscale CLI" "not installed (https://tailscale.com/download)"
else
  if tailscale status --json >/dev/null 2>&1; then
    print_check ok "tailscale daemon" "running"
  else
    print_check fail "tailscale daemon" "not running (sudo tailscale up)"
  fi
fi

serve_out=""
if command -v tailscale >/dev/null 2>&1 && tailscale status --json >/dev/null 2>&1; then
  serve_out=$(tailscale serve status 2>&1 || true)
  if [ -n "$serve_out" ]; then
    if echo "$serve_out" | grep -q "/review"; then
      print_check ok "/review rule" "configured"
    else
      print_check fail "/review rule" "missing (run bin/setup-serve.sh)"
    fi
    if echo "$serve_out" | grep -q "/decide"; then
      print_check ok "/decide rule" "configured"
    else
      print_check fail "/decide rule" "missing (run bin/setup-serve.sh)"
    fi
    url=$(echo "$serve_out" | grep -oE 'https://[a-zA-Z0-9.-]+\.ts\.net(:[0-9]+)?' | head -1 || true)
    if [ -n "$url" ]; then
      print_check ok "public URL" "$url"
    else
      print_check fail "public URL" "no https://*.ts.net URL found in tailscale serve status"
    fi
  else
    print_check fail "tailscale serve" "no rules configured (run bin/setup-serve.sh)"
  fi
fi

print_section "ntfy"

if ! command -v docker >/dev/null 2>&1; then
  print_check fail "docker" "not installed"
else
  # Match any container name containing "ntfy" — covers plain "ntfy",
  # compose-prefixed "mobile-approve-ntfy-1", etc.
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "ntfy"; then
    print_check ok "ntfy container" "running"
  else
    print_check fail "ntfy container" "not running"
  fi
fi

ntfy_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:8090/v1/health 2>/dev/null)
ntfy_code=${ntfy_code:-000}
if [ "$ntfy_code" = "200" ]; then
  print_check ok "ntfy local health" "HTTP 200"
else
  print_check fail "ntfy local health" "HTTP $ntfy_code (is ntfy bound to 127.0.0.1:8090?)"
fi

print_section "Broker"

# 1) Process detection: systemd --user, then docker compose, then bare process
broker_mode="none"
broker_process=""

if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet mobile-approve-broker.service 2>/dev/null; then
  broker_mode="systemd"
  broker_process="systemd: mobile-approve-broker.service"
elif command -v docker >/dev/null 2>&1; then
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "broker"; then
    broker_mode="docker"
    broker_name=$(docker ps --format '{{.Names}}' 2>/dev/null | grep "broker" | head -1)
    broker_process="docker: $broker_name"
  fi
fi

if [ -z "$broker_process" ] && pgrep -f 'broker-cli' >/dev/null 2>&1; then
  broker_mode="bare"
  broker_pid=$(pgrep -f 'broker-cli' | head -1)
  broker_process="bare process (pid $broker_pid)"
fi

if [ -n "$broker_process" ]; then
  print_check ok "broker process" "$broker_process"
else
  print_check fail "broker process" "not running (run bin/setup-broker.sh)"
fi

# 2) Broker /v1/health
broker_health=$(curl -s --max-time 2 http://127.0.0.1:7461/v1/health 2>/dev/null || true)
if echo "$broker_health" | grep -q '"ok":true'; then
  broker_pid=$(echo "$broker_health" | grep -oE '"pid":[0-9]+' | head -1 | sed 's/.*://')
  broker_port=$(echo "$broker_health" | grep -oE '"port":[0-9]+' | head -1 | sed 's/.*://')
  print_check ok "broker /v1/health" "ok (pid=${broker_pid:-?}, port=${broker_port:-?})"
else
  print_check fail "broker /v1/health" "no response on 127.0.0.1:7461"
fi

print_section "Plugin"

# The plugin no longer runs its own HTTP server (since WS1 refactor).
# Check the broker's /health endpoint which is what the phone-facing review
# routes share.
plugin_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:7461/health 2>/dev/null)
plugin_code=${plugin_code:-000}
if [ "$plugin_code" = "200" ]; then
  print_check ok "broker review route" "HTTP 200 (Tailscale-routed /review serves from broker)"
else
  print_check fail "broker review route" "HTTP $plugin_code (broker not running?)"
fi

# Reminder to start opencode so the plugin connects to the broker
if command -v opencode >/dev/null 2>&1; then
  print_check ok "opencode" "installed (run 'opencode' to start a session)"
else
  print_check fail "opencode" "not installed"
fi

echo ""
if [ "$fail" -eq 0 ]; then
  printf "\033[32mAll checks passed.\033[0m\n"
  exit 0
else
  printf "\033[31mSome checks failed.\033[0m\n"
  exit 1
fi