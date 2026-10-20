/**
 * The VLM app for Hyperfy 0.16. Hyperfy runs this script once on the world's server and once in each
 * visitor's browser, with only its sandbox globals (world, app, fetch, props, setTimeout, Matrix4).
 * - Server: long-polls VLM's scene feed with the world key, passes each new snapshot to every client, and
 *   records visits. Visitors' browsers never talk to VLM.
 * - Client: renders the snapshot's plan as nodes under the app root. Each node's local transform is the VLM
 *   transform, so the app's own placement and scale in the world carry the whole scene; the root is never moved.
 */
import type { HyperfyFeedResponse } from 'vlm-shared'
import { diffPlans, planScene, type RenderItem } from './plan.js'
import { FeedPoller, type ScriptFetch, type ScriptSetTimeout } from './poller.js'
import { MODEL_TURN, toVlmPosition, worldToLocal } from './transform.js'
import { VisitRecorder } from './visits.js'

type Vec = { x: number; y: number; z: number; fromArray(a: number[]): unknown }
interface HNode {
  position: Vec
  rotation: { set(x: number, y: number, z: number, order: string): unknown }
  scale: Vec
  onPointerDown?: () => void
  play?: () => void
  add(child: HNode): void
  [prop: string]: unknown
}
interface HPlayer {
  id: string
  position: { x: number; y: number; z: number }
}
declare const world: {
  isServer: boolean
  isClient: boolean
  on(name: 'enter' | 'leave', cb: (e: { playerId: string }) => void): void
  getPlayers(): HPlayer[]
  load(type: 'model', url: string): Promise<HNode>
  open(url: string, newWindow?: boolean): void
}
type Matrix = { elements: ArrayLike<number> }
declare const app: {
  /** The app root's world matrix (Hyperfy forwards unknown app props to the root node). */
  matrixWorld: Matrix
  configure(fields: Array<{ key: string; type: 'text'; label: string; initial: string }>): void
  on(name: string, cb: (data: unknown, networkId?: string) => void): void
  send(name: string, data: unknown): void
  sendTo(playerId: string, name: string, data: unknown): void
  create(type: 'video' | 'image' | 'audio' | 'group'): HNode
  add(node: HNode): void
  remove(node: HNode): void
}
declare const fetch: ScriptFetch
declare const setTimeout: ScriptSetTimeout
declare const props: { feedUrl?: string; worldKey?: string }
declare const Matrix4: new () => Matrix & { copy(m: Matrix): Matrix & { invert(): Matrix } }

const SCENE = 'vlm:scene'
const HELLO = 'vlm:hello'

app.configure([
  { key: 'feedUrl', type: 'text', label: 'VLM feed URL', initial: 'https://api.vlm.gg' },
  { key: 'worldKey', type: 'text', label: 'VLM world key', initial: '' },
])

if (world.isServer) runServer()
else runClient()

function runServer(): void {
  const feedUrl = (props.feedUrl || 'https://api.vlm.gg').trim().replace(/\/+$/, '')
  const worldKey = (props.worldKey || '').trim()
  if (!worldKey) {
    console.log('[vlm] set this app\'s world key (from VLM: Connect your own Hyperfy world)')
    return
  }
  let latest: HyperfyFeedResponse | null = null

  new FeedPoller({
    feedUrl,
    worldKey,
    fetch,
    setTimeout,
    onSnapshot: (r) => {
      latest = r
      app.send(SCENE, r)
    },
  }).start()

  app.on(HELLO, (_data, playerId) => {
    if (latest && playerId) app.sendTo(playerId, SCENE, latest)
  })

  const visits = new VisitRecorder({
    feedUrl,
    worldKey,
    fetch,
    setTimeout,
    now: () => Date.now(),
    // Positions go to VLM in its own frame: world -> app-local (wherever the owner placed the app) -> z mirrored.
    getPlayers: () => {
      const inverse = new Matrix4().copy(app.matrixWorld).invert()
      return world.getPlayers().map((p) => ({ id: p.id, position: toVlmPosition(worldToLocal(p.position, inverse)) }))
    },
  })
  world.on('enter', (e) => visits.enter(e.playerId))
  world.on('leave', (e) => visits.leave(e.playerId))
  visits.start()
}

function runClient(): void {
  type Shown = { item: RenderItem; node: HNode | null }
  let plan: RenderItem[] = []
  const shown = new Map<string, Shown>()

  /** Sets the VLM transform as the node's local transform. Planes and sounds take no scale: a plane's VLM
   * scale is its width and height (see `plane`), so scaling the node as well would size it twice. */
  const place = (node: HNode, item: RenderItem) => {
    const { position: p, rotation: r, scale: s } = item.transform
    node.position.fromArray(p)
    node.rotation.set(r[0], r[1], r[2], 'YXZ')
    node.scale.fromArray(item.kind === 'model' ? s : [1, 1, 1])
    if (item.clickUrl) {
      const url = item.clickUrl
      node.onPointerDown = () => world.open(url, true)
    }
  }

  const plane = (type: 'video' | 'image', item: RenderItem): HNode => {
    const node = app.create(type)
    node.src = item.src
    // A VLM plane is 1 m times its scale, so its scale is the plane's size
    node.width = item.width
    node.height = item.height
    node.fit = 'none'
    node.doubleside = true
    if (type === 'image') node.color = 'transparent'
    else {
      node.loop = item.loop
      node.volume = item.volume
    }
    return node
  }

  const add = (item: RenderItem) => {
    const entry: Shown = { item, node: null }
    shown.set(item.key, entry)
    if (item.kind === 'model') {
      world
        .load('model', item.src)
        .then((model) => {
          if (shown.get(item.key) !== entry) return // removed or replaced while loading
          // The group carries the VLM transform; the model turns inside it to face the way Decentraland shows it.
          const group = app.create('group')
          place(group, item)
          model.rotation.set(MODEL_TURN[0], MODEL_TURN[1], MODEL_TURN[2], 'YXZ')
          group.add(model)
          entry.node = group
          app.add(group)
        })
        .catch((err: unknown) => console.warn(`[vlm] model ${item.src} failed to load`, err))
      return
    }
    let node: HNode
    if (item.kind === 'audio') {
      node = app.create('audio')
      node.src = item.src
      node.loop = item.loop
      node.volume = item.volume
    } else {
      node = plane(item.kind, item)
    }
    place(node, item)
    entry.node = node
    app.add(node)
    node.play?.()
  }

  const remove = (key: string) => {
    const entry = shown.get(key)
    if (!entry) return
    shown.delete(key)
    if (entry.node) app.remove(entry.node)
  }

  app.on(SCENE, (data) => {
    const r = data as HyperfyFeedResponse
    let next: RenderItem[]
    try {
      next = planScene(r?.scene ?? null)
    } catch (err) {
      return console.warn('[vlm] could not read the scene', err)
    }
    const d = diffPlans(plan, next)
    for (const key of d.remove) remove(key)
    for (const item of d.update) {
      remove(item.key)
      add(item)
    }
    for (const item of d.add) add(item)
    plan = next
  })

  app.send(HELLO, null)
}
