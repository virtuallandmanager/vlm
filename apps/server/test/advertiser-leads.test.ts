import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { advertiserLeads } from '../src/db/schema.js'
import { buildApp } from '../src/app.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

describe('advertiser leads', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(async () => { await app.close() })

  const submit = (payload: unknown, a = app, remoteAddress = '203.0.113.7') =>
    a.inject({ method: 'POST', url: '/api/advertiser-leads', payload: payload as any, remoteAddress })
  const rows = () => db.select().from(advertiserLeads)

  it('stores a lead with consent time', async () => {
    const res = await submit({ email: ' Ana@Brand.example ', name: 'Ana', company: 'Brand', website: 'brand.example', message: 'Vodka in nightclubs', consent: true })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ ok: true })
    const [row] = await rows()
    expect(row).toMatchObject({ email: 'ana@brand.example', name: 'Ana', company: 'Brand', website: 'https://brand.example', message: 'Vodka in nightclubs' })
    expect(Math.abs(row.consentAt.getTime() - Date.now())).toBeLessThan(5000)
  })

  it('same email twice updates one row', async () => {
    await submit({ email: 'ana@brand.example', name: 'Ana', company: 'Brand', consent: true })
    const second = await submit({ email: 'ANA@brand.example', company: 'Brand Co', consent: true })
    expect(second.statusCode).toBe(201)
    const all = await rows()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ company: 'Brand Co', name: 'Ana' })
    expect(all[0].updatedAt.getTime()).toBeGreaterThan(all[0].createdAt.getTime())
  })

  it('rejects bad input', async () => {
    const cases: [unknown, string][] = [
      [{ consent: true }, 'invalid_email'],
      [{ email: 'not-an-email', consent: true }, 'invalid_email'],
      [{ email: `${'a'.repeat(243)}@brand.example`, consent: true }, 'invalid_email'],
      [{ email: 'ana@brand.example', consent: false }, 'consent_required'],
      [{ email: 'ana@brand.example' }, 'consent_required'],
      [{ email: 'ana@brand.example', website: 'javascript:alert(1)', consent: true }, 'invalid_website'],
      [{ email: 'ana@brand.example', name: 'n'.repeat(201), consent: true }, 'too_long'],
      [{ email: 'ana@brand.example', message: 'm'.repeat(2001), consent: true }, 'too_long'],
    ]
    for (const [body, error] of cases) {
      const res = await submit(body)
      expect(res.statusCode, JSON.stringify(body).slice(0, 60)).toBe(400)
      expect(res.json().error).toBe(error)
    }
    expect(await rows()).toHaveLength(0)
  })

  it('honeypot answers success and stores nothing', async () => {
    const res = await submit({ email: 'bot@spam.example', consent: true, nickname: 'x' })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ ok: true })
    expect(await rows()).toHaveLength(0)
  })

  it('rate limits a sixth submit per IP per hour', async () => {
    const limited = await buildApp({ logger: false, backfill: false })
    await limited.ready()
    try {
      for (let i = 0; i < 5; i++) expect((await submit({ email: `a${i}@brand.example`, consent: true }, limited)).statusCode).toBe(201)
      expect((await submit({ email: 'a5@brand.example', consent: true }, limited)).statusCode).toBe(429)
    } finally {
      await limited.close()
    }
  })

  it('admin lists leads newest first', async () => {
    await submit({ email: 'first@brand.example', consent: true })
    await submit({ email: 'second@brand.example', name: 'Sam', consent: true })
    const admin = await createUser({ role: 'admin' })
    const res = await app.inject({ method: 'GET', url: '/api/admin/advertiser-leads', headers: { authorization: `Bearer ${tokenFor(admin)}` } })
    expect(res.statusCode).toBe(200)
    const leads = res.json().leads
    expect(leads.map((l: { email: string }) => l.email)).toEqual(['second@brand.example', 'first@brand.example'])
    expect(Object.keys(leads[0]).sort()).toEqual(['company', 'consentAt', 'createdAt', 'email', 'id', 'message', 'name', 'updatedAt', 'website'])
    expect(leads[0]).toMatchObject({ name: 'Sam', company: null })
    expect(leads[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
  })

  it('non-admins get 403, anonymous gets 401', async () => {
    const creator = await createUser({ role: 'creator' })
    const url = '/api/admin/advertiser-leads'
    expect((await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tokenFor(creator)}` } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
  })
})
