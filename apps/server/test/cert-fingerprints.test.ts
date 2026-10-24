import { describe, it, expect, vi } from 'vitest'
import { normalizeCertFingerprints } from '../src/config.js'

const HEX = '0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF'
const COLONS = HEX.match(/../g)!.join(':')

describe('normalizeCertFingerprints', () => {
  it('formats lowercase hex without colons', () => {
    expect(normalizeCertFingerprints(HEX.toLowerCase())).toEqual([COLONS])
  })
  it('keeps an already colon-separated fingerprint', () => {
    expect(normalizeCertFingerprints(COLONS)).toEqual([COLONS])
    expect(normalizeCertFingerprints(COLONS.toLowerCase())).toEqual([COLONS])
  })
  it('handles spaces and several entries', () => {
    expect(normalizeCertFingerprints(`  ${HEX.slice(0, 32)} ${HEX.slice(32).toLowerCase()} , ${COLONS} `)).toEqual([COLONS, COLONS])
  })
  it('drops entries of the wrong length or with non-hex characters, warning by index without the value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bad = HEX.slice(0, 62)
    expect(normalizeCertFingerprints(`${bad},${COLONS},${HEX.replace('0', 'G')}`)).toEqual([COLONS])
    expect(warn).toHaveBeenCalledTimes(2)
    const logged = warn.mock.calls.flat().join(' ')
    expect(logged).toContain('entry 0')
    expect(logged).toContain('entry 2')
    expect(logged).not.toContain(bad)
    warn.mockRestore()
  })
  it('returns nothing for empty input', () => {
    expect(normalizeCertFingerprints('')).toEqual([])
    expect(normalizeCertFingerprints(' , ')).toEqual([])
  })
})
