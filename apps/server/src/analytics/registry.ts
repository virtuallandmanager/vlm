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
const DOWN_MS = 60_000
const MAX_ENTRIES = 10_000
// Positive results per location; negative results per location + claimed entity id, so a stale
// deployment's rejections never block batches from the new deployment at the same location.
// Negative entries record LOCATION-level failures only, never parcel-claim mismatches.
const positive = new Map<string, { at: number; entityId: string | null }>()
const negative = new Map<string, number>()
// Locations whose upstream recently failed while we had a row: skip upstream calls for 60 s.
const upstreamDown = new Map<string, number>()

function remember<V>(m: Map<string, V>, key: string, value: V): void {
  m.delete(key)
  m.set(key, value)
  if (m.size > MAX_ENTRIES) m.delete(m.keys().next().value as string)
}

export function clearRegistryCache(): void {
  positive.clear()
  negative.clear()
  upstreamDown.clear()
}

interface Validated {
  entityId: string | null
  parcels: string[]
  title?: string
}

const urnEntityId = (urn: string) => urn.split('?')[0].split(':').pop() ?? ''

/** Location-level validation only; parcel claims are checked locally by parcelsOk. */
async function validate(ref: AnalyticsSceneRef): Promise<Validated | null> {
  const dir = getDclDirectory()
  if (ref.isWorld) {
    const w = await dir.getWorldScene(ref.worldName!)
    if (!w) return null
    const ids = w.sceneUrns.map(urnEntityId)
    if (ref.entityId && !ids.includes(ref.entityId)) return null
    return { entityId: ref.entityId ? ids.find((i) => i === ref.entityId)! : null, parcels: ref.parcels ?? [], title: ref.title ?? w.title }
  }
  const active = await dir.getActiveSceneAt(ref.baseParcel!)
  if (!active || active.base !== ref.baseParcel) return null
  if (ref.entityId && ref.entityId !== active.entityId) return null
  return { entityId: active.entityId, parcels: active.parcels, title: active.title ?? ref.title }
}

/** Claimed parcels must lie inside the known scene (worlds carry no parcel list to check). */
function parcelsOk(ref: AnalyticsSceneRef, scene: AnalyticsSceneRow): boolean {
  if (ref.isWorld || !ref.parcels) return true
  return ref.parcels.every((p) => scene.parcels.includes(p))
}

const accept = (ref: AnalyticsSceneRef, scene: AnalyticsSceneRow): ResolveResult =>
  parcelsOk(ref, scene) ? { ok: true, scene } : { ok: false, status: 422, error: 'unknown_scene' }

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
  const t = now.getTime()
  const negKey = `${key}|${ref.entityId ?? ''}`
  const rejectedAt = negative.get(negKey)
  if (rejectedAt !== undefined && t - rejectedAt < CACHE_MS) return { ok: false, status: 422, error: 'unknown_scene' }
  const row = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, key) })
  const cached = positive.get(key)
  if (cached && t - cached.at < CACHE_MS && row && (!ref.entityId || ref.entityId === cached.entityId)) return accept(ref, row)
  const downAt = upstreamDown.get(key)
  if (row && downAt !== undefined && t - downAt < DOWN_MS) return accept(ref, row)

  let v: Validated | null
  try {
    v = await validate(ref)
  } catch (err) {
    if (!(err instanceof DirectoryUnavailableError)) throw err
    if (row) {
      remember(upstreamDown, key, t)
      return accept(ref, row)
    }
    return { ok: false, status: 503, error: 'upstream_unavailable' }
  }
  if (!v) {
    remember(negative, negKey, t)
    return { ok: false, status: 422, error: 'unknown_scene' }
  }
  const scene = await upsert(key, ref, v, now)
  remember(positive, key, { at: t, entityId: scene.activeEntityId })
  upstreamDown.delete(key)
  return accept(ref, scene)
}
