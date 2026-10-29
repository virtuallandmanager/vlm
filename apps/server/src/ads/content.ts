import { inArray } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { adSpaceSettings, sceneElements } from '../db/schema.js'
import { AD_CONTENT_DEFAULT } from '@virvixr/shared'
import type { AdContent, AdAudience, AdReviewStatus } from '@virvixr/shared'

/** Whether an ad may be served in a space with this content setting, given the owner's decision on it there. */
export function adAllowed(
  content: AdContent,
  ad: { reviewStatus: AdReviewStatus; audience: AdAudience | null },
  ownerDecision: 'approved' | 'declined' | null,
): boolean {
  if (ad.reviewStatus !== 'approved') return false
  if (content === 'approve') return ownerDecision === 'approved'
  if (content === 'family') return ad.audience === 'family'
  return true
}

/** Each element's content setting: its own, else its original's (booking clones), else the default. */
export async function spaceContentFor(elementIds: string[]): Promise<Map<string, AdContent>> {
  const out = new Map<string, AdContent>()
  if (!elementIds.length) return out
  const els = await db
    .select({ id: sceneElements.id, clonedFromId: sceneElements.clonedFromId })
    .from(sceneElements)
    .where(inArray(sceneElements.id, elementIds))
  const lookup = new Set<string>(elementIds)
  for (const el of els) if (el.clonedFromId) lookup.add(el.clonedFromId)
  const rows = await db.select().from(adSpaceSettings).where(inArray(adSpaceSettings.elementId, [...lookup]))
  const settings = new Map(rows.map((r) => [r.elementId, r.content]))
  for (const id of elementIds) {
    const clonedFrom = els.find((e) => e.id === id)?.clonedFromId
    out.set(id, settings.get(id) ?? (clonedFrom ? settings.get(clonedFrom) : undefined) ?? AD_CONTENT_DEFAULT)
  }
  return out
}
