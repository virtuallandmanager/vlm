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
})
