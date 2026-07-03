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
    // WS3+WS4: the plugin's fetchModelExplanation helper calls this to pull
    // the leading non-synthetic text part for the "Why:" blockquote. The
    // default implementation below returns a fake message with a synthetic
    // part followed by a real preamble + tool part. Scenarios that need a
    // different behaviour (e.g. throw) reassign `fakeClient.session.message`.
    message: async () => ({
      data: {
        info: {},
        parts: [
          {
            id: "part-synth",
            sessionID: "sess-test",
            messageID: "msg-test",
            type: "text",
            text: "(synthetic preamble — must be skipped)",
            synthetic: true,
          },
          {
            id: "part-pre",
            sessionID: "sess-test",
            messageID: "msg-test",
            type: "text",
            text: "I am rewriting the login helper to match the new style guide.",
            synthetic: false,
          },
          {
            id: "part-tool",
            sessionID: "sess-test",
            messageID: "msg-test",
            type: "tool",
            callID: "call-test",
            tool: "edit",
            state: { status: "pending" },
          },
        ],
      },
      error: null,
    }),
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

  // Hook fetch BEFORE the plugin runs so we can capture the requestId
  // and the full /v1/ask response body (so we can build the signed
  // callback URL that T7 now requires).
  let capturedRequestId = null
  let capturedAskBody = null
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
        capturedAskBody = body
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
    // T7: the broker's /<id> POST endpoint (Tailscale-stripped form) now
    // requires ?t=<hmac(secret, requestId)>. The token is in the
    // /v1/ask response's callbackUrl.search.
    const callbackUrl = new URL(capturedAskBody.callbackUrl)
    const callbackPath =
      callbackUrl.pathname.replace(/^\/decide\//, "/") +
      callbackUrl.search
    const cbRes = await origFetch(
      `http://127.0.0.1:${brokerPort}${callbackPath}`,
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

// --- Scenario 6 (WS4 part A): fetchModelExplanation populates modelExplanation ---
//
// The plugin's handlePermissionAsked calls fetchModelExplanation(sessionID,
// messageID) after the whitelist check. The mock fakeClient.session.message
// returns a synthetic text part (must be SKIPPED) followed by a real
// preamble text part. We verify that:
//   - the broker.ask body carries modelExplanation = "I am rewriting…"
//   - the rendered review page HTML contains <blockquote class="why"> with the
//     preamble text
{
  // Need a fresh plugin instance with default phoneNotifications config.
  const hooks2 = await plugin({ client: fakeClient }, cfg)

  let capturedRequestId = null
  let capturedAskBody = null
  let capturedAskResponse = null
  const capturingFetch2 = async (url, ...rest) => {
    const s = typeof url === "string" ? url : url.url
    if (s.includes(":65535")) {
      ntfyCalls++
      throw new Error(`ECONNREFUSED ${s}`)
    }
    if (s.includes("/v1/ask")) {
      // Capture request body so we can inspect modelExplanation.
      const args = rest
      let bodyStr = null
      const init = args[0]
      if (init && typeof init === "object" && typeof init.body === "string") {
        bodyStr = init.body
      }
      const res = await origFetch(url, ...rest)
      if (res.ok) {
        const cloned = res.clone()
        const rj = await cloned.json().catch(() => null)
        if (rj?.requestId) capturedRequestId = rj.requestId
        capturedAskResponse = rj
      }
      if (bodyStr) {
        try {
          capturedAskBody = JSON.parse(bodyStr)
        } catch {
          /* ignore */
        }
      }
      return res
    }
    return origFetch(url, ...rest)
  }
  globalThis.fetch = capturingFetch2

  const e6 = {
    event: {
      type: "permission.asked",
      properties: {
        id: "perm-why",
        sessionID: "sess-test",
        permission: "edit",
        patterns: ["edit src/auth/login.ts"],
        metadata: {},
        always: [],
        tool: { messageID: "msg-test", callID: "call-test" },
      },
    },
  }
  const ep = hooks2.event(e6)

  // Poll for the captured requestId.
  const t0 = Date.now()
  while (!capturedRequestId && Date.now() - t0 < 2000) {
    await new Promise((r) => setTimeout(r, 25))
  }
  globalThis.fetch = origFetch

  check(
    "scenario 6: /v1/ask was called and we captured the requestId",
    typeof capturedRequestId === "string" && capturedRequestId.length > 0,
    { capturedRequestId }
  )
  check(
    "scenario 6: broker.ask body carried modelExplanation (the agent preamble)",
    capturedAskBody &&
      capturedAskBody.modelExplanation ===
        "I am rewriting the login helper to match the new style guide.",
    { modelExplanation: capturedAskBody?.modelExplanation }
  )

  if (capturedRequestId) {
    // Fetch the review page and assert the Why blockquote is rendered.
    const askRes = await origFetch(`http://127.0.0.1:${brokerPort}/v1/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionID: "sess-ws4-why",
        permissionID: "perm-ws4-why",
        tool: "edit",
        title: "review WS4 Why",
        pattern: "edit",
        modelExplanation:
          "I am rewriting the login helper to match the new style guide.",
      }),
    })
    const askJson = await askRes.json()
    const reviewUrl = askJson.reviewUrl
    const u = new URL(reviewUrl)
    const strippedPath =
      u.pathname.replace(/^\/review\//, "/") + u.search
    const reviewRes = await origFetch(`http://127.0.0.1:${brokerPort}${strippedPath}`)
    const reviewHtml = await reviewRes.text()

    check(
      "scenario 6: review page rendered with explanation label and pre",
      reviewHtml.includes('>explanation</div>') &&
        reviewHtml.includes('<pre class="explanation">'),
      { snippet: reviewHtml.match(/<pre class="explanation">[^<]{0,80}/)?.[0] }
    )
    check(
      "scenario 6: review page explanation box contains the preamble text",
      reviewHtml.includes("I am rewriting the login helper"),
      { contains: reviewHtml.includes("I am rewriting the login helper") }
    )
  }

  // Let the plugin finish (it's waiting on the phone callback).
  // We don't actually need it; abort by sending a deny.
  if (capturedRequestId) {
    // T7: use the signed callback URL from /v1/ask.
    const callbackUrl = new URL(capturedAskResponse.callbackUrl)
    const callbackPath =
      callbackUrl.pathname.replace(/^\/decide\//, "/") +
      callbackUrl.search
    const cbRes = await origFetch(
      `http://127.0.0.1:${brokerPort}${callbackPath}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: capturedRequestId,
          receivedAt: Date.now(),
          status: "deny",
          scope: "once",
        }),
      }
    )
    void cbRes
  }
  await ep
  await hooks2.dispose()
}

// --- Scenario 7 (WS4 part B): fetchModelExplanation throws -> page omits Why ---
//
// When fakeClient.session.message throws, fetchModelExplanation catches and
// returns null. The plugin's broker.ask call should still succeed (no
// exception leaks) but with modelExplanation undefined.
// The rendered review page should have NO <blockquote class="why">.
{
  // Replace the mock so that ANY call to session.message throws.
  const originalMessage = fakeClient.session.message
  fakeClient.session.message = async () => {
    throw new Error("synthetic: session.message is broken")
  }

  let capturedRequestId = null
  let capturedAskBody = null
  let capturedAskResponse = null
  const capturingFetch3 = async (url, ...rest) => {
    const s = typeof url === "string" ? url : url.url
    if (s.includes(":65535")) {
      ntfyCalls++
      throw new Error(`ECONNREFUSED ${s}`)
    }
    if (s.includes("/v1/ask")) {
      let bodyStr = null
      const init = rest[0]
      if (init && typeof init === "object" && typeof init.body === "string") {
        bodyStr = init.body
      }
      const res = await origFetch(url, ...rest)
      if (res.ok) {
        const cloned = res.clone()
        const rj = await cloned.json().catch(() => null)
        if (rj?.requestId) capturedRequestId = rj.requestId
        capturedAskResponse = rj
      }
      if (bodyStr) {
        try {
          capturedAskBody = JSON.parse(bodyStr)
        } catch {
          /* ignore */
        }
      }
      return res
    }
    return origFetch(url, ...rest)
  }
  globalThis.fetch = capturingFetch3

  const hooks3 = await plugin({ client: fakeClient }, cfg)

  const e7 = {
    event: {
      type: "permission.asked",
      properties: {
        id: "perm-why-throw",
        sessionID: "sess-throw",
        permission: "edit",
        patterns: ["edit src/foo.ts"],
        metadata: {},
        always: [],
        tool: { messageID: "msg-throw", callID: "call-throw" },
      },
    },
  }
  let pluginThrew = false
  let ep3 = null
  try {
    ep3 = hooks3.event(e7)
  } catch (err) {
    pluginThrew = true
    void err
  }

  // Poll for the captured requestId (modelExplanation should be omitted by
  // the time the plugin's /v1/ask fires).
  const t0s7 = Date.now()
  while (!capturedRequestId && Date.now() - t0s7 < 2000) {
    await new Promise((r) => setTimeout(r, 25))
  }
  globalThis.fetch = origFetch

  check(
    "scenario 7: plugin did NOT throw when fetchModelExplanation threw",
    pluginThrew === false,
    { pluginThrew }
  )

  check(
    "scenario 7: broker.ask body has NO modelExplanation (graceful degrade)",
    capturedAskBody &&
      (capturedAskBody.modelExplanation === undefined ||
        capturedAskBody.modelExplanation === null ||
        capturedAskBody.modelExplanation === ""),
    { modelExplanation: capturedAskBody?.modelExplanation }
  )

  // Render a corresponding review page and assert no <blockquote class="why">.
  if (capturedRequestId) {
    // Fire a phone decision so the plugin exits cleanly.
    // T7: use the signed callback URL from /v1/ask.
    const callbackUrl = new URL(capturedAskResponse.callbackUrl)
    const callbackPath =
      callbackUrl.pathname.replace(/^\/decide\//, "/") +
      callbackUrl.search
    const cbRes = await origFetch(
      `http://127.0.0.1:${brokerPort}${callbackPath}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: capturedRequestId,
          receivedAt: Date.now(),
          status: "deny",
          scope: "once",
        }),
      }
    )
    void cbRes
    // Give the plugin a beat to drain the waitForDecision promise.
    if (ep3) await ep3
  }

  // Render the test page via a fresh /v1/ask (without modelExplanation) and
  // verify no <blockquote class="why"> appears when there's no preamble.
  const askRes = await origFetch(`http://127.0.0.1:${brokerPort}/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionID: "sess-ws4-degrade",
      permissionID: "perm-ws4-degrade",
      tool: "edit",
      title: "review WS4 graceful degrade",
      pattern: "edit",
    }),
  })
  const askJson = await askRes.json()
  const reviewUrl = askJson.reviewUrl
  const u = new URL(reviewUrl)
  const strippedPath = u.pathname.replace(/^\/review\//, "/") + u.search
  const reviewRes = await origFetch(`http://127.0.0.1:${brokerPort}${strippedPath}`)
  const reviewHtml = await reviewRes.text()

  check(
    "scenario 7: review page rendered WITH explanation box showing 'none given' (no preamble available)",
    reviewHtml.includes('<pre class="explanation">') &&
      reviewHtml.includes("none given"),
    { hasNoneGiven: reviewHtml.includes("none given") }
  )

  // Restore the original mock for cleanliness.
  fakeClient.session.message = originalMessage
  await hooks3.dispose()
}

await hooks.dispose()
await broker.stop()
globalThis.fetch = origFetch

console.log(pass ? "ALL OK" : "SOME FAILED")
process.exit(pass ? 0 : 1)
