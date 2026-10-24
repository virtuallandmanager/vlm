import type { FastifyReply, FastifyRequest } from 'fastify'
import { onSceneTouched } from '../realtime/bus.js'

export type LongPollRead = () => Promise<{ version: string; body: unknown } | null>

/**
 * Answers a feed request: at once without `since` or when `since` is stale, otherwise holds up to
 * `holdMs` and answers as soon as the version changes (a scene touch wakes it) or the hold expires.
 * `read` returns null when there is nothing to serve; that answers 404 with `notFoundError`.
 * Return the result from the route handler.
 */
export async function longPoll(
  request: FastifyRequest,
  reply: FastifyReply,
  sceneId: string,
  since: string | undefined,
  holdMs: number,
  read: LongPollRead,
  notFoundError = 'scene_not_found',
) {
  const answer = async (): Promise<{ done: boolean; body?: unknown }> => {
    const snap = await read()
    if (!snap) return { done: true }
    return { done: !since || snap.version !== since, body: snap.body }
  }
  const send = (r: { body?: unknown }) => (r.body ? reply.send(r.body) : reply.status(404).send({ error: notFoundError }))
  if (!since) return send(await answer())

  // Listen for the client leaving first, then subscribe before the first read, so a touch landing after
  // that read can't be missed.
  let closed = false
  let onClose = () => {
    closed = true
  }
  const closeListener = () => onClose()
  request.raw.on('close', closeListener)
  let onTouch = () => {}
  let unsubscribe: () => Promise<void>
  try {
    unsubscribe = await onSceneTouched(sceneId, () => onTouch())
  } catch (err) {
    request.raw.off('close', closeListener)
    request.log.error(err)
    return reply.status(500).send({ error: 'feed_failed' })
  }
  let touched = false
  onTouch = () => {
    touched = true
  }
  const release = () => {
    request.raw.off('close', closeListener)
    void unsubscribe()
  }

  let first: Awaited<ReturnType<typeof answer>>
  try {
    first = await answer()
  } catch (err) {
    release()
    throw err
  }
  if (first.done || closed) {
    release()
    return closed ? undefined : send(first)
  }

  // Hold. Resolves once, whichever of touch / timeout / client close comes first.
  return new Promise<void>((resolve) => {
    let finished = false
    let checking = false
    let again = false
    const finish = (fn: () => unknown) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      release()
      Promise.resolve(fn()).finally(resolve)
    }
    const check = async () => {
      // Serialize re-reads; a touch that lands mid-read triggers one more read afterwards.
      if (checking) { again = true; return }
      checking = true
      try {
        do {
          again = false
          const r = await answer()
          if (r.done) return finish(() => send(r))
        } while (again && !finished)
      } catch (err) {
        request.log.error(err)
        finish(() => reply.status(500).send({ error: 'feed_failed' }))
      } finally {
        checking = false
      }
    }
    const timer = setTimeout(() => {
      // Hold expired: answer with the current state (same version unless a touch was missed).
      finish(async () => {
        const r = await answer().catch(() => null)
        if (r) return send(r)
        return reply.status(500).send({ error: 'feed_failed' })
      })
    }, holdMs)
    onTouch = () => void check()
    onClose = () => finish(() => undefined)
    // A touch during the first read may have come after it read the scene: read once more.
    if (touched) void check()
  })
}
