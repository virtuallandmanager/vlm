import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioDesigns, studioJobs } from '../db/schema.js'
import { destroyWorker, ensureWorker, type MachineDeps } from './machines.js'
import { failJobs } from './results.js'

/**
 * The Design Studio sweep: fails jobs that will never get a result (refunding counted prompts), restarts machines for
 * jobs left waiting, and destroys machines idle for days. Every transition is conditional, so concurrent sweeps on
 * several servers fail each job once.
 */

export const STUDIO_SWEEP_MS = 60_000
const GRACE_SEC = 15 * 60 // after a job's own time limit
const RENDER_TIMEOUT_SEC = 300
const QUEUED_LOST_MS = 10 * 60_000
const QUEUED_RESTART_MS = 60_000 // a worker can exit idle just as a job is queued
const IDLE_MACHINE_MS = 3 * 24 * 3600_000

export const MACHINE_STOPPED = 'The studio machine stopped responding.'
export const MACHINE_NEVER_STARTED = 'The studio machine did not start.'

export async function sweepStudio(now: Date, deps: Partial<MachineDeps> = {}): Promise<{ lost: number; destroyed: number }> {
  const taken = await db.select({ id: studioJobs.id }).from(studioJobs).where(and(
    eq(studioJobs.status, 'taken'),
    sql`${studioJobs.takenAt} < ${now.toISOString()}::timestamptz - make_interval(secs => (CASE WHEN ${studioJobs.type} = 'render' THEN ${RENDER_TIMEOUT_SEC}
      ELSE COALESCE((${studioJobs.payload}->'limits'->>'timeoutSec')::int, 1500) END) + ${GRACE_SEC})`,
  ))
  let lost = await failJobs(taken.map((j) => j.id), MACHINE_STOPPED, now)

  // A worker takes one job at a time: a job waiting behind a running one, or one that finished under 10 minutes
  // ago, is not lost. The 10 minutes count from the later of its queuing and the design's last taken or finished job.
  const lostBefore = new Date(now.getTime() - QUEUED_LOST_MS).toISOString()
  const neverTaken = await db.select({ id: studioJobs.id }).from(studioJobs).where(and(
    eq(studioJobs.status, 'queued'),
    sql`${studioJobs.createdAt} < ${lostBefore}::timestamptz`,
    sql`NOT EXISTS (SELECT 1 FROM studio_jobs o WHERE o.design_id = ${studioJobs.designId} AND o.id <> ${studioJobs.id}
      AND (o.status = 'taken' OR o.finished_at >= ${lostBefore}::timestamptz))`,
  ))
  lost += await failJobs(neverTaken.map((j) => j.id), MACHINE_NEVER_STARTED, now)

  const waiting = await db.selectDistinct({ designId: studioJobs.designId }).from(studioJobs)
    .where(and(eq(studioJobs.status, 'queued'), lt(studioJobs.createdAt, new Date(now.getTime() - QUEUED_RESTART_MS))))
  for (const { designId } of waiting) {
    await ensureWorker(designId, deps).catch((err) => console.error('[studio-sweep] restart failed:', err instanceof Error ? err.message : err))
  }

  const idle = await db.select({ id: studioDesigns.id }).from(studioDesigns).where(and(
    isNotNull(studioDesigns.machineId),
    sql`COALESCE(${studioDesigns.lastJobAt}, ${studioDesigns.createdAt}) < ${new Date(now.getTime() - IDLE_MACHINE_MS).toISOString()}::timestamptz`,
    sql`NOT EXISTS (SELECT 1 FROM studio_jobs j WHERE j.design_id = ${studioDesigns.id} AND j.status IN ('queued', 'taken'))`,
  ))
  let destroyed = 0
  for (const { id } of idle) {
    try {
      await destroyWorker(id, deps)
      destroyed++
    } catch (err) {
      console.error('[studio-sweep] destroy failed:', err instanceof Error ? err.message : err)
    }
  }
  return { lost, destroyed }
}

let timer: ReturnType<typeof setInterval> | null = null

export function startStudioSweep(ms = STUDIO_SWEEP_MS): void {
  if (timer) return
  let running = false
  timer = setInterval(() => {
    if (running) return
    running = true
    sweepStudio(new Date())
      .catch((err) => console.error('[studio-sweep] failed:', err))
      .finally(() => { running = false })
  }, ms)
  timer.unref?.()
}
