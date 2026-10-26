import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { streamingServers, scenes, sceneElements } from '../db/schema.js'
import { serializeSingleElement } from '../services/scene-serializer.js'
import { publishSceneTouched } from '../realtime/bus.js'

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
  return src && live.has(src) ? { ...v, isLive: true, liveSrc: src } : v
}

/** Serialized preset with `isLive: true` on videos whose liveSrc is a live Virvi stream (no query when no video has a liveSrc). */
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

/** A stream went live/offline: touch every scene whose active preset has a video playing it. */
export async function touchScenesPlayingStream(playlistUrl: string): Promise<void> {
  try {
    const url = normalizeUrl(playlistUrl)
    if (!url) return
    const videos = await db
      .select({ sceneId: scenes.id, element: sceneElements })
      .from(sceneElements)
      .innerJoin(scenes, eq(scenes.activePresetId, sceneElements.presetId))
      .where(eq(sceneElements.type, 'video'))
    const hit = new Set<string>()
    for (const v of videos) if (normalizeUrl(serializeSingleElement(v.element).liveSrc) === url) hit.add(v.sceneId)
    for (const id of hit) await publishSceneTouched(id)
  } catch (err) {
    console.error('[live-status] scene touch for stream failed:', err)
  }
}
