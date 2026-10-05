import { describe, it, expect, beforeEach } from 'vitest'
import { DEFAULT_VENUE_RULES, VENUE_ROLE_SCOPES } from 'vlm-shared'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { venues, bookings, accessGrants, sceneCollaborators, organizations, orgMembers, scenes } from '../src/db/schema.js'
import {
  getSceneAccess,
  can,
  canWriteElement,
  scopesForElementChange,
  diffKeys,
  bookingWindowAt,
  linkWalletGrants,
} from '../src/auth/permissions.js'
import { actorFromClaims } from '../src/auth/actor.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement, randomWallet, type TestUser } from './helpers/factories.js'

const H = 3600_000
const actor = (u: TestUser, extra: Record<string, unknown> = {}) =>
  actorFromClaims({ id: u.id, email: u.email, role: u.role, wallet: u.wallet, verified: true, ...extra })

async function seed(opts: { startsInMs?: number } = {}) {
  const owner = await createUser()
  const { scene, preset } = await createScene(owner)
  const screen = await createElement(preset.id, { type: 'video' })
  const bookingPreset = (await createScene(owner, 'tmp')).preset // any preset id works for access tests
  const [venue] = await db
    .insert(venues)
    .values({
      sceneId: scene.id,
      name: 'Neon Arbor',
      slug: `arbor-${crypto.randomUUID()}`,
      defaultPresetId: preset.id,
      rules: DEFAULT_VENUE_RULES,
      rentableElementIds: [screen.id],
    })
    .returning()
  const startsAt = new Date(Date.now() + (opts.startsInMs ?? 24 * H))
  const endsAt = new Date(startsAt.getTime() + 2 * H)
  const [booking] = await db
    .insert(bookings)
    .values({
      venueId: venue.id,
      renterUserId: owner.id,
      title: 'Show',
      startsAt,
      endsAt,
      status: 'confirmed',
      bookingPresetId: bookingPreset.id,
      blockedRange: `[${startsAt.toISOString()},${endsAt.toISOString()})`,
    })
    .returning()
  return { owner, scene, preset, screen, venue, booking, bookingPresetId: bookingPreset.id }
}

async function grant(
  s: Awaited<ReturnType<typeof seed>>,
  who: { wallet?: string | null; userId?: string | null },
  role: keyof typeof VENUE_ROLE_SCOPES = 'vj',
  window: { from?: Date; until?: Date; revoked?: boolean } = {},
) {
  const [g] = await db
    .insert(accessGrants)
    .values({
      bookingId: s.booking.id,
      sceneId: s.scene.id,
      walletAddress: who.wallet ?? null,
      userId: who.userId ?? null,
      role,
      scopes: [...VENUE_ROLE_SCOPES[role]],
      validFrom: window.from ?? new Date(Date.now() - H),
      validUntil: window.until ?? new Date(s.booking.endsAt.getTime() + 15 * 60_000),
      revokedAt: window.revoked ? new Date() : null,
    })
    .returning()
  return g
}

describe('getSceneAccess', () => {
  beforeEach(resetDb)

  it('global admin and scene owner get full access', async () => {
    const s = await seed()
    const admin = await createUser({ role: 'admin' })
    expect((await getSceneAccess(actor(admin), s.scene.id)).level).toBe('admin')
    const ownerAccess = await getSceneAccess(actor(s.owner), s.scene.id)
    expect(ownerAccess.level).toBe('owner')
    expect(ownerAccess.scopes.has('scene.admin')).toBe(true)
  })

  it('org owner/admin get full access; org member does not', async () => {
    const s = await seed()
    const [org] = await db.insert(organizations).values({ name: 'VLM', slug: `vlm-${crypto.randomUUID()}` }).returning()
    await db.update(scenes).set({ orgId: org.id }).where(eq(scenes.id, s.scene.id))
    const orgAdmin = await createUser()
    const member = await createUser()
    await db.insert(orgMembers).values([
      { orgId: org.id, userId: orgAdmin.id, role: 'admin' },
      { orgId: org.id, userId: member.id, role: 'member' },
    ])
    expect((await getSceneAccess(actor(orgAdmin), s.scene.id)).level).toBe('org')
    expect((await getSceneAccess(actor(member), s.scene.id)).level).toBe('none')
  })

  it('editor gets edit + venue scopes but not crew or scene.admin; viewer gets nothing', async () => {
    const s = await seed()
    const editor = await createUser()
    const viewer = await createUser()
    await db.insert(sceneCollaborators).values([
      { sceneId: s.scene.id, userId: editor.id, role: 'editor' },
      { sceneId: s.scene.id, userId: viewer.id, role: 'viewer' },
    ])
    const e = await getSceneAccess(actor(editor), s.scene.id)
    expect(e.level).toBe('editor')
    expect(e.scopes.has('scene.edit')).toBe(true)
    expect(e.scopes.has('screens')).toBe(true)
    expect(e.scopes.has('crew')).toBe(false)
    expect(e.scopes.has('scene.admin')).toBe(false)
    const v = await getSceneAccess(actor(viewer), s.scene.id)
    expect(v.level).toBe('viewer')
    expect(v.scopes.size).toBe(0)
  })

  it('active wallet grant gives its scopes in the setup window', async () => {
    const s = await seed()
    const wallet = randomWallet()
    const crew = await createUser({ wallet })
    await grant(s, { wallet })
    const a = await getSceneAccess(actor(crew), s.scene.id)
    expect(a.level).toBe('grant')
    expect([...a.scopes].sort()).toEqual(['playlist', 'schedule', 'screens'])
    expect(a.booking?.window).toBe('setup')
    expect(a.booking?.bookingPresetId).toBe(s.bookingPresetId)
    expect(await can(actor(crew), s.scene.id, 'screens')).toMatchObject({ ok: true, target: 'bookingPreset' })
    expect((await can(actor(crew), s.scene.id, 'lights.cue')).ok).toBe(false)
  })

  it('grant is live inside the live window', async () => {
    const s = await seed({ startsInMs: 30 * 60_000 }) // starts in 30 min; setup lead is 60 min
    const wallet = randomWallet()
    const crew = await createUser({ wallet })
    await grant(s, { wallet })
    expect(await can(actor(crew), s.scene.id, 'screens')).toMatchObject({ ok: true, target: 'live' })
  })

  it('expired, revoked and not-yet-valid grants give nothing', async () => {
    const s = await seed()
    const [w1, w2, w3] = [randomWallet(), randomWallet(), randomWallet()]
    const [u1, u2, u3] = await Promise.all([createUser({ wallet: w1 }), createUser({ wallet: w2 }), createUser({ wallet: w3 })])
    await grant(s, { wallet: w1 }, 'vj', { from: new Date(Date.now() - 2 * H), until: new Date(Date.now() - H) })
    await grant(s, { wallet: w2 }, 'vj', { revoked: true })
    await grant(s, { wallet: w3 }, 'vj', { from: new Date(Date.now() + H) })
    for (const u of [u1, u2, u3]) expect((await getSceneAccess(actor(u), s.scene.id)).level).toBe('none')
  })

  it('a grant on a canceled booking gives nothing', async () => {
    const s = await seed()
    const wallet = randomWallet()
    const crew = await createUser({ wallet })
    await grant(s, { wallet })
    await db.update(bookings).set({ status: 'canceled' }).where(eq(bookings.id, s.booking.id))
    expect((await getSceneAccess(actor(crew), s.scene.id)).level).toBe('none')
  })

  it('unverified token whose wallet string matches a grant gets nothing', async () => {
    const s = await seed()
    const wallet = randomWallet()
    const crew = await createUser({ wallet })
    await grant(s, { wallet })
    expect((await getSceneAccess(actor(crew, { verified: false }), s.scene.id)).level).toBe('none')
  })

  it('anonymous gets nothing', async () => {
    const s = await seed()
    expect((await getSceneAccess(actorFromClaims(null), s.scene.id)).level).toBe('none')
  })

  it('linkWalletGrants attaches wallet-only grants to the user', async () => {
    const s = await seed()
    const wallet = randomWallet()
    const g = await grant(s, { wallet })
    const crew = await createUser({ wallet })
    expect(await linkWalletGrants(crew.id, wallet.toUpperCase().replace('0X', '0x'))).toBe(1)
    const [row] = await db.select().from(accessGrants).where(eq(accessGrants.id, g.id))
    expect(row.userId).toBe(crew.id)
    // now matches by userId even without a wallet claim
    expect((await getSceneAccess(actor({ ...crew, wallet: null }), s.scene.id)).level).toBe('grant')
  })
})

describe('element write rules', () => {
  const access = (scopes: string[], presetId = 'bp', rentable = ['src-el']) => ({
    level: 'grant' as const,
    scopes: new Set(scopes as any),
    booking: {
      bookingId: 'b',
      grantId: 'g',
      role: 'vj' as const,
      bookingPresetId: presetId,
      window: 'setup' as const,
      validUntil: new Date(),
      rentableElementIds: new Set(rentable),
    },
  })
  const el = { id: 'clone-el', presetId: 'bp', clonedFromId: 'src-el', type: 'video' }

  it('maps video playlist keys to playlist and others to screens', () => {
    expect(scopesForElementChange('video', ['playlist'], [])).toEqual(['playlist'])
    expect(scopesForElementChange('video', ['liveSrc'], [])).toEqual(['screens'])
    expect(scopesForElementChange('video', ['liveSrc', 'playlistIndex'], []).sort()).toEqual(['playlist', 'screens'])
    expect(scopesForElementChange('image', ['textureSrc'], [])).toEqual(['screens'])
    expect(scopesForElementChange('sound', ['audioSrc'], [])).toEqual(['audio'])
    expect(scopesForElementChange('model', ['modelSrc'], [])).toBeNull()
    expect(scopesForElementChange('video', [], ['name'])).toBeNull()
    expect(scopesForElementChange('video', [], ['enabled'])).toEqual(['screens'])
  })

  it('grant may edit a rentable clone in its booking preset with the right scope', () => {
    expect(canWriteElement(access(['screens']), el, { propertyKeys: ['liveSrc'], fieldKeys: [] })).toBe(true)
    expect(canWriteElement(access(['screens']), el, { propertyKeys: ['playlist'], fieldKeys: [] })).toBe(false)
    expect(canWriteElement(access(['screens']), { ...el, presetId: 'live' }, { propertyKeys: ['liveSrc'], fieldKeys: [] })).toBe(false)
    expect(canWriteElement(access(['screens'], 'bp', ['other']), el, { propertyKeys: ['liveSrc'], fieldKeys: [] })).toBe(false)
  })

  it('owner-level access may edit anything', () => {
    const full = { level: 'owner' as const, scopes: new Set<any>(), booking: null }
    expect(canWriteElement(full, { ...el, type: 'model' }, { propertyKeys: ['modelSrc'], fieldKeys: ['name'] })).toBe(true)
  })

  it('diffKeys reports changed, added and removed keys only', () => {
    expect(diffKeys({ a: 1, b: [1], c: 'x' }, { a: 1, b: [2], d: true }).sort()).toEqual(['b', 'c', 'd'])
    expect(diffKeys(null, { a: 1 })).toEqual(['a'])
  })

  it('bookingWindowAt follows setup lead and grace', () => {
    const b = { startsAt: new Date('2026-11-01T20:00:00Z'), endsAt: new Date('2026-11-01T22:00:00Z') }
    expect(bookingWindowAt(b, DEFAULT_VENUE_RULES, new Date('2026-11-01T18:59:59Z'))).toBe('setup')
    expect(bookingWindowAt(b, DEFAULT_VENUE_RULES, new Date('2026-11-01T19:00:00Z'))).toBe('live')
    expect(bookingWindowAt(b, DEFAULT_VENUE_RULES, new Date('2026-11-01T22:14:59Z'))).toBe('live')
    expect(bookingWindowAt(b, DEFAULT_VENUE_RULES, new Date('2026-11-01T22:15:00Z'))).toBeNull()
  })
})
