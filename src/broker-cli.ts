#!/usr/bin/env -S npx tsx
// Standalone broker entry point. Run with:
//   bun run src/broker-cli.ts
//   npx tsx src/broker-cli.ts
//
// Reads config from env vars (preferred for systemd / docker) or from
// ~/.config/opencode/opencode.json as a fallback.
//
// Required env vars:
//   MOBILE_APPROVE_PUBLIC_URL     e.g. https://hostname.ts.net (Tailscale MagicDNS)
//
// Optional env vars:
//   MOBILE_APPROVE_PORT           port to listen on (default 7461)
//   MOBILE_APPROVE_HMAC_SECRET    HMAC secret for review URL tokens
//   MOBILE_APPROVE_LOG_LEVEL      debug | info | warn | error (default info)
//   MOBILE_APPROVE_DEFAULT_TIMEOUT_MS  default ask timeout in ms (default 300000)
//   MOBILE_APPROVE_NONCE_TTL_MS   nonce lifetime (default 600000)
//   MOBILE_APPROVE_NTFY_BASE_URL  ntfy server URL
//   MOBILE_APPROVE_NTFY_TOPIC     ntfy topic
//   MOBILE_APPROVE_NTFY_USER      ntfy user
//   MOBILE_APPROVE_NTFY_PASSWORD  ntfy password
//   MOBILE_APPROVE_OPENCODE_CONFIG  path to opencode.json (fallback)
//   MOBILE_APPROVE_WHITELIST_PATH  override the whitelist persistence file
import { readFileSync } from "node:fs"
import { createBroker } from "./broker.js"
import { resolveConfig, type PluginOptions } from "./types.js"

function loadOptions(): PluginOptions {
  const env = process.env
  const configPath =
    env.MOBILE_APPROVE_OPENCODE_CONFIG ??
    `${process.env.HOME ?? "~"}/.config/opencode/opencode.json`

  if (
    env.MOBILE_APPROVE_PUBLIC_URL &&
    env.MOBILE_APPROVE_NTFY_BASE_URL &&
    env.MOBILE_APPROVE_NTFY_TOPIC &&
    env.MOBILE_APPROVE_NTFY_USER &&
    env.MOBILE_APPROVE_NTFY_PASSWORD
  ) {
    return {
      tunnel: { publicBaseUrl: env.MOBILE_APPROVE_PUBLIC_URL },
      ntfy: {
        baseUrl: env.MOBILE_APPROVE_NTFY_BASE_URL,
        topic: env.MOBILE_APPROVE_NTFY_TOPIC,
        user: env.MOBILE_APPROVE_NTFY_USER,
        password: env.MOBILE_APPROVE_NTFY_PASSWORD,
      },
    }
  }

  let raw: string
  try {
    raw = readFileSync(configPath, "utf8")
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`mobile-approve-broker: failed to read ${configPath}: ${reason}`)
    console.error(
      "Set MOBILE_APPROVE_OPENCODE_CONFIG or the MOBILE_APPROVE_* env vars."
    )
    process.exit(1)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`mobile-approve-broker: ${configPath} is not valid JSON: ${reason}`)
    process.exit(1)
  }

  const config = parsed as { plugin?: unknown }
  if (!Array.isArray(config.plugin)) {
    console.error(`mobile-approve-broker: no "plugin" array in ${configPath}`)
    process.exit(1)
  }

  for (const entry of config.plugin) {
    if (!Array.isArray(entry) || entry.length < 2) continue
    const name = entry[0]
    if (typeof name !== "string") continue
    if (
      !name.includes("mobile-approve") &&
      !name.endsWith("/src/index.ts") &&
      !name.endsWith("/bin/../src/index.ts")
    ) {
      continue
    }
    return entry[1] as PluginOptions
  }

  console.error(
    `mobile-approve-broker: no mobile-approve plugin entry in ${configPath}`
  )
  process.exit(1)
}

function loadEnvOverrides(opts: PluginOptions): PluginOptions {
  const env = process.env
  return {
    ...opts,
    callbackPort: env.MOBILE_APPROVE_PORT
      ? Number(env.MOBILE_APPROVE_PORT)
      : opts.callbackPort,
    defaultTimeoutMs: env.MOBILE_APPROVE_DEFAULT_TIMEOUT_MS
      ? Number(env.MOBILE_APPROVE_DEFAULT_TIMEOUT_MS)
      : opts.defaultTimeoutMs,
    nonceTtlMs: env.MOBILE_APPROVE_NONCE_TTL_MS
      ? Number(env.MOBILE_APPROVE_NONCE_TTL_MS)
      : opts.nonceTtlMs,
    logLevel: (env.MOBILE_APPROVE_LOG_LEVEL as PluginOptions["logLevel"]) ??
      opts.logLevel,
    hmacSecretEnv: "MOBILE_APPROVE_HMAC_SECRET",
    whitelistPath:
      env.MOBILE_APPROVE_WHITELIST_PATH ?? opts.whitelistPath,
  }
}

async function main(): Promise<void> {
  const opts = loadEnvOverrides(loadOptions())
  const cfg = resolveConfig(opts)

  const log = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>
  ) => {
    if (level === "debug" && cfg.logLevel !== "debug") return
    const extraStr = extra ? ` ${JSON.stringify(extra)}` : ""
    console.error(`[${level}] ${message}${extraStr}`)
  }

  const broker = createBroker({ cfg, log })
  const info = await broker.start()
  log("info", "broker ready", info)

  let stopping = false
  const stop = async (signal: string) => {
    if (stopping) return
    stopping = true
    log("info", "shutting down", { signal })
    await broker.stop()
    log("info", "stopped")
    process.exit(0)
  }

  process.on("SIGTERM", () => void stop("SIGTERM"))
  process.on("SIGINT", () => void stop("SIGINT"))
  process.on("SIGHUP", () => void stop("SIGHUP"))
}

main().catch((err) => {
  console.error("mobile-approve-broker: fatal error:", err)
  process.exit(1)
})