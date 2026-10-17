import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsScenes } from '../db/schema.js'
import type { SceneRequestContext } from '../middleware/dcl-auth.js'
import { currentDeployment, getActiveSetup, releaseIfRedeployed } from '../setup/setups.js'
import { DirectoryUnavailableError } from '../analytics/dcl-directory.js'
import { isOfficialRealm, isWorldRealm } from './official-realms.js'

export interface SceneBinding { locationId: string | null; sceneId: string | null }
const VISITOR: SceneBinding = { locationId: null, sceneId: null }

const isWorld = isWorldRealm

/** Same keys as vlm-shared locationKeyFor, built only from the signed context. */
export function locationKeyForContext(ctx: SceneRequestContext, wallet: string, preview: boolean): string {
  const place = isWorld(ctx) ? ctx.realm.serverName.toLowerCase() : ctx.parcel
  if (preview) return `preview:${wallet.toLowerCase()}:${place}`
  return isWorld(ctx) ? `world:${place}` : `gc:${place}`
}

/**
 * The VLM scene a signed scene request may act on: the active setup at its location. Anything uncertain → visitor.
 * Outside local preview, only official Decentraland realms bind (the realm controls serverName, parcel and code),
 * and the signed scene entity must be the deployment the setup recorded (or, when it recorded none, the live one).
 */
export async function bindSceneRequest(ctx: SceneRequestContext, wallet: string, opts: { preview?: boolean } = {}): Promise<SceneBinding> {
  if (!opts.preview && !(await isOfficialRealm(ctx))) return VISITOR
  const key = locationKeyForContext(ctx, wallet, !!opts.preview)
  let loc = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, key) })
  if (!loc && !isWorld(ctx) && !opts.preview) {
    loc = await db.query.analyticsScenes.findFirst({
      where: and(eq(analyticsScenes.kind, 'parcels'), sql`${analyticsScenes.parcels} @> ARRAY[${ctx.parcel}]::text[]`),
    })
  }
  if (!loc) return VISITOR
  let setup = await getActiveSetup(loc.id)
  if (!setup) return { locationId: loc.id, sceneId: null }
  if (!opts.preview && !setup.deploymentEntityId) {
    // Nothing recorded: the official directory's live deployment must be the signed entity. Not recorded here,
    // so a redeploy by someone outside the team still releases the setup through releaseIfRedeployed.
    let live: string | null
    try {
      live = (await currentDeployment(loc)).entityId
    } catch (err) {
      if (err instanceof DirectoryUnavailableError) return { locationId: loc.id, sceneId: null }
      throw err
    }
    if (!live || live !== ctx.sceneId) return { locationId: loc.id, sceneId: null }
  } else if (!opts.preview && setup.deploymentEntityId !== ctx.sceneId) {
    try {
      setup = await releaseIfRedeployed(setup, loc)
    } catch (err) {
      if (err instanceof DirectoryUnavailableError) return { locationId: loc.id, sceneId: null }
      throw err
    }
    if (!setup) return { locationId: loc.id, sceneId: null }
    // Still not the recorded deployment (unchanged, unknown deployer, or another entity than the live one) → visitor.
    if (setup.deploymentEntityId && setup.deploymentEntityId !== ctx.sceneId) return { locationId: loc.id, sceneId: null }
  }
  return { locationId: loc.id, sceneId: setup.vlmSceneId }
}
