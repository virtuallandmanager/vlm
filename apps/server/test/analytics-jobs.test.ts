import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import {
  analyticsSessions,
  analyticsEvents,
  analyticsPositions,
  analyticsRollupHourly,
  analyticsHeatmapDaily,
  analyticsCopresenceDaily,
  analyticsDirtyHours,
} from '../src/db/schema.js'
import { runSessionCloseSweep, rollupHour, rollupDay, runRollups, runRetention } from '../src/analytics/jobs.js'
import { resetDb } from './helpers/db.js'
import { createUser } from './helpers/factories.js'
import { createAnalyticsScene, insertSession } from './helpers/analytics.js'

const H = new Date('2026-10-01T10:00:00Z')
const at = (min: number, sec = 0) => new Date(H.getTime() + min * 60_000 + sec * 1000)

describe('analytics jobs', () => {
  beforeEach(resetDb)

  it('closes sessions idle for more than 60 s', async () => {
    const s = await createAnalyticsScene()
    const idle = await insertSession(s.id, { lastSeenAt: new Date(Date.now() - 61_000) })
    const live = await insertSession(s.id, { lastSeenAt: new Date(Date.now() - 10_000) })
    expect(await runSessionCloseSweep()).toBe(1)
    const rows = await db.select().from(analyticsSessions)
    expect(rows.find((r) => r.id === idle.id)!.endedAt?.getTime()).toBe(idle.lastSeenAt.getTime())
    expect(rows.find((r) => r.id === live.id)!.endedAt).toBeNull()
  })

  it('hourly rollup: counts, uniques, new vs returning, verified, dwell percentiles, peak concurrency, breakdowns', async () => {
    const s = await createAnalyticsScene()
    const a = await insertSession(s.id, { visitorHash: 'A', startedAt: at(0), lastSeenAt: at(10), endedAt: at(10), durationSec: 600, verified: true, country: 'DE', cameraMode: 'third' })
    await insertSession(s.id, { visitorHash: 'B', startedAt: at(5), lastSeenAt: at(8), endedAt: at(8), durationSec: 180, isReturning: true, country: 'DE', cameraMode: 'first' })
    await insertSession(s.id, { visitorHash: 'A', startedAt: at(30), lastSeenAt: at(31), endedAt: at(31), durationSec: 60, isReturning: true, country: 'US' })
    await db.insert(analyticsEvents).values([
      { sceneId: s.id, sessionId: a.id, seq: 1, visitorHash: 'A', type: 'interact', occurredAt: at(1), data: { kind: 'click', target: 'door' } },
      { sceneId: s.id, sessionId: a.id, seq: 2, visitorHash: 'A', type: 'interact', occurredAt: at(2), data: { kind: 'click', target: 'door' } },
      { sceneId: s.id, sessionId: a.id, seq: 3, visitorHash: 'A', type: 'interact', occurredAt: at(2), data: { kind: 'hover', target: 'door' } },
      { sceneId: s.id, sessionId: a.id, seq: 4, visitorHash: 'A', type: 'emote', occurredAt: at(3), data: { emote: 'wave' } },
      { sceneId: s.id, sessionId: a.id, seq: 5, visitorHash: 'A', type: 'video', occurredAt: at(4), data: { target: 'screen', state: 'play' } },
      { sceneId: s.id, sessionId: a.id, seq: 6, visitorHash: 'A', type: 'video', occurredAt: at(6), data: { target: 'screen', state: 'pause' } },
    ])
    await rollupHour(s.id, H)
    const [r] = await db.select().from(analyticsRollupHourly).where(eq(analyticsRollupHourly.sceneId, s.id))
    expect(r).toMatchObject({ sessions: 3, uniqueVisitors: 2, newVisitors: 1, returningVisitors: 2, verifiedSessions: 1, peakConcurrency: 2 })
    expect(r.dwellP50Sec).toBe(180)
    expect(r.interactions).toEqual({ door: 2 })
    expect(r.emotes).toEqual({ wave: 1 })
    expect(r.video).toEqual({ screen: { plays: 1, watchSec: 120 } })
    expect(r.countries).toEqual({ DE: 2, US: 1 })
    expect(r.cameraModes).toEqual({ third: 1, first: 1 })
  })

  it('daily heatmap uses 1 m cells and capped gaps; co-presence needs 5 minutes of overlap', async () => {
    const s = await createAnalyticsScene()
    const a = await insertSession(s.id, { visitorHash: 'A', startedAt: at(0), lastSeenAt: at(10), endedAt: at(10) })
    await insertSession(s.id, { visitorHash: 'B', startedAt: at(2), lastSeenAt: at(9), endedAt: at(9) })
    await insertSession(s.id, { visitorHash: 'C', startedAt: at(9), lastSeenAt: at(12), endedAt: at(12) })
    await db.insert(analyticsPositions).values([
      { sceneId: s.id, sessionId: a.id, seq: 1, occurredAt: at(0, 0), x: 3.4, y: 0, z: 4.9 },
      { sceneId: s.id, sessionId: a.id, seq: 2, occurredAt: at(0, 3), x: 3.6, y: 0, z: 4.1 },
      { sceneId: s.id, sessionId: a.id, seq: 3, occurredAt: at(1, 0), x: 8.0, y: 0, z: 8.0 },
    ])
    await rollupDay(s.id, '2026-10-01')
    const cells = await db.select().from(analyticsHeatmapDaily).where(eq(analyticsHeatmapDaily.sceneId, s.id))
    const cell = (x: number, z: number) => cells.find((c) => c.cellX === x && c.cellZ === z)
    expect(cell(3, 4)).toMatchObject({ dwellSec: 3 + 15, visits: 1 }) // 3 s gap + gap capped at 15 s
    expect(cell(8, 8)).toMatchObject({ dwellSec: 3, visits: 1 }) // last sample counts 3 s
    const pairs = await db.select().from(analyticsCopresenceDaily)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ visitorA: 'A', visitorB: 'B', overlapSec: 420 })
  })

  it('runRollups processes dirty hours and clears them', async () => {
    const s = await createAnalyticsScene()
    await insertSession(s.id, { startedAt: at(0), lastSeenAt: at(1), endedAt: at(1) })
    await db.insert(analyticsDirtyHours).values({ sceneId: s.id, hour: H })
    expect(await runRollups(new Date('2026-10-01T12:00:00Z'))).toEqual({ hours: 1, days: 1 })
    expect(await db.select().from(analyticsDirtyHours)).toHaveLength(0)
    expect(await db.select().from(analyticsRollupHourly)).toHaveLength(1)
  })

  it('retention: unclaimed 30 days, preview 7, claimed by tier; rollups survive', async () => {
    const now = new Date('2026-10-04T00:00:00Z')
    const old = new Date(now.getTime() - 40 * 86400_000)
    const mid = new Date(now.getTime() - 10 * 86400_000)
    const unclaimed = await createAnalyticsScene()
    const preview = await createAnalyticsScene({ kind: 'preview', isPreview: true })
    const owner = await createUser()
    const claimed = await createAnalyticsScene({ claimedByUserId: owner.id, claimStatus: 'active' })
    for (const sc of [unclaimed, preview, claimed]) {
      await insertSession(sc.id, { startedAt: old, lastSeenAt: old })
      await insertSession(sc.id, { startedAt: mid, lastSeenAt: mid })
      await db.insert(analyticsRollupHourly).values({ sceneId: sc.id, hour: old, sessions: 1 })
    }
    await runRetention(now)
    const left = async (id: string) => (await db.select().from(analyticsSessions).where(eq(analyticsSessions.sceneId, id))).length
    expect(await left(unclaimed.id)).toBe(1) // 40-day-old gone, 10-day kept
    expect(await left(preview.id)).toBe(0) // both older than 7 days
    // Test env runs with all features unlocked (no Stripe key) → claimed scenes keep everything
    expect(await left(claimed.id)).toBe(2)
    expect(await db.select().from(analyticsRollupHourly)).toHaveLength(3)
  })
})
