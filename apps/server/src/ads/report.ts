import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { adEvents, scenes } from '../db/schema.js'
import type { AdLevel, AdReport, LevelCounts } from 'vlm-shared'

const LEVELS: AdLevel[] = ['scene', 'screen', 'look', 'click']

function emptyCounts(): LevelCounts {
  return { scene: 0, screen: 0, look: 0, click: 0, unverified: { scene: 0, screen: 0, look: 0, click: 0 } }
}

function add(c: LevelCounts, level: string, verified: boolean, n: number) {
  if (!LEVELS.includes(level as AdLevel)) return
  if (verified) c[level as AdLevel] += n
  else c.unverified[level as AdLevel] += n
}

/** Per-ad numbers. Events are already one per wallet (or guest session) per level per day, so a row is one view. */
export async function adReport(adId: string): Promise<AdReport> {
  const rows = await db
    .select({
      day: adEvents.day,
      elementId: adEvents.elementId,
      sceneName: scenes.name,
      level: adEvents.level,
      verified: adEvents.verified,
      n: sql<number>`count(*)::int`,
    })
    .from(adEvents)
    .innerJoin(scenes, eq(scenes.id, adEvents.sceneId))
    .where(eq(adEvents.adId, adId))
    .groupBy(adEvents.day, adEvents.elementId, scenes.name, adEvents.level, adEvents.verified)

  const totals = emptyCounts()
  const byDay = new Map<string, LevelCounts>()
  const bySpace = new Map<string, { sceneName: string; counts: LevelCounts }>()
  for (const r of rows) {
    add(totals, r.level, r.verified, r.n)
    if (!byDay.has(r.day)) byDay.set(r.day, emptyCounts())
    add(byDay.get(r.day)!, r.level, r.verified, r.n)
    if (!bySpace.has(r.elementId)) bySpace.set(r.elementId, { sceneName: r.sceneName, counts: emptyCounts() })
    add(bySpace.get(r.elementId)!.counts, r.level, r.verified, r.n)
  }

  // Only paid (verified) looks make the average
  const [look] = await db
    .select({ avg: sql<string | null>`avg(${adEvents.dwellMs})` })
    .from(adEvents)
    .where(and(eq(adEvents.adId, adId), eq(adEvents.level, 'look'), eq(adEvents.verified, true)))

  return {
    totals,
    byDay: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, c]) => ({ day, ...c })),
    bySpace: [...bySpace].map(([elementId, v]) => ({ elementId, sceneName: v.sceneName, ...v.counts })),
    avgLookMs: look?.avg == null ? null : Math.round(Number(look.avg)),
  }
}
