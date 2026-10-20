/**
 * The hosted-worlds sweep: ends temporary worlds at their end date, purges ended worlds after the retention window,
 * and fails worlds stuck in provisioning. Every transition is a conditional UPDATE … RETURNING, so concurrent sweeps
 * (or servers) claim each world once.
 */

import { and, eq, isNull, lte, or, sql } from 'drizzle-orm'
import { HOSTED_WORLD_RETENTION_DAYS } from 'vlm-shared'
import { db } from '../db/connection.js'
import { hyperfyWorlds } from '../db/schema.js'
import { cleanUp, destroyHostedWorld, withDeps, type HostingDeps } from './hosting.js'

export type SweepDeps = HostingDeps

export const SWEEP_INTERVAL_MS = 5 * 60_000
/** The health wait is 180 s; a create still `provisioning` after this has been lost (e.g. the server restarted). */
const STUCK_AFTER_MS = 10 * 60_000
const DAY_MS = 24 * 60 * 60_000

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export async function sweepHostedWorlds(now: Date, deps?: Partial<SweepDeps>): Promise<{ ended: number; purged: number; stuck: number }> {
  const d = withDeps(deps)
  const ended = await endDueWorlds(now, d)
  const purged = await purgeEndedWorlds(now, d)
  const stuck = await failStuckWorlds(now, d)
  return { ended, purged, stuck }
}

async function endDueWorlds(now: Date, d: SweepDeps): Promise<number> {
  const claimed = await db
    .update(hyperfyWorlds)
    .set({ status: 'ended', endedAt: now, purgeAfter: new Date(now.getTime() + HOSTED_WORLD_RETENTION_DAYS * DAY_MS) })
    .where(and(eq(hyperfyWorlds.kind, 'hosted'), eq(hyperfyWorlds.status, 'running'), lte(hyperfyWorlds.endsAt, now)))
    .returning({ id: hyperfyWorlds.id, slug: hyperfyWorlds.slug, flyApp: hyperfyWorlds.flyApp })
  for (const w of claimed) {
    try {
      if (!w.flyApp) continue
      for (const m of await d.fly.listMachines(w.flyApp)) await d.fly.stopMachine(w.flyApp, m.id)
      d.log.info({ worldId: w.id, slug: w.slug }, 'hosted world ended')
    } catch (err) {
      // The world is ended either way; a machine left running wakes only on traffic and is removed at purge.
      d.log.error({ worldId: w.id, slug: w.slug, app: w.flyApp, error: errText(err) }, 'hosted world ended but its machines did not stop')
    }
  }
  return claimed.length
}

async function purgeEndedWorlds(now: Date, d: SweepDeps): Promise<number> {
  const retryBefore = new Date(now.getTime() - SWEEP_INTERVAL_MS)
  const due = await db
    .select({ id: hyperfyWorlds.id, purgedAt: hyperfyWorlds.purgedAt })
    .from(hyperfyWorlds)
    .where(
      and(
        eq(hyperfyWorlds.kind, 'hosted'),
        eq(hyperfyWorlds.status, 'ended'),
        lte(hyperfyWorlds.purgeAfter, now),
        // A set purgedAt on a row that still exists is a destroy that failed; retry it once it is a sweep old.
        or(isNull(hyperfyWorlds.purgedAt), lte(hyperfyWorlds.purgedAt, retryBefore)),
      ),
    )
  let purged = 0
  for (const w of due) {
    const [won] = await db
      .update(hyperfyWorlds)
      .set({ purgedAt: now })
      .where(
        and(
          eq(hyperfyWorlds.id, w.id),
          eq(hyperfyWorlds.status, 'ended'),
          w.purgedAt ? eq(hyperfyWorlds.purgedAt, w.purgedAt) : isNull(hyperfyWorlds.purgedAt),
        ),
      )
      .returning({ id: hyperfyWorlds.id })
    if (!won) continue
    try {
      await destroyHostedWorld(w.id, d)
      purged++
    } catch (err) {
      d.log.error({ worldId: w.id, error: errText(err) }, 'hosted world purge failed; will retry')
    }
  }
  return purged
}

async function failStuckWorlds(now: Date, d: SweepDeps): Promise<number> {
  const claimed = await db
    .update(hyperfyWorlds)
    .set({ status: 'failed', errorMessage: "Setup didn't finish in time" })
    .where(
      and(
        eq(hyperfyWorlds.kind, 'hosted'),
        eq(hyperfyWorlds.status, 'provisioning'),
        lte(hyperfyWorlds.createdAt, new Date(now.getTime() - STUCK_AFTER_MS)),
      ),
    )
    .returning()
  for (const w of claimed) {
    d.log.error({ worldId: w.id, slug: w.slug }, 'hosted world stuck in provisioning; marked failed')
    // We can't know how far the create got, so remove whatever may exist (each step is safe to repeat).
    await cleanUp(w, d, { database: true, app: true, files: true })
  }
  return claimed.length
}

export function startHostedWorldSweep(intervalMs: number): () => void {
  if (intervalMs <= 0) return () => {}
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      await sweepHostedWorlds(new Date())
    } catch (err) {
      console.error('[vlm-server] Hosted world sweep failed:', errText(err))
    } finally {
      running = false
    }
  }, intervalMs)
  return () => clearInterval(timer)
}
