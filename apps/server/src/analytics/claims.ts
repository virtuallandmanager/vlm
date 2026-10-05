import { and, eq, isNotNull, lt, or, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsScenes, analyticsSessions, scenePresets, scenes, userAuthMethods, walletChallenges } from '../db/schema.js'
import { config } from '../config.js'
import { getSubscription } from '../integrations/stripe.js'
import { DirectoryUnavailableError, getDclDirectory, type DclDirectory } from './dcl-directory.js'
import type { AnalyticsSceneRow } from './registry.js'

export async function verifiedWalletsOf(userId: string): Promise<string[]> {
  const rows = await db.query.userAuthMethods.findMany({
    where: and(eq(userAuthMethods.userId, userId), eq(userAuthMethods.type, 'wallet'), sql`${userAuthMethods.metadata}->>'verified' = 'true'`),
  })
  return rows.map((r) => r.identifier).filter((id) => /^0x[0-9a-f]{40}$/.test(id))
}

/** Does this wallet control the scene's location? Throws DirectoryUnavailableError if Decentraland can't answer. */
export async function controls(scene: AnalyticsSceneRow, wallet: string, dir: DclDirectory = getDclDirectory()): Promise<boolean> {
  const w = wallet.toLowerCase()
  if (scene.kind === 'preview') return scene.locationKey.startsWith(`preview:${w}:`)
  if (scene.kind === 'world') {
    if ((await dir.getWorldOwner(scene.worldName!)) === w) return true
    return (await dir.getWorldDeployers(scene.worldName!)).includes(w)
  }
  const parcels = scene.parcels.length ? scene.parcels : scene.baseParcel ? [scene.baseParcel] : []
  if (!parcels.length) return false
  let viaRights = true
  for (const p of parcels) {
    const r = await dir.getParcelRights(p)
    const ok = !!r && [r.owner, r.operator, r.updateOperator, ...r.updateManagers, ...r.approvedForAll].includes(w)
    if (!ok) {
      viaRights = false
      break
    }
  }
  if (viaRights) return true
  for (const p of parcels) if ((await dir.getActiveDeployer(p)) !== w) return false
  return true
}

export async function controlsAny(scene: AnalyticsSceneRow, wallets: string[], dir: DclDirectory = getDclDirectory()): Promise<boolean> {
  for (const w of wallets) if (await controls(scene, w, dir)) return true
  return false
}

export class ClaimError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export async function claimScene(
  userId: string,
  locationKey: string,
  vlmSceneId?: string,
): Promise<{ scene: AnalyticsSceneRow; linked: boolean }> {
  const scene = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, locationKey) })
  if (!scene) throw new ClaimError(404, 'No analytics have been recorded at that location yet')
  if (scene.claimStatus === 'active' && scene.claimedByUserId && scene.claimedByUserId !== userId) {
    throw new ClaimError(409, 'This scene has already been claimed')
  }
  const wallets = await verifiedWalletsOf(userId)
  if (!wallets.length) throw new ClaimError(403, 'Sign in with the wallet that controls this LAND or World first')
  let ok: boolean
  try {
    ok = await controlsAny(scene, wallets)
  } catch (err) {
    if (err instanceof DirectoryUnavailableError) throw new ClaimError(503, 'Decentraland is not responding; try again shortly')
    throw err
  }
  if (!ok) throw new ClaimError(403, 'None of your verified wallets control this location')

  let linkTo = vlmSceneId ?? scene.vlmSceneId ?? null
  if (linkTo) {
    const owned = await db.query.scenes.findFirst({ where: and(eq(scenes.id, linkTo), eq(scenes.ownerId, userId)) })
    if (!owned) linkTo = null
  }
  let mayCreate = false
  if (!linkTo) {
    mayCreate = true
    if (!config.allFeaturesUnlocked) {
      const sub = await getSubscription(userId)
      const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(scenes).where(eq(scenes.ownerId, userId))
      if (count >= sub.limits.scenes) mayCreate = false
    }
  }

  return db.transaction(async (tx) => {
    if (!linkTo && mayCreate) {
      const [created] = await tx.insert(scenes).values({ ownerId: userId, name: scene.title || scene.locationKey }).returning()
      const [preset] = await tx.insert(scenePresets).values({ sceneId: created.id, name: 'Default' }).returning()
      await tx.update(scenes).set({ activePresetId: preset.id }).where(eq(scenes.id, created.id))
      linkTo = created.id
    }
    const [updated] = await tx
      .update(analyticsScenes)
      .set({ claimedByUserId: userId, claimStatus: 'active', claimedAt: new Date(), lapsedAt: null, vlmSceneId: linkTo, updatedAt: new Date() })
      .where(
        and(
          eq(analyticsScenes.id, scene.id),
          or(sql`${analyticsScenes.claimStatus} IS DISTINCT FROM 'active'`, eq(analyticsScenes.claimedByUserId, userId)),
        ),
      )
      .returning()
    if (!updated) throw new ClaimError(409, 'This scene has already been claimed') // rolls back any scene created above
    return { scene: updated, linked: !!linkTo }
  })
}

/** Delete expired wallet sign-in challenges. */
export async function purgeWalletChallenges(now = new Date()): Promise<number> {
  const rows = await db.delete(walletChallenges).where(lt(walletChallenges.expiresAt, now)).returning({ nonce: walletChallenges.nonce })
  return rows.length
}

export async function reverifyClaims(now = new Date()): Promise<{ checked: number; lapsed: number }> {
  const claimed = await db.select().from(analyticsScenes).where(and(eq(analyticsScenes.claimStatus, 'active'), isNotNull(analyticsScenes.claimedByUserId)))
  let lapsed = 0
  for (const scene of claimed) {
    try {
      const ok = await controlsAny(scene, await verifiedWalletsOf(scene.claimedByUserId!))
      if (!ok) {
        // A lapsed claim also stops revealing identities: visibility off, revealed wallets/names cleared.
        await db.transaction(async (tx) => {
          await tx
            .update(analyticsScenes)
            .set({ claimStatus: 'lapsed', lapsedAt: now, walletVisibility: false, updatedAt: now })
            .where(eq(analyticsScenes.id, scene.id))
          await tx.update(analyticsSessions).set({ wallet: null, displayName: null }).where(eq(analyticsSessions.sceneId, scene.id))
        })
        lapsed++
      }
    } catch (err) {
      if (!(err instanceof DirectoryUnavailableError)) console.error(`[vlm-server] claim re-verify failed for ${scene.id}`, err)
    }
  }
  return { checked: claimed.length, lapsed }
}
