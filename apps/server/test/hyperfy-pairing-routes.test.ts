import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { HYPERFY_PAIRING } from 'vlm-shared'
import { buildApp } from '../src/app.js'
import { vouchLimiter } from '../src/routes/hyperfy-pairing.js'
import { config } from '../src/config.js'
import { register } from '../src/metrics.js'
import { db } from '../src/db/connection.js'
import { hyperfyPairings, hyperfyWorlds } from '../src/db/schema.js'
import { createWorldKey } from '../src/hyperfy/worlds.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, randomWallet } from './helpers/factories.js'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const SECRET = 'browser-secret-1'
const WORLD_SECRET = 'w'.repeat(64)
const bearer = (t: string) => ({ authorization: `Bearer ${t}` })

describe('Hyperfy pairing routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(() => app.close())

  async function seed(hosted = false, worldSecret = WORLD_SECRET) {
    const owner = await createUser({ wallet: randomWallet() })
    const { scene } = await createScene(owner)
    const key = createWorldKey()
    const [world] = await db.insert(hyperfyWorlds).values({
      sceneId: scene.id, ownerId: owner.id, name: 'Arbor World', keyHash: key.hash, keyPrefix: key.prefix,
      ...(hosted ? { kind: 'hosted', worldSecretHash: sha256(worldSecret) } : {}),
    }).returning()
    return { owner, scene, world, key: key.raw }
  }
  const start = (s: { key: string }) =>
    app.inject({ method: 'POST', url: '/api/hyperfy/pair', payload: { worldKey: s.key, secretHash: sha256(SECRET), playerName: 'Pip' } })
  const vouch = (s: { key: string }, over: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/api/hyperfy/pairings/vouch', payload: { worldKey: s.key, worldSecret: WORLD_SECRET, hyperfyPlayerId: 'player-1', playerName: 'Pip', ...over } })

  it('self-run flow: start, approve, claim, then a pass-enabled edit succeeds', async () => {
    const s = await seed()
    const started = await start(s)
    expect(started.statusCode).toBe(200)
    const { code, approveUrl, qrUrl } = started.json()
    expect(approveUrl).toBe(`${config.webAppUrl}/pair/${code}`)
    expect(qrUrl).toBe(`${config.publicUrl}/api/hyperfy/pair/${code}/qr.png`)

    const qr = await app.inject({ method: 'GET', url: `/api/hyperfy/pair/${code}/qr.png` })
    expect(qr.statusCode).toBe(200)
    expect(qr.headers['content-type']).toBe('image/png')

    const claim = () => app.inject({ method: 'POST', url: `/api/hyperfy/pair/${code}/claim`, payload: { secret: SECRET } })
    expect((await claim()).json()).toEqual({ status: 'pending' })

    // the code is typed with dashes and lowercase on the approval page
    const typed = `${code.slice(0, 3)}-${code.slice(3)}`.toLowerCase()
    expect((await app.inject({ method: 'GET', url: `/api/hyperfy/pair/${typed}` })).statusCode).toBe(401)
    const info = await app.inject({ method: 'GET', url: `/api/hyperfy/pair/${typed}`, headers: bearer(tokenFor(s.owner)) })
    expect(info.json()).toMatchObject({ worldName: 'Arbor World', sceneId: s.scene.id, playerName: 'Pip' })
    const approve = await app.inject({ method: 'POST', url: `/api/hyperfy/pair/${typed}/approve`, headers: bearer(tokenFor(s.owner)) })
    expect(approve.json()).toEqual({ result: 'approved' })

    const claimed = (await claim()).json()
    expect(claimed.status).toBe('approved')
    expect(claimed.sceneId).toBe(s.scene.id)
    const edit = await app.inject({ method: 'GET', url: `/api/scenes/${s.scene.id}/library`, headers: bearer(claimed.pass) })
    expect(edit.statusCode).toBe(200)

    const renew = await app.inject({ method: 'POST', url: `/api/hyperfy/pairings/${claimed.pairingId}/renew`, payload: { secret: SECRET } })
    expect(renew.statusCode).toBe(200)
    expect(renew.json().pass).toBeTruthy()
    expect(renew.json().sceneId).toBe(s.scene.id)
    const wrong = await app.inject({ method: 'POST', url: `/api/hyperfy/pairings/${claimed.pairingId}/renew`, payload: { secret: 'nope' } })
    expect(wrong.statusCode).toBe(401)

    const list = await app.inject({ method: 'GET', url: '/api/hyperfy/pairings', headers: bearer(tokenFor(s.owner)) })
    expect(list.json().pairings).toHaveLength(1)
  })

  it('bad input: unknown world key 401, bad code 404, no access 403, a pass cannot approve', async () => {
    const s = await seed()
    expect((await app.inject({ method: 'POST', url: '/api/hyperfy/pair', payload: { worldKey: 'vlmw_nope', secretHash: sha256(SECRET) } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/api/hyperfy/pair', payload: { worldKey: s.key, secretHash: 'short' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/hyperfy/pair/OOO-111/qr.png' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/hyperfy/pair/OOO-111/claim', payload: { secret: SECRET } })).statusCode).toBe(404)
    const { code } = (await start(s)).json()
    const stranger = await createUser({ wallet: randomWallet() })
    const res = await app.inject({ method: 'POST', url: `/api/hyperfy/pair/${code}/approve`, headers: bearer(tokenFor(stranger)) })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ result: 'no_access' })
    expect((await app.inject({ method: 'POST', url: `/api/hyperfy/pair/${code}/claim`, payload: { secret: SECRET } })).json()).toEqual({ status: 'refused' })
  })

  it('CORS answers any origin without credentials', async () => {
    const res = await app.inject({ method: 'OPTIONS', url: '/api/hyperfy/pair', headers: { origin: 'https://some-world.example', 'access-control-request-method': 'POST' } })
    expect(res.headers['access-control-allow-origin']).toBe('https://some-world.example')
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
    const get = await app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://other.example' } })
    expect(get.headers['access-control-allow-origin']).toBe('https://other.example')
    expect(get.headers['access-control-allow-credentials']).toBeUndefined()
  })

  it("vouch with a wrong secret is 401; self-run worlds can't vouch", async () => {
    const hosted = await seed(true)
    for (const over of [{ worldSecret: 'x'.repeat(64) }, { worldSecret: undefined }, { worldKey: undefined }, { worldKey: 'vlmw_nope' }, { worldKey: 'nope' }]) {
      expect((await vouch(hosted, over)).statusCode).toBe(401)
    }
    const self = await seed(false)
    expect((await vouch(self)).statusCode).toBe(401)
    expect((await vouch(self, { worldSecret: '' })).statusCode).toBe(401)
    expect(await db.select().from(hyperfyPairings)).toHaveLength(0)
    // an ended world's secret stops working
    await db.update(hyperfyWorlds).set({ status: 'ended' }).where(eq(hyperfyWorlds.id, hosted.world.id))
    expect((await vouch(hosted)).statusCode).toBe(401)
  })

  it("vouch with a valid secret and another world's key is 401", async () => {
    const a = await seed(true, 'a'.repeat(64))
    const b = await seed(true, 'b'.repeat(64))
    expect((await vouch(a, { worldSecret: 'a'.repeat(64) })).statusCode).toBe(200)
    expect((await vouch(b, { worldSecret: 'a'.repeat(64) })).statusCode).toBe(401)
    expect((await vouch(a, { worldSecret: 'b'.repeat(64) })).statusCode).toBe(401)
    expect(await db.select().from(hyperfyPairings).where(eq(hyperfyPairings.worldId, b.world.id))).toHaveLength(0)
  })

  it('hosted flow: vouch unlinked returns a code, approve, vouch again returns linked with a pass, a later vouch for the same player is linked without a new code', async () => {
    const s = await seed(true)
    const first = (await vouch(s)).json()
    expect(first.status).toBe('unlinked')
    expect(first.approveUrl).toBe(`${config.webAppUrl}/pair/${first.code}`)
    expect(first.qrUrl).toBe(`${config.publicUrl}/api/hyperfy/pair/${first.code}/qr.png`)
    const [row] = await db.select().from(hyperfyPairings)
    expect(row).toMatchObject({ id: first.pairingId, hyperfyPlayerId: 'player-1', secretHash: null, status: 'pending' })

    // no browser secret exists, so claim and renew refuse it
    expect((await app.inject({ method: 'POST', url: `/api/hyperfy/pair/${first.code}/claim`, payload: { secret: 'x' } })).json()).toEqual({ status: 'expired' })

    expect((await app.inject({ method: 'POST', url: `/api/hyperfy/pair/${first.code}/approve`, headers: bearer(tokenFor(s.owner)) })).json()).toEqual({ result: 'approved' })
    const linked = (await vouch(s)).json()
    expect(linked).toMatchObject({ status: 'linked', pairingId: first.pairingId, sceneId: s.scene.id, user: { id: s.owner.id } })
    expect(linked.code).toBeUndefined()
    const after = (await db.select().from(hyperfyPairings))[0]
    expect(after).toMatchObject({ status: 'claimed', codeHash: null, expiresAt: null })
    expect(after.lastUsedAt).not.toBeNull()
    expect((await app.inject({ method: 'GET', url: `/api/scenes/${s.scene.id}/library`, headers: bearer(linked.pass) })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: `/api/hyperfy/pairings/${first.pairingId}/renew`, payload: { secret: 'x' } })).statusCode).toBe(401)

    const again = (await vouch(s)).json()
    expect(again).toMatchObject({ status: 'linked', pairingId: first.pairingId })
    expect(await db.select().from(hyperfyPairings)).toHaveLength(1)
    // another player of the same world is not linked
    expect((await vouch(s, { hyperfyPlayerId: 'player-2' })).json().status).toBe('unlinked')
    const list = await app.inject({ method: 'GET', url: '/api/hyperfy/pairings', headers: bearer(tokenFor(s.owner)) })
    expect(list.json().pairings).toMatchObject([{ id: first.pairingId, kind: 'hosted', expiresAt: null }])
  })

  it('hosted pairing unused for 90 days is expired', async () => {
    const s = await seed(true)
    const first = (await vouch(s)).json()
    await app.inject({ method: 'POST', url: `/api/hyperfy/pair/${first.code}/approve`, headers: bearer(tokenFor(s.owner)) })
    expect((await vouch(s)).json().status).toBe('linked')
    const old = new Date(Date.now() - HYPERFY_PAIRING.hostedIdleTtlMs - 24 * 3600_000)
    await db.update(hyperfyPairings).set({ lastUsedAt: old, createdAt: old }).where(eq(hyperfyPairings.id, first.pairingId))
    const res = (await vouch(s)).json()
    expect(res.status).toBe('unlinked')
    expect(res.pairingId).not.toBe(first.pairingId)
    expect((await app.inject({ method: 'GET', url: '/api/hyperfy/pairings', headers: bearer(tokenFor(s.owner)) })).json().pairings).toEqual([])
    // just inside the window it is still live
    const recent = new Date(Date.now() - HYPERFY_PAIRING.hostedIdleTtlMs + 3600_000)
    await db.update(hyperfyPairings).set({ lastUsedAt: recent }).where(eq(hyperfyPairings.id, first.pairingId))
    expect((await vouch(s)).json()).toMatchObject({ status: 'linked', pairingId: first.pairingId })
  })

  it('revoke via DELETE then renew is 401 (and only the owner can revoke)', async () => {
    const s = await seed()
    const { code } = (await start(s)).json()
    await app.inject({ method: 'POST', url: `/api/hyperfy/pair/${code}/approve`, headers: bearer(tokenFor(s.owner)) })
    const claimed = (await app.inject({ method: 'POST', url: `/api/hyperfy/pair/${code}/claim`, payload: { secret: SECRET } })).json()
    const stranger = await createUser({ wallet: randomWallet() })
    expect((await app.inject({ method: 'DELETE', url: `/api/hyperfy/pairings/${claimed.pairingId}`, headers: bearer(tokenFor(stranger)) })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: `/api/hyperfy/pairings/${claimed.pairingId}`, headers: bearer(claimed.pass) })).statusCode).toBe(403)
    const del = await app.inject({ method: 'DELETE', url: `/api/hyperfy/pairings/${claimed.pairingId}`, headers: bearer(tokenFor(s.owner)) })
    expect(del.json()).toEqual({ revoked: true })
    const renew = await app.inject({ method: 'POST', url: `/api/hyperfy/pairings/${claimed.pairingId}/renew`, payload: { secret: SECRET } })
    expect(renew.statusCode).toBe(401)
    expect(renew.json()).toEqual({ error: 'pairing_revoked' })
  })

  it('pair start is rate limited (and approve too)', async () => {
    const limited = await buildApp({ rateLimit: true, logger: false, backfill: false })
    await limited.ready()
    try {
      const s = await seed()
      const go = () => limited.inject({ method: 'POST', url: '/api/hyperfy/pair', payload: { worldKey: s.key, secretHash: sha256(SECRET) } })
      for (let i = 0; i < 10; i++) expect((await go()).statusCode).toBe(200)
      expect((await go()).statusCode).toBe(429)
      const user = tokenFor(s.owner)
      const approve = () => limited.inject({ method: 'POST', url: '/api/hyperfy/pair/ABC-234/approve', headers: bearer(user) })
      for (let i = 0; i < 30; i++) expect((await approve()).statusCode).toBe(404)
      expect((await approve()).statusCode).toBe(429)
    } finally {
      await limited.close()
    }
  })

  it('pairing codes never reach the request log', async () => {
    const lines: string[] = []
    const prevLevel = config.logLevel
    ;(config as any).logLevel = 'info'
    const logged = await buildApp({ rateLimit: false, backfill: false, logStream: { write: (m) => void lines.push(m) } })
    ;(config as any).logLevel = prevLevel
    await logged.ready()
    try {
      const s = await seed()
      const { code } = (await logged.inject({ method: 'POST', url: '/api/hyperfy/pair', payload: { worldKey: s.key, secretHash: sha256(SECRET) } })).json()
      for (const url of [`/api/hyperfy/pair/${code}/claim`, `/api/hyperfy/pair/${code.toLowerCase()}/qr.png`, `/api/hyperfy/pair/${code.slice(0, 3)}-${code.slice(3)}`, `/api/hyperfy/pair/${code}/claim?x=1`]) {
        await logged.inject({ method: url.endsWith('claim') || url.includes('claim?') ? 'POST' : 'GET', url, payload: url.includes('claim') ? { secret: SECRET } : undefined })
      }
      const all = lines.join('\n')
      expect(all).toContain('/api/hyperfy/pair/')
      expect(all.toUpperCase()).not.toContain(code)
      expect(all.toUpperCase()).not.toContain(`${code.slice(0, 3)}-${code.slice(3)}`)
    } finally {
      await logged.close()
    }
  })

  it('approval page links (/pair/<code>) and unmatched urls never put a code in the request log or a metric label', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vlm-dash-'))
    mkdirSync(join(dir, 'pair', '_'), { recursive: true })
    writeFileSync(join(dir, 'pair', '_', 'index.html'), '<p>pair</p>')
    writeFileSync(join(dir, 'index.html'), '<p>spa</p>')
    const lines: string[] = []
    const prev = { logLevel: config.logLevel, dashboardDir: config.dashboardDir, metricsEnabled: config.metricsEnabled }
    Object.assign(config as any, { logLevel: 'info', dashboardDir: dir, metricsEnabled: true })
    const logged = await buildApp({ rateLimit: false, backfill: false, logStream: { write: (m) => void lines.push(m) } })
    Object.assign(config as any, prev)
    await logged.ready()
    try {
      const code = 'K7Q4XP'
      const page = await logged.inject({ method: 'GET', url: `/pair/${code}` })
      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('pair')
      for (const url of [`/pair/${code}/`, `/pair/${code.toLowerCase()}?from=qr`, `/pair/K7Q-4XP`]) {
        await logged.inject({ method: 'GET', url })
      }
      // 404s and the SPA fallback match no route: their metric label is fixed, never the raw url
      const stray = 'ZZ9WW8'
      expect((await logged.inject({ method: 'GET', url: `/api/nope/${stray}` })).statusCode).toBe(404)
      await logged.inject({ method: 'GET', url: `/somewhere/${stray}` })
      const all = lines.join('\n')
      expect(all).toContain('/pair/:code')
      expect(all.toUpperCase()).not.toContain(code)
      expect(all.toUpperCase()).not.toContain('K7Q-4XP')
      const metrics = await register.metrics()
      expect(metrics).toContain('route="/pair/:code"')
      expect(metrics).toContain('route="unmatched"')
      expect(metrics.toUpperCase()).not.toContain(code)
      expect(metrics).not.toContain(stray)
    } finally {
      await logged.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('vouch rate limit', () => {
    const prev = { ...vouchLimiter }
    afterEach(() => Object.assign(vouchLimiter, prev))

    it('is per world, after the secret check, and the IP limit does not throttle it', async () => {
      const a = await seed(true)
      const b = await seed(true)
      vouchLimiter.max = 3
      for (let i = 0; i < 3; i++) expect((await vouch(a, { hyperfyPlayerId: `p${i}` })).statusCode).toBe(200)
      expect((await vouch(a, { hyperfyPlayerId: 'p9' })).statusCode).toBe(429)
      // another world from the same IP is unaffected
      expect((await vouch(b)).statusCode).toBe(200)
      // a bad secret is refused before it counts or is limited
      expect((await vouch(a, { worldSecret: 'x'.repeat(64) })).statusCode).toBe(401)
      expect((await vouch(b, { worldSecret: 'x'.repeat(64) })).statusCode).toBe(401)
      expect((await vouch(b, { hyperfyPlayerId: 'q2' })).statusCode).toBe(200)
    })

    it('is not throttled by the per-IP limiter', async () => {
      const limited = await buildApp({ rateLimit: true, logger: false, backfill: false })
      await limited.ready()
      try {
        const s = await seed(true)
        for (let i = 0; i < config.rateLimitMax + 5; i++) {
          const r = await limited.inject({ method: 'POST', url: '/api/hyperfy/pairings/vouch', payload: { worldKey: s.key, worldSecret: WORLD_SECRET, hyperfyPlayerId: 'same', playerName: 'P' } })
          if (r.statusCode !== 200) throw new Error(`call ${i} -> ${r.statusCode}`)
        }
      } finally {
        await limited.close()
      }
    })
  })

  it('vouch with pendingPairingId polls without minting codes, then links once approved', async () => {
    const s = await seed(true)
    const first = (await vouch(s)).json()
    expect(first.status).toBe('unlinked')
    for (let i = 0; i < 3; i++) {
      const poll = await vouch(s, { pendingPairingId: first.pairingId })
      expect(poll.json()).toEqual({ status: 'pending' })
    }
    expect(await db.select().from(hyperfyPairings)).toHaveLength(1)
    // another player's pairing id, or an id of another world, is not this player's pending pairing
    expect((await vouch(s, { hyperfyPlayerId: 'player-2', pendingPairingId: first.pairingId })).json()).toEqual({ status: 'expired' })
    expect((await vouch(s, { pendingPairingId: 'not-a-uuid' })).json()).toEqual({ status: 'expired' })
    await app.inject({ method: 'POST', url: `/api/hyperfy/pair/${first.code}/approve`, headers: bearer(tokenFor(s.owner)) })
    const linked = (await vouch(s, { pendingPairingId: first.pairingId })).json()
    expect(linked).toMatchObject({ status: 'linked', pairingId: first.pairingId, sceneId: s.scene.id, user: { id: s.owner.id } })
    // once claimed, the same call is just a normal vouch
    expect((await vouch(s, { pendingPairingId: first.pairingId })).json()).toMatchObject({ status: 'linked', pairingId: first.pairingId })
    expect(await db.select().from(hyperfyPairings)).toHaveLength(1)
  })

  it('vouch poll reports refused and expired pairings', async () => {
    const s = await seed(true)
    const stranger = await createUser({ wallet: randomWallet() })
    const refused = (await vouch(s)).json()
    await app.inject({ method: 'POST', url: `/api/hyperfy/pair/${refused.code}/approve`, headers: bearer(tokenFor(stranger)) })
    expect((await vouch(s, { pendingPairingId: refused.pairingId })).json()).toEqual({ status: 'refused' })

    const stale = (await vouch(s, { hyperfyPlayerId: 'player-3' })).json()
    await db.update(hyperfyPairings).set({ codeExpiresAt: new Date(Date.now() - 1000) }).where(eq(hyperfyPairings.id, stale.pairingId))
    expect((await vouch(s, { hyperfyPlayerId: 'player-3', pendingPairingId: stale.pairingId })).json()).toEqual({ status: 'expired' })

    // approved, then its code window passes before the poll: expired, no pass
    const late = (await vouch(s, { hyperfyPlayerId: 'player-4' })).json()
    await app.inject({ method: 'POST', url: `/api/hyperfy/pair/${late.code}/approve`, headers: bearer(tokenFor(s.owner)) })
    await db.update(hyperfyPairings).set({ codeExpiresAt: new Date(Date.now() - 1000) }).where(eq(hyperfyPairings.id, late.pairingId))
    expect((await vouch(s, { hyperfyPlayerId: 'player-4', pendingPairingId: late.pairingId })).json()).toEqual({ status: 'expired' })
  })
})
