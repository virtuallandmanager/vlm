import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsScenes, locationSetups, sceneRoles, scenePresets, scenes } from '../db/schema.js'
import { getDclDirectory, type DclDirectory } from '../analytics/dcl-directory.js'
import { verifiedWalletsOf } from '../analytics/claims.js'
import { resolveVerifiedWalletUser } from '../auth/wallet-users.js'
import type { AnalyticsSceneRow } from '../analytics/registry.js'

export type LocationSetupRow = typeof locationSetups.$inferSelect

export class SetupError extends Error {
  constructor(public status: number, public code: string) {
    super(code)
  }
}

export async function getActiveSetup(analyticsSceneId: string): Promise<LocationSetupRow | null> {
  return (await db.query.locationSetups.findFirst({ where: and(eq(locationSetups.analyticsSceneId, analyticsSceneId), isNull(locationSetups.endedAt)) })) ?? null
}

/** Host's verified wallets plus active co-hosts' wallets (lowercased). */
export async function teamWallets(vlmSceneId: string): Promise<string[]> {
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, vlmSceneId) })
  const host = scene ? await verifiedWalletsOf(scene.ownerId) : []
  const co = await db
    .select({ w: sceneRoles.walletAddress })
    .from(sceneRoles)
    .where(and(eq(sceneRoles.sceneId, vlmSceneId), eq(sceneRoles.role, 'cohost'), isNull(sceneRoles.revokedAt)))
  return [...new Set([...host, ...co.map((r) => r.w)].map((w) => w.toLowerCase()))]
}

const entityFromUrn = (urn: string | undefined) => urn?.match(/^urn:decentraland:entity:([^?]+)/)?.[1] ?? null

/** What is deployed at the location right now. Worlds don't expose the deployer (null). */
export async function currentDeployment(scene: AnalyticsSceneRow, dir: DclDirectory = getDclDirectory()) {
  if (scene.kind === 'world') {
    const w = await dir.getWorldScene(scene.worldName!)
    return { entityId: entityFromUrn(w?.sceneUrns?.[0]), deployer: null as string | null }
  }
  const base = scene.baseParcel ?? scene.parcels[0]
  if (!base) return { entityId: null, deployer: null }
  const active = await dir.getActiveSceneAt(base)
  if (!active) return { entityId: null, deployer: null }
  return { entityId: active.entityId, deployer: await dir.getActiveDeployer(base) }
}

/**
 * Host is final, but a new deployment by someone outside the host + co-hosts releases the location.
 * Returns the (possibly updated) active setup, or null if it ended. Unknown current deployment = keep.
 */
export async function releaseIfRedeployed(
  setup: LocationSetupRow,
  scene: AnalyticsSceneRow,
  dir: DclDirectory = getDclDirectory(),
  now = new Date(),
): Promise<LocationSetupRow | null> {
  const current = await currentDeployment(scene, dir)
  if (!current.entityId || current.entityId === setup.deploymentEntityId) return setup
  const team = await teamWallets(setup.vlmSceneId)
  if (scene.kind === 'world') {
    // The Worlds API doesn't expose the actual deployer, so keep when any team wallet could have deployed.
    const allowed = new Set([(await dir.getWorldOwner(scene.worldName!)) ?? '', ...(await dir.getWorldDeployers(scene.worldName!))])
    if (!team.some((w) => allowed.has(w))) return release(setup, scene, now)
  } else {
    // Unknown deployer: keep the setup unchanged (entity not recorded) so it is rechecked next time.
    if (!current.deployer) return setup
    if (!team.includes(current.deployer.toLowerCase())) return release(setup, scene, now)
  }
  const [row] = await db
    .update(locationSetups)
    .set({ deploymentEntityId: current.entityId })
    .where(and(eq(locationSetups.id, setup.id), isNull(locationSetups.endedAt)))
    .returning()
  return row ?? null
}

async function release(setup: LocationSetupRow, scene: AnalyticsSceneRow, now: Date): Promise<null> {
  await db.transaction(async (tx) => {
    const ended = await tx
      .update(locationSetups)
      .set({ endedAt: now, endReason: 'redeployed' })
      .where(and(eq(locationSetups.id, setup.id), isNull(locationSetups.endedAt)))
      .returning({ id: locationSetups.id })
    if (!ended.length) return
    await tx
      .update(analyticsScenes)
      .set({ vlmSceneId: null, updatedAt: now })
      .where(and(eq(analyticsScenes.id, scene.id), eq(analyticsScenes.vlmSceneId, setup.vlmSceneId)))
  })
  return null
}

/** Create (or reuse) the wallet's user, a VLM scene with a default preset, and the active setup. Free: no plan limits. */
export async function setUpLocation(scene: AnalyticsSceneRow, wallet: string, now = new Date()) {
  const w = wallet.toLowerCase()
  if (await getActiveSetup(scene.id)) throw new SetupError(409, 'already_set_up')
  const user = await resolveVerifiedWalletUser(w, `${w.slice(0, 6)}…${w.slice(-4)}`)
  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx.insert(scenes).values({ ownerId: user.id, name: scene.title || scene.locationKey }).returning()
      const [preset] = await tx.insert(scenePresets).values({ sceneId: created.id, name: 'Default' }).returning()
      await tx.update(scenes).set({ activePresetId: preset.id }).where(eq(scenes.id, created.id))
      const [setup] = await tx
        .insert(locationSetups)
        .values({ analyticsSceneId: scene.id, vlmSceneId: created.id, hostUserId: user.id, deploymentEntityId: scene.activeEntityId ?? null, startedAt: now })
        .returning()
      await tx.update(analyticsScenes).set({ vlmSceneId: created.id, updatedAt: now }).where(eq(analyticsScenes.id, scene.id))
      return { setup, vlmSceneId: created.id, userId: user.id }
    })
  } catch (err) {
    // The partial unique index (one active setup per location) loses the race for the second presser.
    const e = err as { code?: string; cause?: { code?: string } }
    if (e.code === '23505' || e.cause?.code === '23505') throw new SetupError(409, 'already_set_up')
    throw err
  }
}
