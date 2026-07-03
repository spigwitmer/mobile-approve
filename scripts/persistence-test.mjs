#!/usr/bin/env -S npx tsx
// Persistence test for the broker's whitelist file I/O.
// Runs in a fresh broker on a separate port (no multi-restart-on-7471).
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBroker } from "../src/broker.ts"

const port = 7480
const baseUrl = `http://127.0.0.1:${port}`

let pass = true
const log = (level, message, extra) => {
  if (level === "debug") return
  console.log(`[${level}]`, message, extra ?? "")
}
const check = (name, ok, extra) => {
  console.log(ok ? "OK  " : "FAIL", name, extra ? JSON.stringify(extra) : "")
  if (!ok) pass = false
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

const tmpDir = mkdtempSync(join(tmpdir(), "mobile-approve-wl-"))
const whitelistPath = join(tmpDir, "whitelist.json")
console.log(`tmpDir: ${tmpDir}`)
console.log(`whitelistPath: ${whitelistPath}`)

let broker = createBroker({ cfg: buildCfg(whitelistPath), log })
await broker.start()

const sessionID = "sess-persist"

{
  const r = await fetch(`${baseUrl}/v1/whitelist`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionID, tool: "bash", pattern: "git status" }),
  })
  check("POST 1 returns ok", r.ok)
  const r2 = await fetch(`${baseUrl}/v1/whitelist`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionID, tool: "bash", pattern: "git log" }),
  })
  check("POST 2 returns ok", r2.ok)

  const onDisk1 = existsSync(whitelistPath)
    ? JSON.parse(readFileSync(whitelistPath, "utf8"))
    : null
  check("whitelist file exists after POST x2", onDisk1 !== null, { whitelistPath })
  check(
    "whitelist file has both patterns after POST x2",
    Array.isArray(onDisk1?.[sessionID]?.bash) &&
      onDisk1[sessionID].bash.includes("git status") &&
      onDisk1[sessionID].bash.includes("git log"),
    { onDisk: onDisk1 }
  )
}

await broker.stop()
broker = createBroker({ cfg: buildCfg(whitelistPath), log })
await broker.start()
await new Promise((r) => setTimeout(r, 200))

{
  const relRes = await fetch(`${baseUrl}/v1/whitelist/${sessionID}`)
  const relBody = await relRes.json()
  check(
    "whitelist reloaded after restart has both patterns",
    Array.isArray(relBody.bash) &&
      relBody.bash.includes("git status") &&
      relBody.bash.includes("git log"),
    { body: relBody }
  )

  const delRes = await fetch(`${baseUrl}/v1/whitelist/${sessionID}`, {
    method: "DELETE",
  })
  const delBody = await delRes.json()
  check(
    "/v1/whitelist DELETE returns ok",
    delRes.ok && delBody.ok === true,
    { status: delRes.status, body: delBody }
  )

  const onDisk2 = JSON.parse(readFileSync(whitelistPath, "utf8"))
  check(
    "whitelist file no longer has session after DELETE",
    onDisk2[sessionID] === undefined,
    { onDisk: onDisk2 }
  )
}

await broker.stop()
broker = createBroker({ cfg: buildCfg(whitelistPath), log })
await broker.start()
await new Promise((r) => setTimeout(r, 200))

{
  const finalRes = await fetch(`${baseUrl}/v1/whitelist/${sessionID}`)
  const finalBody = await finalRes.json()
  check(
    "whitelist session is empty after DELETE + restart",
    finalRes.ok && Object.keys(finalBody).length === 0,
    { body: finalBody }
  )
}

await broker.stop()
rmSync(tmpDir, { recursive: true, force: true })
console.log(pass ? "ALL OK" : "SOME FAILED")
process.exit(pass ? 0 : 1)
