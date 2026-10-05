import { randomBytes } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { locationKeyFor, type AnalyticsSceneRef } from 'vlm-shared'
import { db } from '../db/connection.js'
import { analyticsScenes } from '../db/schema.js'
import { DirectoryUnavailableError, getDclDirectory } from './dcl-directory.js'

export type AnalyticsSceneRow = typeof analyticsScenes.$inferSelect
export type ResolveResult =
  | { ok: true; scene: AnalyticsSceneRow }
  | { ok: false; status: 422 | 503; error: 'unknown_scene' | 'upstream_unavailable' }

const CACHE_MS = 10 * 60_000
// Positive results per location; negative results per location + claimed entity id, so a stale
// deployment's rejections never block batches from the new deployment at the same location.
const positive = new Map<string, { at: number; entityId: string | null }>()
const negative = new Map<string, number>()

export function clearRegistryCache(): void {
  positive.clear()
  negative.clear()
}

interface Validated {
  entityId: string | null
  parcels: string[]
  title?: string
}

async function validate(ref: AnalyticsSceneRef): Promise<Validated | null> {
  const dir = getDclDirectory()
  if (ref.isWorld) {
    const w = await dir.getWorldScene(ref.worldName!)
    if (!w) return null
    if (ref.entityId && !w.sceneUrns.some((u) => u.includes(ref.entityId!))) return null
    return { entityId: ref.entityId ?? null, parcels: ref.parcels ?? [], title: ref.title ?? w.title }
  }
  const active = await dir.getActiveSceneAt(ref.baseParcel!)
  if (!active || active.base !== ref.baseParcel) return null
  if (ref.parcels && !ref.parcels.every((p) => active.parcels.includes(p))) return null
  if (ref.entityId && ref.entityId !== active.entityId) return null
  return { entityId: active.entityId, parcels: active.parcels, title: active.title ?? ref.title }
}

async function upsert(key: string, ref: AnalyticsSceneRef, v: Validated, now: Date): Promise<AnalyticsSceneRow> {
  const [row] = await db
    .insert(analyticsScenes)
    .values({
      kind: ref.isPreview ? 'preview' : ref.isWorld ? 'world' : 'parcels',
      locationKey: key,
      realm: ref.realm,
      baseParcel: ref.baseParcel ?? null,
      parcels: v.parcels,
      worldName: ref.isWorld ? ref.worldName!.toLowerCase() : null,
      activeEntityId: v.entityId,
      title: v.title ?? null,
      salt: randomBytes(32).toString('hex'),
      isPreview: ref.isPreview,
      lastEntityCheckAt: now,
    })
    .onConflictDoUpdate({
      target: analyticsScenes.locationKey,
      set: {
        realm: ref.realm,
        parcels: v.parcels,
        activeEntityId: sql`coalesce(${v.entityId}, ${analyticsScenes.activeEntityId})`,
        title: sql`coalesce(${v.title ?? null}, ${analyticsScenes.title})`,
        lastEntityCheckAt: now,
        updatedAt: now,
      },
    })
    .returning()
  return row
}

export async function resolveAnalyticsScene(ref: AnalyticsSceneRef, signer: string | null, now = new Date()): Promise<ResolveResult> {
  const key = locationKeyFor(ref, signer)
  if (ref.isPreview) {
    return { ok: true, scene: await upsert(key, ref, { entityId: ref.entityId ?? null, parcels: ref.parcels ?? [], title: ref.title }, now) }
  }
  const negKey = `${key}|${ref.entityId ?? ''}`
  const rejectedAt = negative.get(negKey)
  if (rejectedAt !== undefined && now.getTime() - rejectedAt < CACHE_MS) return { ok: false, status: 422, error: 'unknown_scene' }
  const row = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, key) })
  const cached = positive.get(key)
  const fresh = cached && now.getTime() - cached.at < CACHE_MS
  if (fresh && row && (!ref.entityId || ref.entityId === cached!.entityId)) return { ok: true, scene: row }

  let v: Validated | null
  try {
    v = await validate(ref)
  } catch (err) {
    if (err instanceof DirectoryUnavailableError && row) return { ok: true, scene: row }
    if (err instanceof DirectoryUnavailableError) return { ok: false, status: 503, error: 'upstream_unavailable' }
    throw err
  }
  if (!v) {
    negative.set(negKey, now.getTime())
    return { ok: false, status: 422, error: 'unknown_scene' }
  }
  const scene = await upsert(key, ref, v, now)
  positive.set(key, { at: now.getTime(), entityId: scene.activeEntityId })
  return { ok: true, scene }
}
