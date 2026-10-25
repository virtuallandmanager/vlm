import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { subscriptions } from '../src/db/schema.js'
import { utcDay, promptStatus, reservePrompt, refundPrompt, recordCost } from '../src/studio/quota.js'
import { resetDb } from './helpers/db.js'
import { createUser } from './helpers/factories.js'

const NOW = new Date('2026-10-25T12:00:00Z')

describe('studio quota', () => {
  beforeEach(resetDb)

  it('utcDay is the UTC calendar day', () => {
    expect(utcDay(new Date('2026-10-25T23:59:59Z'))).toBe('2026-10-25')
    expect(utcDay(new Date('2026-10-26T00:00:00Z'))).toBe('2026-10-26')
  })

  it('free plan gets three prompts a day', async () => {
    const u = await createUser()
    for (let i = 0; i < 3; i++) expect(await reservePrompt(u.id, NOW, { counted: true })).toEqual({ ok: true, day: '2026-10-25' })
    expect(await reservePrompt(u.id, NOW, { counted: true })).toEqual({ ok: false, reason: 'allowance' })
    const s = await promptStatus(u.id, NOW)
    expect(s).toMatchObject({ plan: 'free', allowance: 3, used: 3, left: 0, overCostCeiling: false })
  })

  it('the allowance resets at midnight UTC', async () => {
    const u = await createUser()
    const late = new Date('2026-10-25T23:59:00Z')
    for (let i = 0; i < 3; i++) await reservePrompt(u.id, late, { counted: true })
    expect((await promptStatus(u.id, late)).resetsAt).toBe('2026-10-26T00:00:00.000Z')
    expect(await reservePrompt(u.id, new Date('2026-10-26T00:00:01Z'), { counted: true })).toEqual({ ok: true, day: '2026-10-26' })
  })

  it('concurrent reservations never pass the allowance', async () => {
    const u = await createUser()
    const results = await Promise.all(Array.from({ length: 6 }, () => reservePrompt(u.id, NOW, { counted: true })))
    expect(results.filter((r) => r.ok)).toHaveLength(3)
    expect((await promptStatus(u.id, NOW)).used).toBe(3)
  })

  it('the hidden cost ceiling stops prompts, counted or not', async () => {
    const u = await createUser()
    await db.insert(subscriptions).values({ userId: u.id, tier: 'creator' })
    await recordCost(u.id, '2026-10-25', 30)
    expect(await reservePrompt(u.id, NOW, { counted: true })).toEqual({ ok: false, reason: 'cost_ceiling' })
    expect(await reservePrompt(u.id, NOW, { counted: false })).toEqual({ ok: false, reason: 'cost_ceiling' })
    expect((await promptStatus(u.id, NOW)).overCostCeiling).toBe(true)
  })

  it("uncounted reservations don't use the allowance", async () => {
    const u = await createUser()
    for (let i = 0; i < 3; i++) await reservePrompt(u.id, NOW, { counted: true })
    expect(await reservePrompt(u.id, NOW, { counted: false })).toEqual({ ok: true, day: '2026-10-25' })
    expect((await promptStatus(u.id, NOW)).used).toBe(3)
  })

  it('refunds give a prompt back once and never go negative', async () => {
    const u = await createUser()
    await reservePrompt(u.id, NOW, { counted: true })
    await refundPrompt(u.id, '2026-10-25')
    await refundPrompt(u.id, '2026-10-25')
    expect((await promptStatus(u.id, NOW)).used).toBe(0)
  })

  it('paid plans use their own allowance', async () => {
    const u = await createUser()
    await db.insert(subscriptions).values({ userId: u.id, tier: 'pro' })
    expect(await promptStatus(u.id, NOW)).toMatchObject({ plan: 'pro', allowance: 40, left: 40 })
  })
})
