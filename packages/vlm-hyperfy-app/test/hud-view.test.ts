import { describe, expect, it } from 'vitest'
import { planScene } from '../src/plan.js'
import { hudModel } from '../src/hud/model.js'
import { HudView, type HudActions, type UiNode } from '../src/hud/view.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fake = Record<string, any>

function host() {
  const created: Fake[] = []
  return {
    created,
    create(type: string, data: Record<string, unknown> = {}): UiNode {
      const n: Fake = {
        type,
        ...data,
        children: [] as Fake[],
        add(c: Fake) {
          this.children.push(c)
        },
        remove(c: Fake) {
          this.children = this.children.filter((x: Fake) => x !== c)
        },
      }
      created.push(n)
      return n as UiNode
    },
    add() {},
    remove() {},
  }
}

const texts = (n: Fake): string[] => [
  ...(typeof n.value === 'string' ? [n.value as string] : []),
  ...n.children.flatMap(texts),
]
const noop = new Proxy({}, { get: () => () => {} }) as HudActions

const vm = (x: number) =>
  hudModel({
    pairing: { status: 'linked', displayName: 'Ada', sceneId: 's' },
    edit: {
      selectedKey: 'm1:i1',
      selectedName: 'Tree',
      mode: 'move',
      lock: 'free',
      snap: false,
      dirty: true,
      dragging: true,
      saving: false,
      prompt: false,
      values: { x, y: 0, z: 0 },
    },
    plan: planScene(null),
    scene: null,
    alerts: [],
    ui: { editing: true },
  })

describe('HudView', () => {
  it('a drag that only changes the values updates their text without rebuilding the HUD', () => {
    const h = host()
    const view = new HudView(h, noop)
    view.render(vm(1))
    const made = h.created.length
    const bar = h.created.find((n) => n.type === 'ui')!
    expect(texts(bar)).toContain('X 1.00')
    view.render(vm(2.5))
    expect(h.created.length).toBe(made)
    expect(texts(bar)).toContain('X 2.50')
    expect(texts(bar)).not.toContain('X 1.00')
  })

  it('the exact-value keypad draws its keys as buttons that type through typeKey', () => {
    const h = host()
    const pressed: Array<[string, string]> = []
    const act = new Proxy({}, { get: (_t, name) => (name === 'typeKey' ? (prop: string, char: string) => void pressed.push([prop, char]) : () => {}) }) as HudActions
    const view = new HudView(h, act)
    const typing = hudModel({ ...vmState(), ui: { editing: true, typing: { target: 'x', text: '1' } } })
    view.render(typing)
    const bar = h.created.find((n) => n.type === 'ui')!
    for (const label of ['7', '0', '-', '.', '⌫', 'Enter', 'Esc']) expect(texts(bar)).toContain(label)
    const find = (n: Fake, label: string): Fake | undefined =>
      n.onPointerDown && texts(n).includes(label) && texts(n).length === 1 ? n : n.children.map((c: Fake) => find(c, label)).find(Boolean)
    find(bar, '7')!.onPointerDown()
    find(bar, '⌫')!.onPointerDown()
    find(bar, 'Enter')!.onPointerDown()
    expect(pressed).toEqual([
      ['digit7', '7'],
      ['backspace', 'Backspace'],
      ['enter', 'Enter'],
    ])
  })
})

function vmState() {
  return {
    pairing: { status: 'linked' as const, displayName: 'Ada', sceneId: 's' },
    edit: { selectedKey: 'm1:i1', selectedName: 'Tree', mode: 'move' as const, lock: 'free' as const, snap: false, dirty: false, dragging: false, saving: false, prompt: false, values: { x: 1, y: 0, z: 0 } },
    plan: planScene(null),
    scene: null,
    alerts: [],
  }
}
