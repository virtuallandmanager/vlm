import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { arFloors, arMarkers, arSpaces } from '../db/schema.js'
import type { SceneAccess } from '../auth/permissions.js'
import { isUuid, type SceneFrom } from '../auth/scene-from.js'

/** Who may set up AR spaces: the scene's owner, co-hosts and editors (and admins). Booking hosts and viewers may not. */
export const mayBuild = (access: SceneAccess): boolean =>
  access.level === 'admin' || access.level === 'owner' || access.level === 'cohost' || access.level === 'editor'

export async function spaceScene(spaceId: string): Promise<string | null> {
  if (!isUuid(spaceId)) return null
  const [row] = await db.select({ sceneId: arSpaces.sceneId }).from(arSpaces).where(eq(arSpaces.id, spaceId))
  return row?.sceneId ?? null
}

export async function floorScene(floorId: string): Promise<string | null> {
  if (!isUuid(floorId)) return null
  const [row] = await db
    .select({ sceneId: arSpaces.sceneId })
    .from(arFloors)
    .innerJoin(arSpaces, eq(arSpaces.id, arFloors.spaceId))
    .where(eq(arFloors.id, floorId))
  return row?.sceneId ?? null
}

export async function markerScene(markerId: string): Promise<string | null> {
  if (!isUuid(markerId)) return null
  const [row] = await db
    .select({ sceneId: arSpaces.sceneId })
    .from(arMarkers)
    .innerJoin(arFloors, eq(arFloors.id, arMarkers.floorId))
    .innerJoin(arSpaces, eq(arSpaces.id, arFloors.spaceId))
    .where(eq(arMarkers.id, markerId))
  return row?.sceneId ?? null
}

const idParam = (r: { params?: unknown }) => (r.params as Record<string, unknown> | undefined)?.id
export const fromSpace: SceneFrom = (r) => spaceScene(idParam(r) as string)
export const fromFloor: SceneFrom = (r) => floorScene(idParam(r) as string)
export const fromMarker: SceneFrom = (r) => markerScene(idParam(r) as string)
