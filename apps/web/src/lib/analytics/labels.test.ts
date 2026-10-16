import { describe, it, expect } from 'vitest'
import { visitorLabel, formatDuration } from './labels'

describe('visitorLabel', () => {
  it('prefers a display name, then a short wallet, then the hash prefix', () => {
    expect(visitorLabel({ displayName: 'Ana', walletAddress: '0xabcdef0123456789abcdef0123456789abcdef01', userId: 'f00dbabe12345678' })).toBe('Ana')
    expect(visitorLabel({ displayName: null, walletAddress: '0xabcdef0123456789abcdef0123456789abcdef01', userId: 'f00dbabe12345678' })).toBe('0xabcd…ef01')
    expect(visitorLabel({ displayName: null, walletAddress: null, userId: 'f00dbabe12345678' })).toBe('Visitor f00dbabe')
  })
})

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(42)).toBe('42s')
    expect(formatDuration(125)).toBe('2m 5s')
    expect(formatDuration(3720)).toBe('1h 2m')
    expect(formatDuration(0)).toBe('0s')
  })
})
