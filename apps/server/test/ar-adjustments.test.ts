import { describe, it, expect } from 'vitest'
import type { Adjustment, SerializedScene } from 'vlm-shared'
import { applyAdjustments } from '../src/ar/adjustments.js'

const scene = (): SerializedScene => ({
  videos: [],
  images: [],
  sounds: [],
  models: [
    {
      sk: 'e1',
      instances: [
        { sk: 'i1', position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 90, z: 0 }, scale: { x: 2, y: 2, z: 2 } },
        { sk: 'i2', position: { x: 5, y: 5, z: 5 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      ],
    },
  ],
})

const adj: Adjustment = { dPosition: { x: 0.5, y: 0, z: 0 }, dRotation: { x: 0, y: 10, z: 0 }, scaleFactor: { x: 0.5, y: 1, z: 1 } }

describe('applyAdjustments', () => {
  it('adds offsets and multiplies scale', () => {
    const out = applyAdjustments(scene(), new Map([['i1', adj]]))
    const i1 = (out.models[0].instances as any[])[0]
    expect(i1.position).toEqual({ x: 1.5, y: 2, z: 3 })
    expect(i1.rotation).toEqual({ x: 0, y: 100, z: 0 })
    expect(i1.scale).toEqual({ x: 1, y: 2, z: 2 })
    expect(i1.arAdjusted).toBe(true)
  })

  it('leaves other instances and the input alone', () => {
    const input = scene()
    const out = applyAdjustments(input, new Map([['i1', adj]]))
    expect(input).toEqual(scene())
    expect((out.models[0].instances as any[])[1]).toEqual((scene().models[0].instances as any[])[1])
    expect((out.models[0].instances as any[])[1].arAdjusted).toBeUndefined()
    expect(out).not.toBe(input)
  })
})
