import type { IngestBatch, VLMPlatformAdapter } from 'vlm-shared'

export interface TransportResult {
  status: number
  body?: unknown
}

export interface AnalyticsTransport {
  send(url: string, batch: IngestBatch): Promise<TransportResult>
}

/** Minimal fetch shape; vlm-core compiles without the DOM lib. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text(): Promise<string> }>

function parse(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined
  } catch {
    return undefined
  }
}

/** Signed fetch when the adapter has it (DCL), plain fetch otherwise. Network failures report status 0. */
export function createTransport(
  adapter: { signedRequest?: VLMPlatformAdapter['signedRequest'] },
  fetchImpl: FetchLike | undefined = (globalThis as { fetch?: FetchLike }).fetch,
): AnalyticsTransport {
  return {
    async send(url, batch) {
      const body = JSON.stringify(batch)
      try {
        if (adapter.signedRequest) {
          const res = await adapter.signedRequest(url, { method: 'POST', body })
          return { status: res.status, body: parse(res.body) }
        }
        if (!fetchImpl) return { status: 0 }
        const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
        return { status: res.status, body: parse(await res.text()) }
      } catch {
        return { status: 0 }
      }
    },
  }
}
