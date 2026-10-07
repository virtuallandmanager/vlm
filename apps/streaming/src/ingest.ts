/**
 * Publish lifecycle: a publish is transcoded and reported live only after the VLM API authorizes
 * its key (fail closed). Node-Media-Server emits prePublish synchronously, so a rejected publisher
 * is dropped via `reject` once the check answers.
 */
export interface IngestDeps {
  authorize(streamKey: string): Promise<boolean>
  notify(streamKey: string, status: 'live' | 'offline'): Promise<void>
  startTranscode(streamKey: string, streamPath: string): void
  stopTranscode(streamKey: string): void
  reject(sessionId: string): void
  removeOutput(streamKey: string): void
  /** HLS output is deleted this long after a stream ends (default 60 s). */
  cleanupDelayMs?: number
  /** Concurrent transcodes this machine accepts (default 4). */
  maxStreams?: number
}

export function keyFromPath(streamPath: string): string {
  const k = streamPath.split('/').pop() ?? ''
  return /^[A-Za-z0-9_-]{1,128}$/.test(k) ? k : ''
}

export function createIngest(deps: IngestDeps) {
  const sessions = new Map<string, { streamKey: string; authorized: boolean; closed: boolean }>()
  const cleanups = new Map<string, ReturnType<typeof setTimeout>>()
  const live = new Set<string>()
  const maxStreams = deps.maxStreams ?? 4

  async function onPrePublish(sessionId: string, streamPath: string): Promise<void> {
    const streamKey = keyFromPath(streamPath)
    if (!streamKey) {
      deps.reject(sessionId)
      return
    }
    const s = { streamKey, authorized: false, closed: false }
    sessions.set(sessionId, s)
    let ok = false
    try {
      ok = await deps.authorize(streamKey)
    } catch {
      ok = false
    }
    if (s.closed) return // the publisher left while we checked
    if (!ok || live.has(streamKey) || live.size >= maxStreams) {
      sessions.delete(sessionId)
      deps.reject(sessionId)
      return
    }
    s.authorized = true
    const pending = cleanups.get(streamKey)
    if (pending) {
      clearTimeout(pending)
      cleanups.delete(streamKey)
    }
    live.add(streamKey)
    deps.startTranscode(streamKey, streamPath)
    await deps.notify(streamKey, 'live').catch(() => {})
  }

  async function onDonePublish(sessionId: string): Promise<void> {
    const s = sessions.get(sessionId)
    if (!s) return
    sessions.delete(sessionId)
    s.closed = true
    if (!s.authorized) return
    live.delete(s.streamKey)
    deps.stopTranscode(s.streamKey)
    const timer = setTimeout(() => {
      cleanups.delete(s.streamKey)
      if (!live.has(s.streamKey)) deps.removeOutput(s.streamKey)
    }, deps.cleanupDelayMs ?? 60_000)
    cleanups.set(s.streamKey, timer)
    await deps.notify(s.streamKey, 'offline').catch(() => {})
  }

  return { onPrePublish, onDonePublish, isLive: (k: string) => live.has(k), liveCount: () => live.size }
}
