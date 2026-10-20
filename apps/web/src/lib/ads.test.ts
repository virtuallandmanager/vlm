import { describe, it, expect } from 'vitest'
import type { LevelCounts } from 'vlm-shared'
import { shapeLabel, isHttpsUrl, clickRate, offImageLabel, adModeHint } from './ads'

const zero = { scene: 0, screen: 0, look: 0, click: 0 }
const counts = (screen: number, click: number): LevelCounts => ({ ...zero, screen, click, unverified: { ...zero } })

describe('shapeLabel', () => {
  it('names every shape', () => {
    expect(shapeLabel('16:9')).toBe('16:9 landscape')
    expect(shapeLabel('1:1')).toBe('1:1 square')
    expect(shapeLabel('9:16')).toBe('9:16 portrait')
    expect(shapeLabel('2:5')).toBe('2:5 tall')
  })
})

describe('isHttpsUrl', () => {
  it('accepts https urls only', () => {
    expect(isHttpsUrl('https://example.com/a?b=1')).toBe(true)
    expect(isHttpsUrl('http://example.com')).toBe(false)
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpsUrl('example.com')).toBe(false)
    expect(isHttpsUrl('')).toBe(false)
  })
})

describe('clickRate', () => {
  it('is verified clicks over verified screen', () => {
    expect(clickRate(counts(1000, 13))).toBe('1.3%')
    expect(clickRate(counts(4, 1))).toBe('25.0%')
  })
  it('ignores unverified counts', () => {
    const c = counts(100, 5)
    c.unverified = { scene: 9, screen: 900, look: 9, click: 900 }
    expect(clickRate(c)).toBe('5.0%')
  })
  it('is a dash when nobody saw it on screen', () => {
    expect(clickRate(counts(0, 0))).toBe('—')
  })
})

describe('offImageLabel', () => {
  it('offers the off image in image mode and as the fallback in the ads modes', () => {
    expect(offImageLabel(1)).toBe('Off Image URL')
    expect(offImageLabel(4)).toBe('Fallback Image URL (shown when no ad can play)')
    expect(offImageLabel(5)).toBe('Fallback Image URL (shown when no ad can play)')
    for (const t of [0, 2, 3]) expect(offImageLabel(t)).toBeNull()
  })
})

describe('adModeHint', () => {
  it('describes the ads modes without claiming ads need an admin placement', () => {
    expect(adModeHint(4)).toBe('Shows ads while no stream is live. House ads fill it unless a partner ad is placed on it.')
    expect(adModeHint(5)).toBe('Plays the playlist with an ad after every video. House ads fill it unless a partner ad is placed on it.')
    expect(adModeHint(1)).toBeNull()
  })
})
