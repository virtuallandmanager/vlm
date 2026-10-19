// Which catalog models can be browsed and newly linked: everything outside a pack, and models in enabled packs.
// Already-linked models are never filtered by this (switching a pack off only stops new picks).
import { and, eq, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { assetLibraryItems, catalogPacks } from '../db/schema.js'

export function browsableAsset(): SQL {
  return sql`(${assetLibraryItems.packId} IS NULL OR EXISTS (SELECT 1 FROM ${catalogPacks} WHERE ${catalogPacks.id} = ${assetLibraryItems.packId} AND ${catalogPacks.enabled}))`
}

export class PackDisabledError extends Error {
  readonly code = 'pack_disabled'
  constructor() {
    super('This pack is no longer available')
  }
}

/** True when the model is in a switched-off pack. */
export async function inDisabledPack(assetItemId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: assetLibraryItems.id })
    .from(assetLibraryItems)
    .innerJoin(catalogPacks, eq(catalogPacks.id, assetLibraryItems.packId))
    .where(and(eq(assetLibraryItems.id, assetItemId), eq(catalogPacks.enabled, false)))
    .limit(1)
  return !!row
}
