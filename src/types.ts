import { randomBytes } from "node:crypto"

export type PluginOptions = {
  callbackPort?: number
  brokerBaseUrl?: string
  defaultTimeoutMs?: number
  hmacSecretEnv?: string
  nonceTtlMs?: number
  phoneNotifications?: boolean
  whitelistPath?: string
  ntfy?: {
    baseUrl: string
    topic: string
    user: string
    password: string
  }
  tunnel?: {
    publicBaseUrl: string
  }
  logLevel?: "debug" | "info" | "warn" | "error"
}

export type ResolvedConfig = {
  brokerBaseUrl: string
  callbackPort: number
  defaultTimeoutMs: number
  hmacSecret: string
  hmacSecretGenerated: boolean
  hmacSecretEnv: string
  nonceTtlMs: number
  phoneNotifications: boolean
  whitelistPath?: string
  ntfy: PluginOptions["ntfy"]
  tunnel: PluginOptions["tunnel"]
  logLevel: "debug" | "info" | "warn" | "error"
}

export const DEFAULTS: Required<Omit<PluginOptions, "ntfy" | "tunnel" | "whitelistPath">> = {
  brokerBaseUrl: "",
  callbackPort: 7461,
  defaultTimeoutMs: 300_000,
  hmacSecretEnv: "MOBILE_APPROVE_SECRET",
  nonceTtlMs: 600_000,
  phoneNotifications: true,
  logLevel: "info",
}

export function resolveConfig(opts: PluginOptions = {}): ResolvedConfig {
  const envName = opts.hmacSecretEnv ?? DEFAULTS.hmacSecretEnv
  let secret = process.env[envName]
  let hmacSecretGenerated = false
  if (!secret) {
    // Don't throw. Generate a random per-session secret so the plugin still
    // works. Phone approvals won't survive an opencode restart, but the
    // plugin will at least load. The startup log surfaces a warning.
    secret = randomBytes(32).toString("base64url")
    hmacSecretGenerated = true
  }
  if (!opts.ntfy?.baseUrl || !opts.ntfy.topic) {
    throw new Error(
      "mobile-approve: ntfy.baseUrl and ntfy.topic must be configured. " +
        "See docs/install.md."
    )
  }
  if (!opts.tunnel?.publicBaseUrl) {
    throw new Error(
      "mobile-approve: tunnel.publicBaseUrl must be configured. " +
        "See docs/install.md."
    )
  }
  return {
    brokerBaseUrl:
      opts.brokerBaseUrl ?? `http://127.0.0.1:${opts.callbackPort ?? DEFAULTS.callbackPort}`,
    callbackPort: opts.callbackPort ?? DEFAULTS.callbackPort,
    defaultTimeoutMs: opts.defaultTimeoutMs ?? DEFAULTS.defaultTimeoutMs,
    hmacSecret: secret,
    hmacSecretGenerated,
    hmacSecretEnv: envName,
    nonceTtlMs: opts.nonceTtlMs ?? DEFAULTS.nonceTtlMs,
    phoneNotifications: opts.phoneNotifications ?? DEFAULTS.phoneNotifications,
    whitelistPath: opts.whitelistPath,
    ntfy: opts.ntfy,
    tunnel: opts.tunnel,
    logLevel: opts.logLevel ?? DEFAULTS.logLevel,
  }
}

export type Decision = {
  requestId: string
  status: "allow" | "deny"
  scope: "once" | "always"
  patterns?: string[]
  command?: string
  agentHint?: string
  receivedAt: number
}

export type FileDiffEntry = {
  filename: string
  diff: string
}

export type PermissionSnapshot = {
  id: string
  type: string
  title: string
  pattern?: string | string[]
  metadata?: Record<string, unknown>
  sessionID: string
  messageID: string
  callID?: string
  createdAt: number
  diff?: string
  filediff?: FileDiffEntry[]
  modelExplanation?: string
}

export type Pending = {
  resolve: (d: Decision) => void
  reject: (e: Error) => void
  createdAt: number
  permission: PermissionSnapshot
  hmacSecret: string
  messageId?: string
}

export type PublishInput = {
  baseUrl: string
  topic: string
  user: string
  password: string
  requestId: string
  token: string
  reviewUrl: string
  title: string
  body: string
  priority?: 1 | 2 | 3 | 4 | 5
  tags?: string[]
  click?: string
}