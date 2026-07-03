import { createHmac, randomUUID } from "node:crypto"
import {
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  fsyncSync,
  writeFileSync,
  closeSync,
} from "node:fs"
import { dirname, join } from "node:path"
import type { Pending, Decision } from "./types.js"

export type WhitelistFile = Record<string, Record<string, string[]>>

function hmac(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("base64url")
}

export function newRequestId(): string {
  return randomUUID()
}

export class Whitelist {
  private readonly rules = new Map<string, Set<string>>()

  add(tool: string, pattern: string): void {
    let patterns = this.rules.get(tool)
    if (!patterns) {
      patterns = new Set()
      this.rules.set(tool, patterns)
    }
    patterns.add(pattern)
  }

  matches(tool: string, pattern: string): boolean {
    const patterns = this.rules.get(tool)
    if (!patterns) return false
    if (patterns.has(pattern)) return true
    for (const p of patterns) {
      if (matchWildcard(p, pattern)) return true
    }
    return false
  }

  size(): number {
    let n = 0
    for (const s of this.rules.values()) n += s.size
    return n
  }

  getRules(): ReadonlyMap<string, ReadonlySet<string>> {
    return this.rules
  }

  *entriesForExport(): IterableIterator<[string, Set<string>]> {
    yield* this.rules.entries()
  }
}

export class SessionWhitelists {
  private readonly bySession = new Map<string, Whitelist>()

  for(sessionID: string): Whitelist {
    let wl = this.bySession.get(sessionID)
    if (!wl) {
      wl = new Whitelist()
      this.bySession.set(sessionID, wl)
    }
    return wl
  }

  delete(sessionID: string): void {
    this.bySession.delete(sessionID)
  }

  snapshotAll(): WhitelistFile {
    const out: WhitelistFile = {}
    for (const [sessionID, wl] of this.bySession) {
      const tools: Record<string, string[]> = {}
      for (const [tool, patterns] of wl.entriesForExport()) {
        tools[tool] = [...patterns]
      }
      out[sessionID] = tools
    }
    return out
  }

  loadSnapshot(data: WhitelistFile): void {
    if (!data || typeof data !== "object") return
    for (const [sessionID, tools] of Object.entries(data)) {
      if (!tools || typeof tools !== "object") continue
      for (const [tool, patterns] of Object.entries(tools)) {
        if (!Array.isArray(patterns)) continue
        for (const pattern of patterns) {
          if (typeof pattern !== "string") continue
          this.for(sessionID).add(tool, pattern)
        }
      }
    }
  }

  totalSize(): number {
    let n = 0
    for (const wl of this.bySession.values()) n += wl.size()
    return n
  }

  sessionCount(): number {
    return this.bySession.size
  }
}

export class WhitelistPersistence {
  private readonly filePath: string
  private readonly onError?: (err: Error) => void

  constructor(filePath: string, onError?: (err: Error) => void) {
    this.filePath = filePath
    this.onError = onError
  }

  load(): WhitelistFile {
    let raw: string
    try {
      raw = readFileSync(this.filePath, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}
      this.report(err, "read")
      return {}
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      this.report(err, "parse")
      return {}
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.report(new Error("whitelist file is not a JSON object"), "parse")
      return {}
    }
    return parsed as WhitelistFile
  }

  save(data: WhitelistFile): void {
    const json = JSON.stringify(data)
    const tmp = `${this.filePath}.tmp`
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) {
        this.report(new Error(`parent directory does not exist: ${dir}`), "write")
        return
      }
      const fd = openSync(tmp, "w", 0o600)
      try {
        writeFileSync(fd, json)
        try {
          fsyncSync(fd)
        } catch (err) {
          this.report(err, "fsync")
        }
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, this.filePath)
    } catch (err) {
      this.report(err, "rename")
    }
  }

  getPath(): string {
    return this.filePath
  }

  private report(err: unknown, op: string): void {
    const reason = err instanceof Error ? err.message : String(err)
    if (this.onError) {
      this.onError(new Error(`whitelist persistence ${op} failed: ${reason}`))
    }
  }
}

export function defaultWhitelistPath(): string {
  const base =
    process.env.XDG_CONFIG_HOME ??
    join(process.env.HOME ?? "~", ".config")
  return join(base, "mobile-approve", "whitelist.json")
}

function matchWildcard(pattern: string, candidate: string): boolean {
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

export function signToken(secret: string, requestId: string): string {
  return hmac(secret, `mobile-approve|${requestId}`)
}

export function verifyToken(
  secret: string,
  requestId: string,
  token: string
): boolean {
  const expected = signToken(secret, requestId)
  if (expected.length !== token.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ token.charCodeAt(i)
  }
  return diff === 0
}

export class NonceStore {
  private readonly entries = new Map<string, Pending>()
  private readonly ttlMs: number

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs
    setInterval(() => this.gc(), Math.min(ttlMs, 60_000)).unref()
  }

  register(id: string, pending: Pending): void {
    this.entries.set(id, pending)
  }

  consume(id: string): Pending | null {
    const p = this.entries.get(id)
    if (!p) return null
    this.entries.delete(id)
    if (Date.now() - p.createdAt > this.ttlMs) return null
    return p
  }

  peek(id: string): Pending | null {
    const p = this.entries.get(id)
    if (!p) return null
    if (Date.now() - p.createdAt > this.ttlMs) return null
    return p
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  list(): Array<[string, Pending]> {
    const now = Date.now()
    const out: Array<[string, Pending]> = []
    for (const [id, p] of this.entries) {
      if (now - p.createdAt <= this.ttlMs) {
        out.push([id, p])
      }
    }
    return out
  }

  private gc(): void {
    const now = Date.now()
    for (const [id, p] of this.entries) {
      if (now - p.createdAt > this.ttlMs) {
        this.entries.delete(id)
        p.reject(new Error("nonce expired before decision"))
      }
    }
  }
}

export function isDecision(value: unknown): value is Decision {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  if (typeof v.requestId !== "string") return false
  if (v.status !== "allow" && v.status !== "deny") return false
  if (v.scope !== "once" && v.scope !== "always") return false
  if (typeof v.receivedAt !== "number") return false
  if (v.command !== undefined && typeof v.command !== "string") return false
  if (v.command !== undefined && (v.command as string).length > 8192) return false
  if (v.agentHint !== undefined && typeof v.agentHint !== "string") return false
  if (v.agentHint !== undefined && (v.agentHint as string).length > 4096)
    return false
  if (v.patterns !== undefined) {
    if (!Array.isArray(v.patterns)) return false
    if (!v.patterns.every((p) => typeof p === "string" && p.length <= 512))
      return false
  }
  return true
}