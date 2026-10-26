import { Matrix4 } from 'three'
import { describe, expect, it, vi } from 'vitest'
import type { SerializedScene } from 'vlm-shared'
import { TransformSession } from 'vlm-core/transform/session'
import { EditController, clickHandler, renderedItem, type HudAlert, type RenderedItem } from '../src/edit/controller.js'
import { planScene, type RenderItem } from '../src/plan.js'
import { VlmApi } from '../src/vlm-api.js'

const v = (x: number, y: number, z: number) => ({ x, y, z })

/** A scene with image `el1` and its instances, each at (x, 1, 2) in VLM coordinates. */
function scene(xs: Record<string, number>): SerializedScene {
  return {
    videos: [],
    models: [],
    sounds: [],
    images: [
      {
        sk: 'el1',
        name: 'Poster',
        enabled: true,
        textureSrc: 'https://cdn.example/a.png',
        instances: Object.entries(xs).map(([sk, x]) => ({ sk, enabled: true, position: v(x, 1, 2), rotation: v(0, 0, 0), scale: v(2, 1, 1) })),
      },
    ],
  } as unknown as SerializedScene
}

type Reply = { status: number; body?: unknown } | undefined

function setup(xs: Record<string, number> = { inst1: 1 }, opts: { replies?: Reply[]; rootInverse?: Matrix4; renews?: boolean } = {}) {
  let plan: RenderItem[] = planScene(scene(xs))
  const replies = [...(opts.replies ?? [])]
  const fetch = vi.fn(async (_url: string, _init?: unknown) => {
    const r = replies.length ? replies.shift() : { status: 200, body: {} }
    if (!r) return undefined
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} }
  })
  const api = new VlmApi({ feedUrl: 'https://api.example', fetch: fetch as never, getPass: () => 'pass', onAuthFailure: async () => opts.renews ?? false })
  const save = vi.spyOn(api, 'saveTransform')
  const preview = vi.fn()
  const restore = vi.fn()
  const alerts: HudAlert[] = []
  const session = new TransformSession({ now: () => 0, onDraft: () => {} })
  const timers: Array<{ fn: () => void; ms: number }> = []
  const items = () => new Map<string, RenderedItem>(plan.map((i) => [i.key, renderedItem(i)]))
  const inverse = opts.rootInverse
  const edit = new EditController({
    session,
    api,
    items,
    preview,
    restore,
    alert: (a) => alerts.push(a),
    setTimeout: (fn: () => void, ms: number) => void timers.push({ fn, ms }),
    ...(inverse ? { rootInverse: () => inverse } : {}),
  })
  /** A new feed snapshot: the app swaps its plan, then tells the controller. */
  const feed = (next: Record<string, number>) => {
    const prev = plan
    plan = planScene(scene(next))
    edit.onSnapshot(prev, plan)
  }
  /** Runs the oldest pending timer and lets its save settle. */
  const tick = async () => {
    timers.shift()!.fn()
    await settle()
  }
  return { edit, session, api, save, fetch, preview, restore, alerts, feed, timers, tick }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

/** A world-space ray (Hyperfy frame) looking down -z from (x, 1, z). VLM z=2 is Hyperfy z=-2. */
const look = (x: number, z = 3) => ({ origin: v(x, 1, z), direction: v(0, 0, -1) })
const X_ARROW = { kind: 'arrow', axis: 'x' } as const

/** Selects inst1 and drags its X arrow from x=1 to x=3 (Hyperfy and VLM agree on x). */
function dragX(t: ReturnType<typeof setup>, to = 3, from = 1) {
  expect(t.edit.select('el1:inst1')).toBe('ok')
  t.edit.pointerDown(X_ARROW, look(from))
  t.edit.pointerMove(look(to))
}

describe('EditController', () => {
  it('select, drag on the X arrow, save calls saveTransform with VLM coordinates', async () => {
    // The app root sits at world (10, 0, 0): world rays are taken into its frame first.
    const root = new Matrix4().makeTranslation(10, 0, 0)
    const t = setup({ inst1: 1 }, { rootInverse: new Matrix4().copy(root).invert() })
    expect(t.edit.select('el1:inst1')).toBe('ok')
    t.edit.pointerDown(X_ARROW, look(11))
    t.edit.pointerMove(look(13))
    t.edit.pointerUp()
    const moved = { position: v(3, 1, 2), rotation: v(0, 0, 0), scale: v(2, 1, 1) }
    expect(t.preview).toHaveBeenLastCalledWith('el1:inst1', moved)
    expect(t.edit.state.dirty).toBe(true)
    // The arrow locked the drag to x only for its duration.
    expect(t.edit.state.lock).toBe('free')

    await t.edit.save()
    expect(t.save).toHaveBeenCalledTimes(1)
    const [id, sent] = t.save.mock.calls[0]
    expect(id).toBe('inst1')
    expect(sent.position.x).toBeCloseTo(3)
    expect(sent.position.y).toBeCloseTo(1)
    expect(sent.position.z).toBeCloseTo(2) // VLM z, not Hyperfy's -2
    expect(sent.scale).toEqual(v(2, 1, 1))
    expect(t.fetch.mock.calls[0][0]).toBe('https://api.example/api/instances/inst1')
    expect(t.alerts).toEqual([{ kind: 'info', text: 'Saved' }])
    expect(t.edit.state.dirty).toBe(false)
  })

  it('revert restores the baseline and clears dirty', () => {
    const t = setup()
    t.edit.select('el1:inst1')
    expect(t.edit.setValue('y', 4)).toBe(true)
    expect(t.preview).toHaveBeenLastCalledWith('el1:inst1', { position: v(1, 4, 2), rotation: v(0, 0, 0), scale: v(2, 1, 1) })
    expect(t.edit.state.dirty).toBe(true)
    t.edit.revert()
    expect(t.restore).toHaveBeenCalledWith('el1:inst1')
    expect(t.session.draft).toEqual({ position: v(1, 1, 2), rotation: v(0, 0, 0), scale: v(2, 1, 1) })
    expect(t.edit.state.dirty).toBe(false)
    expect(t.edit.state.selectedKey).toBe('el1:inst1')
  })

  it("a snapshot during a drag doesn't overwrite the draft; revert shows the newest feed value", () => {
    const t = setup()
    dragX(t)
    expect(t.session.draft!.position.x).toBeCloseTo(3)
    t.feed({ inst1: 7 }) // someone else moved it to x=7 meanwhile
    expect(t.session.draft!.position.x).toBeCloseTo(3)
    // The app re-rendered the node from the feed; the draft is shown on it again.
    expect(t.preview.mock.lastCall![1].position.x).toBeCloseTo(3)
    t.edit.pointerMove(look(4))
    expect(t.session.draft!.position.x).toBeCloseTo(4)
    t.edit.pointerUp()
    t.edit.revert()
    expect(t.session.draft!.position).toEqual(v(7, 1, 2))
    expect(t.restore).toHaveBeenLastCalledWith('el1:inst1')
    expect(t.edit.state.dirty).toBe(false)
  })

  it('a snapshot for a clean selection takes the feed value and drops the preview; a removed item is deselected', () => {
    const t = setup()
    t.edit.select('el1:inst1')
    t.feed({ inst1: 5 })
    expect(t.session.draft!.position.x).toBe(5)
    expect(t.restore).toHaveBeenLastCalledWith('el1:inst1') // no preview left over the feed value
    t.feed({})
    expect(t.edit.state.selectedKey).toBe(null)
  })

  it('selecting another item while dirty asks to save or revert', () => {
    const t = setup({ inst1: 1, inst2: 4 })
    t.edit.select('el1:inst1')
    t.edit.setValue('x', 2)
    expect(t.edit.select('el1:inst2')).toBe('dirty')
    expect(t.edit.state).toMatchObject({ selectedKey: 'el1:inst1', prompt: true, dirty: true })
    // Answering the prompt with Revert moves on to the item that was asked for.
    t.edit.revert()
    expect(t.edit.state).toMatchObject({ selectedKey: 'el1:inst2', prompt: false, dirty: false })
    expect(t.session.draft!.position.x).toBe(4)
  })

  it('done while dirty asks too; done when clean deselects', () => {
    const t = setup()
    t.edit.select('el1:inst1')
    t.edit.setValue('x', 2)
    expect(t.edit.done()).toBe('dirty')
    expect(t.edit.state.prompt).toBe(true)
    t.edit.revert()
    expect(t.edit.state.selectedKey).toBe(null)
    t.edit.select('el1:inst1')
    expect(t.edit.done()).toBe('ok')
    expect(t.edit.state.selectedKey).toBe(null)
  })

  it('an auth failure on save renews the pass and saves in the same press', async () => {
    const t = setup({ inst1: 1 }, { replies: [{ status: 401 }, { status: 200, body: {} }], renews: true })
    dragX(t)
    t.edit.pointerUp()
    const draft = t.session.draft
    await t.edit.save()
    expect(t.save).toHaveBeenCalledTimes(1)
    expect(t.fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse((t.fetch.mock.calls[1][1] as { body: string }).body)).toEqual(draft)
    expect(t.alerts).toEqual([{ kind: 'info', text: 'Saved' }])
    expect(t.edit.state.dirty).toBe(false)
  })

  it("an auth failure that can't renew keeps the draft (the link shows expired) and a save after re-linking succeeds", async () => {
    const t = setup({ inst1: 1 }, { replies: [{ status: 401 }, { status: 200, body: {} }] })
    dragX(t)
    t.edit.pointerUp()
    const draft = t.session.draft
    await t.edit.save()
    expect(t.fetch).toHaveBeenCalledTimes(1)
    expect(t.edit.state.dirty).toBe(true)
    expect(t.session.draft).toEqual(draft)
    expect(t.restore).not.toHaveBeenCalled()
    expect(t.alerts).toEqual([])
    await t.edit.save()
    expect(t.save.mock.calls[1][1]).toEqual(draft)
    expect(t.alerts).toEqual([{ kind: 'info', text: 'Saved' }])
    expect(t.edit.state.dirty).toBe(false)
  })

  it("no_access on save alerts 'You can't edit this right now' and reverts", async () => {
    const t = setup({ inst1: 1 }, { replies: [{ status: 403 }] })
    dragX(t)
    t.edit.pointerUp()
    await t.edit.save()
    expect(t.alerts).toEqual([{ kind: 'error', text: "You can't edit this right now" }])
    expect(t.restore).toHaveBeenCalledWith('el1:inst1')
    expect(t.session.draft!.position).toEqual(v(1, 1, 2))
    expect(t.edit.state.dirty).toBe(false)
  })

  it('a lost connection or another failure keeps the draft with its alert', async () => {
    const t = setup({ inst1: 1 }, { replies: [undefined, { status: 500 }, { status: 422 }] })
    dragX(t)
    t.edit.pointerUp()
    await t.edit.save()
    await t.edit.save()
    await t.edit.save()
    expect(t.alerts).toEqual([
      { kind: 'error', text: 'Lost connection to VLM. Retrying…' },
      { kind: 'error', text: "Couldn't save: server" },
      { kind: 'error', text: "Couldn't save: invalid" },
    ])
    expect(t.edit.state.dirty).toBe(true)
    expect(t.restore).not.toHaveBeenCalled()
  })

  it('the body handle (null) moves freely on the ground plane in move mode; rings rotate only in rotate mode', () => {
    const t = setup()
    t.edit.select('el1:inst1')
    // Looking down at the floor from above: free move lands where the ray meets the item's height.
    t.edit.pointerDown(null, { origin: v(0, 5, 0), direction: v(0, -1, 0) })
    t.edit.pointerMove({ origin: v(2, 5, -6), direction: v(0, -1, 0) })
    t.edit.pointerUp()
    expect(t.session.draft!.position).toEqual(v(2, 1, 6))
    t.edit.pointerDown({ kind: 'ring', axis: 'y' }, look(1))
    expect(t.edit.state.dragging).toBe(false)
    t.edit.setMode('rotate')
    t.edit.pointerDown({ kind: 'ring', axis: 'y' }, look(1))
    expect(t.edit.state.dragging).toBe(true)
  })
})

describe('clickHandler', () => {
  it('edit mode makes clicks select instead of open links', () => {
    const on = { select: vi.fn(), open: vi.fn() }
    const linked = { key: 'el1:inst1', clickUrl: 'https://example.com/' }
    const plain = { key: 'el1:inst2', clickUrl: null }

    clickHandler(linked, false, on)!()
    expect(on.open).toHaveBeenCalledWith('https://example.com/')
    expect(on.select).not.toHaveBeenCalled()
    expect(clickHandler(plain, false, on)).toBeUndefined()

    on.open.mockClear()
    clickHandler(linked, true, on)!()
    clickHandler(plain, true, on)!()
    expect(on.select.mock.calls).toEqual([['el1:inst1'], ['el1:inst2']])
    expect(on.open).not.toHaveBeenCalled()
  })
})

describe('EditController after a save', () => {
  it('save then done keeps the saved transform shown until the feed confirms', async () => {
    const t = setup()
    dragX(t)
    t.edit.pointerUp()
    await t.edit.save()
    expect(t.edit.done()).toBe('ok')
    expect(t.restore).not.toHaveBeenCalled() // restore would put the node back at the old x=1
    t.feed({ inst1: 1 }) // a snapshot that hasn't caught up yet
    expect(t.restore).not.toHaveBeenCalled()
    t.feed({ inst1: 3 }) // the feed carries the save: the node can show the feed again
    expect(t.restore).toHaveBeenCalledWith('el1:inst1')
  })

  it("save answering the prompt doesn't restore the old value", async () => {
    const t = setup({ inst1: 1, inst2: 4 })
    t.edit.select('el1:inst1')
    t.edit.setValue('x', 2)
    expect(t.edit.select('el1:inst2')).toBe('dirty')
    await t.edit.save()
    expect(t.edit.state.selectedKey).toBe('el1:inst2')
    expect(t.restore).not.toHaveBeenCalledWith('el1:inst1')
  })

  it('pressing the item again after save drags from the saved transform', async () => {
    const t = setup()
    dragX(t)
    t.edit.pointerUp()
    await t.edit.save()
    expect(t.edit.state.dirty).toBe(false)
    t.edit.pointerDown(X_ARROW, look(3))
    t.edit.pointerMove(look(4))
    t.edit.pointerUp()
    expect(t.session.draft!.position.x).toBeCloseTo(4)
    expect(t.preview.mock.lastCall![1].position.x).toBeCloseTo(4)
  })

  it('a lost save retries with back-off and says Reconnected, then Saved', async () => {
    const t = setup({ inst1: 1 }, { replies: [undefined, undefined, undefined, undefined, undefined, undefined, { status: 200 }] })
    dragX(t)
    t.edit.pointerUp()
    await t.edit.save()
    const delays: number[] = []
    while (t.timers.length) {
      delays.push(t.timers[0].ms)
      await t.tick()
    }
    expect(delays).toEqual([2000, 4000, 8000, 16000, 30000, 30000])
    expect(t.save).toHaveBeenCalledTimes(7)
    for (const [, sent] of t.save.mock.calls) expect(sent.position.x).toBeCloseTo(3)
    expect(t.alerts).toEqual([
      { kind: 'error', text: 'Lost connection to VLM. Retrying…' },
      { kind: 'info', text: 'Reconnected' },
      { kind: 'info', text: 'Saved' },
    ])
    expect(t.edit.state.dirty).toBe(false)
  })

  it('revert, a new edit or deselecting cancels the pending retry', async () => {
    const t = setup({ inst1: 1 }, { replies: [undefined, undefined, undefined] })
    dragX(t)
    t.edit.pointerUp()
    await t.edit.save()
    t.edit.revert()
    await t.tick()
    expect(t.save).toHaveBeenCalledTimes(1)

    t.edit.setValue('x', 5)
    await t.edit.save() // lost again
    t.edit.setValue('x', 6) // a new edit: the retry would send a stale draft
    await t.tick()
    expect(t.save).toHaveBeenCalledTimes(2)

    await t.edit.save() // lost again
    t.edit.revert()
    expect(t.edit.done()).toBe('ok')
    await t.tick()
    expect(t.save).toHaveBeenCalledTimes(3)
    expect(t.timers).toEqual([])
  })

  it('a Z-arrow drag under an offset root saves the VLM z with its sign', async () => {
    // Root at world (0, 0, 10): VLM (1, 1, 2) is local (1, 1, -2), world (1, 1, 8). Rays look along +x.
    const root = new Matrix4().makeTranslation(0, 0, 10)
    const t = setup({ inst1: 1 }, { rootInverse: new Matrix4().copy(root).invert() })
    const across = (worldZ: number) => ({ origin: v(-3, 1, worldZ), direction: v(1, 0, 0) })
    t.edit.select('el1:inst1')
    t.edit.pointerDown({ kind: 'arrow', axis: 'z' }, across(8))
    t.edit.pointerMove(across(5)) // world z down 3 = Hyperfy -z = VLM +z
    t.edit.pointerUp()
    await t.edit.save()
    const sent = t.save.mock.calls[0][1]
    expect(sent.position.x).toBeCloseTo(1)
    expect(sent.position.y).toBeCloseTo(1)
    expect(sent.position.z).toBeCloseTo(5)
  })
})
