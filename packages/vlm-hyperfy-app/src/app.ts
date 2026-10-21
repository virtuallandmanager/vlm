/**
 * The VLM app for Hyperfy 0.16. Hyperfy runs this script once on the world's server and once in each
 * visitor's browser, with only its sandbox globals (world, app, fetch, props, setTimeout, Matrix4).
 * - Server: long-polls VLM's scene feed with the world key, passes each new snapshot to every client, and
 *   records visits. Visitors' browsers never talk to VLM.
 * - Client: renders the snapshot's plan as nodes under the app root. Each node's local transform is the VLM
 *   transform, so the app's own placement and scale in the world carry the whole scene; the root is never moved.
 * - HUD (client, admins and builders only): links the player to VLM, then edits the scene with VLM's REST API.
 *   Hosted worlds link through the server half, which vouches for its players with VLM_WORLD_SECRET
 *   (`app.vlmWorldSecret`, server only); self-run worlds pair from the browser with a code.
 */
import { HYPERFY_FEED, HYPERFY_PAIRING, type HyperfyFeedResponse, type HyperfyVouchResponse, type SerializedScene } from 'vlm-shared'
import { TransformSession } from 'vlm-core/transform/session'
import { clickHandler, EditController, renderedItem, type HudAlert, type RenderedItem } from './edit/controller.js'
import { Gizmo, type GizmoNode } from './edit/gizmo.js'
import { pointerRay } from './edit/rays.js'
import {
  alertsFromSnapshot,
  failureAlert,
  hudModel,
  inFrontOf,
  initialUi,
  pairingAlert,
  placeAsset,
  typeKey,
  type AssetEntry,
  type Axis,
  type HudUi,
} from './hud/model.js'
import { HudView, type UiNode } from './hud/view.js'
import { Pairing, type PairingState, type PassRenewer } from './pairing.js'
import { diffPlans, planScene, type RenderItem } from './plan.js'
import { FeedPoller, type ScriptFetch, type ScriptSetTimeout } from './poller.js'
import { MODEL_TURN, toHyperfyTransform, toVlmPosition, worldToLocal, type HyperfyTransform } from './transform.js'
import { VlmApi, type ApiResult, type VlmTransform } from './vlm-api.js'
import { VisitRecorder } from './visits.js'

type Vec = { x: number; y: number; z: number; fromArray(a: number[]): unknown }
interface HNode {
  position: Vec
  rotation: { set(x: number, y: number, z: number, order: string): unknown }
  scale: Vec
  onPointerDown?: (() => void) | undefined
  play?: () => void
  add(child: HNode): void
  [prop: string]: unknown
}
interface HPlayer {
  id: string
  name?: string
  admin?: boolean
  builder?: boolean
  position: { x: number; y: number; z: number }
}
type XYZ = { x: number; y: number; z: number }
interface HButton {
  onPress: (() => boolean | void) | null
  down: boolean
  released: boolean
}
/** What the HUD uses of `app.control()` (client only). */
interface HControl {
  keyL: HButton
  mouseLeft: HButton
  pointer: { locked: boolean; coords: XYZ }
  camera: { position: XYZ; quaternion: XYZ & { w: number }; zoom: number }
  screen: { width: number; height: number }
  /** Every key press, with its text (`e.key`); returning true captures it. */
  onButtonPress?: (prop: string, text: string) => boolean
}
declare const world: {
  isServer: boolean
  isClient: boolean
  on(name: 'enter' | 'leave', cb: (e: { playerId: string }) => void): void
  getPlayers(): HPlayer[]
  /** The local player (client) or the player with this id. */
  getPlayer(id?: string): HPlayer | null
  load(type: 'model', url: string): Promise<HNode>
  open(url: string, newWindow?: boolean): void
}
type Matrix = { elements: ArrayLike<number> }
declare const app: {
  /** The app root's world matrix (Hyperfy forwards unknown app props to the root node). */
  matrixWorld: Matrix
  /** VLM_WORLD_SECRET on a VLM-hosted world's server half; undefined anywhere else (self-run worlds, clients). */
  vlmWorldSecret?: string
  configure(fields: Array<{ key: string; type: 'text'; label: string; initial: string }>): void
  on(name: string, cb: (data: unknown, networkId?: string) => void): void
  send(name: string, data: unknown): void
  sendTo(playerId: string, name: string, data: unknown): void
  create(type: 'video' | 'image' | 'audio' | 'group'): HNode
  create(type: 'ui' | 'uiview' | 'uitext' | 'uiimage' | 'prim', data?: Record<string, unknown>): HNode
  add(node: HNode | GizmoNode | object): void
  remove(node: HNode | GizmoNode | object): void
  control(): HControl
}
declare const fetch: ScriptFetch
declare const setTimeout: ScriptSetTimeout
declare const props: { feedUrl?: string; worldKey?: string }
declare const Matrix4: new () => Matrix & { copy(m: Matrix): Matrix & { invert(): Matrix } }
declare const uuid: () => string

const SCENE = 'vlm:scene'
/** Client asks its server half to link it (and, linked, for a fresh pass); the server half answers that player only. */
const LINK = 'vlm:link'
/** What the server half sends back on LINK. 'self': this world can't vouch, pair from the browser. */
type LinkReply =
  | { status: 'self' }
  | { status: 'linked'; pass: string; passExpiresAt: string; pairingId: string; sceneId: string; displayName: string }
  | { status: 'unlinked'; code: string; approveUrl: string; qrUrl: string; expiresAt: string }
  | { status: 'expired' }
  | { status: 'lost' }
const LINK_REPLY_MS = 10_000
const ALERT_MS = 6_000

type V3 = { x: number; y: number; z: number }
const closeV = (a: V3, b: V3) => Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.y - b.y) < 1e-4 && Math.abs(a.z - b.z) < 1e-4
const sameTransform = (a: VlmTransform, b: VlmTransform) =>
  closeV(a.position, b.position) && closeV(a.rotation, b.rotation) && closeV(a.scale, b.scale)
const HELLO = 'vlm:hello'

app.configure([
  { key: 'feedUrl', type: 'text', label: 'VLM feed URL', initial: 'https://api.vlm.gg' },
  { key: 'worldKey', type: 'text', label: 'VLM world key', initial: '' },
])

if (world.isServer) runServer()
else runHud(runClient())

function runServer(): void {
  const feedUrl = (props.feedUrl || 'https://api.vlm.gg').trim().replace(/\/+$/, '')
  const worldKey = (props.worldKey || '').trim()
  runLinkRelay(feedUrl, worldKey)
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

/**
 * The server half's answer to LINK. The player is the event's sender (Hyperfy passes the sender's socket id, which
 * is the player id), never anything in the message. Hosted worlds vouch for that player with the world secret and
 * send the result to that player only; while unlinked they poll the pending pairing every claimPollMs until it is
 * approved, refused or expired. Without a secret (a self-run world) nothing is vouched: the player pairs from the browser.
 */
function runLinkRelay(feedUrl: string, worldKey: string): void {
  const secret = app.vlmWorldSecret
  /** Each player's link in progress: the poll that may act, its pending pairing and the code card it was sent. */
  const pending = new Map<string, { token: number; pairingId?: string; card?: LinkReply }>()
  let tokens = 0
  const reply = (playerId: string, r: LinkReply) => app.sendTo(playerId, LINK, r)

  const vouch = async (playerId: string, pendingPairingId?: string): Promise<HyperfyVouchResponse | { httpStatus: number } | undefined> => {
    const body = {
      worldKey,
      worldSecret: secret,
      hyperfyPlayerId: playerId,
      playerName: world.getPlayer(playerId)?.name ?? null,
      ...(pendingPairingId ? { pendingPairingId } : {}),
    }
    try {
      const res = await fetch(`${feedUrl}/api/hyperfy/pairings/vouch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-VLM-App-Version': String(HYPERFY_FEED.version) },
        body: JSON.stringify(body),
      })
      if (!res) return undefined
      if (!res.ok) return { httpStatus: res.status }
      return (await res.json()) as HyperfyVouchResponse
    } catch {
      return undefined
    }
  }

  const step = async (playerId: string, token: number, failDelay: number): Promise<void> => {
    const mine = () => pending.get(playerId)?.token === token
    if (!mine()) return
    const entry = pending.get(playerId)!
    const r = await vouch(playerId, entry.pairingId)
    if (!mine()) return
    const again = (delay: number) => setTimeout(() => void step(playerId, token, delay), delay || HYPERFY_PAIRING.claimPollMs)
    const status = r && 'status' in r ? r.status : null
    if (r && 'status' in r && r.status === 'linked') {
      pending.delete(playerId)
      reply(playerId, { status: 'linked', pass: r.pass, passExpiresAt: r.passExpiresAt, pairingId: r.pairingId, sceneId: r.sceneId, displayName: r.user?.displayName ?? '' })
    } else if (r && 'status' in r && r.status === 'unlinked') {
      entry.pairingId = r.pairingId
      entry.card = { status: 'unlinked', code: r.code, approveUrl: r.approveUrl, qrUrl: r.qrUrl, expiresAt: r.expiresAt }
      reply(playerId, entry.card)
      again(0)
    } else if (status === 'pending') {
      again(0)
    } else if (status === 'refused' || status === 'expired') {
      pending.delete(playerId)
      reply(playerId, { status: 'expired' })
    } else if (r && 'httpStatus' in r && r.httpStatus === 401) {
      // VLM doesn't know this world's secret (yet): the browser can still pair with a code.
      pending.delete(playerId)
      reply(playerId, { status: 'self' })
    } else if (entry.pairingId) {
      // Lost while a code is out: keep polling, backing off.
      again(Math.min(Math.max(failDelay * 2, HYPERFY_FEED.retryMinMs), HYPERFY_FEED.retryMaxMs))
    } else {
      pending.delete(playerId)
      reply(playerId, { status: 'lost' })
    }
  }

  app.on(LINK, (_data, playerId) => {
    if (!playerId) return
    if (!secret || !worldKey) return reply(playerId, { status: 'self' })
    const current = pending.get(playerId)
    // A code is already out for this player: show it again rather than minting another.
    if (current?.card) return reply(playerId, current.card)
    if (current) return
    const token = ++tokens
    pending.set(playerId, { token })
    void step(playerId, token, 0)
  })
  world.on('leave', (e) => pending.delete(e.playerId))
}

/** What the client half offers edit mode and the HUD. */
export interface ClientEditHooks {
  /** Swaps every VLM node's click: select (while editing) or open its link. */
  setEditing(on: boolean, select: (key: string) => void): void
  items(): Map<string, RenderedItem>
  preview(key: string, t: VlmTransform): void
  restore(key: string): void
  /** Called after each snapshot is applied, with the previous and the new plan and the new scene. */
  onPlan(cb: (prev: RenderItem[], next: RenderItem[], scene: SerializedScene | null) => void): void
}

function runClient(): ClientEditHooks {
  type Shown = { item: RenderItem; node: HNode | null }
  let plan: RenderItem[] = []
  const shown = new Map<string, Shown>()
  /** Edit mode's drafts shown in place of the feed transform, by key, until restored. */
  const previews = new Map<string, VlmTransform>()
  let editing = false
  let select: (key: string) => void = () => {}
  const planListeners: Array<(prev: RenderItem[], next: RenderItem[], scene: SerializedScene | null) => void> = []

  const setClick = (node: HNode, item: RenderItem) => {
    node.onPointerDown = clickHandler(item, editing, { select: (key) => select(key), open: (url) => world.open(url, true) })
  }

  /** Sets the VLM transform as the node's local transform. Planes and sounds take no scale: a plane's VLM
   * scale is its width and height (see `plane`), so scaling the node as well would size it twice. */
  const place = (node: HNode, item: RenderItem, t: HyperfyTransform = item.transform) => {
    const { position: p, rotation: r, scale: s } = t
    node.position.fromArray(p)
    node.rotation.set(r[0], r[1], r[2], 'YXZ')
    node.scale.fromArray(item.kind === 'model' ? s : [1, 1, 1])
    if (item.kind === 'video' || item.kind === 'image') {
      node.width = s[0]
      node.height = s[1]
    }
  }

  /** The transform to show: edit mode's draft if there is one, else the feed's. */
  const shownTransform = (item: RenderItem): HyperfyTransform => {
    const draft = previews.get(item.key)
    return draft ? toHyperfyTransform(draft) : item.transform
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
          place(group, item, shownTransform(item))
          setClick(group, item)
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
    place(node, item, shownTransform(item))
    setClick(node, item)
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
    // A preview ends with its item, or once the feed carries it (a save came back).
    for (const [key, t] of [...previews]) {
      const entry = shown.get(key)
      if (!entry || sameTransform(entry.item.vlm, t)) previews.delete(key)
    }
    const prev = plan
    plan = next
    for (const cb of planListeners) cb(prev, next, r?.scene ?? null)
  })

  app.send(HELLO, null)

  return {
    setEditing(on, onSelect) {
      editing = on
      select = onSelect
      for (const { item, node } of shown.values()) if (node) setClick(node, item)
    },
    items: () => new Map([...shown.values()].map(({ item }) => [item.key, renderedItem(item)])),
    preview(key, t) {
      const entry = shown.get(key)
      if (!entry) return
      previews.set(key, t)
      if (entry.node) place(entry.node, entry.item, toHyperfyTransform(t))
    },
    restore(key) {
      previews.delete(key)
      const entry = shown.get(key)
      if (entry?.node) place(entry.node, entry.item)
    },
    onPlan(cb) {
      planListeners.push(cb)
    },
  }
}

/**
 * The HUD, for players who are admin or builder in this world (visitors get nothing: no nodes, no controls).
 *
 * Input (Hyperfy fires node pointer events only for the reticle while the pointer is locked, and for screen UI while
 * it is unlocked):
 * - Aim (pointer locked, Hyperfy's normal play): with edit mode on, clicking a VLM object selects it; clicking the
 *   selected object again starts a body drag, and gizmo handles start handle drags. A drag follows the camera's
 *   forward ray until the mouse button is released.
 * - Panels (pointer unlocked with ` or Esc, Hyperfy's own toggles): the bar and panels are clickable; clicking the
 *   world locks the pointer again.
 * - Keys: L cycles the axis lock (Shift is Hyperfy's run key). While a field is being typed into, every key goes to
 *   it: digits, '-' and '.' for values, any character for links and searches, Enter commits, Escape cancels.
 */
function runHud(hooks: ClientEditHooks): void {
  const feedUrl = (props.feedUrl || 'https://api.vlm.gg').trim().replace(/\/+$/, '')
  const worldKey = (props.worldKey || '').trim()
  let ui: HudUi = initialUi()
  let link: PairingState = { status: 'idle' }
  let scene: SerializedScene | null = null
  let plan: RenderItem[] = []
  const alerts: Array<HudAlert & { id: number }> = []
  let alertIds = 0
  let visible = false
  let control: HControl | null = null
  let gizmo: Gizmo | null = null
  let pairing: Pairing | null = null
  /** Bumped by each link attempt: a late reply to an older attempt is ignored. */
  let linkGen = 0
  /** A hosted renewal waiting for the server half's answer. */
  let renewWaiter: ((r: Awaited<ReturnType<PassRenewer>>) => void) | null = null
  let lastDrawn = ''

  const sceneId = () => (link.status === 'linked' ? link.sceneId : '')
  const rootInverse = () => new Matrix4().copy(app.matrixWorld).invert()

  const api = new VlmApi({ feedUrl, fetch, getPass: () => pairing?.pass() ?? null, onAuthFailure: () => void pairing?.renewNow() })
  const session = new TransformSession({ now: () => Date.now(), onDraft: () => {} })
  const controller = new EditController({
    session,
    api,
    items: () => hooks.items(),
    preview: (key, t) => hooks.preview(key, t),
    restore: (key) => hooks.restore(key),
    alert: (a) => pushAlert(a),
    rootInverse,
    onChange: () => redraw(),
    setTimeout,
  })

  // Built on first show, so a visitor's browser never gets HUD nodes.
  let view: HudView | null = null
  const makeView = () =>
    new HudView(
      {
        create: (type, data) => app.create(type, data) as unknown as UiNode,
        add: (n) => app.add(n),
        remove: (n) => app.remove(n),
      },
      {
        link: () => startLink(),
        openUrl: (url) => world.open(url, true),
        toggleEditing: () => setEditing(!ui.editing),
        setMode: (m) => controller.setMode(m),
        cycleLock: () => controller.cycleLock(),
        toggleSnap: () => controller.setSnap(!controller.state.snap),
        save: () => void controller.save(),
        revert: () => controller.revert(),
        done: () => controller.done(),
        typeAxis: (axis) => controller.state.values && setUi({ typing: { target: axis, text: '' } }),
        openPanel: (p) => {
          setUi({ panel: ui.panel === p ? null : p, typing: null })
          if (ui.panel === 'layout') void loadPresets()
          if (ui.panel === 'assets') void loadTab(ui.tab)
        },
        toggleEnabled: (id, on) => void request(api.setEnabled(id, on)),
        setPreset: (id) => void request(api.setPreset(sceneId(), id)),
        toggleLive: (id, on) => void request(api.setLive(id, on)),
        setTab: (tab) => {
          setUi({ tab, chosen: null, typing: null })
          void loadTab(tab)
        },
        choose: (id) => setUi({ chosen: id }),
        typeField: (field) => setUi({ typing: { target: field, text: field === 'link' ? ui.linkUrl : ui.query } }),
        place: () => void place(),
      },
    )

  // ── alerts and drawing ───────────────────────────────────────────────

  function pushAlert(a: HudAlert | null): void {
    if (!a || !visible) return
    const id = ++alertIds
    alerts.push({ kind: a.kind, text: a.text, id })
    if (alerts.length > 10) alerts.shift()
    setTimeout(() => {
      const i = alerts.findIndex((x) => x.id === id)
      if (i >= 0) alerts.splice(i, 1)
      redraw()
    }, ALERT_MS)
    redraw()
  }

  function setUi(patch: Partial<HudUi>): void {
    ui = { ...ui, ...patch }
    redraw()
  }

  function redraw(): void {
    const vm = visible
      ? hudModel({ pairing: link, edit: controller.state, plan, scene, alerts: alerts.map(({ kind, text }) => ({ kind, text })), ui })
      : null
    const drawn = JSON.stringify(vm)
    if (drawn !== lastDrawn) {
      lastDrawn = drawn
      if (vm) view ??= makeView()
      view?.render(vm)
    }
    // The gizmo sits on the selected item (its draft while editing), in the app root's frame.
    const key = controller.state.selectedKey
    const t = session.draft ?? (key ? hooks.items().get(key)?.transform : undefined)
    if (gizmo) gizmo.show(controller.state.mode, ui.editing && key && t ? toHyperfyTransform(t).position : null)
  }

  // ── linking ──────────────────────────────────────────────────────────

  function setLink(s: PairingState): void {
    const before = link
    link = s
    pushAlert(pairingAlert(before, s))
    if (s.status === 'linked' && before.status !== 'linked') void loadPresets()
    // Edit mode stays on if the link lapses: the draft is kept, and Save works again once re-linked.
    redraw()
  }

  /** Hosted renewals ask the server half to vouch again; it answers with a fresh pass. */
  const hostedRenewer: PassRenewer = () =>
    new Promise((resolve) => {
      renewWaiter?.(null)
      renewWaiter = resolve
      app.send(LINK, null)
      setTimeout(() => {
        if (renewWaiter === resolve) {
          renewWaiter = null
          resolve(null)
        }
      }, LINK_REPLY_MS)
    })

  const newPairing = (renewer?: PassRenewer) => {
    pairing?.stop()
    pairing = new Pairing({ feedUrl, worldKey, fetch, setTimeout, uuid, onState: setLink, ...(renewer ? { renewer } : {}) })
    return pairing
  }

  /** Asks the server half first: a hosted world vouches; anything else (or no answer) pairs from the browser. */
  function startLink(): void {
    const gen = ++linkGen
    setUi({ linking: true })
    app.send(LINK, null)
    setTimeout(() => {
      if (gen === linkGen && ui.linking) pairSelf()
    }, LINK_REPLY_MS)
  }

  function pairSelf(): void {
    linkGen++
    setUi({ linking: false })
    newPairing().start(world.getPlayer()?.name ?? '')
  }

  app.on(LINK, (data) => {
    const r = data as LinkReply
    if (!r || typeof r !== 'object') return
    const waiter = renewWaiter
    renewWaiter = null
    switch (r.status) {
      case 'self':
        waiter?.(null)
        if (ui.linking) pairSelf()
        return
      case 'linked':
        if (waiter) return waiter({ pass: r.pass, passExpiresAt: r.passExpiresAt, sceneId: r.sceneId })
        if (!ui.linking && link.status !== 'waiting') return
        setUi({ linking: false })
        newPairing(hostedRenewer).adopt({ pass: r.pass, passExpiresAt: r.passExpiresAt, pairingId: r.pairingId, sceneId: r.sceneId, displayName: r.displayName })
        return
      case 'unlinked':
        // A renewal that found no live pairing (revoked) gets a new code: show it.
        pairing?.stop()
        waiter?.(null)
        setUi({ linking: false })
        setLink({ status: 'waiting', code: r.code, approveUrl: r.approveUrl, qrUrl: r.qrUrl, expiresAt: r.expiresAt })
        return
      case 'expired':
        if (waiter) return waiter('revoked')
        setUi({ linking: false })
        setLink({ status: 'expired' })
        return
      case 'lost':
        if (waiter) return waiter(null)
        setUi({ linking: false })
        pushAlert(failureAlert('lost'))
        return
    }
  })

  // ── panels ───────────────────────────────────────────────────────────

  async function request(p: Promise<ApiResult<unknown>>): Promise<boolean> {
    const r = await p
    if (!r.ok) pushAlert(failureAlert(r.reason))
    return r.ok
  }

  async function loadPresets(): Promise<void> {
    const id = sceneId()
    if (!id) return
    const r = await api.getScene(id)
    if (r.ok) setUi({ presets: r.value.presets })
  }

  async function loadTab(tab: HudUi['tab']): Promise<void> {
    const id = sceneId()
    if (!id || tab === 'link') return
    if (tab === 'library') {
      setUi({ library: null })
      const r = await api.listLibrary(id)
      if (!r.ok) pushAlert(failureAlert(r.reason))
      const entries: AssetEntry[] = r.ok
        ? r.value.filter((e) => e.kind === 'model' && e.url).map((e) => ({ id: e.id, name: e.name || 'Model', src: e.url, source: 'library' }))
        : []
      setUi({ library: entries })
    } else {
      setUi({ catalog: null })
      const r = await api.listCatalog(ui.query)
      if (!r.ok) pushAlert(failureAlert(r.reason))
      const entries: AssetEntry[] = r.ok
        ? r.value.assets.filter((a) => a.cdnUrl).map((a) => ({ id: a.id, name: a.name || 'Model', src: a.cdnUrl!, source: 'catalog' }))
        : []
      setUi({ catalog: entries })
    }
  }

  async function place(): Promise<void> {
    const me = world.getPlayer()
    const presetId = typeof scene?.sk === 'string' ? scene.sk : ''
    const list = ui.tab === 'library' ? ui.library : ui.tab === 'catalog' ? ui.catalog : null
    const entry: AssetEntry | undefined =
      ui.tab === 'link' ? { id: 'link', name: 'Model', src: ui.linkUrl.trim(), source: 'link' } : list?.find((e) => e.id === ui.chosen)
    if (!me || !control || !entry || !presetId || ui.placing) return
    setUi({ placing: true })
    await placeAsset({ api, sceneId: sceneId(), presetId, entry, transform: inFrontOf(control.camera, me.position.y, rootInverse()), alert: pushAlert })
    setUi({ placing: false })
  }

  // ── edit mode and input ──────────────────────────────────────────────

  const ray = () => {
    const c = control!
    const pointer = c.pointer.locked ? null : { x: c.pointer.coords.x, y: c.pointer.coords.y, aspect: c.screen.width / (c.screen.height || 1) }
    return pointerRay(c.camera, pointer)
  }

  /** A click on a VLM node while editing: select it, or (already selected) grab it. */
  const onNodeClick = (key: string) => {
    if (!control) return
    if (controller.state.selectedKey === key) controller.pointerDown(null, ray())
    else controller.select(key)
  }

  function setEditing(on: boolean): void {
    if (!on && controller.done() === 'dirty') return // the bar asks Save or Revert first
    if (on && !gizmo) {
      gizmo = new Gizmo(
        { create: (type, data) => app.create(type as 'prim', data) as unknown as GizmoNode, add: (n) => app.add(n), remove: (n) => app.remove(n) },
        {
          down: (h) => control && controller.pointerDown(h, ray()),
          enter: (h) => gizmo?.highlight(h),
          leave: () => gizmo?.highlight(null),
        },
      )
    }
    hooks.setEditing(on, onNodeClick)
    setUi({ editing: on, typing: null })
  }

  function bindControl(): HControl {
    const c = app.control()
    c.keyL.onPress = () => {
      if (!ui.editing || ui.typing) return
      controller.cycleLock()
      return true
    }
    c.onButtonPress = (prop, text) => {
      const typing = ui.typing
      if (!typing) return false
      const isAxis = typing.target === 'x' || typing.target === 'y' || typing.target === 'z'
      const r = typeKey(typing.text, prop, text, isAxis ? 'number' : 'text')
      if (r.action === 'cancel') setUi({ typing: null })
      else if (r.action === 'commit') {
        setUi({ typing: null })
        if (isAxis) {
          const v = Number(r.text)
          if (r.text.trim() && Number.isFinite(v)) controller.setValue(typing.target as Axis, v)
        } else if (typing.target === 'link') setUi({ linkUrl: r.text.trim() })
        else {
          setUi({ query: r.text })
          void loadTab('catalog')
        }
      } else setUi({ typing: { target: typing.target, text: r.text } })
      return true
    }
    return c
  }

  hooks.onPlan((prev, next, sc) => {
    if (link.status === 'linked') for (const a of alertsFromSnapshot(scene, sc)) pushAlert(a)
    scene = sc
    plan = next
    controller.onSnapshot(prev, next)
    redraw()
  })

  app.on('update', () => {
    const me = world.getPlayer()
    const allowed = !!me && (!!me.admin || !!me.builder)
    if (allowed !== visible) {
      if (!allowed && ui.editing) {
        controller.revert()
        controller.done()
        hooks.setEditing(false, onNodeClick)
        ui = { ...ui, editing: false, typing: null }
      }
      visible = allowed
      if (visible && !control) control = bindControl()
      redraw()
    }
    if (!visible || !control) return
    if (controller.state.dragging) {
      if (!control.mouseLeft.down || control.mouseLeft.released) controller.pointerUp()
      else controller.pointerMove(ray())
    }
  })
}
