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
function node(type: string): Fake {
  return { type, position: new Vector3(), rotation: new Euler(), scale: new Vector3(1, 1, 1), children: [] as Fake[], add(c: Fake) { this.children.push(c) } }
}

/** Runs the bundled script with only the sandbox globals it may use. */
function run(opts: { isServer: boolean; players?: Fake[]; matrixWorld?: Matrix4 }) {
  const timers: Array<() => void> = []
  const posts: Array<{ url: string; body: any }> = []
  const handlers = new Map<string, (data: unknown, id?: string) => void>()
  const added: Fake[] = []
  const loads: Array<Promise<Fake>> = []
  const world = {
    isServer: opts.isServer,
    isClient: !opts.isServer,
    on() {},
    getPlayers: () => opts.players ?? [],
    load: (_type: string, _url: string) => {
      const p = Promise.resolve(node('model'))
      loads.push(p)
      return p
    },
    open() {},
  }
  const app = {
    matrixWorld: opts.matrixWorld ?? new Matrix4(),
    configure() {},
    on: (name: string, cb: (data: unknown, id?: string) => void) => handlers.set(name, cb),
    send() {},
    sendTo() {},
    create: (type: string) => node(type),
    add: (n: Fake) => added.push(n),
    remove() {},
  }
  const fetch = async (url: string, init: { body?: string }) => {
    if (url.includes('/api/hyperfy/analytics')) posts.push({ url, body: JSON.parse(init.body!) })
    return undefined // the feed poller just backs off
  }
  const setTimeout = (fn: () => void) => void timers.push(fn)
  const props = { feedUrl: 'https://api.example', worldKey: 'vlmw_k' }
  new Function('world', 'app', 'fetch', 'props', 'setTimeout', 'Matrix4', 'Vector3', js)(world, app, fetch, props, setTimeout, Matrix4, Vector3)
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  return { timers, posts, handlers, added, loads, settle }
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
})
