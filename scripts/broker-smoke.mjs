#!/usr/bin/env -S npx tsx
// Integration test for the broker's /v1/* HTTP API.
// Spawns the broker in-process and exercises:
//   - /v1/health
//   - /v1/ask
//   - /v1/decision/:requestId (long-poll)
//   - /v1/whitelist
//   - /v1/whitelist/:sessionID (GET, DELETE)
//   - /v1/pending
import { createHmac } from "node:crypto"
import { createBroker } from "../src/broker.ts"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const port = 7471
const baseUrl = `http://127.0.0.1:${port}`

// Some keep-alive sockets from the test's fetch() calls may still be
// active when the test's broker is stopped. undici emits a benign
// "SocketError: other side closed" warning for those when the broker
// closes the connection — the fetch()'s body was already consumed, so
// the test result is valid. Suppress that one specific case.
process.on("unhandledRejection", (e) => {
  if (e?.cause?.code === "UND_ERR_SOCKET") return
  console.error("UNHANDLED REJECTION:", e)
  process.exit(1)
})
process.on("uncaughtException", (e) => {
  if (e?.cause?.code === "UND_ERR_SOCKET") return
  console.error("UNCAUGHT EXCEPTION:", e)
  process.exit(1)
})

const log = (level, message, extra) => {
  if (level === "debug") return
  console.log(`[${level}] ${message}`, extra ?? "")
}

function buildCfg(whitelistPath) {
  return {
    callbackPort: port,
    defaultTimeoutMs: 5000,
    hmacSecret: "test-secret",
    hmacSecretGenerated: false,
    hmacSecretEnv: "MOBILE_APPROVE_SECRET",
    nonceTtlMs: 60000,
    logLevel: "info",
    ntfy: undefined,
    tunnel: { publicBaseUrl: `http://127.0.0.1:${port}` },
    ...(whitelistPath !== undefined ? { whitelistPath } : {}),
  }
}

// Use a per-test tmpdir for the whitelist so the test does NOT pollute
// the user's real config file at ~/.config/mobile-approve/whitelist.json.
const sharedTmpDir = mkdtempSync(join(tmpdir(), "mobile-approve-broker-smoke-"))
const sharedWhitelistPath = join(sharedTmpDir, "whitelist.json")

let broker = createBroker({
  cfg: buildCfg(sharedWhitelistPath),
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
let ask1Body
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
  ask1Body = body
  check("/v1/ask returns requestId", typeof body.requestId === "string" && body.requestId.length > 0, { body })
  check("/v1/ask returns reviewUrl", typeof body.reviewUrl === "string" && body.reviewUrl.includes("/review/"), { reviewUrl: body.reviewUrl })
  check("/v1/ask returns callbackUrl", typeof body.callbackUrl === "string" && body.callbackUrl.includes("/decide/"), { callbackUrl: body.callbackUrl })
  requestId1 = body.requestId
}

// Helper: fire a phone-callback decision. Takes the /v1/ask response body
// and POSTs to the Tailscale-stripped /<id>?t=<token> path.
async function decide(askBody) {
  const callbackUrl = new URL(askBody.callbackUrl)
  const callbackPath =
    callbackUrl.pathname.replace(/^\/decide\//, "/") + callbackUrl.search
  return fetch(`${baseUrl}${callbackPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: askBody.requestId,
      receivedAt: Date.now(),
      status: "allow",
      scope: "once",
    }),
  })
}

// Consume scenario 2's ask so it doesn't leak into /v1/pending later.
await decide(ask1Body)

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

// --- T7: forged token rejected at /v1/decide ---
// Ask the broker for a real review URL, then attempt to POST a decision
// back with a forged token. The broker must reject the forged POST and
// keep the nonce live so a follow-up real POST still works.
{
  // Step 1: ask
  const askRes = await fetch(`${baseUrl}/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionID: "sess-t7",
      permissionID: "perm-t7",
      tool: "bash",
      title: "T7 forged-token test",
      pattern: "echo t7",
    }),
  })
  const ask = await askRes.json()
  const t7RequestId = ask.requestId
  const t7RealToken = new URL(ask.callbackUrl).searchParams.get("t")
  check(
    "T7 /v1/ask returned a real signed token",
    typeof t7RealToken === "string" && t7RealToken.length > 0,
    { t7RealToken }
  )

  // The phone callback lands on the Tailscale-stripped form: /<id>?t=<token>.
  const realCallbackPath = `${baseUrl}/${t7RequestId}?t=${t7RealToken}`

  // Step 2: start the waiter so we can confirm the nonce survives the
  // forged attempts and only resolves after the REAL POST.
  const t7Waiter = fetch(`${baseUrl}/v1/decision/${t7RequestId}?timeoutMs=5000`)

  // Give the waiter a moment to subscribe to the pending entry.
  await new Promise((r) => setTimeout(r, 100))

  // Step 3: forged POST (garbage token) must be rejected.
  const forgedRes = await fetch(`${baseUrl}/${t7RequestId}?t=garbage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: t7RequestId,
      receivedAt: Date.now(),
      status: "allow",
      scope: "once",
    }),
  })
  check(
    "T7 forged token POST rejected (401)",
    forgedRes.status === 401,
    { status: forgedRes.status }
  )

  // Step 4: POST with no token must be rejected.
  const noTokenRes = await fetch(`${baseUrl}/${t7RequestId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: t7RequestId,
      receivedAt: Date.now(),
      status: "allow",
      scope: "once",
    }),
  })
  check(
    "T7 no-token POST rejected (401)",
    noTokenRes.status === 401,
    { status: noTokenRes.status }
  )

  // Step 5: the real POST with the signed token must succeed.
  const realRes = await fetch(realCallbackPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: t7RequestId,
      receivedAt: Date.now(),
      status: "deny",
      scope: "once",
    }),
  })
  check(
    "T7 real-token POST succeeds (200) after forgeries",
    realRes.status === 200,
    { status: realRes.status }
  )

  // Step 6: waiter resolves with the decision (proves the nonce was
  // not consumed by the forged attempts).
  const t7WaiterRes = await t7Waiter
  const t7WaiterBody = await t7WaiterRes.json().catch(() => null)
  check(
    "T7 waiter resolves with the real decision (nonce survived forgeries)",
    t7WaiterRes.ok &&
      t7WaiterBody &&
      t7WaiterBody.status === "deny" &&
      t7WaiterBody.scope === "once",
    { status: t7WaiterRes.status, body: t7WaiterBody }
  )
}

// --- T9: GET /v1/pending ---
{
  // The `decide` helper is defined earlier in the file, after scenario 2.
  // It takes the /v1/ask response body (with the signed callbackUrl) and
  // POSTs to the Tailscale-stripped /<id>?t=<token> path.

  // Drain any leftover asks from earlier scenarios so the "empty" baseline
  // holds. Scenario 2 already self-cleans via decide(ask1Body). Other
  // scenarios that leave dangling asks would be a test bug; if any are
  // present, the drain below will report them as leftover.
  {
    const drain = await (await fetch(`${baseUrl}/v1/pending`)).json()
    // Best-effort: just report the count. We don't try to consume entries
    // whose callbackUrl we don't have, because that would require the HMAC
    // secret to be re-derived per requestId, and T7 now requires the token.
    if (drain.pending?.length > 0) {
      console.log(
        `WARN: ${drain.pending.length} leftover pending ask(s) at T9 start:`,
        drain.pending.map((p) => p.requestId).join(", ")
      )
    }
  }

  // 9a. Start fresh — verify pending is empty.
  {
    const res = await fetch(`${baseUrl}/v1/pending`)
    const body = await res.json()
    check(
      "/v1/pending empty when no asks",
      res.ok && Array.isArray(body.pending) && body.pending.length === 0,
      { status: res.status, body }
    )
  }

  // 9b. POST 2 /v1/ask calls for the same session, different tools.
  let t9Ask1, t9Ask2
  {
    const r1 = await fetch(`${baseUrl}/v1/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionID: "sess-pending",
        permissionID: "perm-pending-1",
        tool: "bash",
        title: "t9 ask 1",
        pattern: "rm -rf build/",
      }),
    })
    t9Ask1 = await r1.json()

    const r2 = await fetch(`${baseUrl}/v1/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionID: "sess-pending",
        permissionID: "perm-pending-2",
        tool: "edit",
        title: "t9 ask 2",
        pattern: "src/foo.ts",
      }),
    })
    t9Ask2 = await r2.json()

    check(
      "T9: /v1/ask returns 2 distinct requestIds",
      typeof t9Ask1.requestId === "string" &&
        typeof t9Ask2.requestId === "string" &&
        t9Ask1.requestId !== t9Ask2.requestId &&
        t9Ask1.requestId.length > 0,
      { ask1: t9Ask1.requestId, ask2: t9Ask2.requestId }
    )
  }

  // 9c. GET /v1/pending — should show both, with correct fields.
  {
    const res = await fetch(`${baseUrl}/v1/pending`)
    const body = await res.json()
    check(
      "/v1/pending returns 2 entries after 2 asks",
      res.ok && Array.isArray(body.pending) && body.pending.length === 2,
      { body }
    )

    const byId = new Map(body.pending.map((p) => [p.requestId, p]))
    check(
      "/v1/pending contains both requestIds",
      byId.has(t9Ask1.requestId) && byId.has(t9Ask2.requestId),
      {
        known: [...byId.keys()],
        expected: [t9Ask1.requestId, t9Ask2.requestId],
      }
    )

    const shapeOk = body.pending.every(
      (p) =>
        typeof p.requestId === "string" &&
        typeof p.sessionID === "string" &&
        typeof p.tool === "string" &&
        typeof p.ageMs === "number" &&
        p.ageMs >= 0
    )
    check(
      "/v1/pending entries have required fields and ageMs >= 0",
      shapeOk,
      { entries: body.pending }
    )

    check(
      "/v1/pending sessionID matches what we POSTed",
      byId.get(t9Ask1.requestId)?.sessionID === "sess-pending" &&
        byId.get(t9Ask2.requestId)?.sessionID === "sess-pending",
      {
        s1: byId.get(t9Ask1.requestId)?.sessionID,
        s2: byId.get(t9Ask2.requestId)?.sessionID,
      }
    )

    check(
      "/v1/pending tool matches what we POSTed",
      byId.get(t9Ask1.requestId)?.tool === "bash" &&
        byId.get(t9Ask2.requestId)?.tool === "edit",
      {
        t1: byId.get(t9Ask1.requestId)?.tool,
        t2: byId.get(t9Ask2.requestId)?.tool,
      }
    )
  }

  // 9d. Resolve ask1 via the phone callback path (Tailscale-stripped /<id>?t=<token>).
  {
    const res = await decide(t9Ask1)
    check("/v1/decide returns 200 for resolved ask1", res.status === 200, {
      status: res.status,
    })
  }

  // 9e. GET /v1/pending — should show 1, with ask1 gone.
  {
    const res = await fetch(`${baseUrl}/v1/pending`)
    const body = await res.json()
    check(
      "/v1/pending returns 1 entry after resolving ask1",
      body.pending.length === 1,
      { body }
    )
    check(
      "/v1/pending ask1 is gone after resolve",
      !body.pending.some((p) => p.requestId === t9Ask1.requestId),
      { pending: body.pending }
    )
    check(
      "/v1/pending ask2 is still present after ask1 resolve",
      body.pending.some((p) => p.requestId === t9Ask2.requestId),
      { pending: body.pending }
    )
  }

  // 9f. Resolve ask2.
  {
    const res = await decide(t9Ask2)
    check("/v1/decide returns 200 for resolved ask2", res.status === 200, {
      status: res.status,
    })
  }

  // 9g. GET /v1/pending — empty again.
  {
    const res = await fetch(`${baseUrl}/v1/pending`)
    const body = await res.json()
    check(
      "/v1/pending empty after both asks resolved",
      body.pending.length === 0,
      { body }
    )
  }
}

// --- WS3+WS4 review page fields ---
//
// These scenarios exercise the diff/filediff/modelExplanation fields on
// AskInput. Each one POSTs /v1/ask, fetches the resulting review page
// via the publicBaseUrl, and asserts on the rendered HTML.
// We don't restart the broker between scenarios (a same-port stop+start
// can strand undici keep-alive sockets in TIME_WAIT and hang subsequent
// fetches). The earlier scenarios all leave the broker in a usable state.

// Helper: ask and resolve to the rendered HTML of the review page.

// Helper: ask and resolve to the rendered HTML of the review page.
async function askAndFetchReview(body) {
  const askRes = await fetch(`${baseUrl}/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const askBody = await askRes.json()
  const { requestId, reviewUrl } = askBody
  const u = new URL(reviewUrl)
  const strippedPath =
    u.pathname.replace(/^\/review\//, "/") + u.search
  // callbackBase + strippedPath points at the SAME decision server (broker)
  // via Tailscale-stripped form
  const res = await fetch(`${baseUrl}${strippedPath}`)
  const html = await res.text()
  return { requestId, html, status: res.status }
}

// 9. /v1/ask with a single-file diff renders <pre class="diff"> with add/del spans
{
  const sampleDiff = [
    "diff --git a/src/auth/login.ts b/src/auth/login.ts",
    "--- a/src/auth/login.ts",
    "+++ b/src/auth/login.ts",
    "@@ -10,7 +10,8 @@ export async function login(req: Request) {",
    "   if (!user) return json({ error: \"missing user\" }, 400)",
    "   const ok = await verifyPassword(user, req.body.password)",
    "-  if (!ok) return json({ error: \"bad credentials\" }, 401)",
    "+  if (!ok) {",
    "+    return json({ error: \"bad credentials\" }, 401)",
    "+  }",
    "   req.session.userID = user.id",
    "   return json({ ok: true })",
    " }",
  ].join("\n")
  const { html, status } = await askAndFetchReview({
    sessionID: "sess-diff",
    permissionID: "perm-diff",
    tool: "edit",
    title: "edit src/auth/login.ts",
    pattern: "edit src/auth/login.ts",
    diff: sampleDiff,
  })
  check("review page returns 200 for diff ask", status === 200, { status })
  check("diff renders as <pre class=\"diff\">", html.includes('<pre class="diff">'), { snippet: html.match(/<pre class="diff">[^<]{0,80}/)?.[0] })
  check(
    "diff renders <span class=\"add\"> for added lines",
    html.includes('<span class="add">+  if (!ok) {</span>') ||
      /<span class="add">\+  if \(!ok\) \{<\/span>/.test(html) ||
      html.includes('<span class="add">') && html.includes("+  if (!ok)"),
    { hasAdd: html.includes('<span class="add">') }
  )
  check(
    "diff renders <span class=\"del\"> for removed lines",
    html.includes('<span class="del">') && html.includes("-  if (!ok) return json"),
    { hasDel: html.includes('<span class="del">'), hasLine: html.includes("-  if (!ok) return json") }
  )
  check(
    "diff renders <span class=\"hunk\"> for @@ hunk headers",
    html.includes('<span class="hunk">'),
    { hasHunk: html.includes('<span class="hunk">') }
  )
}

// 10. /v1/ask with filediff[] renders one <details> per file
{
  const diffA = [
    "diff --git a/foo.ts b/foo.ts",
    "--- a/foo.ts",
    "+++ b/foo.ts",
    "@@ -1,3 +1,3 @@",
    "-old line",
    "+new line",
    " keep",
  ].join("\n")
  const diffB = [
    "diff --git a/bar.ts b/bar.ts",
    "--- a/bar.ts",
    "+++ b/bar.ts",
    "@@ -1,3 +1,4 @@",
    " keep",
    "+added line",
  ].join("\n")
  const { html, status } = await askAndFetchReview({
    sessionID: "sess-filediff",
    permissionID: "perm-filediff",
    tool: "apply_patch",
    title: "apply_patch across 2 files",
    pattern: "apply_patch",
    filediff: [
      { filename: "src/foo.ts", diff: diffA },
      { filename: "src/bar.ts", diff: diffB },
    ],
  })
  check("review page returns 200 for filediff ask", status === 200, { status })
  const detailsCount = (html.match(/<details class="filediff">/g) || []).length
  check(
    "filediff renders one <details class=\"filediff\"> per file",
    detailsCount === 2,
    { detailsCount }
  )
  check(
    "filediff summary lists both filenames",
    html.includes("src/foo.ts") && html.includes("src/bar.ts"),
    { hasFoo: html.includes("src/foo.ts"), hasBar: html.includes("src/bar.ts") }
  )
  check(
    "filediff summary shows +N -M stats",
    /\(\+1\s+-1\)/.test(html) && /\(\+1\s+-0\)/.test(html),
    { snippets: html.match(/\(\+[0-9]+\s+-[0-9]+\)/g)?.slice(0, 4) }
  )
}

// 11. /v1/ask with modelExplanation renders a dedicated "explanation" box
{
  const { html, status } = await askAndFetchReview({
    sessionID: "sess-why",
    permissionID: "perm-why",
    tool: "bash",
    title: "rename foo to bar",
    pattern: "mv foo bar",
    modelExplanation: "Renaming foo to bar for the new convention.",
  })
  check("review page returns 200 for why ask", status === 200, { status })
  check(
    "modelExplanation renders as a dedicated explanation box (label + pre.explanation)",
    html.includes('>explanation</div>') &&
      html.includes('<pre class="explanation">'),
    { hasLabel: html.includes('>explanation</div>'), hasPre: html.includes('<pre class="explanation">') }
  )
  check(
    "modelExplanation is rendered as a peer of tool/pattern/metadata (inside the same panel)",
    // both <pre>explanation and <pre>tool should be inside the same .panel
    /<div class="panel">[\s\S]*<div class="label">tool<\/div>[\s\S]*<pre class="explanation">/.test(html),
    { samePanel: /<pre class="explanation">[\s\S]{0,200}<pre>/.test(html) }
  )
  check(
    "modelExplanation contains the provided text",
    html.includes("Renaming foo to bar"),
    { hasText: html.includes("Renaming foo to bar") }
  )
  check(
    "modelExplanation in metadata key is NOT echoed again",
    !/metadata[\s\S]*\b(modelExplanation|model_explanation)\b/i.test(html),
    {
      doubleEchoed:
        /metadata[\s\S]*\b(modelExplanation|model_explanation)\b/i.test(html),
    }
  )
}

// 12. /v1/ask with none of the new fields -> none of the new HTML elements appear
{
  const { html, status } = await askAndFetchReview({
    sessionID: "sess-plain",
    permissionID: "perm-plain",
    tool: "bash",
    title: "list files",
    pattern: "ls",
    metadata: { cwd: "/home/you/proj" },
  })
  check("review page returns 200 for plain ask", status === 200, { status })
  check(
    "plain ask shows explanation box with 'none given' fallback",
    html.includes('<pre class="explanation">') &&
      html.includes("none given"),
    { hasNoneGiven: html.includes("none given") }
  )
  check(
    "plain ask has NO <pre class=\"diff\">",
    !html.includes('<pre class="diff">'),
    { hasDiff: html.includes('<pre class="diff">') }
  )
  check(
    "plain ask has NO <details class=\"filediff\">",
    !html.includes('<details class="filediff">'),
    { hasFilediff: html.includes('<details class="filediff">') }
  )
}

// 13. auto-close script content
//
// Verifies that the rendered review page wires up an auto-close countdown
// after a successful decision POST. The default is 3000ms; per-load override
// is via ?closeAfter=N (N in seconds; 0 disables). The override is read by
// the inline script from window.location.search — at server-render time the
// HTML is identical regardless of the query string, so we can only assert
// on the wiring (presence of closeAfterMs literal, the countdown function,
// "Close now" UI, and the URLSearchParams parser), not on the runtime
// multiplication. The DEFAULT case uses askAndFetchReview (no query); the
// OVERRIDE case builds a /review/...?... path with ?closeAfter=10 appended.
{
  const { html, status } = await askAndFetchReview({
    sessionID: "sess-autoclose",
    permissionID: "perm-autoclose",
    tool: "bash",
    title: "auto-close default",
    pattern: "echo autoclose",
  })
  check("auto-close default page returns 200", status === 200, { status })
  check(
    "default closeAfterMs literal (3000) appears in script",
    /closeAfterMs\s*=\s*3000/.test(html),
    { has3000: /closeAfterMs\s*=\s*3000/.test(html) }
  )
  check(
    "countdown wiring present (setInterval)",
    /setInterval\(/.test(html)
  )
  check(
    "Close now button text referenced in script",
    /Close now/.test(html)
  )
  check(
    "window.close() call present in script",
    /window\.close\(/.test(html)
  )
  check(
    "URLSearchParams-based override parser present",
    /URLSearchParams[\s\S]{0,200}\.get\(['"]closeAfter['"]\)/.test(html)
  )

  // Override: GET the same review page with ?closeAfter=10 appended.
  const askRes2 = await fetch(`${baseUrl}/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionID: "sess-autoclose-ovr",
      permissionID: "perm-autoclose-ovr",
      tool: "bash",
      title: "auto-close override",
      pattern: "echo autoclose-override",
    }),
  })
  const ask2 = await askRes2.json()
  const u2 = new URL(ask2.reviewUrl)
  const sep = u2.search ? "&" : "?"
  const overridePath =
    u2.pathname.replace(/^\/review\//, "/") + u2.search + sep + "closeAfter=10"
  const res2 = await fetch(`${baseUrl}${overridePath}`)
  const html2 = await res2.text()
  check(
    "override ?closeAfter=10 page returns 200",
    res2.ok,
    { status: res2.status }
  )
  check(
    "override URL path was built with closeAfter=10",
    overridePath.includes("closeAfter=10"),
    { overridePath }
  )
  check(
    "override page still serializes default closeAfterMs=3000 (URL override is runtime only)",
    /closeAfterMs\s*=\s*3000/.test(html2)
  )
  check(
    "override page wires ?closeAfter param via URLSearchParams",
    /URLSearchParams[\s\S]{0,200}\.get\(['"]closeAfter['"]\)/.test(html2)
  )
  check(
    "override page multiplies seconds to ms (presence of * 1000)",
    /closeAfterMs\s*=\s*sec\s*===\s*0\s*\?\s*0\s*:\s*Math\.round\(sec\s*\*\s*1000\)/.test(html2)
  )
}

// 14. recall: ask + recall returns 200 recalled, second recall returns already-decided
//
// The /v1/recall/:requestId endpoint consumes the pending nonce so a
// follow-up phone callback returns 410. A second /v1/recall call after
// the consume must return already-decided.
{
  // Ask
  const askRes = await fetch(`${baseUrl}/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionID: "sess-recall",
      permissionID: "perm-recall",
      tool: "bash",
      title: "recall test",
      pattern: "echo recall",
    }),
  })
  const ask = await askRes.json()
  const requestId = ask.requestId
  check(
    "14: /v1/ask returned a requestId",
    typeof requestId === "string" && requestId.length > 0,
    { requestId }
  )

  // First recall: pending was just registered, should report "recalled"
  const r1 = await fetch(`${baseUrl}/v1/recall/${requestId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "allow", scope: "once" }),
  })
  const r1Body = await r1.json().catch(() => null)
  check(
    "14: first recall returns 200 with status=recalled",
    r1.ok && r1Body && r1Body.ok === true && r1Body.status === "recalled",
    { status: r1.status, body: r1Body }
  )

  // Second recall: pending was consumed, should report "already-decided"
  const r2 = await fetch(`${baseUrl}/v1/recall/${requestId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "deny", scope: "once" }),
  })
  const r2Body = await r2.json().catch(() => null)
  check(
    "14: second recall returns 200 with status=already-decided",
    r2.ok && r2Body && r2Body.ok === true && r2Body.status === "already-decided",
    { status: r2.status, body: r2Body }
  )

  // Verify GET /v1/pending no longer lists the requestId.
  const pendingRes = await fetch(`${baseUrl}/v1/pending`)
  const pendingBody = await pendingRes.json()
  check(
    "14: /v1/pending no longer lists the recalled requestId",
    !pendingBody.pending.some((p) => p.requestId === requestId),
    { pending: pendingBody.pending.map((p) => p.requestId) }
  )

  // And verify a follow-up phone callback returns 410 (nonce consumed).
  const callbackUrl = new URL(ask.callbackUrl)
  const callbackPath =
    callbackUrl.pathname.replace(/^\/decide\//, "/") + callbackUrl.search
  const cbRes = await fetch(`${baseUrl}${callbackPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId,
      receivedAt: Date.now(),
      status: "allow",
      scope: "once",
    }),
  })
  check(
    "14: phone callback after recall returns 410 (nonce consumed)",
    cbRes.status === 410,
    { status: cbRes.status }
  )
}

// 15. recall: ask + phone-decide + recall returns already-decided
//
// When the phone beats the TUI to the punch, the nonce is consumed by
// the decide path; a later /v1/recall must report already-decided.
{
  // Ask
  const askRes = await fetch(`${baseUrl}/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionID: "sess-recall-2",
      permissionID: "perm-recall-2",
      tool: "bash",
      title: "recall after phone-decide",
      pattern: "echo r2",
    }),
  })
  const ask = await askRes.json()

  // Phone decides first via the Tailscale-stripped /<id>?t=<token> path
  const decideRes = await decide(ask)
  check(
    "15: phone decide before recall returns 200",
    decideRes.status === 200,
    { status: decideRes.status }
  )

  // Now recall — must be already-decided
  const r = await fetch(`${baseUrl}/v1/recall/${ask.requestId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "deny", scope: "once" }),
  })
  const rBody = await r.json().catch(() => null)
  check(
    "15: recall after phone-decide returns 200 with status=already-decided",
    r.ok && rBody && rBody.ok === true && rBody.status === "already-decided",
    { status: r.status, body: rBody }
  )
}

await broker.stop()

// Persistence scenario has been moved to scripts/persistence-test.mjs
// (uses a separate port to avoid the multi-restart-on-7471 socket-reuse
// issue, where a fourth bind to the same port would close a half-written
// HTTP response from the previous broker).

console.log(pass ? "ALL OK" : "SOME FAILED")
process.exit(pass ? 0 : 1)
