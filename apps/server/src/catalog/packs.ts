// Catalog packs with their model counts, for the admin switches and the public credits list.
import { eq, sql } from 'drizzle-orm'
import type { CatalogPack } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { assetLibraryItems, catalogPacks } from '../db/schema.js'

export async function listPacks(id?: string): Promise<CatalogPack[]> {
  const rows = await db
    .select({
      id: catalogPacks.id,
      name: catalogPacks.name,
      source: catalogPacks.source,
      license: catalogPacks.license,
      attribution: catalogPacks.attribution,
      sourceUrl: catalogPacks.sourceUrl,
      enabled: catalogPacks.enabled,
      modelCount: sql<number>`count(${assetLibraryItems.id})::int`,
    })
    .from(catalogPacks)
    .leftJoin(assetLibraryItems, eq(assetLibraryItems.packId, catalogPacks.id))
    .where(id ? eq(catalogPacks.id, id) : undefined)
    .groupBy(catalogPacks.id)
    .orderBy(catalogPacks.name)
  return rows as CatalogPack[]
}
