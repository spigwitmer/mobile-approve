import { createDecisionServer, type ExtraRoute } from "./server.js"
import { publishAsk } from "./ntfy.js"
import { renderReviewPage } from "./webui.js"
import {
  newRequestId,
  NonceStore,
  SessionWhitelists,
  signToken,
} from "./security.js"
import type {
  Decision,
  PermissionSnapshot,
  ResolvedConfig,
} from "./types.js"
import type { IncomingMessage, ServerResponse } from "node:http"

export type BrokerLog = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>
) => void

export type AskInput = {
  sessionID: string
  permissionID: string
  tool: string
  title: string
  pattern?: string | string[]
  metadata?: Record<string, unknown>
}

export type AskResult = {
  requestId: string
  reviewUrl: string
  callbackUrl: string
}

export interface Broker {
  start(): Promise<{ port: number; baseUrl: string }>
  stop(): Promise<void>

  ask(input: AskInput): Promise<AskResult>
  waitForDecision(
    requestId: string,
    timeoutMs: number
  ): Promise<Decision>

  matches(sessionID: string, tool: string, pattern: string): boolean
  addWhitelist(sessionID: string, tool: string, pattern: string): void
  forgetSession(sessionID: string): void
  whitelistSize(): number
  whitelistSessionCount(): number

  port(): number
  baseUrl(): string
  reviewUrl(requestId: string, token: string): string
  callbackUrl(requestId: string, token: string): string
}

export type BrokerOptions = {
  cfg: ResolvedConfig
  log: BrokerLog
}

const startTime = Date.now()

function firstPattern(p: AskInput["pattern"]): string {
  if (!p) return ""
  if (Array.isArray(p)) return p[0] ?? ""
  return p
}

function buildNotification(
  snapshot: PermissionSnapshot,
  reviewUrl: string
): {
  title: string
  body: string
  priority: 1 | 2 | 3 | 4 | 5
  tags: string[]
} {
  const title = `opencode wants to ${snapshot.title || snapshot.type}`
  const lines: string[] = []
  lines.push(`tool: ${snapshot.type}`)
  if (snapshot.pattern) {
    const p = Array.isArray(snapshot.pattern)
      ? snapshot.pattern.join(" | ")
      : snapshot.pattern
    lines.push(`pattern: ${p}`)
  }
  if (snapshot.metadata && typeof snapshot.metadata === "object") {
    const md = snapshot.metadata as Record<string, unknown>
    if (typeof md.cwd === "string") lines.push(`cwd: ${md.cwd}`)
  }
  lines.push("")
  lines.push(`Open on your phone: ${reviewUrl}`)
  return {
    title,
    body: lines.join("\n"),
    priority: 4,
    tags: ["warning"],
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown
): void {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.setHeader("Cache-Control", "no-store")
  res.end(JSON.stringify(body))
}

async function readJsonBody(
  req: IncomingMessage,
  max = 16384
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let len = 0
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => {
      len += c.length
      if (len > max) {
        resolve({ ok: false, error: "body too large" })
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      if (!raw.trim()) {
        resolve({ ok: false, error: "empty body" })
        return
      }
      try {
        resolve({ ok: true, value: JSON.parse(raw) })
      } catch {
        resolve({ ok: false, error: "invalid json" })
      }
    })
    req.on("error", () => {
      resolve({ ok: false, error: "read error" })
    })
  })
}

export function createBroker(opts: BrokerOptions): Broker {
  const { cfg, log } = opts

  const store = new NonceStore(cfg.nonceTtlMs)
  const whitelists = new SessionWhitelists()

  function snapshotFromAsk(input: AskInput): PermissionSnapshot {
    return {
      id: input.permissionID,
      type: input.tool,
      title: input.title,
      pattern: input.pattern,
      metadata: input.metadata,
      sessionID: input.sessionID,
      messageID: "",
      createdAt: Date.now(),
    }
  }

  // All functions below are hoisted; the route handlers in buildV1Routes
  // reference them via closure and are only invoked after `server` is
  // initialized (when an HTTP request arrives).
  let server: ReturnType<typeof createDecisionServer>

  async function ask(input: AskInput): Promise<AskResult> {
    const requestId = newRequestId()
    const token = signToken(cfg.hmacSecret, requestId)
    const reviewUrl = server!.reviewUrl(requestId, token)
    const callbackUrl = server!.url(requestId, token)
    const snapshot = snapshotFromAsk(input)

    // Register the pending request BEFORE publishing to ntfy. A fast phone
    // tap (sub-100ms) would otherwise race against the registration and
    // get a 410 from the server.
    server!.register(requestId, snapshot)

    log("info", "ask -> publishing to phone", {
      opencodeRequestId: input.permissionID,
      internalRequestId: requestId,
      tool: input.tool,
      title: input.title,
      pattern: firstPattern(input.pattern),
      sessionID: input.sessionID,
      reviewUrl,
    })

    if (cfg.ntfy) {
      try {
        await publishAsk({
          baseUrl: cfg.ntfy.baseUrl,
          topic: cfg.ntfy.topic,
          user: cfg.ntfy.user,
          password: cfg.ntfy.password,
          requestId,
          token,
          reviewUrl,
          ...buildNotification(snapshot, reviewUrl),
        })
        log("info", "ntfy notification published", { requestId })
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        log("error", "ntfy publish failed; callback-only fallback", {
          requestId,
          reason,
        })
      }
    } else {
      log("warn", "ntfy not configured; callback-only fallback", { requestId })
    }

    return { requestId, reviewUrl, callbackUrl }
  }

  async function waitForDecision(
    requestId: string,
    timeoutMs: number
  ): Promise<Decision> {
    return server!.waitForDecision(requestId, timeoutMs)
  }

  function matches(
    sessionID: string,
    tool: string,
    pattern: string
  ): boolean {
    if (!pattern) return false
    return whitelists.for(sessionID).matches(tool, pattern)
  }

  function addWhitelist(
    sessionID: string,
    tool: string,
    pattern: string
  ): void {
    whitelists.for(sessionID).add(tool, pattern)
    log("info", "whitelist updated", {
      sessionID,
      tool,
      pattern,
      total: whitelists.totalSize(),
    })
  }

  function forgetSession(sessionID: string): void {
    const had = whitelists.sessionCount()
    whitelists.delete(sessionID)
    if (whitelists.sessionCount() < had) {
      log("info", "session deleted; whitelist cleared", {
        sessionID,
        remainingSessions: whitelists.sessionCount(),
      })
    }
  }

  function getWhitelistSnapshot(
    sessionID: string
  ): Record<string, string[]> {
    const wl = whitelists.for(sessionID)
    const out: Record<string, string[]> = {}
    for (const [tool, patterns] of (wl as unknown as { rules: Map<string, Set<string>> }).rules) {
      out[tool] = [...patterns]
    }
    return out
  }

  function buildV1Routes(): ExtraRoute[] {
    return [
      {
        method: "GET",
        match: (url) => url.pathname === "/v1/health",
        handle: async (_req, res) => {
          sendJson(res, 200, {
            ok: true,
            pid: process.pid,
            port: server!.port(),
            baseUrl: server!.baseUrl(),
            uptimeMs: Date.now() - startTime,
            whitelistSize: whitelists.totalSize(),
            whitelistSessionCount: whitelists.sessionCount(),
          })
        },
      },
      {
        method: "POST",
        match: (url) => url.pathname === "/v1/ask",
        handle: async (req, res, _url) => {
          const body = await readJsonBody(req)
          if (!body.ok) {
            sendJson(res, 400, { ok: false, error: body.error })
            return
          }
          const input = body.value as AskInput
          if (!input || typeof input !== "object") {
            sendJson(res, 400, { ok: false, error: "missing or invalid body" })
            return
          }
          if (typeof input.sessionID !== "string" || !input.sessionID) {
            sendJson(res, 400, { ok: false, error: "sessionID required" })
            return
          }
          if (typeof input.permissionID !== "string" || !input.permissionID) {
            sendJson(res, 400, { ok: false, error: "permissionID required" })
            return
          }
          if (typeof input.tool !== "string" || !input.tool) {
            sendJson(res, 400, { ok: false, error: "tool required" })
            return
          }
          try {
            const result = await ask(input)
            sendJson(res, 200, result)
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            sendJson(res, 500, { ok: false, error: reason })
          }
        },
      },
      {
        method: "GET",
        match: (url) => {
          const m = url.pathname.match(/^\/v1\/decision\/([^/]+)$/)
          return !!m
        },
        handle: async (_req, res, url) => {
          const m = url.pathname.match(/^\/v1\/decision\/([^/]+)$/)!
          const requestId = decodeURIComponent(m[1])
          const timeoutMs = Number(url.searchParams.get("timeoutMs") ?? "300000")
          if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            sendJson(res, 400, { ok: false, error: "invalid timeoutMs" })
            return
          }
          try {
            const decision = await waitForDecision(requestId, timeoutMs)
            sendJson(res, 200, decision)
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            const isTimeout = /timeout/i.test(reason)
            sendJson(res, isTimeout ? 408 : 500, { ok: false, error: reason })
          }
        },
      },
      {
        method: "POST",
        match: (url) => url.pathname === "/v1/whitelist",
        handle: async (req, res) => {
          const body = await readJsonBody(req)
          if (!body.ok) {
            sendJson(res, 400, { ok: false, error: body.error })
            return
          }
          const v = body.value as Record<string, unknown>
          if (
            typeof v.sessionID !== "string" ||
            typeof v.tool !== "string" ||
            typeof v.pattern !== "string"
          ) {
            sendJson(res, 400, { ok: false, error: "sessionID, tool, pattern required" })
            return
          }
          addWhitelist(v.sessionID, v.tool, v.pattern)
          sendJson(res, 200, { ok: true })
        },
      },
      {
        method: "GET",
        match: (url) => /^\/v1\/whitelist\/[^/]+$/.test(url.pathname),
        handle: async (_req, res, url) => {
          const sessionID = decodeURIComponent(
            url.pathname.replace(/^\/v1\/whitelist\//, "")
          )
          sendJson(res, 200, getWhitelistSnapshot(sessionID))
        },
      },
      {
        method: "DELETE",
        match: (url) => /^\/v1\/whitelist\/[^/]+$/.test(url.pathname),
        handle: async (_req, res, url) => {
          const sessionID = decodeURIComponent(
            url.pathname.replace(/^\/v1\/whitelist\//, "")
          )
          forgetSession(sessionID)
          sendJson(res, 200, { ok: true })
        },
      },
    ]
  }

  server = createDecisionServer({
    port: cfg.callbackPort,
    publicBaseUrl: cfg.tunnel!.publicBaseUrl,
    store,
    extraRoutes: buildV1Routes(),
  })

  async function start(): Promise<{ port: number; baseUrl: string }> {
    await server.listen()
    log("info", "decision server listening", {
      port: server.port(),
      callback: server.baseUrl(),
    })
    if (cfg.hmacSecretGenerated) {
      log(
        "warn",
        "MOBILE_APPROVE_SECRET was not set; generated a random per-broker-instance secret. " +
          "Phone approvals will not survive a broker restart. " +
          "Add 'export MOBILE_APPROVE_SECRET=\"<base64>\"' to your shell rcfile.",
        { envVar: cfg.hmacSecretEnv }
      )
    }
    return { port: server.port(), baseUrl: server.baseUrl() }
  }

  async function stop(): Promise<void> {
    await server.stop()
  }

  return {
    start,
    stop,
    ask,
    waitForDecision,
    matches,
    addWhitelist,
    forgetSession,
    whitelistSize: () => whitelists.totalSize(),
    whitelistSessionCount: () => whitelists.sessionCount(),
    port: () => server.port(),
    baseUrl: () => server.baseUrl(),
    reviewUrl: (requestId, token) => server.reviewUrl(requestId, token),
    callbackUrl: (requestId, token) => server.url(requestId, token),
  }
}

export const _internal = {
  buildNotification,
  snapshotFromAsk: (input: AskInput) =>
    ({
      id: input.permissionID,
      type: input.tool,
      title: input.title,
      pattern: input.pattern,
      metadata: input.metadata,
      sessionID: input.sessionID,
      messageID: "",
      createdAt: Date.now(),
    }) as PermissionSnapshot,
  renderReviewPage,
}

export type { Decision }
