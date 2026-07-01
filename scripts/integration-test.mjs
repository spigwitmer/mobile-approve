#!/usr/bin/env -S npx tsx
// Integration test for the new permission.asked event-hook dispatch path.
// Mocks the OpencodeClient and exercises the full plugin end-to-end.
import plugin from "../src/index.ts"

const replies = []

const fakeClient = {
  app: {
    log: async () => ({ data: true }),
  },
  session: {
    prompt: async () => ({ data: true }),
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
// Monkey-patch fetch to count ntfy publish attempts.
const origFetch = globalThis.fetch
globalThis.fetch = async (url, ...rest) => {
  const s = typeof url === "string" ? url : url.url
  if (s.includes(":65535")) {
    ntfyCalls++
    // Simulate a network failure like the real unreachable URL would cause
    throw new Error(`ECONNREFUSED ${s}`)
  }
  return origFetch(url, ...rest)
}

const cfg = {
  callbackPort: 7463,
  defaultTimeoutMs: 1500,
  nonceTtlMs: 60_000,
  hmacSecret: "integration-test-secret",
  hmacSecretGenerated: false,
  hmacSecretEnv: "MOBILE_APPROVE_SECRET",
  logLevel: "info",
  tunnel: { publicBaseUrl: "http://127.0.0.1:7463" },
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

// --- Scenario 1: phone ask + timeout -> default-deny -> reply reject ---
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
  // Wait long enough for ntfy publish + decision timeout
  await ep
  check(
    "scenario 1: default-deny (timeout) -> reply reject",
    replies.length === 1 &&
      replies[0].response === "reject" &&
      replies[0].permissionID === "perm-1",
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
    "scenario 2: first ask -> reply reject",
    replies.length === 1 && replies[0].response === "reject",
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

await hooks.dispose()
globalThis.fetch = origFetch

console.log(pass ? "ALL OK" : "SOME FAILED")
process.exit(pass ? 0 : 1)