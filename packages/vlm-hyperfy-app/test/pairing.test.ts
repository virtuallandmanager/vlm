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
  res(200, { status: 'approved', pass, passExpiresAt: new Date(T0 + ttlMs).toISOString(), pairingId: 'pid-1', user: { id: 'u', displayName: 'Ada' } })

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
    expect(t.states.at(-1)).toEqual({ status: 'linked', displayName: 'Ada' })
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

  it('a revoked pairing is lost; a failed renew backs off and retries', async () => {
    const t = make({
      'POST /api/hyperfy/pair': [res(200, START)],
      'POST /api/hyperfy/pair/ABC234/claim': [approved('PASS1', 15 * 60_000)],
      'POST /api/hyperfy/pairings/pid-1/renew': [undefined, res(401, { error: 'pairing_revoked' })],
    })
    t.p.start('Ada')
    await t.advance(HYPERFY_PAIRING.claimPollMs)
    await t.advance(15 * 60_000 - HYPERFY_PAIRING.renewBeforeMs - HYPERFY_PAIRING.claimPollMs + 100)
    expect(t.calls.filter((c) => c.url.endsWith('/renew')).length).toBe(1)
    expect(t.states.at(-1)).toEqual({ status: 'linked', displayName: 'Ada' })
    await t.advance(5_000)
    expect(t.calls.filter((c) => c.url.endsWith('/renew')).length).toBe(2)
    expect(t.states.at(-1)).toEqual({ status: 'lost' })
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
    t.p.adopt({ pass: 'H1', passExpiresAt: new Date(T0 + 10 * 60_000).toISOString(), displayName: 'Bo' })
    expect(t.p.pass()).toBe('H1')
    expect(t.states.at(-1)).toEqual({ status: 'linked', displayName: 'Bo' })
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

describe('VlmApi with Pairing', () => {
  it('an expired pass keeps the draft and Save succeeds after renew', async () => {
    const t = make(
      {
        'POST /api/hyperfy/pair': [res(200, START)],
        'POST /api/hyperfy/pair/ABC234/claim': [approved('OLD', 15 * 60_000)],
        'POST /api/hyperfy/pairings/pid-1/renew': [res(200, { pass: 'NEW', passExpiresAt: new Date(T0 + 45 * 60_000).toISOString() })],
        'PUT /api/instances/i1': [(): Res => res(401, { error: 'x' }), res(200, { instance: { id: 'i1' } })],
      },
    )
    let failures = 0
    const api = new VlmApi({ feedUrl: 'https://api.example', fetch: t.fetch, getPass: () => t.p.pass(), onAuthFailure: () => { failures++; void t.p.renewNow() } })
    t.p.start('Ada')
    await t.advance(HYPERFY_PAIRING.claimPollMs)
    const draft = { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 90, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
    const first = await api.saveTransform('i1', draft)
    expect(first).toEqual({ ok: false, reason: 'auth' })
    expect(failures).toBe(1)
    await t.advance(0)
    expect(t.p.pass()).toBe('NEW')
    const second = await api.saveTransform('i1', draft)
    expect(second.ok).toBe(true)
    const puts = t.calls.filter((c) => c.init.method === 'PUT')
    expect(puts[0].init.headers!.Authorization).toBe('Bearer OLD')
    expect(puts[1].init.headers!.Authorization).toBe('Bearer NEW')
  })
})
