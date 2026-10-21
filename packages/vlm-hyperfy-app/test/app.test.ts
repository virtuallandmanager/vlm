import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import { beforeAll, describe, expect, it } from 'vitest'
import type { HyperfyFeedResponse } from 'vlm-shared'
// @ts-expect-error plain .mjs shared with the build script
import { bundleOptions } from '../scripts/bundle-options.mjs'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
let js = ''

beforeAll(async () => {
  // Bundled the same way as scripts/build-hyp.mjs.
  const out = await build(bundleOptions(pkg, join(pkg, 'src/app.ts')))
  js = out.outputFiles[0].text
}, 30_000)

type Fake = Record<string, any>

/** A Hyperfy-like node: three.js transform objects plus children. */
function node(type: string, data: Fake = {}): Fake {
  return {
    type,
    ...data,
    position: new Vector3(),
    rotation: new Euler(),
    scale: new Vector3(1, 1, 1),
    children: [] as Fake[],
    add(c: Fake) {
      this.children.push(c)
    },
    remove(c: Fake) {
      this.children = this.children.filter((x: Fake) => x !== c)
    },
  }
}

/** A fake `app.control()`: buttons made on first use, a locked pointer, the camera rig and the screen. */
function control(): Fake {
  const target: Fake = {
    pointer: { locked: true, coords: new Vector3(0.5, 0.5, 0), lock() {}, unlock() {} },
    camera: { position: new Vector3(0, 1.6, 0), quaternion: new Quaternion(), zoom: 0 },
    screen: { width: 1600, height: 900 },
    release() {},
  }
  return new Proxy(target, {
    get(t, prop: string) {
      if (!(prop in t)) t[prop] = { $button: true, down: false, pressed: false, released: false, capture: false, onPress: null, onRelease: null }
      return t[prop]
    },
  })
}

/** Every text in a node tree, depth first. */
const texts = (n: Fake): string[] => [...(typeof n.value === 'string' ? [n.value] : []), ...(n.children ?? []).flatMap(texts)]
/** The first node in the tree with a click handler whose text is `label`. */
function button(roots: Fake[], label: string): Fake | undefined {
  for (const r of roots) {
    if (r.onPointerDown && texts(r).includes(label)) return r
    const inner = button(r.children ?? [], label)
    if (inner) return inner
  }
  return undefined
}

type Res = { ok: boolean; status: number; json(): Promise<unknown> } | undefined
const res = (status: number, body: unknown): Res => ({ ok: status < 400, status, json: async () => body })
const HOSTED = { secret: 's3cret', apiUrl: 'https://vlm.example/', worldKey: 'vlmw_env' }
const admin = (id: string, name: string) => ({ id, name, admin: true, builder: false, position: new Vector3() })
const START = { code: 'SLF234', approveUrl: 'https://vlm.gg/pair/SLF234', qrUrl: 'https://q', expiresAt: new Date(Date.now() + 600_000).toISOString() }

/** Globals the sandbox doesn't have: any use is recorded. */
function forbiddenGlobals(used: string[]) {
  const trap = (name: string) =>
    new Proxy(function () {}, {
      get: () => (used.push(name), undefined),
      apply: () => (used.push(name), undefined),
      construct: () => (used.push(name), {}),
    })
  const names = ['setInterval', 'clearTimeout', 'clearInterval', 'localStorage', 'crypto', 'TextEncoder', 'WebSocket', 'require']
  const values = names.map(trap)
  const URL = { createObjectURL: () => 'blob:x' }
  return { names: [...names, 'URL'], values: [...values, URL] }
}

/** Runs the bundled script with only the sandbox globals it may use. */
function run(opts: {
  isServer: boolean
  players?: Fake[]
  /** The client's local player (world.getPlayer()). */
  me?: Fake
  matrixWorld?: Matrix4
  /** The server-only VLM world (Task 9 provides it from the machine env). */
  vlmWorld?: { secret?: string; apiUrl?: string; worldKey?: string }
  route?: (url: string, body: any) => Res | undefined
}) {
  const timers: Array<() => void> = []
  const posts: Array<{ url: string; body: any }> = []
  const requests: Array<{ url: string; body: any }> = []
  const handlers = new Map<string, (data: unknown, id?: string) => void>()
  const added: Fake[] = []
  const created: Fake[] = []
  const loads: Array<Promise<Fake>> = []
  const sent: Array<{ name: string; data: any }> = []
  const sentTo: Array<{ playerId: string; name: string; data: any }> = []
  const controls: Fake[] = []
  const used: string[] = []
  const world = {
    isServer: opts.isServer,
    isClient: !opts.isServer,
    on() {},
    getPlayers: () => opts.players ?? [],
    getPlayer: (id?: string) => (id === undefined ? (opts.me ?? null) : ((opts.players ?? []).find((p) => p.id === id) ?? null)),
    load: (_type: string, _url: string) => {
      const p = Promise.resolve(node('model'))
      loads.push(p)
      return p
    },
    open() {},
  }
  const app = {
    matrixWorld: opts.matrixWorld ?? new Matrix4(),
    vlmWorld: opts.vlmWorld,
    configure() {},
    on: (name: string, cb: (data: unknown, id?: string) => void) => handlers.set(name, cb),
    send: (name: string, data: unknown) => void sent.push({ name, data }),
    sendTo: (playerId: string, name: string, data: unknown) => void sentTo.push({ playerId, name, data }),
    create: (type: string, data?: Fake) => {
      const n = node(type, data)
      created.push(n)
      return n
    },
    add: (n: Fake) => added.push(n),
    remove: (n: Fake) => {
      const i = added.indexOf(n)
      if (i >= 0) added.splice(i, 1)
    },
    control: () => {
      const c = control()
      controls.push(c)
      return c
    },
  }
  const fetch = async (url: string, init: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : undefined
    if (url.includes('/api/hyperfy/analytics')) posts.push({ url, body })
    else requests.push({ url, body })
    return opts.route?.(url, body) // undefined: the feed poller just backs off
  }
  const setTimeout = (fn: () => void) => void timers.push(fn)
  const props = { feedUrl: 'https://api.example', worldKey: 'vlmw_k' }
  let n = 0
  const uuid = () => `uuid-${++n}`
  const bad = forbiddenGlobals(used)
  new Function('world', 'app', 'fetch', 'props', 'setTimeout', 'Matrix4', 'Vector3', 'Quaternion', 'uuid', ...bad.names, js)(
    world,
    app,
    fetch,
    props,
    setTimeout,
    Matrix4,
    Vector3,
    Quaternion,
    uuid,
    ...bad.values,
  )
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  /** Runs every pending timer once, then lets promises settle. */
  const tick = async () => {
    for (const fn of timers.splice(0)) fn()
    await settle()
  }
  const update = () => handlers.get('update')?.(1 / 60)
  return { timers, posts, requests, handlers, added, created, loads, sent, sentTo, controls, used, settle, tick, update }
}

describe('the VLM app script', () => {
  it('server: players already in the world are recorded, and positions are posted in VLM coordinates', async () => {
    // App moved to (10, 0, 20), turned 90° about Y and scaled 2: VLM (1, 0, 2) is Hyperfy local (1, 0, -2).
    const root = new Matrix4().compose(new Vector3(10, 0, 20), new Quaternion().setFromEuler(new Euler(0, Math.PI / 2, 0)), new Vector3(2, 2, 2))
    const at = new Vector3(1, 0, -2).applyMatrix4(root)
    const s = run({ isServer: true, players: [{ id: 'p1', position: at }], matrixWorld: root })
    // Run every pending timer once (poller, sample, flush) a few rounds.
    for (let round = 0; round < 4 && !s.posts.length; round++) {
      for (const fn of s.timers.splice(0)) fn()
      await s.settle()
    }
    expect(s.posts.length).toBeGreaterThan(0)
    const events = s.posts[0].body.events
    expect(events[0]).toMatchObject({ type: 'enter', playerId: 'p1' })
    const pos = events.find((e: { type: string }) => e.type === 'pos')
    expect(pos.x).toBeCloseTo(1)
    expect(pos.y).toBeCloseTo(0)
    expect(pos.z).toBeCloseTo(2)
  })

  it('client: a model sits in a group carrying the mapped transform, turned half a circle inside it', async () => {
    const c = run({ isServer: false })
    const snap: HyperfyFeedResponse = {
      v: 1,
      version: 'a',
      scene: {
        videos: [],
        images: [],
        sounds: [],
        models: [
          {
            sk: 'm1',
            modelSrc: 'https://x/m.glb',
            instances: [{ sk: 'i1', position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 90, z: 0 }, scale: { x: 2, y: 2, z: 2 } }],
          },
        ],
      },
    }
    c.handlers.get('vlm:scene')!(snap)
    await Promise.all(c.loads)
    await c.settle()
    expect(c.added).toHaveLength(1)
    const group = c.added[0]
    expect(group.type).toBe('group')
    expect(group.position.toArray()).toEqual([1, 2, -3])
    expect(group.rotation.y).toBeCloseTo(-Math.PI / 2)
    expect(group.scale.toArray()).toEqual([2, 2, 2])
    expect(group.children).toHaveLength(1)
    const model = group.children[0]
    expect(model.type).toBe('model')
    expect([model.rotation.x, model.rotation.y, model.rotation.z]).toEqual([0, Math.PI, 0])
    expect(model.scale.toArray()).toEqual([1, 1, 1])
  })

  it('the sandbox build runs the client and server halves without forbidden globals', async () => {
    const me = { id: 'p1', name: 'Pip', admin: true, builder: true, position: new Vector3() }
    const server = run({ isServer: true, players: [me], vlmWorld: HOSTED, route: () => res(200, { status: 'pending' }) })
    server.handlers.get('vlm:link')!(null, 'p1')
    for (let i = 0; i < 3; i++) await server.tick()
    const client = run({ isServer: false, me, route: () => res(200, { code: 'ABC234', approveUrl: 'a', qrUrl: 'q', expiresAt: new Date(Date.now() + 600_000).toISOString() }) })
    client.update()
    button(client.added, 'Link to VLM')!.onPointerDown()
    client.handlers.get('vlm:link')!({ status: 'self', attempt: client.sent.find((m) => m.name === 'vlm:link')!.data.attempt })
    for (let i = 0; i < 3; i++) await client.tick()
    client.update()
    expect([...server.used, ...client.used]).toEqual([])
  })

  it("the HUD draws nothing for a visitor who isn't admin or builder", async () => {
    const c = run({ isServer: false, me: { id: 'p9', name: 'Vi', admin: false, builder: false, position: new Vector3() } })
    c.update()
    await c.settle()
    expect(c.created.filter((n) => n.type.startsWith('ui'))).toEqual([])
    expect(c.controls).toHaveLength(0)
    expect(c.sent.filter((m) => m.name === 'vlm:link')).toEqual([])
  })

  it('an admin or builder gets the Link button; a self-run world pairs from the browser', async () => {
    const c = run({
      isServer: false,
      me: { id: 'p1', name: 'Pip', admin: false, builder: true, position: new Vector3() },
      route: (url) => (url.endsWith('/api/hyperfy/pair') ? res(200, { code: 'ABC234', approveUrl: 'https://vlm.gg/pair/ABC234', qrUrl: 'https://q', expiresAt: new Date(Date.now() + 600_000).toISOString() }) : undefined),
    })
    c.update()
    const link = button(c.added, 'Link to VLM')
    expect(link).toBeDefined()
    link!.onPointerDown()
    expect(c.sent.filter((m) => m.name === 'vlm:link')).toHaveLength(1)
    c.handlers.get('vlm:link')!({ status: 'self', attempt: c.sent.find((m) => m.name === 'vlm:link')!.data.attempt })
    await c.settle()
    expect(c.requests.find((r) => r.url === 'https://api.example/api/hyperfy/pair')?.body).toMatchObject({ worldKey: 'vlmw_k', playerName: 'Pip' })
    c.update()
    expect(c.added.flatMap(texts)).toContain('ABC-234')
  })

  it('hosted: a vlm:link request is answered with the vouch result for that player only', async () => {
    const players = [admin('p1', 'Pip'), admin('p2', 'Bo')]
    const vouches: any[] = []
    const s = run({
      isServer: true,
      players,
      vlmWorld: HOSTED,
      route: (url, body) => {
        if (!url.endsWith('/api/hyperfy/pairings/vouch')) return undefined
        // only VLM's own API, from the server-only world, never the builder-editable props.feedUrl
        expect(url).toBe('https://vlm.example/api/hyperfy/pairings/vouch')
        vouches.push(body)
        if (vouches.length === 1) return res(200, { status: 'unlinked', code: 'ABC234', approveUrl: 'https://vlm.gg/pair/ABC234', qrUrl: 'https://q', expiresAt: 'e', pairingId: 'pair-1' })
        if (vouches.length === 2) return res(200, { status: 'pending' })
        return res(200, { status: 'linked', pass: 'PASS', passExpiresAt: 'x', pairingId: 'pair-1', sceneId: 'scene-1', user: { id: 'u1', displayName: 'Ada' } })
      },
    })
    // The body can't pick the player: the sender's id does.
    s.handlers.get('vlm:link')!({ hyperfyPlayerId: 'p2', playerName: 'Mallory', attempt: 4 }, 'p1')
    await s.settle()
    expect(vouches[0]).toEqual({ worldKey: 'vlmw_env', worldSecret: 's3cret', hyperfyPlayerId: 'p1', playerName: 'Pip' })
    expect(s.sentTo).toEqual([{ playerId: 'p1', name: 'vlm:link', data: { status: 'unlinked', code: 'ABC234', approveUrl: 'https://vlm.gg/pair/ABC234', qrUrl: 'https://q', expiresAt: 'e', attempt: 4 } }])
    // polls with the pending pairing until it's approved
    await s.tick()
    expect(vouches[1]).toMatchObject({ hyperfyPlayerId: 'p1', pendingPairingId: 'pair-1' })
    expect(s.sentTo).toHaveLength(1)
    await s.tick()
    expect(vouches[2]).toMatchObject({ hyperfyPlayerId: 'p1', pendingPairingId: 'pair-1' })
    expect(s.sentTo.at(-1)).toEqual({ playerId: 'p1', name: 'vlm:link', data: { status: 'linked', pass: 'PASS', passExpiresAt: 'x', pairingId: 'pair-1', sceneId: 'scene-1', displayName: 'Ada', attempt: 4 } })
    // linked: polling stops, and nothing was broadcast
    await s.tick()
    expect(vouches).toHaveLength(3)
    expect(s.sentTo.every((m) => m.playerId === 'p1')).toBe(true)
    expect(s.sent.filter((m) => m.name === 'vlm:link')).toEqual([])
    // the world secret never reaches a player
    expect(JSON.stringify([s.sentTo, s.sent])).not.toContain('s3cret')
    expect(s.requests.filter((r) => r.url.includes('api.example') && r.url.includes('vouch'))).toEqual([])
  })

  it('hosted: a sender who is neither admin nor builder gets no vouch and no reply', async () => {
    const s = run({ isServer: true, players: [{ id: 'p3', name: 'Vi', admin: false, builder: false, position: new Vector3() }], vlmWorld: HOSTED, route: () => res(200, { status: 'pending' }) })
    s.handlers.get('vlm:link')!({ attempt: 1 }, 'p3')
    s.handlers.get('vlm:link')!({ attempt: 1 }, 'nobody')
    await s.tick()
    expect(s.requests.filter((r) => r.url.includes('vouch'))).toEqual([])
    expect(s.sentTo).toEqual([])
  })

  it('a server-only world with missing fields is self-run: no vouch', async () => {
    for (const vlmWorld of [undefined, { secret: 's3cret', worldKey: 'vlmw_env' }, { secret: '', apiUrl: 'https://vlm.example', worldKey: 'vlmw_env' }, { secret: 's3cret', apiUrl: 'https://vlm.example' }]) {
      const s = run({ isServer: true, players: [admin('p1', 'Pip')], vlmWorld, route: () => res(200, { status: 'pending' }) })
      s.handlers.get('vlm:link')!({ attempt: 2 }, 'p1')
      await s.settle()
      expect(s.requests.filter((r) => r.url.includes('vouch'))).toEqual([])
      expect(s.sentTo).toEqual([{ playerId: 'p1', name: 'vlm:link', data: { status: 'self', attempt: 2 } }])
    }
  })

  it('client: a late reply to an older link attempt is ignored', async () => {
    const c = run({ isServer: false, me: admin('p1', 'Pip'), route: (url) => (url.endsWith('/api/hyperfy/pair') ? res(200, START) : undefined) })
    c.update()
    button(c.added, 'Link to VLM')!.onPointerDown()
    const attempt = c.sent.find((m) => m.name === 'vlm:link')!.data.attempt
    expect(typeof attempt).toBe('number')
    await c.tick() // no answer: falls back to pairing from the browser
    c.update()
    expect(c.added.flatMap(texts)).toContain('SLF-234')
    c.handlers.get('vlm:link')!({ status: 'unlinked', code: 'LAT234', approveUrl: 'a', qrUrl: 'q', expiresAt: 'e', attempt })
    c.update()
    expect(c.added.flatMap(texts)).toContain('SLF-234')
    expect(c.added.flatMap(texts)).not.toContain('LAT-234')
  })

  it('client: a self answer while a hosted code is showing switches to pairing from the browser', async () => {
    const c = run({ isServer: false, me: admin('p1', 'Pip'), route: (url) => (url.endsWith('/api/hyperfy/pair') ? res(200, START) : undefined) })
    c.update()
    button(c.added, 'Link to VLM')!.onPointerDown()
    const attempt = c.sent.find((m) => m.name === 'vlm:link')!.data.attempt
    c.handlers.get('vlm:link')!({ status: 'unlinked', code: 'HOS234', approveUrl: 'a', qrUrl: 'q', expiresAt: 'e', attempt })
    c.update()
    expect(c.added.flatMap(texts)).toContain('HOS-234')
    c.handlers.get('vlm:link')!({ status: 'self', attempt })
    await c.settle()
    c.update()
    expect(c.requests.some((r) => r.url === 'https://api.example/api/hyperfy/pair')).toBe(true)
    expect(c.added.flatMap(texts)).not.toContain('HOS-234')
    expect(c.added.flatMap(texts)).toContain('SLF-234')
  })

  it('client: losing admin and builder stops the link, so no more pass renewals', async () => {
    const me = admin('p1', 'Pip')
    const c = run({ isServer: false, me })
    c.update()
    button(c.added, 'Link to VLM')!.onPointerDown()
    const attempt = c.sent.find((m) => m.name === 'vlm:link')!.data.attempt
    // A pass that is due for renewal at once.
    c.handlers.get('vlm:link')!({ status: 'linked', pass: 'P', passExpiresAt: new Date(Date.now() + 60_000).toISOString(), pairingId: 'pair-1', sceneId: 'scene-1', displayName: 'Ada', attempt })
    await c.settle()
    me.admin = false
    c.update()
    const before = c.sent.filter((m) => m.name === 'vlm:link').length
    for (let i = 0; i < 3; i++) await c.tick()
    expect(c.sent.filter((m) => m.name === 'vlm:link').length).toBe(before)
  })

  it('self-run: the server half never vouches and tells the player to pair from the browser', async () => {
    const s = run({ isServer: true, players: [admin('p1', 'Pip')] })
    s.handlers.get('vlm:link')!(null, 'p1')
    await s.settle()
    expect(s.requests.filter((r) => r.url.includes('vouch'))).toEqual([])
    expect(s.sentTo).toEqual([{ playerId: 'p1', name: 'vlm:link', data: { status: 'self', attempt: 0 } }])
  })
})
