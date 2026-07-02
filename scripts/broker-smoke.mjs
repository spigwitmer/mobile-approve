#!/usr/bin/env -S npx tsx
// Integration test for the broker's /v1/* HTTP API.
// Spawns the broker in-process and exercises:
//   - /v1/health
//   - /v1/ask
//   - /v1/decision/:requestId (long-poll)
//   - /v1/whitelist
//   - /v1/whitelist/:sessionID (GET, DELETE)
import { createBroker } from "../src/broker.ts"

const port = 7471
const baseUrl = `http://127.0.0.1:${port}`

const log = (level, message, extra) => {
  if (level === "debug") return
  console.log(`[${level}] ${message}`, extra ?? "")
}

const broker = createBroker({
  cfg: {
    callbackPort: port,
    defaultTimeoutMs: 5000,
    hmacSecret: "test-secret",
    hmacSecretGenerated: false,
    hmacSecretEnv: "MOBILE_APPROVE_SECRET",
    nonceTtlMs: 60000,
    logLevel: "info",
    ntfy: undefined,
    tunnel: { publicBaseUrl: `http://127.0.0.1:${port}` },
  },
  log,
})

let pass = true
function check(name, ok, info) {
  console.log(ok ? "OK  " : "FAIL", name, info !== undefined ? JSON.stringify(info) : "")
  if (!ok) pass = false
}

await broker.start()

// 1. /v1/health
{
  const res = await fetch(`${baseUrl}/v1/health`)
  const body = await res.json()
  check("/v1/health returns ok", res.ok && body.ok === true, { status: res.status, body })
  check("/v1/health includes port", body.port === port, { port: body.port })
}

// 2. /v1/ask
let requestId1
{
  const res = await fetch(`${baseUrl}/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionID: "sess-1",
      permissionID: "perm-1",
      tool: "bash",
      title: "delete build artifacts",
      pattern: "rm -rf build/",
      metadata: { cwd: "/home/you/proj" },
    }),
  })
  const body = await res.json()
  check("/v1/ask returns requestId", typeof body.requestId === "string" && body.requestId.length > 0, { body })
  check("/v1/ask returns reviewUrl", typeof body.reviewUrl === "string" && body.reviewUrl.includes("/review/"), { reviewUrl: body.reviewUrl })
  check("/v1/ask returns callbackUrl", typeof body.callbackUrl === "string" && body.callbackUrl.includes("/decide/"), { callbackUrl: body.callbackUrl })
  requestId1 = body.requestId
}

// 3. /v1/ask rejects missing fields
{
  const res = await fetch(`${baseUrl}/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionID: "sess-1" }),
  })
  check("/v1/ask rejects incomplete body", res.status === 400, { status: res.status })
}

// 4. /v1/decision/:requestId with timeout (no phone callback ever arrives)
{
  // First, register a real ask so the broker has something to wait for
  const askRes = await fetch(`${baseUrl}/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionID: "sess-timeout",
      permissionID: "perm-timeout",
      tool: "bash",
      title: "timeout test",
      pattern: "echo hi",
    }),
  })
  const { requestId } = await askRes.json()

  const t0 = Date.now()
  const res = await fetch(`${baseUrl}/v1/decision/${requestId}?timeoutMs=500`)
  const elapsed = Date.now() - t0
  const body = await res.json()
  check(
    "/v1/decision times out at 408 (no phone callback)",
    res.status === 408 && /timeout/i.test(body.error ?? ""),
    { status: res.status, elapsed, body }
  )
  check("/v1/decision timeout elapsed around 500ms", elapsed >= 400 && elapsed < 2000, { elapsed })
}

// 4b. /v1/decision/:requestId with unknown requestId returns 500 (or some error)
{
  const res = await fetch(`${baseUrl}/v1/decision/does-not-exist?timeoutMs=100`)
  const body = await res.json()
  check(
    "/v1/decision unknown requestId returns error",
    res.status >= 400,
    { status: res.status, body }
  )
}

// 5. /v1/whitelist POST + GET
{
  const res1 = await fetch(`${baseUrl}/v1/whitelist`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionID: "sess-1", tool: "bash", pattern: "git status" }),
  })
  const body1 = await res1.json()
  check("/v1/whitelist POST returns ok", res1.ok && body1.ok === true, { status: res1.status, body: body1 })

  const res2 = await fetch(`${baseUrl}/v1/whitelist/sess-1`)
  const body2 = await res2.json()
  check(
    "/v1/whitelist GET returns the pattern",
    Array.isArray(body2.bash) && body2.bash.includes("git status"),
    { body: body2 }
  )
}

// 6. /v1/whitelist GET unknown session returns empty object
{
  const res = await fetch(`${baseUrl}/v1/whitelist/sess-unknown`)
  const body = await res.json()
  check("/v1/whitelist unknown session returns {}", res.ok && Object.keys(body).length === 0, { body })
}

// 7. /v1/whitelist DELETE
{
  const res = await fetch(`${baseUrl}/v1/whitelist/sess-1`, { method: "DELETE" })
  const body = await res.json()
  check("/v1/whitelist DELETE returns ok", res.ok && body.ok === true, { status: res.status, body })

  const res2 = await fetch(`${baseUrl}/v1/whitelist/sess-1`)
  const body2 = await res2.json()
  check("/v1/whitelist after DELETE is empty", Object.keys(body2).length === 0, { body: body2 })
}

// 8. End-to-end: ask + phone callback + waitForDecision
{
  // Step 1: ask
  const res0 = await fetch(`${baseUrl}/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionID: "sess-e2e",
      permissionID: "perm-e2e",
      tool: "bash",
      title: "test",
      pattern: "ls",
    }),
  })
  const ask = await res0.json()
  const requestId = ask.requestId

  // Step 2: extract callback path
  // callbackUrl is e.g. http://127.0.0.1:7471/decide/<id>?t=<token>
  // Tailscale-stripped: /<id>?t=<token>
  const callbackUrl = new URL(ask.callbackUrl)
  const callbackPath =
    callbackUrl.pathname.replace(/^\/decide\//, "/") + callbackUrl.search

  // Step 3: start the waiter
  const waiterPromise = fetch(
    `${baseUrl}/v1/decision/${requestId}?timeoutMs=5000`
  )

  // Step 4: fire the phone callback after a small delay
  await new Promise((r) => setTimeout(r, 100))
  const callbackRes = await fetch(`${baseUrl}${callbackPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId,
      receivedAt: Date.now(),
      status: "allow",
      scope: "once",
    }),
  })

  // Step 5: the waiter should now resolve with the decision
  const waiterRes = await waiterPromise
  const waiterBody = await waiterRes.json().catch(() => null)

  check(
    "phone callback POST returns 200",
    callbackRes.status === 200,
    { status: callbackRes.status }
  )
  check(
    "waiter resolves with the phone's decision",
    waiterRes.ok &&
      waiterBody &&
      waiterBody.status === "allow" &&
      waiterBody.scope === "once",
    { status: waiterRes.status, body: waiterBody }
  )
}

await broker.stop()

console.log(pass ? "ALL OK" : "SOME FAILED")
process.exit(pass ? 0 : 1)
