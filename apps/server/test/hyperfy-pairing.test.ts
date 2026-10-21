import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { HYPERFY_PAIRING, normalizePairingCode, DEFAULT_VENUE_RULES } from 'vlm-shared'
import { db } from '../src/db/connection.js'
import { hyperfyPairings, hyperfyWorlds, venues, bookings, accessGrants } from '../src/db/schema.js'
import { createWorldKey } from '../src/hyperfy/worlds.js'
import { actorFromClaims } from '../src/auth/actor.js'
import { verifySessionToken } from '../src/auth/tokens.js'
import { startPairing, pairingForApproval, approvePairing, claimPairing, renewPairing, revokePairing, listPairings, pairingActive } from '../src/hyperfy/pairing.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, randomWallet, type TestUser } from './helpers/factories.js'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const actor = (u: TestUser) => actorFromClaims({ id: u.id, email: u.email, role: u.role, wallet: u.wallet, verified: true })
const SECRET = 'browser-secret-1'

describe('Hyperfy pairings and passes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(() => app.close())

  async function seed() {
    const owner = await createUser({ wallet: randomWallet() })
    const { scene } = await createScene(owner)
    const key = createWorldKey()
    const [world] = await db.insert(hyperfyWorlds).values({ sceneId: scene.id, ownerId: owner.id, name: 'Arbor World', keyHash: key.hash, keyPrefix: key.prefix }).returning()
    return { owner, scene, world, key: key.raw }
  }
  async function pair(s: Awaited<ReturnType<typeof seed>>, player: string | null = 'Pip') {
    return startPairing(s.key, sha256(SECRET), player, null)
  }

  it('a code from a valid world key; invalid key throws', async () => {
    const s = await seed()
    const before = Date.now()
    const { code, expiresAt } = await pair(s)
    expect(normalizePairingCode(code)).toBe(code)
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + HYPERFY_PAIRING.codeTtlMs - 1000)
    await expect(startPairing('vlmw_nope', sha256(SECRET), null, null)).rejects.toThrow('invalid_world_key')
    const info = await pairingForApproval(code)
    expect(info).toMatchObject({ worldName: 'Arbor World', sceneId: s.scene.id, sceneName: s.scene.name, playerName: 'Pip' })
    expect(await pairingForApproval('ZZZZZZ')).toBeNull()
  })

  it('approval by a user without editing access is refused and the claim never returns a pass', async () => {
    const s = await seed()
    const stranger = await createUser({ wallet: randomWallet() })
    const { code } = await pair(s)
    expect(await approvePairing(code, actor(stranger))).toBe('no_access')
    const [row] = await db.select().from(hyperfyPairings)
    expect(row.status).toBe('refused')
    expect(await claimPairing(code, SECRET, app)).toEqual({ status: 'refused' })
  })

  it('owner approves, claim returns a pass bound to the world\'s scene with via hyperfy and the pairing id', async () => {
    const s = await seed()
    const { code } = await pair(s)
    expect(await claimPairing(code, SECRET, app)).toEqual({ status: 'pending' })
    expect(await approvePairing(code, actor(s.owner))).toBe('approved')
    const res = await claimPairing(code, SECRET, app)
    expect(res.status).toBe('approved')
    if (res.status !== 'approved') throw new Error('unreachable')
    const claims = verifySessionToken(res.pass)!
    expect(claims).toMatchObject({ kind: 'scene', sceneId: s.scene.id, id: s.owner.id, wallet: s.owner.wallet, verified: true, via: 'hyperfy', pairingId: res.pairingId, worldId: s.world.id })
    expect(res.user).toEqual({ id: s.owner.id, displayName: s.owner.displayName })
    expect(res.sceneId).toBe(s.scene.id)
    expect(new Date(res.passExpiresAt).getTime()).toBeGreaterThan(Date.now())
    const [row] = await db.select().from(hyperfyPairings)
    expect(row.status).toBe('claimed')
    expect(row.codeHash).toBeNull()
    expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now() + HYPERFY_PAIRING.selfPairingTtlMs - 5000)
  })

  it('a booking host can approve; their pass carries their verified wallet', async () => {
    const s = await seed()
    const host = await createUser({ wallet: randomWallet() })
    const { preset } = await createScene(s.owner, 'tmp')
    const startsAt = new Date(Date.now() - 3_600_000), endsAt = new Date(Date.now() + 3_600_000)
    const [venue] = await db.insert(venues).values({ sceneId: s.scene.id, name: 'V', slug: `v-${crypto.randomUUID()}`, defaultPresetId: preset.id, rules: DEFAULT_VENUE_RULES, rentableElementIds: [] } as any).returning()
    const [booking] = await db.insert(bookings).values({ venueId: venue.id, renterUserId: host.id, title: 'Show', startsAt, endsAt, status: 'live', bookingPresetId: preset.id, blockedRange: `[${startsAt.toISOString()},${endsAt.toISOString()})` } as any).returning()
    await db.insert(accessGrants).values({ bookingId: booking.id, sceneId: s.scene.id, userId: host.id, walletAddress: host.wallet, role: 'host', scopes: ['screens', 'playlist'], validFrom: startsAt, validUntil: new Date(endsAt.getTime() + 900_000) } as any)
    const { code } = await pair(s)
    expect(await approvePairing(code, actor(host))).toBe('approved')
    const res = await claimPairing(code, SECRET, app)
    if (res.status !== 'approved') throw new Error('not approved')
    expect(verifySessionToken(res.pass)).toMatchObject({ id: host.id, wallet: host.wallet, sceneId: s.scene.id })
  })

  it('a user without a verified wallet gets a pass with a null wallet', async () => {
    const s = await seed()
    const noWallet = await createUser({ wallet: null })
    const { scene } = await createScene(noWallet)
    await db.update(hyperfyWorlds).set({ sceneId: scene.id }).where(eq(hyperfyWorlds.id, s.world.id))
    const { code } = await pair(s)
    expect(await approvePairing(code, actor(noWallet))).toBe('approved')
    const res = await claimPairing(code, SECRET, app)
    if (res.status !== 'approved') throw new Error('not approved')
    expect(verifySessionToken(res.pass)!.wallet).toBeNull()
  })

  it('claim with the wrong secret returns pending and doesn\'t consume the code', async () => {
    const s = await seed()
    const { code } = await pair(s)
    await approvePairing(code, actor(s.owner))
    expect(await claimPairing(code, 'wrong', app)).toEqual({ status: 'pending' })
    expect((await claimPairing(code, SECRET, app)).status).toBe('approved')
  })

  it('a code can be claimed once', async () => {
    const s = await seed()
    const { code } = await pair(s)
    await approvePairing(code, actor(s.owner))
    const results = await Promise.all([claimPairing(code, SECRET, app), claimPairing(code, SECRET, app)])
    expect(results.filter((r) => r.status === 'approved')).toHaveLength(1)
    expect((await claimPairing(code, SECRET, app)).status).toBe('expired')
  })

  it('an expired code is expired', async () => {
    const s = await seed()
    const { code } = await pair(s)
    const later = new Date(Date.now() + HYPERFY_PAIRING.codeTtlMs + 1000)
    expect(await approvePairing(code, actor(s.owner), later)).toBe('expired')
    expect(await claimPairing(code, SECRET, app, later)).toEqual({ status: 'expired' })
    expect(await pairingForApproval(code, later)).toBeNull()
  })

  it('renew issues a fresh pass and bumps lastUsedAt; renew after revoke is revoked', async () => {
    const s = await seed()
    const { code } = await pair(s)
    await approvePairing(code, actor(s.owner))
    const res = await claimPairing(code, SECRET, app)
    if (res.status !== 'approved') throw new Error('not approved')
    expect(await renewPairing(res.pairingId, 'wrong', app)).toBe('revoked')
    const renewed = await renewPairing(res.pairingId, SECRET, app)
    if (typeof renewed === 'string') throw new Error(renewed)
    expect(verifySessionToken(renewed.pass)).toMatchObject({ via: 'hyperfy', pairingId: res.pairingId, sceneId: s.scene.id })
    expect(renewed.sceneId).toBe(s.scene.id)
    const [row] = await db.select().from(hyperfyPairings)
    expect(row.lastUsedAt).not.toBeNull()
    expect((await listPairings(s.owner.id)).map((p) => p.id)).toEqual([res.pairingId])
    expect(await revokePairing(res.pairingId, s.owner.id)).toBe(true)
    expect(await renewPairing(res.pairingId, SECRET, app)).toBe('revoked')
    expect(await listPairings(s.owner.id)).toEqual([])
    expect(await revokePairing(res.pairingId, s.owner.id)).toBe(false)
  })

  it('self pairing expires after 12 h', async () => {
    const s = await seed()
    const { code } = await pair(s)
    await approvePairing(code, actor(s.owner))
    const res = await claimPairing(code, SECRET, app)
    if (res.status !== 'approved') throw new Error('not approved')
    const later = new Date(Date.now() + HYPERFY_PAIRING.selfPairingTtlMs + 60_000)
    expect(await pairingActive(res.pairingId)).toBe(true)
    expect(await pairingActive(res.pairingId, later)).toBe(false)
    expect(await renewPairing(res.pairingId, SECRET, app, later)).toBe('expired')
  })

  it('a hosted pairing has no expiresAt, expires after 90 idle days, and refuses secret claim/renew', async () => {
    const s = await seed()
    const { code } = await startPairing(s.key, null, 'Hosted Pip', 'player-1')
    expect(await claimPairing(code, SECRET, app)).toEqual({ status: 'expired' })
    await approvePairing(code, actor(s.owner))
    const [row] = await db.select().from(hyperfyPairings)
    await db.update(hyperfyPairings).set({ status: 'claimed', codeHash: null, expiresAt: null }).where(eq(hyperfyPairings.id, row.id))
    const idle = new Date(Date.now() + HYPERFY_PAIRING.hostedIdleTtlMs - 60_000)
    expect(await pairingActive(row.id, idle)).toBe(true)
    expect(await pairingActive(row.id, new Date(Date.now() + HYPERFY_PAIRING.hostedIdleTtlMs + 60_000))).toBe(false)
    expect(await renewPairing(row.id, SECRET, app)).toBe('revoked')
    expect((await listPairings(s.owner.id))[0]).toMatchObject({ kind: 'hosted', expiresAt: null })
  })

  it('a revoked pairing\'s pass is refused by the middleware at once', async () => {
    const s = await seed()
    const { code } = await pair(s)
    await approvePairing(code, actor(s.owner))
    const res = await claimPairing(code, SECRET, app)
    if (res.status !== 'approved') throw new Error('not approved')
    const call = () => app.inject({ method: 'GET', url: `/api/scenes/${s.scene.id}/library`, headers: { authorization: `Bearer ${res.pass}` } })
    expect((await call()).statusCode).toBe(200)
    expect(await revokePairing(res.pairingId, s.owner.id)).toBe(true)
    const after = await call()
    expect(after.statusCode).toBe(401)
    expect(after.json()).toEqual({ error: 'pairing_revoked' })
    // an ordinary account token is unaffected
    expect((await app.inject({ method: 'GET', url: `/api/scenes/${s.scene.id}/library`, headers: { authorization: `Bearer ${tokenFor(s.owner)}` } })).statusCode).toBe(200)
  })

  it('startPairing needs exactly one of secretHash and hyperfyPlayerId', async () => {
    const s = await seed()
    await expect(startPairing(s.key, sha256(SECRET), 'Pip', 'player-1')).rejects.toThrow('invalid_pairing_kind')
    await expect(startPairing(s.key, null, 'Pip', null)).rejects.toThrow('invalid_pairing_kind')
    expect(await db.select().from(hyperfyPairings)).toHaveLength(0)
    // the database refuses it too
    await expect(db.insert(hyperfyPairings).values({ worldId: s.world.id, codeHash: 'x', secretHash: 'a', hyperfyPlayerId: 'p', status: 'pending', codeExpiresAt: new Date() })).rejects.toThrow()
    await expect(db.insert(hyperfyPairings).values({ worldId: s.world.id, codeHash: 'y', secretHash: null, hyperfyPlayerId: null, status: 'pending', codeExpiresAt: new Date() })).rejects.toThrow()
  })

  it('a Hyperfy pass can\'t create a hand-off code', async () => {
    const s = await seed()
    const { code } = await pair(s)
    await approvePairing(code, actor(s.owner))
    const res = await claimPairing(code, SECRET, app)
    if (res.status !== 'approved') throw new Error('not approved')
    const out = await app.inject({ method: 'POST', url: '/api/auth/handoff', headers: { authorization: `Bearer ${res.pass}` } })
    expect(out.statusCode).toBe(403)
    expect(out.json()).toEqual({ error: 'hyperfy_pass_not_allowed' })
  })

  it('codes and secrets are stored only as hashes', async () => {
    const s = await seed()
    const { code } = await pair(s)
    const [row] = await db.select().from(hyperfyPairings)
    expect(row.codeHash).toBe(sha256(code))
    expect(row.secretHash).toBe(sha256(SECRET))
    const dump = JSON.stringify(row)
    expect(dump).not.toContain(code)
    expect(dump).not.toContain(SECRET)
  })
})
