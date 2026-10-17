import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsScenes } from '../db/schema.js'
import type { SceneRequestContext } from '../middleware/dcl-auth.js'
import { getActiveSetup, releaseIfRedeployed } from '../setup/setups.js'
import { DirectoryUnavailableError } from '../analytics/dcl-directory.js'

export interface SceneBinding { locationId: string | null; sceneId: string | null }
const VISITOR: SceneBinding = { locationId: null, sceneId: null }

const isWorld = (ctx: SceneRequestContext) => ctx.realm.serverName.toLowerCase().endsWith('.eth')

/** Same keys as vlm-shared locationKeyFor, built only from the signed context. */
export function locationKeyForContext(ctx: SceneRequestContext, wallet: string, preview: boolean): string {
  const place = isWorld(ctx) ? ctx.realm.serverName.toLowerCase() : ctx.parcel
  if (preview) return `preview:${wallet.toLowerCase()}:${place}`
  return isWorld(ctx) ? `world:${place}` : `gc:${place}`
}

/** The VLM scene a signed scene request may act on: the active setup at its location. Anything uncertain → visitor. */
export async function bindSceneRequest(ctx: SceneRequestContext, wallet: string, opts: { preview?: boolean } = {}): Promise<SceneBinding> {
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
  if (!opts.preview && setup.deploymentEntityId && setup.deploymentEntityId !== ctx.sceneId) {
    try {
      setup = await releaseIfRedeployed(setup, loc)
    } catch (err) {
      if (err instanceof DirectoryUnavailableError) return { locationId: loc.id, sceneId: null }
      throw err
    }
    if (!setup) return { locationId: loc.id, sceneId: null }
  }
  return { locationId: loc.id, sceneId: setup.vlmSceneId }
}
