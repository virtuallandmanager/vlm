import { describe, it, expect } from 'vitest'
import type { SceneLibraryItemData } from '@virvixr/shared'
import { applyLibraryChange, hudStatus } from '../src/media-status.js'
import { Virvi } from '../src/Virvi.js'

const item = (over: Partial<SceneLibraryItemData> = {}): SceneLibraryItemData => ({
  id: 'l1', kind: 'media', name: 'a.png', contentType: 'image/png', url: 'https://cdn/a.png', sizeBytes: 1,
  bookingId: null, createdAt: '2026-10-18T00:00:00.000Z', status: 'ready', error: null, ...over,
})

describe('hudStatus', () => {
  const none = new Set<string>()
  it('passes in-flight and failed statuses through', () => {
    expect(hudStatus(item({ status: 'uploading' }), false, none)).toBe('uploading')
    expect(hudStatus(item({ status: 'processing' }), true, none)).toBe('processing')
    expect(hudStatus(item({ status: 'failed' }), true, none)).toBe('failed')
  })
  it('a ready model that is placed but not deployed needs sync', () => {
    const glb = item({ url: 'https://cdn/m.glb', contentType: 'model/gltf-binary' })
    expect(hudStatus(glb, true, new Set(['https://cdn/m.glb']))).toBe('needs_sync')
    expect(hudStatus(glb, true, none)).toBe('available')
  })
  it('a ready image is available even if its url is in the set', () => {
    expect(hudStatus(item(), false, new Set(['https://cdn/a.png']))).toBe('available')
  })
})

describe('applyLibraryChange', () => {
  const a = item({ id: 'a' }), b = item({ id: 'b' })
  it('prepends a new item', () => {
    expect(applyLibraryChange([a], { action: 'upsert', item: b }).map((i) => i.id)).toEqual(['b', 'a'])
  })
  it('replaces an existing item in place', () => {
    const next = applyLibraryChange([a, b], { action: 'upsert', item: item({ id: 'b', status: 'failed' }) })
    expect(next.map((i) => i.id)).toEqual(['a', 'b'])
    expect(next[1].status).toBe('failed')
  })
  it('removes by id and ignores unknown ids', () => {
    expect(applyLibraryChange([a, b], { action: 'remove', id: 'a' }).map((i) => i.id)).toEqual(['b'])
    expect(applyLibraryChange([a, b], { action: 'remove', id: 'zz' })).toHaveLength(2)
  })
})

describe('Virvi.onLibraryChanged', () => {
  it('delivers scene_library_changed messages until unsubscribed', () => {
    const virvi = new Virvi({ capabilities: { gltfModels: true, platformName: 'test' } } as any)
    const handlers: Record<string, (m: unknown) => void> = {}
    ;(virvi as any).colyseus = { onMessage: (t: string, h: (m: unknown) => void) => { handlers[t] = h }, onLeave: () => {}, getRoom: () => null }
    ;(virvi as any).registerMessageHandlers()
    const got: unknown[] = []
    const off = virvi.onLibraryChanged((c) => got.push(c))
    handlers.scene_library_changed({ action: 'remove', id: 'x' })
    off()
    handlers.scene_library_changed({ action: 'remove', id: 'y' })
    expect(got).toEqual([{ action: 'remove', id: 'x' }])
  })
})
