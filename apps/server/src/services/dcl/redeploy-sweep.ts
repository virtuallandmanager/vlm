/**
 * Redeploys a World when models were added in-world that it doesn't hold yet.
 *
 * Mode A (`virvi`): the first sweep that sees a pending model stamps `pendingSince`; once a minute has
 * passed (so a burst of additions makes one deploy) Virvi redeploys. Mode B (`sign`): only `pendingSince`
 * is kept, which the HUD and dashboard show as "ready to publish".
 */
import { and, eq, inArray } from 'drizzle-orm'
import { dclBudget } from 'vlm-shared'
import { db } from '../../db/connection.js'
import { dclWorldDestinations, sceneDeployments } from '../../db/schema.js'
import { modelsInScene, pendingModels, type ModelNeed } from './assemble.js'
import {
  DeployerError, liveBaseFor, reconcileStaleDeployments, startVirviDeploy,
  type Destination, type DeployOptions,
} from './world-deployer.js'
import { getWorldsClient } from './worlds-client.js'

export { pendingModels }

/** How long a model waits after it is first seen, so a burst of additions makes one deployment. */
export const BATCH_WINDOW_MS = 60_000

async function setStatus(id: string, status: Destination['status'], statusDetail: string | null) {
  await db.update(dclWorldDestinations).set({ status, statusDetail, updatedAt: new Date() }).where(eq(dclWorldDestinations.id, id))
}

/** A plain sentence when the pending models don't fit the World's budget, else null. Triangles first (no network). */
function triangleProblem(dest: Destination, all: ModelNeed[]): string | null {
  const total = all.reduce((n, m) => n + (m.triangles ?? 0), 0)
  const limit = dclBudget(dest.parcels.length).triangles
  if (total <= limit) return null
  const unknown = all.filter((m) => m.triangles == null).length
  const note = unknown > 0 ? ` ${unknown} model${unknown === 1 ? ' has' : 's have'} no triangle count yet and counted as 0.` : ''
  return `Your scene would have ${total.toLocaleString('en-US')} triangles, over the ${limit.toLocaleString('en-US')} your ${dest.parcels.length} parcel${dest.parcels.length === 1 ? '' : 's'} allow. Remove some models to publish.${note}`
}

async function storageProblem(dest: Destination, pending: ModelNeed[]): Promise<string | null> {
  const bytes = pending.reduce((n, m) => n + (m.bytes ?? 0), 0)
  if (bytes === 0) return null
  let stats: { maxAllowedBytes: number; usedBytes: number } | null
  try {
    stats = await getWorldsClient().getWalletStats(dest.ownerWallet)
  } catch {
    return null // can't tell: let the deploy try, Decentraland will say if it's full
  }
  if (!stats || bytes <= stats.maxAllowedBytes - stats.usedBytes) return null
  const mb = (n: number) => (n / 1_000_000).toFixed(1)
  return `The new models need ${mb(bytes)} MB of World storage but only ${mb(Math.max(0, stats.maxAllowedBytes - stats.usedBytes))} MB is left.`
}

/** One pass over every destination. `marked` counts destinations that newly became pending. */
export async function sweepRedeploys(now: Date = new Date(), opts: DeployOptions = {}): Promise<{ started: number; marked: number }> {
  await reconcileStaleDeployments(now)
  let started = 0
  let marked = 0
  for (const dest of await db.select().from(dclWorldDestinations)) {
    try {
      const pending = await pendingModels(dest)
      if (pending.length === 0) {
        if (dest.pendingSince || dest.status === 'over_budget') {
          await db.update(dclWorldDestinations)
            .set({ pendingSince: null, ...(dest.status === 'over_budget' ? { status: 'ok' as const, statusDetail: null } : {}), updatedAt: new Date() })
            .where(eq(dclWorldDestinations.id, dest.id))
        }
        continue
      }
      let since = dest.pendingSince
      if (!since) {
        since = now
        marked++
        await db.update(dclWorldDestinations).set({ pendingSince: now, updatedAt: new Date() }).where(eq(dclWorldDestinations.id, dest.id))
      }
      if (dest.mode !== 'virvi' || !dest.grantedAt || !['ok', 'unreachable', 'over_budget'].includes(dest.status)) continue
      if (now.getTime() - since.getTime() < BATCH_WINDOW_MS) continue
      const busy = await db.query.sceneDeployments.findFirst({
        where: and(eq(sceneDeployments.destinationId, dest.id), inArray(sceneDeployments.status, ['building', 'deploying'])),
        columns: { id: true },
      })
      if (busy) continue

      const problem = triangleProblem(dest, await modelsInScene(dest.sceneId))
      if (problem) {
        if (dest.statusDetail !== problem || dest.status !== 'over_budget') await setStatus(dest.id, 'over_budget', problem)
        continue
      }
      try {
        await liveBaseFor(dest) // sets needs_review / unreachable itself and throws
      } catch (err) {
        if (err instanceof DeployerError) continue
        throw err
      }
      const bytesProblem = await storageProblem(dest, pending)
      if (bytesProblem) {
        if (dest.statusDetail !== bytesProblem || dest.status !== 'over_budget') await setStatus(dest.id, 'over_budget', bytesProblem)
        continue
      }
      if (dest.status === 'over_budget') await setStatus(dest.id, 'ok', null)
      await startVirviDeploy(dest.id, null, opts)
      started++
    } catch (err) {
      console.error('[redeploy-sweep] destination failed:', dest.id, err instanceof Error ? err.message : err)
    }
  }
  return { started, marked }
}

export function startDclRedeploySweep(ms: number): () => void {
  if (ms <= 0) return () => {}
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      await sweepRedeploys()
    } catch (err) {
      console.error('[vlm-server] Redeploy sweep failed:', err)
    } finally {
      running = false
    }
  }, ms)
  return () => clearInterval(timer)
}
