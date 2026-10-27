import { asc, eq, inArray } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { ads, adCreatives, adPlacements, sceneElements } from '../db/schema.js'
import { VideoSourceType, AD_SHAPES } from '@virvixr/shared'
import type { AdItem, AdServeResponse, AdShape, AdFormats } from '@virvixr/shared'
import { isUnderActiveBooking } from './booking.js'

type Space = { shape: AdShape; formats: AdFormats }

function spaceFor(el: { type: string; properties: unknown }): Space | null {
  const p = (el.properties ?? {}) as Record<string, unknown>
  if (el.type === 'ad_space') {
    const shape = AD_SHAPES.includes(p.shape as AdShape) ? (p.shape as AdShape) : null
    if (!shape) return null
    const formats: AdFormats = p.formats === 'image' || p.formats === 'video' ? p.formats : 'both'
    return { shape, formats }
  }
  if (el.type === 'video' && (p.offType === VideoSourceType.ADS || p.offType === VideoSourceType.PLAYLIST_ADS)) {
    const shape = AD_SHAPES.includes(p.adShape as AdShape) ? (p.adShape as AdShape) : '16:9'
    return { shape, formats: 'both' }
  }
  return null
}

export async function selectAdsForElements(
  sceneId: string,
  elementIds: string[],
  now: Date,
  opts: { ignoreBooking?: boolean } = {},
): Promise<AdServeResponse['spaces']> {
  const result: AdServeResponse['spaces'] = {}
  if (!elementIds.length) return result

  const elements = await db.select().from(sceneElements).where(inArray(sceneElements.id, elementIds))
  const spaces = new Map<string, { el: (typeof elements)[number]; space: Space }>()
  for (const el of elements) {
    const space = spaceFor(el)
    if (space) spaces.set(el.id, { el, space })
  }
  if (!spaces.size) return result

  const lookupIds = new Set<string>()
  for (const { el } of spaces.values()) {
    lookupIds.add(el.id)
    if (el.clonedFromId) lookupIds.add(el.clonedFromId)
  }
  const placements = await db.select().from(adPlacements).where(inArray(adPlacements.elementId, [...lookupIds]))

  const rows = await db
    .select({
      adId: ads.id,
      adKind: ads.kind,
      clickUrl: ads.clickUrl,
      status: ads.status,
      startsAt: ads.startsAt,
      endsAt: ads.endsAt,
      creativeId: adCreatives.id,
      shape: adCreatives.shape,
      kind: adCreatives.kind,
      url: adCreatives.url,
    })
    .from(ads)
    .innerJoin(adCreatives, eq(adCreatives.adId, ads.id))
    .where(eq(ads.status, 'active'))
    .orderBy(asc(ads.id), asc(adCreatives.id))
  const live = rows.filter((r) => (!r.startsAt || r.startsAt <= now) && (!r.endsAt || now < r.endsAt))

  for (const [id, { el, space }] of spaces) {
    if (!opts.ignoreBooking && (await isUnderActiveBooking(sceneId, el, now))) {
      result[id] = { paused: true, ads: [] }
      continue
    }
    const fits = live.filter((r) => r.shape === space.shape && (space.formats === 'both' || r.kind === space.formats))
    const placed = new Set(
      placements.filter((p) => p.elementId === el.id || p.elementId === el.clonedFromId).map((p) => p.adId),
    )
    const partner = fits.filter((r) => r.adKind === 'partner' && placed.has(r.adId))
    const chosen = partner.length ? partner : fits.filter((r) => r.adKind === 'house')
    const items: AdItem[] = chosen.map((r) => ({
      adId: r.adId,
      creativeId: r.creativeId,
      kind: r.kind,
      url: r.url,
      clickUrl: r.clickUrl,
      house: r.adKind === 'house',
    }))
    result[id] = { paused: false, ads: items }
  }
  return result
}
