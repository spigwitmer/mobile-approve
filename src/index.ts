import type { Plugin } from "@opencode-ai/plugin"
import type { Permission } from "@opencode-ai/sdk"
import { resolveConfig, type PluginOptions } from "./types.js"
import { BrokerClient } from "./client.js"

function mapPermissionAskedToPermission(p: Record<string, unknown>): Permission {
  const id = typeof p.id === "string" ? p.id : ""
  const sessionID = typeof p.sessionID === "string" ? p.sessionID : ""
  const permission = typeof p.permission === "string" ? p.permission : ""
  const patterns = Array.isArray(p.patterns)
    ? (p.patterns.filter((x) => typeof x === "string") as string[])
    : []
  const tool =
    p.tool && typeof p.tool === "object" ? (p.tool as Record<string, unknown>) : null
  const messageID =
    tool && typeof tool.messageID === "string" ? tool.messageID : ""
  const callID =
    tool && typeof tool.callID === "string" ? tool.callID : ""
  const metadata =
    p.metadata && typeof p.metadata === "object"
      ? (p.metadata as Record<string, unknown>)
      : {}
  return {
    id,
    type: permission,
    pattern: patterns,
    sessionID,
    messageID,
    callID: callID || undefined,
    title: permission,
    metadata,
    time: { created: Date.now() },
  }
}

function firstPattern(p: Permission["pattern"]): string {
  if (!p) return ""
  if (Array.isArray(p)) return p[0] ?? ""
  return p
}

function patternMatches(pattern: string, candidate: string): boolean {
  if (pattern === candidate) return true
  let pi = 0
  let ci = 0
  let star = -1
  let matchPos = 0
  while (ci < candidate.length) {
    if (pi < pattern.length && pattern[pi] === candidate[ci]) {
      pi++
      ci++
    } else if (pi < pattern.length && pattern[pi] === "*") {
      star = pi
      matchPos = ci
      pi++
    } else if (star !== -1) {
      pi = star + 1
      matchPos++
      ci = matchPos
    } else {
      return false
    }
  }
  while (pi < pattern.length && pattern[pi] === "*") pi++
  return pi === pattern.length
}

export default (async ({ client }, options?: PluginOptions) => {
  const cfg = resolveConfig(options)

  const log = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>
  ) => {
    if (level === "debug" && cfg.logLevel !== "debug") return
    const pri: Record<typeof level, "debug" | "info" | "warn" | "error"> = {
      debug: "debug",
      info: "info",
      warn: "warn",
      error: "error",
    }
    void client.app.log({
      body: {
        service: "mobile-approve",
        level: pri[level],
        message,
        extra,
      },
    })
  }

  const broker = new BrokerClient({
    baseUrl: cfg.brokerBaseUrl,
  })

  // Verify the broker is reachable on plugin load. Log a clear error and
  // continue without phone approval if it's not (the in-TUI prompt still
  // works as a fallback).
  try {
    await broker.health()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log(
      "warn",
      "mobile-approve broker is unreachable; phone approval disabled. " +
        "Run `bin/setup-broker.sh` to install the broker. " +
        "The in-TUI permission prompt still works.",
      { reason, brokerUrl: broker.url }
    )
  }

  async function sendAgentHint(
    sessionID: string,
    hint: string
  ): Promise<void> {
    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: hint, synthetic: true }],
        },
      })
      log("info", "agent hint sent", { sessionID, length: hint.length })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log("error", "failed to send agent hint", { sessionID, reason })
    }
  }

  const seenRequestIds = new Set<string>()

  async function replyToOpencode(
    sessionID: string,
    permissionID: string,
    response: "once" | "always" | "reject",
    label: string
  ): Promise<void> {
    const c = client as unknown as {
      postSessionIdPermissionsPermissionId?: (opts: {
        body?: { response: "once" | "always" | "reject" }
        path: { id: string; permissionID: string }
      }) => Promise<unknown>
      _client?: {
        post?: (req: { url: string; body?: unknown }) => Promise<unknown>
      }
    }

    if (typeof c.postSessionIdPermissionsPermissionId === "function") {
      try {
        await c.postSessionIdPermissionsPermissionId({
          body: { response },
          path: { id: sessionID, permissionID },
        })
        log("info", "permission replied via V1 endpoint", {
          opencodeRequestId: permissionID,
          sessionID,
          response,
          label,
        })
        return
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        log("warn", "V1 reply failed; trying V2 endpoint", {
          opencodeRequestId: permissionID,
          reason,
        })
      }
    }

    const inner = c._client
    if (inner && typeof inner.post === "function") {
      try {
        const res = (await inner.post({
          url: `/api/session/${sessionID}/permission/${permissionID}/reply`,
          body: { reply: response },
        })) as { response?: Response; ok?: boolean; status?: number }
        const status = res?.response?.status ?? res?.status
        const ok =
          res?.ok === true ||
          status === 200 ||
          status === 204 ||
          (typeof status === "number" && status < 400)
        if (ok) {
          log("info", "permission replied via V2 endpoint", {
            opencodeRequestId: permissionID,
            sessionID,
            response,
            label,
            status,
          })
          return
        }
        throw new Error(
          `V2 reply returned non-success: status=${status ?? "?"}, ok=${res?.ok ?? "?"}`
        )
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        log("error", "V2 reply failed", {
          opencodeRequestId: permissionID,
          reason,
        })
        throw err
      }
    }

    throw new Error(
      `No usable reply endpoint on OpencodeClient (sessionID=${sessionID}, permissionID=${permissionID})`
    )
  }

  async function handlePermissionAsked(input: Permission): Promise<void> {
    if (seenRequestIds.has(input.id)) {
      log("debug", "permission.asked already handled; skip", {
        requestId: input.id,
      })
      return
    }
    seenRequestIds.add(input.id)
    setTimeout(() => seenRequestIds.delete(input.id), 5 * 60_000)

    const pattern = firstPattern(input.pattern)

    // Whitelist check via broker
    let whitelisted = false
    if (pattern) {
      try {
        whitelisted = await brokerWhitelisted(
          input.sessionID,
          input.type,
          pattern
        )
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        log("warn", "broker whitelist check failed; falling through to phone", {
          reason,
        })
      }
    }
    if (whitelisted) {
      log("debug", "whitelist hit; auto-allow", {
        requestId: input.id,
        sessionID: input.sessionID,
        tool: input.type,
        pattern,
      })
      try {
        await replyToOpencode(
          input.sessionID,
          input.id,
          "once",
          "whitelist-hit"
        )
      } catch {
        /* logged */
      }
      return
    }

    // Submit to broker (publishes to ntfy + registers for phone callback)
    let requestId: string
    try {
      const askResult = await broker.ask({
        sessionID: input.sessionID,
        permissionID: input.id,
        tool: input.type,
        title: input.title || input.type,
        pattern: input.pattern,
        metadata: input.metadata,
      })
      requestId = askResult.requestId
    } catch (err) {
      // Broker is down (or misbehaving). Don't auto-deny — that would silently
      // block the user. Let opencode's in-TUI prompt take over so the user
      // can still approve/deny from the terminal. The next time the broker
      // is healthy, the phone path will resume.
      const reason = err instanceof Error ? err.message : String(err)
      log(
        "error",
        "broker ask failed; in-TUI prompt will handle this permission",
        {
          opencodeRequestId: input.id,
          reason,
        }
      )
      return
    }

    try {
      const decision = await broker.waitForDecision(
        requestId,
        cfg.defaultTimeoutMs
      )
      log("info", "decision received", {
        requestId,
        opencodeRequestId: input.id,
        status: decision.status,
        scope: decision.scope,
        hasCommand: typeof decision.command === "string",
        hasAgentHint: typeof decision.agentHint === "string",
      })

      const response: "once" | "always" | "reject" =
        decision.status === "deny"
          ? "reject"
          : decision.scope === "always"
            ? "always"
            : "once"

      await safeReplyToOpencode(
        input.sessionID,
        input.id,
        response,
        "phone-decision"
      )

      if (decision.status === "allow" && decision.scope === "always") {
        const p =
          decision.patterns && decision.patterns.length > 0
            ? decision.patterns[0]
            : pattern
        if (p) {
          try {
            await broker.addWhitelist(input.sessionID, input.type, p)
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            log("warn", "broker addWhitelist failed", { reason })
          }
        }
      }

      if (decision.agentHint) {
        await sendAgentHint(input.sessionID, decision.agentHint)
      }
    } catch (err) {
      // Phone didn't respond in time (default 5 min). Let the in-TUI prompt
      // handle it rather than silently denying the action.
      const reason = err instanceof Error ? err.message : String(err)
      log(
        "warn",
        "phone did not respond in time; in-TUI prompt will handle this permission",
        {
          requestId,
          opencodeRequestId: input.id,
          reason,
          tool: input.type,
          timeoutMs: cfg.defaultTimeoutMs,
        }
      )
      return
    }
  }

  async function brokerWhitelisted(
    sessionID: string,
    tool: string,
    pattern: string
  ): Promise<boolean> {
    const wl = await broker.getWhitelist(sessionID)
    const patterns = wl[tool] ?? []
    return patterns.some((p) => patternMatches(p, pattern))
  }

  async function safeReplyToOpencode(
    sessionID: string,
    permissionID: string,
    response: "once" | "always" | "reject",
    label: string
  ): Promise<void> {
    try {
      await replyToOpencode(sessionID, permissionID, response, label)
    } catch {
      /* already logged */
    }
  }

  return {
    dispose: async () => {
      // No HTTP server to stop — the broker runs as a separate process.
    },

    event: async ({ event }) => {
      // v1.17.12 emits "permission.asked" events (not "permission.updated"
      // as the V1 SDK type claims). The runtime event type is broader than
      // the SDK's `Event` union, so we cast to read the actual properties.
      const evt = event as unknown as { type: string; properties?: unknown }
      if (evt.type === "permission.asked") {
        log("info", "permission.asked received", {
          propKeys: Object.keys((evt.properties ?? {}) as object),
        })
        const p = mapPermissionAskedToPermission(
          (evt.properties ?? {}) as Record<string, unknown>
        )
        await handlePermissionAsked(p)
        return
      }

      if (evt.type === "session.deleted") {
        const sessionID = (evt.properties as { info: { id: string } }).info.id
        try {
          await broker.forgetSession(sessionID)
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          log("warn", "broker forgetSession failed", { sessionID, reason })
        }
        return
      }
    },
  }
}) satisfies Plugin
