import type { Plugin } from "@opencode-ai/plugin"
import type { Permission } from "@opencode-ai/sdk"
import { resolveConfig, type PluginOptions } from "./types.js"
import {
  newRequestId,
  NonceStore,
  SessionWhitelists,
  signToken,
} from "./security.js"
import { createDecisionServer } from "./server.js"
import { publishAsk } from "./ntfy.js"

function snapshotPermission(input: Permission) {
  const createdAt =
    typeof input.time?.created === "number" ? input.time.created : Date.now()
  return {
    id: input.id,
    type: input.type,
    title: input.title,
    pattern: input.pattern,
    metadata: input.metadata,
    sessionID: input.sessionID,
    messageID: input.messageID,
    callID: input.callID,
    createdAt,
  }
}

function firstPattern(p: Permission["pattern"]): string {
  if (Array.isArray(p)) return p[0] ?? ""
  return p ?? ""
}

// v1.17.12 publishes permission asks as "permission.asked" events with the
// shape declared in @opencode-ai/sdk as EventPermissionAsked (NOT
// "permission.updated" which the SDK v1 types are stale on, and NOT
// "permission.v2.asked" which is the literal name in the V2 module but not
// what the runtime actually emits). This mapper normalizes the wire shape
// into the V1 Permission object the rest of the plugin works with.
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

function buildNotification(
  snapshot: ReturnType<typeof snapshotPermission>,
  reviewUrl: string
): { title: string; body: string; priority: 1 | 2 | 3 | 4 | 5; tags: string[] } {
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

  const store = new NonceStore(cfg.nonceTtlMs)
  const whitelists = new SessionWhitelists()
  const server = createDecisionServer({
    port: cfg.callbackPort,
    publicBaseUrl: cfg.tunnel!.publicBaseUrl,
    store,
  })
  await server.listen()
  log("info", "decision server listening", {
    port: server.port(),
    callback: server.baseUrl(),
  })
  if (cfg.hmacSecretGenerated) {
    log(
      "warn",
      "MOBILE_APPROVE_SECRET was not set; generated a random per-session secret. " +
        "Phone approvals will not survive an opencode restart. " +
        "Add 'export MOBILE_APPROVE_SECRET=\"<base64>\"' to your shell rcfile.",
      { envVar: cfg.hmacSecretEnv }
    )
  }

  async function sendAgentHint(
    sessionID: string,
    hint: string
  ): Promise<void> {
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text: hint }],
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
    // v1.17.12 publishes V2 permission events but the OpencodeClient we
    // receive is the V1 SDK client (which still exposes V1-shaped methods).
    // Try two reply paths:
    //
    //   1. V1 endpoint: client.postSessionIdPermissionsPermissionId
    //      URL: /session/{id}/permissions/{permissionID}
    //      Body: { response }
    //
    //   2. V2 endpoint (raw HTTP via the underlying hey-api client):
    //      URL: /api/session/{sessionID}/permission/{requestID}/reply
    //      Body: { reply }
    //
    // IMPORTANT: the V1 method is defined on the OpencodeClient prototype
    // and calls this._client.post(...) internally. Extracting it as
    // `const v1 = client.postSessionIdPermissionsPermissionId` and calling
    // `v1(...)` loses the `this` binding, and the SDK throws
    // "undefined is not an object (evaluating 'this._client')". Always
    // call it as a method: `client.postSessionIdPermissionsPermissionId(...)`.
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

    const whitelist = whitelists.for(input.sessionID)
    const pattern = firstPattern(input.pattern)

    if (pattern && whitelist.matches(input.type, pattern)) {
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

    const requestId = newRequestId()
    const token = signToken(cfg.hmacSecret, requestId)
    const reviewUrl = server.reviewUrl(requestId, token)
    const snapshot = snapshotPermission(input)

    log("info", "permission.asked received -> publishing to phone", {
      opencodeRequestId: input.id,
      internalRequestId: requestId,
      tool: input.type,
      title: input.title,
      pattern,
      sessionID: input.sessionID,
      reviewUrl,
    })

    try {
      await publishAsk({
        baseUrl: cfg.ntfy!.baseUrl,
        topic: cfg.ntfy!.topic,
        user: cfg.ntfy!.user,
        password: cfg.ntfy!.password,
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

    try {
      const decision = await server.awaitDecision(
        requestId,
        cfg.defaultTimeoutMs,
        snapshot
      )
      log("info", "decision received", {
        requestId,
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

      try {
        await replyToOpencode(
          input.sessionID,
          input.id,
          response,
          "phone-decision"
        )
      } catch {
        /* logged */
      }

      if (decision.status === "allow" && decision.scope === "always") {
        const p =
          decision.patterns && decision.patterns.length > 0
            ? decision.patterns[0]
            : pattern
        if (p) {
          whitelist.add(input.type, p)
          log("info", "whitelist updated", {
            sessionID: input.sessionID,
            tool: input.type,
            pattern: p,
            total: whitelist.size(),
          })
        }
      }

      if (decision.agentHint) {
        await sendAgentHint(input.sessionID, decision.agentHint)
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log("warn", "default-deny (no reply)", {
        requestId,
        opencodeRequestId: input.id,
        reason,
        tool: input.type,
      })
      try {
        await replyToOpencode(
          input.sessionID,
          input.id,
          "reject",
          "default-deny-timeout"
        )
      } catch {
        /* logged */
      }
    }
  }

  return {
    dispose: async () => {
      await server.stop()
    },

    event: async ({ event }) => {
      // v1.17.12 publishes "permission.asked" events with the V1-shaped
      // EventPermissionAsked payload (id, sessionID, permission, patterns,
      // metadata, always, tool). Listen for that name and map the payload
      // into the V1 Permission object the rest of the plugin works with.
      const evt = event as unknown as { type: string; properties?: unknown }
      if (evt.type === "permission.asked") {
        log("info", "permission.asked received", {
          propKeys: evt.properties ? Object.keys(evt.properties) : null,
        })
        const p = mapPermissionAskedToPermission(
          (evt.properties ?? {}) as Record<string, unknown>
        )
        await handlePermissionAsked(p)
        return
      }

      if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id
        whitelists.delete(sessionID)
        log("info", "session deleted; whitelist cleared", {
          sessionID,
          remainingSessions: whitelists.sessionCount(),
        })
        return
      }
    },
  }
}) satisfies Plugin