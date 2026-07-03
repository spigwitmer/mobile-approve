#!/usr/bin/env -S npx tsx
// Integration test for the new permission.asked event-hook dispatch path.
// Spawns a real broker in-process, has the plugin talk to it over HTTP, and
// mocks the OpencodeClient. Exercises the full flow:
//   1) plugin -> broker.ask -> ntfy publish + register
//   2) broker.waitForDecision (timeout path) -> plugin -> opencode reply
import { createBroker } from "../src/broker.ts"
import plugin from "../src/index.ts"

const brokerPort = 7463
const replies = []
const promptAsyncCalls = []

const fakeClient = {
  app: {
    log: async () => ({ data: true }),
  },
  session: {
    promptAsync: async (opts) => {
      promptAsyncCalls.push({
        path: opts.path,
        body: opts.body,
      })
      return { data: true }
    },
  },
  postSessionIdPermissionsPermissionId: async (opts) => {
    replies.push({
      sessionID: opts.path.id,
      permissionID: opts.path.permissionID,
      response: opts.body.response,
    })
    return {
      data: true,
      error: null,
      request: new Request("http://test/"),
      response: new Response(),
    }
  },
}

let ntfyCalls = 0
const origFetch = globalThis.fetch
globalThis.fetch = async (url, ...rest) => {
  const s = typeof url === "string" ? url : url.url
  // Count ntfy publish attempts (port 65535 is the unreachable test endpoint)
  if (s.includes(":65535")) {
    ntfyCalls++
    throw new Error(`ECONNREFUSED ${s}`)
  }
  return origFetch(url, ...rest)
}

// Spawn a real broker in-process
const broker = createBroker({
  cfg: {
    callbackPort: brokerPort,
    defaultTimeoutMs: 1500,
    nonceTtlMs: 60_000,
    hmacSecret: "integration-test-secret",
    hmacSecretGenerated: false,
    hmacSecretEnv: "MOBILE_APPROVE_SECRET",
    logLevel: "info",
    tunnel: { publicBaseUrl: `http://127.0.0.1:${brokerPort}` },
    ntfy: { baseUrl: "http://127.0.0.1:65535", topic: "oc-test", user: "u", password: "p" },
  },
  log: (level, message, extra) => {
    if (level === "debug") return
    // quiet: console.log(`[broker ${level}] ${message}`)
  },
})
await broker.start()

const cfg = {
  callbackPort: brokerPort,
  defaultTimeoutMs: 1500,
  nonceTtlMs: 60_000,
  hmacSecret: "integration-test-secret",
  hmacSecretGenerated: false,
  hmacSecretEnv: "MOBILE_APPROVE_SECRET",
  logLevel: "info",
  tunnel: { publicBaseUrl: `http://127.0.0.1:${brokerPort}` },
  ntfy: { baseUrl: "http://127.0.0.1:65535", topic: "oc-test", user: "u", password: "p" },
}

const hooks = await plugin({ client: fakeClient }, cfg)
if (!hooks.event || !hooks.dispose) {
  console.error("FAIL: plugin didn't return event/dispose hooks")
  process.exit(1)
}

let pass = true
function check(name, ok, info) {
  console.log(ok ? "OK  " : "FAIL", name, info !== undefined ? JSON.stringify(info) : "")
  if (!ok) pass = false
}

// --- Scenario 1: phone ask + timeout -> no reply (in-TUI fallback) ---
{
  replies.length = 0
  ntfyCalls = 0
  const e1 = {
    event: {
      type: "permission.asked",
      properties: {
        id: "perm-1",
        sessionID: "sess-1",
        permission: "bash",
        patterns: ["npm test"],
        metadata: {},
        always: [],
        tool: { messageID: "msg-1", callID: "call-1" },
      },
    },
  }
  const ep = hooks.event(e1)
  // Wait long enough for ntfy publish + decision timeout (1500ms)
  await ep
  check(
    "scenario 1: phone timeout -> NO auto-reply (let in-TUI prompt handle it)",
    replies.length === 0,
    { replies }
  )
  check("scenario 1: ntfy publish attempted", ntfyCalls === 1, { ntfyCalls })
}

// --- Scenario 2: dedupe blocks re-handling of same permission.id ---
{
  replies.length = 0
  ntfyCalls = 0
  const e1 = {
    event: {
      type: "permission.asked",
      properties: {
        id: "perm-2",
        sessionID: "sess-2",
        permission: "bash",
        patterns: ["ls /tmp"],
        metadata: {},
        always: [],
        tool: { messageID: "msg-2", callID: "call-2" },
      },
    },
  }
  await hooks.event(e1)
  check(
    "scenario 2: first ask -> NO auto-reply (timeout, let in-TUI handle it)",
    replies.length === 0,
    { replies }
  )

  // Re-fire with same permission.id - should be deduped
  replies.length = 0
  const e2 = {
    event: {
      type: "permission.asked",
      properties: e1.event.properties,
    },
  }
  await hooks.event(e2)
  check(
    "scenario 2: dedupe blocks re-handling of same permission.id",
    replies.length === 0,
    { replies }
  )
}

// --- Scenario 3: session.deleted event ---
{
  await hooks.event({
    event: {
      type: "session.deleted",
      properties: { info: { id: "sess-2" } },
    },
  })
  check("scenario 3: session.deleted is handled (no throw)", true)
}

// --- Scenario 3b: broker down -> NO auto-reply (in-TUI fallback) ---
{
  // Stop the broker so the plugin can't reach it.
  await broker.stop()
  replies.length = 0
  const e = {
    event: {
      type: "permission.asked",
      properties: {
        id: "perm-broker-down",
        sessionID: "sess-broker-down",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        tool: { messageID: "msg-bd", callID: "call-bd" },
      },
    },
  }
  await hooks.event(e)
  check(
    "scenario 3b: broker unreachable -> NO auto-reply (let in-TUI prompt handle it)",
    replies.length === 0,
    { replies }
  )

  // Restart the broker for subsequent scenarios.
  await broker.start()
}

// --- Scenario 4: end-to-end ask + phone decision (deny + hint) + plugin reply ---
//
// The plugin flow for a phone-deny-with-hint:
//   1) plugin calls broker.ask -> broker publishes to ntfy + registers a pending decision
//   2) phone user taps "Deny with a hint" -> broker decides + returns Decision to /v1/decision
//   3) plugin's waitForDecision resolves with the decision
//   4) plugin calls replyToOpencode("reject")
//   5) plugin calls sendAgentHint(hint) which posts to /session/{id}/prompt_async
//      with noReply: true and synthetic: true
//
// We capture the requestId from the /v1/ask response, then POST the
// phone's decision to the broker's /<id> endpoint (Tailscale-stripped form),
// and verify the plugin's calls.
{
  replies.length = 0
  promptAsyncCalls.length = 0

  // Hook fetch BEFORE the plugin runs so we can capture the requestId.
  let capturedRequestId = null
  const capturingFetch = async (url, ...rest) => {
    const s = typeof url === "string" ? url : url.url
    if (s.includes(":65535")) {
      ntfyCalls++
      throw new Error(`ECONNREFUSED ${s}`)
    }
    if (s.includes("/v1/ask")) {
      // Need to clone the response so we can read the body AND let the
      // plugin see it. clone() returns a new Response.
      const res = await origFetch(url, ...rest)
      if (res.ok) {
        const cloned = res.clone()
        const body = await cloned.json().catch(() => null)
        if (body?.requestId) capturedRequestId = body.requestId
      }
      return res
    }
    return origFetch(url, ...rest)
  }
  globalThis.fetch = capturingFetch

  const e1 = {
    event: {
      type: "permission.asked",
      properties: {
        id: "perm-hint",
        sessionID: "sess-hint",
        permission: "bash",
        patterns: ["npm install left-pad"],
        metadata: {},
        always: [],
        tool: { messageID: "msg-hint", callID: "call-hint" },
      },
    },
  }
  const ep = hooks.event(e1)

  // Poll for the captured requestId (the plugin's /v1/ask should
  // resolve within a few hundred ms).
  const t0 = Date.now()
  while (!capturedRequestId && Date.now() - t0 < 2000) {
    await new Promise((r) => setTimeout(r, 25))
  }

  globalThis.fetch = origFetch

  check(
    "scenario 4: /v1/ask was called and we captured the requestId",
    typeof capturedRequestId === "string" && capturedRequestId.length > 0,
    { capturedRequestId }
  )

  if (capturedRequestId) {
    // The broker's /<id> POST endpoint (Tailscale-stripped form) accepts
    // the phone's decision. The body includes the requestId, status,
    // scope, and agentHint.
    const cbRes = await origFetch(
      `http://127.0.0.1:${brokerPort}/${capturedRequestId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: capturedRequestId,
          receivedAt: Date.now(),
          status: "deny",
          scope: "once",
          agentHint: "use npm install --save-dev left-pad instead",
        }),
      }
    )
    check(
      "scenario 4: phone callback returns 200",
      cbRes.status === 200,
      { status: cbRes.status }
    )
  }

  // Wait for the plugin's event handler to complete (waits for the
  // decision, then calls replyToOpencode + sendAgentHint).
  await ep

  check(
    "scenario 4: plugin replied to opencode with 'reject'",
    replies.length === 1 && replies[0].response === "reject",
    { replies }
  )

  check(
    "scenario 4: plugin called session.promptAsync with the right shape",
    promptAsyncCalls.length === 1 &&
      promptAsyncCalls[0].path.id === "sess-hint" &&
      promptAsyncCalls[0].body.noReply === true &&
      Array.isArray(promptAsyncCalls[0].body.parts) &&
      promptAsyncCalls[0].body.parts[0].type === "text" &&
      promptAsyncCalls[0].body.parts[0].synthetic === true &&
      promptAsyncCalls[0].body.parts[0].text ===
        "use npm install --save-dev left-pad instead",
    {
      call: promptAsyncCalls[0],
    }
  )
}

// --- Scenario 5: phone notifications off (phoneNotifications: false) ---
//
// When the user pre-sets phoneNotifications: false in opencode.json (or
// toggles it via the in-TUI tool), the plugin's handlePermissionAsked
// bails out BEFORE calling the broker. The in-TUI prompt takes over.
// We verify that:
//   - broker.ask is NOT called (no ntfy publish)
//   - no reply is sent to opencode
{
  await hooks.dispose()
  replies.length = 0
  promptAsyncCalls.length = 0
  ntfyCalls = 0
  // Reload the plugin with phoneNotifications: false
  const cfgOff = { ...cfg, phoneNotifications: false }
  const hooksOff = await plugin({ client: fakeClient }, cfgOff)

  const e5 = {
    event: {
      type: "permission.asked",
      properties: {
        id: "perm-silent",
        sessionID: "sess-silent",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        tool: { messageID: "msg-silent", callID: "call-silent" },
      },
    },
  }
  await hooksOff.event(e5)
  // Give the plugin a moment in case it were going to fire requests
  await new Promise((r) => setTimeout(r, 50))
  check(
    "scenario 5: phoneNotifications=false -> broker.ask NOT called (no ntfy publish)",
    ntfyCalls === 0,
    { ntfyCalls }
  )
  check(
    "scenario 5: phoneNotifications=false -> NO reply to opencode (in-TUI handles it)",
    replies.length === 0,
    { replies }
  )
  check(
    "scenario 5: phoneNotifications=false -> sendAgentHint NOT called either",
    promptAsyncCalls.length === 0,
    { promptAsyncCalls }
  )
  await hooksOff.dispose()
}

await hooks.dispose()
await broker.stop()
globalThis.fetch = origFetch

console.log(pass ? "ALL OK" : "SOME FAILED")
process.exit(pass ? 0 : 1)
