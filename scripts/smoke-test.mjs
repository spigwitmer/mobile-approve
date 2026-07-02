#!/usr/bin/env -S npx tsx
import { NonceStore, signToken, isDecision, SessionWhitelists } from "../src/security.ts"
import { createDecisionServer } from "../src/server.ts"
import { renderReviewPage } from "../src/webui.ts"

const port = 7462
const publicBaseUrl = "http://127.0.0.1:" + port
const store = new NonceStore(60_000)
const server = createDecisionServer({ port, publicBaseUrl, store })
await server.listen()
console.log("listening on", publicBaseUrl)

const whitelist = new SessionWhitelists()

const requestId = crypto.randomUUID()
const token = signToken("test-secret", requestId)
const reviewUrl = server.reviewUrl(requestId, token)
const callbackUrl = server.url(requestId, token)
console.log("reviewUrl:", reviewUrl)

const snapshot = {
  id: "perm-1",
  type: "bash",
  title: "delete build artifacts",
  pattern: "rm -rf build/",
  metadata: { cwd: "/home/you/proj" },
  sessionID: "sess-1",
  messageID: "msg-1",
  callID: "call-1",
  createdAt: Date.now(),
}
server.register(requestId, snapshot)
const decisionPromise = server.waitForDecision(requestId, 10_000)

// 1) GET /<id>?t=<token> renders the simplified UI.
// (Tailscale Serve strips the "/review" prefix when forwarding, so the
// plugin only sees the single-segment form.)
const htmlRes = await fetch(`${publicBaseUrl}/${requestId}?t=${token}`)
const html = await htmlRes.text()
console.log("review html status:", htmlRes.status, "length:", html.length)
console.log("contains primary Allow once:", html.includes("data-action=\"once\""))
console.log("contains Reject:", html.includes("data-action=\"reject\""))
console.log("contains always-pattern input:", html.includes("id=\"always-pattern\""))
console.log("contains More options details:", html.includes(">More options<"))
console.log("hidden textarea id:", html.includes("id=\"command\"") && html.includes("id=\"hint\""))

// 1b) Array-pattern ask renders radios
const requestIdArr = crypto.randomUUID()
const tokArr = signToken("test-secret", requestIdArr)
const snapArr = { ...snapshot, id: requestIdArr, pattern: ["rm *", "rm -rf *"] }
server.register(requestIdArr, snapArr)
const dpArr = server.waitForDecision(requestIdArr, 10_000)
const htmlArrRes = await fetch(`${publicBaseUrl}/${requestIdArr}?t=${tokArr}`)
const htmlArr = await htmlArrRes.text()
console.log("array-pattern review html status:", htmlArrRes.status)
console.log("  contains radio rm *:", htmlArr.includes('value="rm *"'))
console.log("  contains radio rm -rf *:", htmlArr.includes('value="rm -rf *"'))
console.log("  contains __custom__ radio:", htmlArr.includes('value="__custom__"'))
console.log("  contains name=always:", htmlArr.includes('name="always"'))
// Cleanup
await postDecision(requestIdArr, { status: "deny", scope: "once" })
await dpArr

// 2) Test the TUI-mirror decisions
async function postDecision(reqId, body) {
  const res = await fetch(`${publicBaseUrl}/${reqId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: reqId, receivedAt: Date.now(), ...body }),
  })
  console.log(`POST /decide (${body.status}/${body.scope}):`, res.status)
  if (!res.ok) {
    console.log("  body:", await res.text())
    return null
  }
  return res.json()
}

// Scenario A: Allow once
await postDecision(requestId, { status: "allow", scope: "once" })
const v1 = await decisionPromise
console.log("scenario A:", v1.status, v1.scope)

// Scenario B: Allow always with a custom pattern
const requestIdB = crypto.randomUUID()
const tokB = signToken("test-secret", requestIdB)
const snapB = { ...snapshot, id: requestIdB }
server.register(requestIdB, snapB)
const dpB = server.waitForDecision(requestIdB, 10_000)
await postDecision(requestIdB, {
  status: "allow",
  scope: "always",
  patterns: ["git status"],
})
const v2 = await dpB
console.log("scenario B:", v2.status, v2.scope, v2.patterns)
whitelist.for("sess-A").add("bash", "git status")  // mirror what the plugin would do
const wlA = whitelist.for("sess-A")
const wlA_match = wlA.matches("bash", "git status")
const wlA_nomatch = !wlA.matches("bash", "rm -rf /")
const wlB_nomatch = !whitelist.for("sess-B").matches("bash", "git status")
const sessionsBefore = whitelist.sessionCount()

console.log("sess-A whitelist matches git status?", wlA_match)
console.log("sess-A whitelist doesn't match rm -rf /?", wlA_nomatch)
console.log("sess-A whitelist size:", wlA.size())
console.log("isolation: sess-B doesn't match?", wlB_nomatch)
console.log("isolation: total whitelist count:", sessionsBefore)

// Cleanup on session delete
whitelist.delete("sess-A")
const sessionsAfter = whitelist.sessionCount()
const totalAfter = whitelist.totalSize()
const wlB_size_after = whitelist.for("sess-B").size()
console.log("after sess-A delete: sessionCount:", sessionsAfter)
console.log("after sess-A delete: totalSize:", totalAfter)
console.log("sess-B still present (touched):", wlB_size_after === 0 && sessionsAfter === 1)

// Scenario C: Reject
const requestIdC = crypto.randomUUID()
const tokC = signToken("test-secret", requestIdC)
const snapC = { ...snapshot, id: requestIdC }
server.register(requestIdC, snapC)
const dpC = server.waitForDecision(requestIdC, 10_000)
await postDecision(requestIdC, { status: "deny", scope: "once" })
const v3 = await dpC
console.log("scenario C:", v3.status, v3.scope)

// 3) Replay protection (use A's already-consumed requestId)
const replayRes = await fetch(callbackUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ requestId, receivedAt: Date.now(), status: "allow", scope: "once" }),
})
console.log("replay status:", replayRes.status)

// 4) GET /review after consume returns 410
const html2 = await fetch(`${publicBaseUrl}/${requestId}?t=${token}`)
console.log("review after consume:", html2.status)

await server.stop()

// 5) isDecision validation
console.log("isDecision valid:", isDecision({ requestId: "x", status: "allow", scope: "once", receivedAt: 1 }))
console.log("isDecision bad command:", !isDecision({ requestId: "x", status: "allow", scope: "once", receivedAt: 1, command: 123 }))

const checks = [
  ["review renders", htmlRes.status === 200],
  ["has once button", html.includes('data-action="once"')],
  ["has reject button", html.includes('data-action="reject"')],
  ["has always pattern input", html.includes('id="always-pattern"')],
  ["has more options", html.includes('>More options<')],
  ["array-pattern shows radios", htmlArrRes.status === 200 && htmlArr.includes('name="always"') && htmlArr.includes('value="rm -rf *"')],
  ["A: allow once", v1.status === "allow" && v1.scope === "once"],
  ["B: allow always with patterns", v2.status === "allow" && v2.scope === "always" && v2.patterns?.[0] === "git status"],
  ["C: reject", v3.status === "deny"],
  ["whitelist match", wlA_match],
  ["whitelist no-match", wlA_nomatch],
  ["whitelist per-session isolation", wlB_nomatch],
  ["whitelist cleanup on session delete", sessionsBefore === 2 && sessionsAfter === 1 && totalAfter === 0],
  ["replay blocked", replayRes.status === 410],
  ["review gone after consume", html2.status === 410],
  ["isDecision guards", isDecision({ requestId: "x", status: "allow", scope: "once", receivedAt: 1 }) && !isDecision({ requestId: "x", status: "allow", scope: "once", receivedAt: 1, command: 123 })],
]
for (const [name, ok] of checks) console.log(ok ? "OK  " : "FAIL", name)
console.log(checks.every(([, ok]) => ok) ? "ALL OK" : "SOME FAILED")
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)