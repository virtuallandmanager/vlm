import { describe, it, expect } from 'vitest'
import { HYPERFY_PAIRING, formatPairingCode, normalizePairingCode } from '@virvixr/shared'

describe('pairing constants', () => {
  it('holds the fixed pairing values', () => {
    expect(HYPERFY_PAIRING).toEqual({
      codeTtlMs: 600_000,
      selfPairingTtlMs: 43_200_000,
      hostedIdleTtlMs: 7_776_000_000,
      renewBeforeMs: 120_000,
      claimPollMs: 2_000,
      codeAlphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
      codeLength: 6,
    })
  })
})

describe('formatPairingCode', () => {
  it('formats a code with a dash', () => {
    expect(formatPairingCode('K7Q4XP')).toBe('K7Q-4XP')
  })
})

describe('normalizePairingCode', () => {
  it('normalizes a typed code with lowercase, spaces and a dash', () => {
    expect(normalizePairingCode('k7q-4xp')).toBe('K7Q4XP')
    expect(normalizePairingCode(' k7q 4xp ')).toBe('K7Q4XP')
    expect(normalizePairingCode('K7Q4XP')).toBe('K7Q4XP')
  })

  it('returns null for a code containing 0, O, 1 or I', () => {
    expect(normalizePairingCode('K0Q4XP')).toBeNull()
    expect(normalizePairingCode('KOQ4XP')).toBeNull()
    expect(normalizePairingCode('K1Q4XP')).toBeNull()
    expect(normalizePairingCode('KIQ4XP')).toBeNull()
  })

  it('rejects codes of the wrong length or with characters outside the alphabet', () => {
    expect(normalizePairingCode('K7Q4X')).toBeNull()
    expect(normalizePairingCode('K7Q4XPA')).toBeNull()
    expect(normalizePairingCode('')).toBeNull()
    expect(normalizePairingCode('K7Q4X!')).toBeNull()
  })
})
