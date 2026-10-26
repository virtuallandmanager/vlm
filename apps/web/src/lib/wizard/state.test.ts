import { describe, expect, it } from 'vitest'
import type { WizardAsset } from '../api'
import { canAdvance, initialState, wizardReducer, type WizardState } from './state'

const asset = (id: string, tris = 100, dim = 1): WizardAsset => ({
  id, name: id, thumbnailUrl: null, cdnUrl: null, dimensions: { x: dim, y: 1, z: dim }, triangleCount: tris, fileSizeBytes: 10,
})
const dcl = { world: 'a.dcl.eth', wallet: '0x1', hasScene: false, footprint: null }
const withPlot = (over: Partial<WizardState> = {}): WizardState =>
  wizardReducer(
    { ...wizardReducer(initialState, { type: 'setDcl', dcl }), ...over },
    { type: 'setPlot', plot: { width: 1, depth: 1, base: { x: 0, y: 0 } } },
  )

describe('applyTheme', () => {
  it('keeps what fits and records the drop (12 x 1,500 tris on 1x1)', () => {
    const s = wizardReducer(withPlot(), {
      type: 'applyTheme', themeId: 't',
      items: Array.from({ length: 12 }, (_, i) => ({ asset: asset('a', 1500), x: 0.1 + i * 0.07, z: 0.5, rotationY: 0 })),
    })
    expect(s.items).toHaveLength(6)
    expect(s.lastDropped).toBe(6)
    expect(s.themeId).toBe('t')
  })
})

describe('applyTheme without Decentraland limits', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ asset: asset('a', 1500), x: 0.1 + i * 0.07, z: 0.5, rotationY: 0 }))
  it('keeps every item for a Hyperfy-only user', () => {
    const h = wizardReducer(initialState, { type: 'setHyperfy', hyperfy: { kind: 'self', name: 'w' } })
    const s = wizardReducer(h, { type: 'applyTheme', themeId: 't', items: many })
    expect(s.items).toHaveLength(12)
    expect(s.lastDropped).toBe(0)
  })
  it('keeps every item when dcl is set but no plot yet', () => {
    const d = wizardReducer(initialState, { type: 'setDcl', dcl })
    expect(wizardReducer(d, { type: 'applyTheme', themeId: 't', items: many }).items).toHaveLength(12)
  })
  it('setPlot does not drop items without a dcl destination', () => {
    let s = wizardReducer(initialState, { type: 'setHyperfy', hyperfy: { kind: 'self', name: 'w' } })
    s = wizardReducer(s, { type: 'applyTheme', themeId: 't', items: many })
    s = wizardReducer(s, { type: 'setPlot', plot: { width: 1, depth: 1, base: { x: 0, y: 0 } } })
    expect(s.items).toHaveLength(12)
  })
})

describe('addAsset', () => {
  it('places a free item near the centre', () => {
    const s = wizardReducer(withPlot(), { type: 'addAsset', asset: asset('a') })
    expect(s.items).toHaveLength(1)
    expect(s.items[0].x).toBeCloseTo(8, 0)
  })
  it('refuses over budget with a notice, leaving items alone', () => {
    const start = withPlot()
    const s = wizardReducer(start, { type: 'addAsset', asset: asset('big', 10_001) })
    expect(s.items).toEqual([])
    expect(s.notice).toMatch(/This plot fits about 10,000 triangles/)
  })
  it('adds a 1x1 building after switching a theme to Empty plot', () => {
    let s = wizardReducer(withPlot(), { type: 'applyTheme', themeId: 'park', items: [{ asset: asset('tree'), x: 0.5, z: 0.5, rotationY: 0 }] })
    s = wizardReducer(s, { type: 'applyTheme', themeId: 'empty', items: [] })
    s = wizardReducer(s, { type: 'addAsset', asset: asset('house', 3_000, 16) })
    expect(s.items).toHaveLength(1)
    expect(s.notice).toBeNull()
  })
  it('refuses when there is no room', () => {
    let s = withPlot()
    for (let i = 0; i < 40; i++) s = wizardReducer(s, { type: 'addAsset', asset: asset('b', 10, 4) })
    expect(s.items.length).toBeLessThan(40)
    expect(s.notice).toMatch(/free room/)
  })
  it('uses unique keys', () => {
    let s = withPlot()
    s = wizardReducer(s, { type: 'addAsset', asset: asset('a') })
    s = wizardReducer(s, { type: 'removeItem', key: s.items[0].key })
    s = wizardReducer(s, { type: 'addAsset', asset: asset('a') })
    s = wizardReducer(s, { type: 'addAsset', asset: asset('a') })
    expect(new Set(s.items.map((i) => i.key)).size).toBe(2)
  })
})

describe('moveItem / rotateItem / setPlot', () => {
  it('clamps a move outside the plot', () => {
    let s = wizardReducer(withPlot(), { type: 'addAsset', asset: asset('a') })
    s = wizardReducer(s, { type: 'moveItem', key: s.items[0].key, x: -50, z: 500 })
    expect(s.items[0]).toMatchObject({ x: 0.5, z: 15.5 })
  })
  it('rotates by 90', () => {
    let s = wizardReducer(withPlot(), { type: 'addAsset', asset: asset('a') })
    for (let i = 0; i < 4; i++) s = wizardReducer(s, { type: 'rotateItem', key: s.items[0].key })
    expect(s.items[0].rotationY).toBe(0)
  })
  it('shrinking the plot clamps items and fits the budget', () => {
    let s = withPlot()
    s = wizardReducer(s, { type: 'setPlot', plot: { width: 3, depth: 1, base: { x: 0, y: 0 } } })
    s = wizardReducer(s, { type: 'applyTheme', themeId: null, items: Array.from({ length: 10 }, () => ({ asset: asset('a', 2500), x: 0.9, z: 0.5, rotationY: 0 })) })
    expect(s.items).toHaveLength(10)
    s = wizardReducer(s, { type: 'setPlot', plot: { width: 1, depth: 1, base: { x: 0, y: 0 } } })
    expect(s.items).toHaveLength(4)
    expect(s.lastDropped).toBe(6)
    expect(s.items.every((i) => i.x <= 15.5)).toBe(true)
    expect(s.spawn).toEqual({ x: 8, z: 1 })
  })
})

describe('canAdvance', () => {
  it('needs a destination at where', () => {
    expect(canAdvance(initialState)).toBe(false)
    expect(canAdvance(wizardReducer(initialState, { type: 'setAr', ar: { name: 'x' } }))).toBe(true)
  })
  it('needs a plot at size when dcl is set; hyperfy-only does not', () => {
    const d = wizardReducer({ ...initialState, step: 'size' }, { type: 'setDcl', dcl })
    expect(canAdvance(d)).toBe(false)
    expect(canAdvance(wizardReducer(d, { type: 'setPlot', plot: { width: 1, depth: 1, base: { x: 0, y: 0 } } }))).toBe(true)
    const h = wizardReducer({ ...initialState, step: 'size' }, { type: 'setHyperfy', hyperfy: { kind: 'self', name: 'w' } })
    expect(canAdvance(h)).toBe(true)
  })
  it('blocks assets/arrange when over budget', () => {
    const s: WizardState = { ...withPlot({ step: 'assets' }), items: [{ key: 'k', asset: asset('a', 20_000), x: 8, z: 8, rotationY: 0 }] }
    expect(canAdvance(s)).toBe(false)
    expect(canAdvance({ ...s, step: 'arrange' })).toBe(false)
  })
  it('hyperfy-only placement uses the 2x2 guide plot', () => {
    let s = wizardReducer(initialState, { type: 'setHyperfy', hyperfy: { kind: 'self', name: 'w' } })
    s = wizardReducer(s, { type: 'addAsset', asset: asset('a', 50_000, 20) })
    expect(s.items).toHaveLength(1)
    expect(canAdvance({ ...s, step: 'assets' })).toBe(true)
  })
})
