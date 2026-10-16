import { describe, it, expect } from 'vitest'
import { safeNextPath } from './next-path'

describe('safeNextPath', () => {
  it('accepts same-origin paths with query strings', () => {
    expect(safeNextPath('/analytics/?scene=abc')).toBe('/analytics/?scene=abc')
    expect(safeNextPath('/scenes')).toBe('/scenes')
  })
  it('rejects anything that could leave the site', () => {
    for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'javascript:alert(1)', 'analytics', '', null, undefined, '/%2F%2Fevil.com'.replace('%2F%2F', '//')]) {
      expect(safeNextPath(bad as any)).toBeNull()
    }
  })
  it('rejects dot-segment tricks that normalise to a protocol-relative path', () => {
    for (const bad of ['/.//evil.com', '/a/..//evil.com', '/./\\evil.com']) {
      expect(safeNextPath(bad)).toBeNull()
    }
  })
  it('normalises harmless dot segments', () => {
    expect(safeNextPath('/analytics/./?scene=x')).toBe('/analytics/?scene=x')
  })
})
