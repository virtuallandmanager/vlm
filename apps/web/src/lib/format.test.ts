import { describe, it, expect } from 'vitest'
import { countLabel, formatBytes, plural } from './format'

describe('list formatting', () => {
  it('pads the count to two digits and separates thousands', () => {
    expect(countLabel(2)).toBe('02')
    expect(countLabel(0)).toBe('00')
    expect(countLabel(123)).toBe('123')
    expect(countLabel(5482)).toBe('5,482')
  })

  it('pluralizes the noun after the count', () => {
    expect(plural(1, 'event')).toBe('1 event')
    expect(plural(4, 'event')).toBe('4 events')
    expect(plural(0, 'file')).toBe('0 files')
    expect(plural(5482, 'asset')).toBe('5,482 assets')
  })

  it('formats file sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(292_966)).toBe('286.1 KB')
    expect(formatBytes(1_468_006)).toBe('1.4 MB')
  })
})
