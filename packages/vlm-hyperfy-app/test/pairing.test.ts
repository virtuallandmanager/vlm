import { describe, expect, it } from 'vitest'
import { HYPERFY_PAIRING } from 'vlm-shared'
import { Pairing, type PairingState } from '../src/pairing.js'
import { sha256Hex } from '../src/sha256.js'
import { VlmApi } from '../src/vlm-api.js'

type Res = { ok: boolean; status: number; json(): Promise<unknown> } | undefined
type Call = { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }
const res = (status: number, body: unknown = {}): Res => ({ ok: status >= 200 && status < 300, status, json: async () => body })

const START = { code: 'ABC234', approveUrl: 'https://vlm.gg/pair/ABC234', qrUrl: 'https://api/qr.png', expiresAt: '2026-10-21T00:10:00.000Z' }
const T0 = Date.parse('2026-10-21T00:00:00.000Z')

/** Fake clock + timers + fetch routed by "METHOD path". */
function harness(routes: Record<string, Array<Res | (() => Res)>>) {
  const calls: Call[] = []
  const timers: Array<{ fn: () => void; at: number }> = []
  let now = T0
  const fetch = async (url: string, init: object): Promise<Res> => {
    const c = { url, init: init as Call['init'] }
    calls.push(c)
    const key = `${c.init.method} ${url.replace('https://api.example', '')}`
    const q = routes[key]
    if (!q) throw new Error(`unrouted ${key}`)
    const r = q.length > 1 ? q.shift()! : q[0]
    return typeof r === 'function' ? r() : r
  }
  const setTimeout = (fn: () => void, ms: number) => {
    timers.push({ fn, at: now + ms })
    timers.sort((a, b) => a.at - b.at)
    return 1
  }
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  /** Moves the clock forward, firing due timers in order. */
  const advance = async (ms: number) => {
    const end = now + ms
    await settle()
    while (timers.length && timers[0].at <= end) {
      const t = timers.shift()!
      now = Math.max(now, t.at)
      t.fn()
      await settle()
    }
    now = end
  }
  let n = 0
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  return { calls, fetch, setTimeout, advance, settle, uuid, now: () => now, timers }
}

function make(routes: Record<string, Array<Res | (() => Res)>>, extra: Partial<ConstructorParameters<typeof Pairing>[0]> = {}) {
  const h = harness(routes)
  const states: PairingState[] = []
  const p = new Pairing({
    feedUrl: 'https://api.example',
    worldKey: 'vlmw_k',
    fetch: h.fetch,
    setTimeout: h.setTimeout,
    uuid: h.uuid,
    now: h.now,
    onState: (s) => states.push(s),
    ...extra,
  })
  return { ...h, p, states }
}

const approved = (pass: string, ttlMs: number) =>
  res(200, { status: 'approved', pass, passExpiresAt: new Date(T0 + ttlMs).toISOString(), pairingId: 'pid-1', sceneId: 'scene-1', user: { id: 'u', displayName: 'Ada' } })

describe('Pairing', () => {
  it("start posts the secret's hash, never the secret", async () => {
    const t = make({ 'POST /api/hyperfy/pair': [res(200, START)], 'POST /api/hyperfy/pair/ABC234/claim': [res(200, { status: 'pending' })] })
    t.p.start('Ada')
    await t.advance(HYPERFY_PAIRING.claimPollMs)
    const start = t.calls[0]
    const body = JSON.parse(start.init.body!)
    const secret = ['1', '2', '3'].map((i) => `00000000-0000-4000-8000-${i.padStart(12, '0')}`).join('')
    expect(body).toEqual({ worldKey: 'vlmw_k', playerName: 'Ada', secretHash: sha256Hex(secret) })
    expect(start.init.body).not.toContain(secret)
    expect(t.states.at(-1)).toEqual({ status: 'waiting', code: 'ABC234', approveUrl: START.approveUrl, qrUrl: START.qrUrl, expiresAt: START.expiresAt })
  })

  it('claim polling stops on approved and adopts the pass', async () => {
    const t = make({
      'POST /api/hyperfy/pair': [res(200, START)],
      'POST /api/hyperfy/pair/ABC234/claim': [res(200, { status: 'pending' }), res(200, { status: 'pending' }), approved('PASS1', 15 * 60_000)],
    })
    t.p.start('Ada')
    await t.advance(HYPERFY_PAIRING.claimPollMs)
    expect(t.p.pass()).toBeNull()
    await t.advance(HYPERFY_PAIRING.claimPollMs * 2)
    expect(t.p.pass()).toBe('PASS1')
    expect(t.states.at(-1)).toEqual({ status: 'linked', displayName: 'Ada', sceneId: 'scene-1' })
    const claims = t.calls.filter((c) => c.url.endsWith('/claim')).length
    expect(claims).toBe(3)
    await t.advance(60_000)
    expect(t.calls.filter((c) => c.url.endsWith('/claim')).length).toBe(3)
    expect(JSON.parse(t.calls.find((c) => c.url.endsWith('/claim'))!.init.body!)).toEqual({
      secret: ['1', '2', '3'].map((i) => `00000000-0000-4000-8000-${i.padStart(12, '0')}`).join(''),
    })
  })

  it('a refused or expired claim ends in expired', async () => {
    const t = make({ 'POST /api/hyperfy/pair': [res(200, START)], 'POST /api/hyperfy/pair/ABC234/claim': [res(200, { status: 'refused' })] })
    t.p.start('Ada')
    await t.advance(HYPERFY_PAIRING.claimPollMs)
    expect(t.states.at(-1)).toEqual({ status: 'expired' })
    expect(t.p.pass()).toBeNull()
  })

  it('claim polling survives a lost connection', async () => {
    const t = make({
      'POST /api/hyperfy/pair': [res(200, START)],
      'POST /api/hyperfy/pair/ABC234/claim': [undefined, approved('PASS1', 15 * 60_000)],
    })
    t.p.start('Ada')
    await t.advance(HYPERFY_PAIRING.claimPollMs)
    await t.advance(10_000)
    expect(t.p.pass()).toBe('PASS1')
  })

  it('renew happens 2 minutes before expiry', async () => {
    const t = make({
      'POST /api/hyperfy/pair': [res(200, START)],
      'POST /api/hyperfy/pair/ABC234/claim': [approved('PASS1', 15 * 60_000)],
      'POST /api/hyperfy/pairings/pid-1/renew': [res(200, { pass: 'PASS2', passExpiresAt: new Date(T0 + 30 * 60_000).toISOString() })],
    })
    t.p.start('Ada')
    await t.advance(HYPERFY_PAIRING.claimPollMs)
    await t.advance(15 * 60_000 - HYPERFY_PAIRING.renewBeforeMs - HYPERFY_PAIRING.claimPollMs - 1000)
    expect(t.calls.some((c) => c.url.endsWith('/renew'))).toBe(false)
    await t.advance(2000)
    expect(t.calls.filter((c) => c.url.endsWith('/renew')).length).toBe(1)
    expect(t.p.pass()).toBe('PASS2')
    expect(JSON.parse(t.calls.find((c) => c.url.endsWith('/renew'))!.init.body!).secret).toHaveLength(108)
  })

  it('a renewal carries the pass\'s scene id into the linked state', async () => {
    const t = make({
      'POST /api/hyperfy/pair': [res(200, START)],
      'POST /api/hyperfy/pair/ABC234/claim': [approved('PASS1', 15 * 60_000)],
      'POST /api/hyperfy/pairings/pid-1/renew': [res(200, { pass: 'PASS2', passExpiresAt: new Date(T0 + 30 * 60_000).toISOString(), sceneId: 'scene-2' })],
    })
    t.p.start('Ada')
    await t.advance(HYPERFY_PAIRING.claimPollMs)
    expect(t.states.at(-1)).toEqual({ status: 'linked', displayName: 'Ada', sceneId: 'scene-1' })
    await t.advance(15 * 60_000)
    expect(t.states.at(-1)).toEqual({ status: 'linked', displayName: 'Ada', sceneId: 'scene-2' })
    t.p.stop()
  })

  it('a revoked pairing is expired; a failed renew backs off and retries', async () => {
    const t = make({
      'POST /api/hyperfy/pair': [res(200, START)],
      'POST /api/hyperfy/pair/ABC234/claim': [approved('PASS1', 15 * 60_000)],
      'POST /api/hyperfy/pairings/pid-1/renew': [undefined, res(401, { error: 'pairing_revoked' })],
    })
    t.p.start('Ada')
    await t.advance(HYPERFY_PAIRING.claimPollMs)
    await t.advance(15 * 60_000 - HYPERFY_PAIRING.renewBeforeMs - HYPERFY_PAIRING.claimPollMs + 100)
    expect(t.calls.filter((c) => c.url.endsWith('/renew')).length).toBe(1)
    expect(t.states.at(-1)).toEqual({ status: 'lost' })
    await t.advance(5_000)
    expect(t.calls.filter((c) => c.url.endsWith('/renew')).length).toBe(2)
    expect(t.states.at(-1)).toEqual({ status: 'expired' })
    expect(t.p.pass()).toBeNull()
  })

  it('adopt installs a hosted link and renews through the injected renewer', async () => {
    let renews = 0
    const t = make(
      {},
      {
        renewer: async () => {
          renews++
          return { pass: 'H2', passExpiresAt: new Date(T0 + 40 * 60_000).toISOString() }
        },
      },
    )
    t.p.adopt({ pass: 'H1', passExpiresAt: new Date(T0 + 10 * 60_000).toISOString(), displayName: 'Bo', sceneId: 'scene-1' })
    expect(t.p.pass()).toBe('H1')
    expect(t.states.at(-1)).toEqual({ status: 'linked', displayName: 'Bo', sceneId: 'scene-1' })
    await t.advance(10 * 60_000 - HYPERFY_PAIRING.renewBeforeMs + 10)
    expect(renews).toBe(1)
    expect(t.p.pass()).toBe('H2')
    expect(t.calls).toHaveLength(0)
    t.p.stop()
  })

  it('stop cancels pending work', async () => {
    const t = make({ 'POST /api/hyperfy/pair': [res(200, START)], 'POST /api/hyperfy/pair/ABC234/claim': [res(200, { status: 'pending' })] })
    t.p.start('Ada')
    await t.advance(HYPERFY_PAIRING.claimPollMs)
    t.p.stop()
    const n = t.calls.length
    await t.advance(30_000)
    expect(t.calls.length).toBe(n)
  })
})


const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()

describe('Pairing: fix round 1', () => {
  it('a 401-triggered renew does not leave the old renew timer running: one renew per pass lifetime', async () => {
    let t!: ReturnType<typeof make>
    const fresh = (): Res => res(200, { pass: 'P' + t.calls.length, passExpiresAt: iso(t.now() + 15 * MIN) })
    t = make({
      'POST /api/hyperfy/pair': [res(200, START)],
      'POST /api/hyperfy/pair/ABC234/claim': [approved('P1', 15 * MIN)],
      'POST /api/hyperfy/pairings/pid-1/renew': [fresh],
    })
    t.p.start('Ada')
    await t.advance(HYPERFY_PAIRING.claimPollMs)
    await t.advance(MIN)
    await t.p.renewNow() // what onAuthFailure does
    await t.advance(60 * MIN)
    // renews at 1, 14, 27, 40, 53 minutes after the 401
    expect(t.calls.filter((c) => c.url.endsWith('/renew')).length).toBe(5)
  })

  it('renew 401 is expired; network failures are lost while retrying, and expired once the pass runs out', async () => {
    const t = make({
      'POST /api/hyperfy/pair': [res(200, START)],
      'POST /api/hyperfy/pair/ABC234/claim': [approved('P1', 15 * MIN)],
      'POST /api/hyperfy/pairings/pid-1/renew': [undefined],
    })
    t.p.start('Ada')
    await t.advance(HYPERFY_PAIRING.claimPollMs)
    await t.advance(14 * MIN)
    expect(t.states.at(-1)).toEqual({ status: 'lost' })
    expect(t.p.pass()).toBe('P1')
    await t.advance(2 * MIN)
    expect(t.states.at(-1)).toEqual({ status: 'expired' })
    expect(t.states.filter((s) => s.status === 'expired')).toHaveLength(1)
    expect(t.p.pass()).toBeNull()
  })

  it('after the pass really expires, a failing renew then a successful one lets Save succeed', async () => {
    let ok = false
    const t = make({
      'POST /api/hyperfy/pair': [res(200, START)],
      'POST /api/hyperfy/pair/ABC234/claim': [approved('OLD', 15 * MIN)],
      'POST /api/hyperfy/pairings/pid-1/renew': [(): Res => (ok ? res(200, { pass: 'NEW', passExpiresAt: iso(T0 + 60 * MIN) }) : undefined)],
      'PUT /api/instances/i1': [(): Res => res(200, { instance: {} })],
    })
    const api = new VlmApi({ feedUrl: 'https://api.example', fetch: t.fetch, getPass: () => t.p.pass(), onAuthFailure: () => t.p.renewNow() })
    t.p.start('Ada')
    await t.advance(HYPERFY_PAIRING.claimPollMs)
    await t.advance(16 * MIN)
    expect(t.p.pass()).toBeNull()
    const draft = { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
    expect(await api.saveTransform('i1', draft)).toEqual({ ok: false, reason: 'auth' })
    ok = true
    await t.advance(HYPERFY_FEED_MAX)
    expect(t.p.pass()).toBe('NEW')
    expect((await api.saveTransform('i1', draft)).ok).toBe(true)
    expect(t.states.at(-1)).toEqual({ status: 'linked', displayName: 'Ada', sceneId: 'scene-1' })
  })

  it('a failed pair start retries with back-off; invalid_world_key is a terminal error', async () => {
    const t = make({ 'POST /api/hyperfy/pair': [undefined, res(500), res(200, START)], 'POST /api/hyperfy/pair/ABC234/claim': [res(200, { status: 'pending' })] })
    t.p.start('Ada')
    await t.advance(0)
    expect(t.states.at(-1)).toEqual({ status: 'lost' })
    await t.advance(10_000)
    expect(t.calls.filter((c) => c.url.endsWith('/pair')).length).toBe(3)
    expect(t.states.some((s) => s.status === 'waiting')).toBe(true)

    const bad = make({ 'POST /api/hyperfy/pair': [res(401, { error: 'invalid_world_key' })] })
    bad.p.start('Ada')
    await bad.advance(60_000)
    expect(bad.states.at(-1)).toEqual({ status: 'error', reason: 'invalid_world_key' })
    expect(bad.calls).toHaveLength(1)
  })

  it('claim failure back-off never polls faster than claimPollMs', async () => {
    const t = make({ 'POST /api/hyperfy/pair': [res(200, START)], 'POST /api/hyperfy/pair/ABC234/claim': [undefined] })
    t.p.start('Ada')
    await t.advance(HYPERFY_PAIRING.claimPollMs)
    const times = t.timers.map((x) => x.at - t.now())
    expect(times.length).toBe(1)
    expect(times[0]).toBeGreaterThanOrEqual(HYPERFY_PAIRING.claimPollMs)
  })

  it('renewNow is a no-op for a hosted link without a renewer; a malformed expiry is ignored', async () => {
    const t = make({})
    t.p.adopt({ pass: 'H1', passExpiresAt: iso(T0 + 10 * MIN), displayName: 'Bo', sceneId: 'scene-1' })
    expect(await t.p.renewNow()).toBe(false)
    expect(t.calls).toHaveLength(0)
    const u = make({})
    u.p.adopt({ pass: 'X', passExpiresAt: 'not a date', displayName: 'Bo', sceneId: 'scene-1' })
    expect(u.p.pass()).toBeNull()
    expect(u.states).toHaveLength(0)

    const bad = make({}, { renewer: async () => ({ pass: 'Y', passExpiresAt: 'garbage' }) })
    bad.p.adopt({ pass: 'H1', passExpiresAt: iso(T0 + 10 * MIN), displayName: 'Bo', sceneId: 'scene-1' })
    expect(await bad.p.renewNow()).toBe(false)
    expect(bad.p.pass()).toBe('H1')
  })
})

const HYPERFY_FEED_MAX = 30_000

describe('VlmApi with Pairing', () => {
  it('an expired pass keeps no one waiting: Save renews and goes through in one press', async () => {
    const t = make(
      {
        'POST /api/hyperfy/pair': [res(200, START)],
        'POST /api/hyperfy/pair/ABC234/claim': [approved('OLD', 15 * 60_000)],
        'POST /api/hyperfy/pairings/pid-1/renew': [res(200, { pass: 'NEW', passExpiresAt: new Date(T0 + 45 * 60_000).toISOString() })],
        'PUT /api/instances/i1': [(): Res => res(401, { error: 'x' }), res(200, { instance: { id: 'i1' } })],
      },
    )
    let failures = 0
    const api = new VlmApi({ feedUrl: 'https://api.example', fetch: t.fetch, getPass: () => t.p.pass(), onAuthFailure: () => (failures++, t.p.renewOrExpire()) })
    t.p.start('Ada')
    await t.advance(HYPERFY_PAIRING.claimPollMs)
    const draft = { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 90, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
    const saved = await api.saveTransform('i1', draft)
    expect(saved.ok).toBe(true)
    expect(failures).toBe(1)
    expect(t.p.pass()).toBe('NEW')
    const puts = t.calls.filter((c) => c.init.method === 'PUT')
    expect(puts.map((c) => c.init.headers!.Authorization)).toEqual(['Bearer OLD', 'Bearer NEW'])
    expect(t.states.at(-1)).toEqual({ status: 'linked', displayName: 'Ada', sceneId: 'scene-1' })
  })
})

describe('Pairing.renewOrExpire (VLM refused the pass)', () => {
  for (const [name, renew] of [
    ['revoked (renew 401)', res(401)],
    ['a failed renew', undefined],
  ] as const) {
    it(`${name}: the link shows expired at once and stops renewing`, async () => {
      const t = make({
        'POST /api/hyperfy/pair': [res(200, START)],
        'POST /api/hyperfy/pair/ABC234/claim': [approved('P1', 15 * MIN)],
        'POST /api/hyperfy/pairings/pid-1/renew': [renew],
      })
      t.p.start('Ada')
      await t.advance(HYPERFY_PAIRING.claimPollMs)
      expect(await t.p.renewOrExpire()).toBe(false)
      expect(t.states.at(-1)).toEqual({ status: 'expired' })
      expect(t.p.pass()).toBeNull()
      const renews = t.calls.filter((c) => c.url.endsWith('/renew')).length
      await t.advance(60 * MIN)
      expect(t.calls.filter((c) => c.url.endsWith('/renew')).length).toBe(renews)
      expect(t.states.filter((s) => s.status === 'linked')).toHaveLength(1)
    })
  }

  it('a renewed pass is true and stays linked', async () => {
    const t = make({
      'POST /api/hyperfy/pair': [res(200, START)],
      'POST /api/hyperfy/pair/ABC234/claim': [approved('P1', 15 * MIN)],
      'POST /api/hyperfy/pairings/pid-1/renew': [res(200, { pass: 'P2', passExpiresAt: iso(T0 + 30 * MIN) })],
    })
    t.p.start('Ada')
    await t.advance(HYPERFY_PAIRING.claimPollMs)
    expect(await t.p.renewOrExpire()).toBe(true)
    expect(t.p.pass()).toBe('P2')
    expect(t.states.at(-1)).toMatchObject({ status: 'linked' })
  })
})
