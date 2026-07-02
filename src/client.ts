import type { AskInput, AskResult } from "./broker.js"
import type { Decision } from "./types.js"

export type BrokerClientOptions = {
  baseUrl: string
  fetch?: typeof globalThis.fetch
}

export type BrokerHealth = {
  ok: boolean
  pid?: number
  port?: number
  baseUrl?: string
  uptimeMs?: number
  whitelistSize?: number
  whitelistSessionCount?: number
}

export class BrokerError extends Error {
  status: number
  body?: string

  constructor(status: number, message: string, body?: string) {
    super(message)
    this.name = "BrokerError"
    this.status = status
    this.body = body
  }
}

export class BrokerClient {
  private baseUrl: string
  private fetch: typeof globalThis.fetch

  constructor(opts: BrokerClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "")
    this.fetch = opts.fetch ?? globalThis.fetch
  }

  async health(): Promise<BrokerHealth> {
    const res = await this.fetch(`${this.baseUrl}/v1/health`)
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new BrokerError(res.status, `broker health failed: ${res.status} ${res.statusText}`.trim(), body)
    }
    return (await res.json()) as BrokerHealth
  }

  async ask(input: AskInput): Promise<AskResult> {
    const res = await this.fetch(`${this.baseUrl}/v1/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new BrokerError(res.status, `broker ask failed: ${res.status} ${res.statusText}`.trim(), body)
    }
    return (await res.json()) as AskResult
  }

  async waitForDecision(
    requestId: string,
    timeoutMs: number
  ): Promise<Decision> {
    const url = new URL(
      `${this.baseUrl}/v1/decision/${encodeURIComponent(requestId)}`
    )
    url.searchParams.set("timeoutMs", String(timeoutMs))
    const res = await this.fetch(url.toString(), {
      // waitForDecision is a long-poll; cap at timeoutMs + 5s buffer
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    })
    if (res.status === 408) {
      throw new Error("broker decision timeout")
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new BrokerError(res.status, `broker decision failed: ${res.status} ${res.statusText}`.trim(), body)
    }
    return (await res.json()) as Decision
  }

  async addWhitelist(
    sessionID: string,
    tool: string,
    pattern: string
  ): Promise<void> {
    const res = await this.fetch(`${this.baseUrl}/v1/whitelist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID, tool, pattern }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new BrokerError(res.status, `broker addWhitelist failed: ${res.status} ${res.statusText}`.trim(), body)
    }
  }

  async forgetSession(sessionID: string): Promise<void> {
    const res = await this.fetch(
      `${this.baseUrl}/v1/whitelist/${encodeURIComponent(sessionID)}`,
      { method: "DELETE" }
    )
    if (res.status === 404) return
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new BrokerError(res.status, `broker forgetSession failed: ${res.status} ${res.statusText}`.trim(), body)
    }
  }

  async getWhitelist(
    sessionID: string
  ): Promise<Record<string, string[]>> {
    const res = await this.fetch(
      `${this.baseUrl}/v1/whitelist/${encodeURIComponent(sessionID)}`
    )
    if (res.status === 404) return {}
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new BrokerError(res.status, `broker getWhitelist failed: ${res.status} ${res.statusText}`.trim(), body)
    }
    return (await res.json()) as Record<string, string[]>
  }

  get url(): string {
    return this.baseUrl
  }
}
