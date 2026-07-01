import type { PublishInput } from "./types.js"

function escapeHeaderValue(s: string): string {
  return s.replace(/[\r\n]/g, " ").replace(/[\u0080-\uFFFF]/g, (c) => {
    const bytes = new TextEncoder().encode(c)
    let b64 = ""
    for (const b of bytes) b64 += String.fromCharCode(b)
    return `=?UTF-8?B?${btoa(b64)}?=`
  })
}

export async function publishAsk(input: PublishInput): Promise<void> {
  const auth = Buffer.from(`${input.user}:${input.password}`).toString("base64")
  const url = `${input.baseUrl.replace(/\/$/, "")}/${encodeURIComponent(
    input.topic
  )}`

  const action = `view, Open decision, ${input.reviewUrl}, clear=true`

  const headers: Record<string, string> = {
    Authorization: `Basic ${auth}`,
    Title: escapeHeaderValue(input.title),
    Priority: String(input.priority ?? 4),
    Click: input.reviewUrl,
    Actions: action,
  }
  if (input.tags && input.tags.length > 0) {
    headers.Tags = input.tags.map((t) => t.replace(/,/g, " ")).join(",")
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: input.body,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(
      `ntfy publish failed: ${res.status} ${res.statusText} ${text}`.trim()
    )
  }
}