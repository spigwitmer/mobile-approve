import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { isDecision, NonceStore, signToken, verifyToken } from "./security.js"
import type { Decision, PermissionSnapshot, Pending } from "./types.js"
import { renderReviewPage } from "./webui.js"

export type DecisionServer = {
  url: (requestId: string, token: string) => string
  reviewUrl: (requestId: string, token: string) => string
  listen: () => Promise<{ port: number }>
  stop: () => Promise<void>
  register: (requestId: string, snapshot: PermissionSnapshot, hmacSecret: string) => void
  waitForDecision: (requestId: string, timeoutMs: number) => Promise<Decision>
  baseUrl: () => string
  port: () => number
}

export type ExtraRoute = {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH"
  match: (url: URL) => boolean
  handle: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void
}

export type ServerDeps = {
  port: number
  host?: string
  publicBaseUrl: string
  store: NonceStore
  extraRoutes?: ExtraRoute[]
}

async function readBody(req: IncomingMessage, max = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    let len = 0
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => {
      len += c.length
      if (len > max) {
        reject(new Error("body too large"))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.setHeader("Cache-Control", "no-store")
  res.end(JSON.stringify(body))
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.setHeader("Cache-Control", "no-store")
  res.end(body)
}

export function createDecisionServer(deps: ServerDeps): DecisionServer {
  const { store, extraRoutes = [] } = deps
  const host = deps.host ?? "127.0.0.1"
  let actualPort = deps.port

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost")
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, pid: process.pid })
        return
      }
      for (const route of extraRoutes) {
        if (req.method === route.method && route.match(url)) {
          await route.handle(req, res, url)
          return
        }
      }
// The plugin server accepts the requestId in two equivalent forms:
//   1. Single-segment path (Tailscale Serve's post-strip form):
//        /<id>?t=<token>     (from public /review/<id>?t=<token>)
//        /<id>               (from public /decide/<id>)
//   2. Prefixed path (direct local access, no Tailscale in front):
//        /review/<id>?t=<token>
//        /decide/<id>
// The prefix-stripped form is what production traffic looks like.
      const requestId = extractRequestId(url.pathname)
      if (requestId && req.method === "GET") {
        if (requestId.length > 256) {
          sendJson(res, 400, { ok: false, error: "bad requestId" })
          return
        }
        const t = url.searchParams.get("t")
        if (!t) {
          sendJson(res, 401, { ok: false, error: "missing token" })
          return
        }
        const pending = store.peek(requestId)
        if (!pending) {
          sendJson(res, 410, { ok: false, error: "unknown or expired nonce" })
          return
        }
        if (!verifyStoredToken(pending, requestId, t)) {
          sendJson(res, 401, { ok: false, error: "invalid token" })
          return
        }
        const callbackUrl = `${baseUrl()}/decide/${requestId}?t=${signToken(pending.hmacSecret, requestId)}`
        const html = renderReviewPage({
          requestId,
          callbackUrl,
          expiresAtMs: pending.createdAt + 600_000,
          permission: pending.permission,
        })
        sendHtml(res, 200, html)
        return
      }
      if (requestId && req.method === "POST") {
        if (requestId.length > 256) {
          sendJson(res, 400, { ok: false, error: "bad requestId" })
          return
        }
        const t = url.searchParams.get("t")
        if (!t) {
          sendJson(res, 401, { ok: false, error: "missing token" })
          return
        }
        const pending = store.peek(requestId)
        if (!pending) {
          sendJson(res, 410, { ok: false, error: "unknown or expired nonce" })
          return
        }
        if (!verifyStoredToken(pending, requestId, t)) {
          sendJson(res, 401, { ok: false, error: "invalid token" })
          return
        }
        const raw = await readBody(req)
        let parsed: unknown
        try {
          parsed = JSON.parse(raw || "{}")
        } catch {
          sendJson(res, 400, { ok: false, error: "invalid json" })
          return
        }
        if (!isDecision(parsed)) {
          sendJson(res, 400, { ok: false, error: "invalid decision shape" })
          return
        }
        if (parsed.requestId !== requestId) {
          sendJson(res, 400, { ok: false, error: "requestId mismatch" })
          return
        }
        const consumed = store.consume(requestId)
        if (!consumed) {
          sendJson(res, 410, { ok: false, error: "unknown or expired nonce" })
          return
        }
        consumed.resolve(parsed)
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 404, { ok: false, error: "not found" })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      sendJson(res, 500, { ok: false, error: msg })
    }
  })

  const listen = () =>
    new Promise<{ port: number }>((resolve, reject) => {
      server.once("error", reject)
      server.listen(actualPort, host, () => {
        server.off("error", reject)
        const addr = server.address() as AddressInfo | null
        if (!addr) {
          reject(new Error("server address not available"))
          return
        }
        actualPort = addr.port
        resolve({ port: actualPort })
      })
    })

  const stop = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
    })

  // Tailscale Serve strips the matched prefix (e.g. "/review", "/decide")
  // when forwarding to the upstream. The plugin server therefore only sees
  // the post-strip path. The PUBLIC URLs returned to the phone still include
  // the prefix so Tailscale routes them correctly to us — only the INTERNAL
  // route handlers operate on the stripped form.
  const baseUrl = () => deps.publicBaseUrl.replace(/\/$/, "")
  const url = (requestId: string, token: string) =>
    `${baseUrl()}/decide/${requestId}?t=${token}`
  const reviewUrl = (requestId: string, token: string) =>
    `${baseUrl()}/review/${requestId}?t=${token}`

  const register = (
    requestId: string,
    snapshot: PermissionSnapshot,
    hmacSecret: string
  ): void => {
    store.register(requestId, {
      resolve: () => {},
      reject: () => {},
      createdAt: Date.now(),
      permission: snapshot,
      hmacSecret,
    })
  }

  const waitForDecision = (
    requestId: string,
    timeoutMs: number
  ): Promise<Decision> =>
    new Promise<Decision>((resolve, reject) => {
      const existing = store.peek(requestId)
      if (!existing) {
        reject(new Error("unknown or expired request"))
        return
      }
      const timer = setTimeout(() => {
        const p = store.consume(requestId)
        if (p) {
          p.reject(new Error("timeout"))
        }
        reject(new Error("timeout"))
      }, timeoutMs)
      timer.unref()
      store.register(requestId, {
        resolve: (d: Decision) => {
          clearTimeout(timer)
          resolve(d)
        },
        reject: (e: Error) => {
          clearTimeout(timer)
          reject(e)
        },
        createdAt: existing.createdAt,
        permission: existing.permission,
        hmacSecret: existing.hmacSecret,
      })
    })

  return {
    url,
    reviewUrl,
    listen,
    stop,
    register,
    waitForDecision,
    baseUrl,
    port: () => actualPort,
  }
}

function verifyStoredToken(
  pending: Pending,
  requestId: string,
  token: string
): boolean {
  if (typeof token !== "string" || token.length === 0 || token.length > 512) {
    return false
  }
  return verifyToken(pending.hmacSecret, requestId, token)
}

// Extract the requestId from the pathname, accepting both prefixed
// ("/review/<id>", "/decide/<id>") and Tailscale-stripped ("/<id>") forms.
// Returns null if the pathname doesn't match any of these.
function extractRequestId(pathname: string): string | null {
  // Tailscale-stripped form: "/<id>" with no further slashes
  if (pathname.length >= 2 && pathname[0] === "/") {
    let hasSlash = false
    for (let i = 1; i < pathname.length; i++) {
      if (pathname[i] === "/") {
        hasSlash = true
        break
      }
    }
    if (!hasSlash) return pathname.slice(1) || null
  }
  // Prefixed forms (direct access)
  if (pathname.startsWith("/review/")) {
    const id = pathname.slice("/review/".length)
    return id || null
  }
  if (pathname.startsWith("/decide/")) {
    const id = pathname.slice("/decide/".length)
    return id || null
  }
  return null
}