/**
 * Publish lifecycle: a publish is transcoded only after the Virvi API authorizes its key (fail closed),
 * and reported live only once its HLS playlist exists (screens switch immediately on "live", so they
 * must find something to play). Node-Media-Server emits prePublish synchronously, so a rejected
 * publisher is dropped via `reject` once the check answers.
 *
 * HLS output lives under the stream's public playback id, never its (secret) stream key.
 */
export interface IngestDeps {
  /** The stream's playback id when the key may publish, else null. May throw (treated as null). */
  authorize(streamKey: string): Promise<string | null>
  notify(streamKey: string, status: 'live' | 'offline'): Promise<void>
  startTranscode(streamKey: string, streamPath: string, playbackId: string): void
  stopTranscode(streamKey: string): void
  /** Resolves true once the playback id's playlist exists (false after a timeout). */
  waitForPlaylist(playbackId: string): Promise<boolean>
  reject(sessionId: string): void
  removeOutput(playbackId: string): void
  /** HLS output is deleted this long after a stream ends (default 60 s). */
  cleanupDelayMs?: number
  /** Concurrent transcodes this machine accepts (default 4). */
  maxStreams?: number
}

export function keyFromPath(streamPath: string): string {
  const k = streamPath.split('/').pop() ?? ''
  return /^[A-Za-z0-9_-]{1,128}$/.test(k) ? k : ''
}

interface Session {
  streamKey: string
  playbackId: string | null
  transcoding: boolean
  announced: boolean
  closed: boolean
}

export function createIngest(deps: IngestDeps) {
  const sessions = new Map<string, Session>()
  const cleanups = new Map<string, ReturnType<typeof setTimeout>>() // by playback id
  const live = new Set<string>() // stream keys with a running transcode
  const notifyChains = new Map<string, Promise<void>>() // per stream key, so offline never overtakes live
  const maxStreams = deps.maxStreams ?? 4

  const notify = (streamKey: string, status: 'live' | 'offline'): Promise<void> => {
    const next = (notifyChains.get(streamKey) ?? Promise.resolve()).then(() => deps.notify(streamKey, status).catch(() => {}))
    notifyChains.set(streamKey, next)
    void next.then(() => {
      if (notifyChains.get(streamKey) === next) notifyChains.delete(streamKey)
    })
    return next
  }

  const stop = (s: Session) => {
    live.delete(s.streamKey)
    deps.stopTranscode(s.streamKey)
    s.transcoding = false
  }

  async function onPrePublish(sessionId: string, streamPath: string): Promise<void> {
    const streamKey = keyFromPath(streamPath)
    if (!streamKey) {
      deps.reject(sessionId)
      return
    }
    const s: Session = { streamKey, playbackId: null, transcoding: false, announced: false, closed: false }
    sessions.set(sessionId, s)
    let playbackId: string | null = null
    try {
      playbackId = await deps.authorize(streamKey)
    } catch {
      playbackId = null
    }
    if (s.closed) return // the publisher left while we checked
    if (!playbackId || live.has(streamKey) || live.size >= maxStreams) {
      sessions.delete(sessionId)
      deps.reject(sessionId)
      return
    }
    s.playbackId = playbackId
    const pending = cleanups.get(playbackId)
    if (pending) {
      clearTimeout(pending)
      cleanups.delete(playbackId)
    }
    // Start from an empty folder: a re-publish must not append to the previous stream's playlist
    deps.removeOutput(playbackId)
    live.add(streamKey)
    s.transcoding = true
    deps.startTranscode(streamKey, streamPath, playbackId)

    const ready = await deps.waitForPlaylist(playbackId)
    if (s.closed) return // onDonePublish already stopped it; it was never announced
    if (!ready) {
      stop(s)
      sessions.delete(sessionId)
      deps.reject(sessionId)
      deps.removeOutput(playbackId)
      return
    }
    s.announced = true
    await notify(streamKey, 'live')
  }

  async function onDonePublish(sessionId: string): Promise<void> {
    const s = sessions.get(sessionId)
    if (!s) return
    sessions.delete(sessionId)
    s.closed = true
    if (!s.transcoding || !s.playbackId) return
    stop(s)
    const playbackId = s.playbackId
    const timer = setTimeout(() => {
      cleanups.delete(playbackId)
      if (!live.has(s.streamKey)) deps.removeOutput(playbackId)
    }, deps.cleanupDelayMs ?? 60_000)
    cleanups.set(playbackId, timer)
    if (s.announced) await notify(s.streamKey, 'offline')
  }

  return { onPrePublish, onDonePublish, isLive: (k: string) => live.has(k), liveCount: () => live.size }
}
