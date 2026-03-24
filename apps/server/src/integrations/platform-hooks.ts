/**
 * Platform Hooks — HTTP push dispatch for non-WebSocket platforms.
 *
 * When scene data changes via the Colyseus room, this module pushes updates
 * to all registered callback URLs for the affected scene. Designed primarily
 * for Second Life (LSL scripts), but platform-agnostic.
 *
 * Callbacks that fail 3 times consecutively are removed.
 * Callbacks that haven't re-registered in 5 minutes are cleaned up.
 */

import { eq, lt, and } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { platformCallbacks } from '../db/schema.js'

/**
 * Dispatch a payload to all registered callbacks for a scene.
 * Fire-and-forget with a short timeout — does not block the caller.
 */
export async function dispatchPlatformCallbacks(
  sceneId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  let callbacks: (typeof platformCallbacks.$inferSelect)[]
  try {
    callbacks = await db
      .select()
      .from(platformCallbacks)
      .where(eq(platformCallbacks.sceneId, sceneId))
  } catch (err) {
    console.error('[platform-hooks] Error querying callbacks:', err)
    return
  }

  if (callbacks.length === 0) return

  const body = JSON.stringify(payload)

  await Promise.allSettled(
    callbacks.map(async (cb) => {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)

        const res = await fetch(cb.callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        })

        clearTimeout(timeout)

        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        // Reset failure count on success
        if (cb.failureCount > 0) {
          await db
            .update(platformCallbacks)
            .set({ failureCount: 0 })
            .where(eq(platformCallbacks.id, cb.id))
        }
      } catch {
        const newCount = (cb.failureCount || 0) + 1
        if (newCount >= 3) {
          // Remove stale callback after 3 consecutive failures
          await db
            .delete(platformCallbacks)
            .where(eq(platformCallbacks.id, cb.id))
          console.log(
            `[platform-hooks] Removed callback ${cb.id} after ${newCount} failures (${cb.platform} → ${cb.callbackUrl})`,
          )
        } else {
          await db
            .update(platformCallbacks)
            .set({ failureCount: newCount })
            .where(eq(platformCallbacks.id, cb.id))
        }
      }
    }),
  )
}

/**
 * Remove callbacks that haven't re-registered within the last 5 minutes.
 * Called by the cleanup cron.
 */
export async function cleanupStaleCallbacks(): Promise<number> {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000)
  const result = await db
    .delete(platformCallbacks)
    .where(lt(platformCallbacks.lastRegistered, cutoff))
    .returning({ id: platformCallbacks.id })
  return result.length
}

/**
 * Send a keepalive ping to all registered callbacks.
 * Also prunes any that fail.
 */
export async function pingAllCallbacks(): Promise<void> {
  let callbacks: (typeof platformCallbacks.$inferSelect)[]
  try {
    callbacks = await db.select().from(platformCallbacks)
  } catch {
    return
  }

  if (callbacks.length === 0) return

  const body = JSON.stringify({ action: 'ping' })

  await Promise.allSettled(
    callbacks.map(async (cb) => {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)

        const res = await fetch(cb.callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        })

        clearTimeout(timeout)

        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      } catch {
        const newCount = (cb.failureCount || 0) + 1
        if (newCount >= 3) {
          await db
            .delete(platformCallbacks)
            .where(eq(platformCallbacks.id, cb.id))
        } else {
          await db
            .update(platformCallbacks)
            .set({ failureCount: newCount })
            .where(eq(platformCallbacks.id, cb.id))
        }
      }
    }),
  )
}

/**
 * Start periodic cron jobs for callback maintenance.
 * Returns a cleanup function to stop the timers.
 */
export function startHookCrons(): () => void {
  // Cleanup stale callbacks every 60 seconds
  const cleanupInterval = setInterval(async () => {
    try {
      const removed = await cleanupStaleCallbacks()
      if (removed > 0) {
        console.log(`[platform-hooks] Cleaned up ${removed} stale callback(s)`)
      }
    } catch (err) {
      console.error('[platform-hooks] Cleanup cron error:', err)
    }
  }, 60_000)

  // Keepalive ping every 60 seconds
  const pingInterval = setInterval(async () => {
    try {
      await pingAllCallbacks()
    } catch (err) {
      console.error('[platform-hooks] Ping cron error:', err)
    }
  }, 60_000)

  return () => {
    clearInterval(cleanupInterval)
    clearInterval(pingInterval)
  }
}
