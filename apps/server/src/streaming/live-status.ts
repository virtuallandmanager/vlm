import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { streamingServers } from '../db/schema.js'

/** URLs are compared exactly after trimming (creators paste them). */
export const normalizeUrl = (u: unknown): string => (typeof u === 'string' ? u.trim() : '')

async function liveUrls(): Promise<Set<string>> {
  const rows = await db
    .select({ url: streamingServers.hlsPlaylistUrl })
    .from(streamingServers)
    .where(eq(streamingServers.status, 'live'))
  return new Set(rows.map((r) => normalizeUrl(r.url)).filter(Boolean))
}

const mark = <E extends Record<string, unknown>>(v: E, live: Set<string>): E => {
  const src = normalizeUrl(v.liveSrc)
  return src && live.has(src) ? { ...v, isLive: true } : v
}

/** Serialized preset with `isLive: true` on videos whose liveSrc is a live VLM stream (no query when no video has a liveSrc). */
export async function withLiveStatus<P extends { videos: Record<string, unknown>[] }>(preset: P): Promise<P> {
  if (!preset.videos.some((v) => normalizeUrl(v.liveSrc))) return preset
  const live = await liveUrls()
  return live.size ? { ...preset, videos: preset.videos.map((v) => mark(v, live)) } : preset
}

/** Same for one serialized video element. */
export async function withLiveVideo<E extends Record<string, unknown>>(element: E): Promise<E> {
  if (!normalizeUrl(element.liveSrc)) return element
  return mark(element, await liveUrls())
}
