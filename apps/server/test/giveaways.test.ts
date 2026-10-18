import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { giveaways, giveawayItems } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

describe('giveaway item delete', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(() => app.close())

  it("cannot delete another giveaway's item through your own giveaway id", async () => {
    const a = await createUser(); const b = await createUser()
    const [g1] = await db.insert(giveaways).values({ ownerId: a.id, name: 'G1' }).returning()
    const [g2] = await db.insert(giveaways).values({ ownerId: b.id, name: 'G2' }).returning()
    const [item2] = await db.insert(giveawayItems).values({ giveawayId: g2.id, name: 'Prize' }).returning()
    const [item1] = await db.insert(giveawayItems).values({ giveawayId: g1.id, name: 'Mine' }).returning()
    const del = (id: string) => app.inject({ method: 'DELETE', url: `/api/giveaways/${g1.id}/items/${id}`, headers: { authorization: `Bearer ${tokenFor(a)}` } })

    const res = await del(item2.id)
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Item not found' })
    expect(await db.select().from(giveawayItems).where(eq(giveawayItems.id, item2.id))).toHaveLength(1)

    expect((await del(item1.id)).statusCode).toBe(204)
    expect(await db.select().from(giveawayItems).where(eq(giveawayItems.id, item1.id))).toHaveLength(0)
  })
})
