import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { assetLibraryItems, bookings, mediaAssets, sceneLibrary } from '../db/schema.js'

export interface LibraryItem {
  id: string
  kind: 'media' | 'model'
  name: string
  contentType: string | null
  url: string
  sizeBytes: number
  addedBy: string | null
  bookingId: string | null
  createdAt: string
}

// Booking-linked items show only while the booking is confirmed or live (the venue lifecycle job flips
// bookings to 'ended' after endsAt + grace, so status alone is the codebase's definition of active).
const ACTIVE_BOOKING = sql`(${sceneLibrary.bookingId} IS NULL OR EXISTS (SELECT 1 FROM ${bookings} b WHERE b.id = ${sceneLibrary.bookingId} AND b.status IN ('confirmed','live')))`

export async function listSceneLibrary(sceneId: string): Promise<LibraryItem[]> {
  const rows = await db
    .select({ l: sceneLibrary, m: mediaAssets, a: assetLibraryItems })
    .from(sceneLibrary)
    .leftJoin(mediaAssets, eq(mediaAssets.id, sceneLibrary.mediaAssetId))
    .leftJoin(assetLibraryItems, eq(assetLibraryItems.id, sceneLibrary.assetItemId))
    .where(and(eq(sceneLibrary.sceneId, sceneId), ACTIVE_BOOKING))
    .orderBy(sql`${sceneLibrary.createdAt} desc`)
  return rows.flatMap(({ l, m, a }): LibraryItem[] => {
    const base = { id: l.id, addedBy: l.addedBy, bookingId: l.bookingId, createdAt: l.createdAt.toISOString() }
    if (m) return [{ ...base, kind: 'media', name: m.filename, contentType: m.contentType, url: m.publicUrl ?? '', sizeBytes: m.sizeBytes }]
    if (a) return [{ ...base, kind: 'model', name: a.name, contentType: 'model/gltf-binary', url: a.cdnUrl ?? '', sizeBytes: a.fileSizeBytes }]
    return []
  })
}

export async function linkToScene(
  sceneId: string,
  item: { mediaAssetId?: string; assetItemId?: string },
  addedBy: string | null,
  bookingId: string | null = null,
): Promise<string> {
  const values = { sceneId, mediaAssetId: item.mediaAssetId ?? null, assetItemId: item.assetItemId ?? null, addedBy, bookingId }
  const [row] = await db.insert(sceneLibrary).values(values).onConflictDoNothing().returning({ id: sceneLibrary.id })
  if (row) return row.id
  const existing = await db.query.sceneLibrary.findFirst({
    where: and(
      eq(sceneLibrary.sceneId, sceneId),
      item.mediaAssetId ? eq(sceneLibrary.mediaAssetId, item.mediaAssetId) : eq(sceneLibrary.assetItemId, item.assetItemId!),
    ),
    columns: { id: true },
  })
  return existing!.id
}

/**
 * Link every media file / model already placed in a scene (URL in element or instance properties).
 * Keys are the media-bearing ones in vlm-shared element types; `playlist` is an array of video URLs.
 * Idempotent; returns rows added.
 */
const PLACED = sql.raw(`
  SELECT DISTINCT sp.scene_id, u.url FROM (
    SELECT e.preset_id, e.properties AS props FROM scene_elements e
    UNION ALL
    SELECT e.preset_id, i.properties FROM scene_element_instances i JOIN scene_elements e ON e.id = i.element_id
  ) p
  JOIN scene_presets sp ON sp.id = p.preset_id
  CROSS JOIN LATERAL (
    SELECT p.props->>k AS url FROM unnest(ARRAY['textureSrc','modelSrc','audioSrc','offImageSrc','imgSrc','kioskImgSrc']) AS k
    UNION ALL
    SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.props->'playlist') = 'array' THEN p.props->'playlist' ELSE '[]'::jsonb END)
  ) u
  WHERE u.url IS NOT NULL AND u.url <> ''`)

const rowCount = (r: unknown): number => (Array.isArray(r) ? r.length : ((r as { rows?: unknown[] }).rows?.length ?? 0))

export async function backfillSceneLibrary(): Promise<number> {
  const media = await db.execute(sql`
    INSERT INTO scene_library (scene_id, media_asset_id, added_by)
    SELECT pl.scene_id, m.id, s.owner_id FROM (${PLACED}) pl
      JOIN media_assets m ON m.public_url = pl.url JOIN scenes s ON s.id = pl.scene_id
    ON CONFLICT DO NOTHING RETURNING id`)
  const models = await db.execute(sql`
    INSERT INTO scene_library (scene_id, asset_item_id, added_by)
    SELECT pl.scene_id, a.id, s.owner_id FROM (${PLACED}) pl
      JOIN asset_library_items a ON a.cdn_url = pl.url JOIN scenes s ON s.id = pl.scene_id
    ON CONFLICT DO NOTHING RETURNING id`)
  return rowCount(media) + rowCount(models)
}
