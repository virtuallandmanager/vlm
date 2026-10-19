import { describe, it, expect } from 'vitest'
import { countLabel, filterScenes, placeholderHues, shortId } from './scenes'

describe('scene list helpers', () => {
  it('shortens an id to its first 8 characters', () => {
    expect(shortId('c0061176-3b67-4688-a115-a55a806e684a')).toBe('c0061176…')
    expect(shortId('abc')).toBe('abc')
  })

  it('pads the count to two digits', () => {
    expect(countLabel(2)).toBe('02')
    expect(countLabel(0)).toBe('00')
    expect(countLabel(123)).toBe('123')
  })

  it('filters by name or description, ignoring case and spaces around the query', () => {
    const scenes = [
      { id: '1', name: 'Ghost Towns', description: null },
      { id: '2', name: "Haze's Lazy Daze Cat Cafe", description: 'cozy cats' },
    ]
    expect(filterScenes(scenes, '  ghost ').map((s) => s.id)).toEqual(['1'])
    expect(filterScenes(scenes, 'COZY').map((s) => s.id)).toEqual(['2'])
    expect(filterScenes(scenes, '')).toHaveLength(2)
    expect(filterScenes(scenes, 'nothing')).toEqual([])
  })

  it('gives each scene stable placeholder hues', () => {
    const a = placeholderHues('c0061176-3b67')
    expect(placeholderHues('c0061176-3b67')).toEqual(a)
    expect(a.every((h) => h >= 0 && h < 360)).toBe(true)
    expect(placeholderHues('1d061abf-0000')).not.toEqual(a)
  })
})
