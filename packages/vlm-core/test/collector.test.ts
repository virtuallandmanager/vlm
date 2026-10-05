import { describe, it, expect, vi } from 'vitest'
import { Collector } from '../src/analytics/collector.js'
import type { AnalyticsProbe, IngestBatch } from 'vlm-shared'

function rig(opts: { insideAt?: (x: number) => boolean } = {}) {
  let now = 0
  let pose: { position: { x: number; y: number; z: number }; headingDeg: number } | null = {
    position: { x: 8, y: 0, z: 8 },
    headingDeg: 92,
  }
  const pending = { interactions: [] as any[], video: [] as any[], emotes: [] as string[] }
  const probe: AnalyticsProbe = {
    getPlayerPose: () => pose,
    getCameraMode: () => 'third',
    isInsideScene: (p) => (opts.insideAt ? opts.insideAt(p.x) : p.x >= 0 && p.x < 16),
    pollInteractions: () => pending.interactions.splice(0),
    pollVideoEvents: () => pending.video.splice(0),
    pollEmotes: () => pending.emotes.splice(0),
    showNotice: vi.fn(),
  }
  const batches: IngestBatch[] = []
  let notice = false
  let ids = 0
  const c = new Collector({
    apiUrl: 'http://x',
    probe,
    transport: {
      send: async (_u, b) => {
        batches.push(b)
        return { status: 200, body: { ok: true, accepted: b.events.length, notice } }
      },
    },
    scene: { realm: 'main', isWorld: false, isPreview: false, baseParcel: '0,0', parcels: ['0,0'] },
    visitor: { visitorId: '0xabc', isGuest: false, displayName: 'Ana' },
    context: { platform: 'desktop', realm: 'main', sdkVersion: '2.0.0' },
    now: () => now,
    uuid: () => `00000000-0000-4000-8000-00000000000${++ids}`,
    random: () => 1,
  })
  const events = () => batches.flatMap((b) => b.events)
  const types = () => events().map((e) => e.type)
  const step = async (ms: number) => {
    now += ms
    c.tick()
    await new Promise((r) => setTimeout(r, 0))
  }
  return {
    c,
    probe,
    batches,
    events,
    types,
    step,
    move: (x: number, z = 8) => (pose = { position: { x, y: 0, z }, headingDeg: 92 }),
    vanish: () => (pose = null),
    pending,
    setNotice: (v: boolean) => (notice = v),
  }
}

describe('Collector', () => {
  it('starts a session on entering and sends session.start immediately with context', async () => {
    const r = rig()
    await r.step(0)
    expect(r.types()[0]).toBe('session.start')
    expect(r.events()[0].data).toMatchObject({ platform: 'desktop', realm: 'main', isGuest: false, cameraMode: 'third', sdkVersion: '2.0.0' })
    expect(r.batches[0].sessionId).toBe(r.c.sessionId)
  })

  it('samples position every 3 s when moving and every 15 s when idle, rounded', async () => {
    const r = rig()
    await r.step(0)
    for (let i = 1; i <= 3; i++) {
      r.move(8 + i)
      await r.step(3_000)
    }
    await r.step(5_000) // flush
    const moving = r.events().filter((e) => e.type === 'pos')
    expect(moving.length).toBeGreaterThanOrEqual(3)
    expect(moving[0].data).toMatchObject({ y: 0, z: 8, ry: 90, m: true })
    const before = moving.length
    for (let i = 0; i < 5; i++) await r.step(3_000) // idle 15 s
    await r.step(5_000)
    expect(r.events().filter((e) => e.type === 'pos').length).toBe(before + 1)
  })

  it('emits a heartbeat every 15 s while inside', async () => {
    const r = rig()
    await r.step(0)
    await r.step(15_000)
    await r.step(5_000)
    expect(r.types()).toContain('session.heartbeat')
  })

  it('leaving sends session.leave at once; returning within 60 s resumes the same session', async () => {
    const r = rig()
    await r.step(0)
    const first = r.c.sessionId
    r.move(40)
    await r.step(1_000)
    expect(r.types()).toContain('session.leave')
    r.move(8)
    await r.step(30_000)
    expect(r.c.sessionId).toBe(first)
    expect(r.types().filter((t) => t === 'session.start')).toHaveLength(1)
  })

  it('returning after 60 s starts a new session', async () => {
    const r = rig()
    await r.step(0)
    const first = r.c.sessionId
    r.move(40)
    await r.step(1_000)
    r.move(8)
    await r.step(61_000)
    expect(r.c.sessionId).not.toBe(first)
    expect(r.types().filter((t) => t === 'session.start')).toHaveLength(2)
  })

  it('records clicks immediately and dedupes hovers per target for 10 s', async () => {
    const r = rig()
    await r.step(0)
    r.pending.interactions.push({ kind: 'hover', target: 'door' }, { kind: 'hover', target: 'door' })
    await r.step(100)
    r.pending.interactions.push({ kind: 'hover', target: 'door' })
    await r.step(9_000)
    r.pending.interactions.push({ kind: 'click', target: 'door' })
    await r.step(100)
    const ints = r.events().filter((e) => e.type === 'interact')
    expect(ints.map((e) => e.data!.kind)).toEqual(['hover', 'click'])
  })

  it('records video and emotes, and custom events via track()', async () => {
    const r = rig()
    await r.step(0)
    r.pending.video.push({ target: 'screen', state: 'play' })
    r.pending.emotes.push('wave')
    r.c.track('bought_ticket', { tier: 'vip' })
    await r.step(100)
    await r.step(100)
    expect(r.events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'video', data: { target: 'screen', state: 'play' } }),
        expect.objectContaining({ type: 'emote', data: { emote: 'wave' } }),
        expect.objectContaining({ type: 'custom', data: { name: 'bought_ticket', props: { tier: 'vip' } } }),
      ]),
    )
  })

  it('ignores interactions and track() while outside the scene', async () => {
    const r = rig()
    r.move(40)
    r.c.track('x')
    r.pending.interactions.push({ kind: 'click', target: 'door' })
    await r.step(6_000)
    expect(r.batches).toHaveLength(0)
  })

  it('shows the notice once when the server asks, then sends identity', async () => {
    const r = rig()
    r.setNotice(true)
    await r.step(0)
    await r.step(100)
    expect(r.probe.showNotice).toHaveBeenCalledTimes(1)
    r.c.track('after')
    await r.step(100)
    const last = r.batches.at(-1)!
    expect(last.noticeShown).toBe(true)
    expect(last.displayName).toBe('Ana')
    expect(r.batches[0].noticeShown).toBe(false)
    expect(r.batches[0].displayName).toBeUndefined()
  })

  it('destroy() sends session.leave with reason destroy', async () => {
    const r = rig()
    await r.step(0)
    await r.c.destroy()
    const leave = r.events().find((e) => e.type === 'session.leave')
    expect(leave?.data).toEqual({ reason: 'destroy' })
  })

  it('does nothing when the player pose is unavailable', async () => {
    const r = rig()
    r.vanish()
    await r.step(6_000)
    expect(r.batches).toHaveLength(0)
  })

  it('numbers events per session starting at 0', async () => {
    const r = rig()
    await r.step(0) // session.start (0) + first position sample (1)
    r.c.track('a') // custom (2)
    await r.step(100)
    expect(r.types()).toEqual(['session.start', 'pos', 'custom'])
    expect(r.events().map((e) => e.seq)).toEqual([0, 1, 2])
  })
})
