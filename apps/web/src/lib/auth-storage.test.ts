import { describe, it, expect } from 'vitest'
import { AUTH_KEY, readStoredAuth } from './auth-storage'

const memory = (entries: Record<string, string>) => {
  const m = new Map(Object.entries(entries))
  return { getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => void m.delete(k), has: (k: string) => m.has(k) }
}

describe('readStoredAuth', () => {
  it('stores the session under virvi_auth', () => {
    expect(AUTH_KEY).toBe('virvi_auth')
  })
  it('ignores a legacy vlm_auth entry and leaves it alone', () => {
    const s = memory({ vlm_auth: JSON.stringify({ token: 't', user: { id: 'u' } }) })
    expect(readStoredAuth(s)).toBeNull()
    expect(s.has('vlm_auth')).toBe(true)
  })
  it('reads virvi_auth', () => {
    const s = memory({ virvi_auth: JSON.stringify({ token: 't', refresh: null, user: { id: 'u' } }) })
    expect(readStoredAuth(s)).toEqual({ token: 't', refresh: null, user: { id: 'u' } })
  })
  it('drops an unreadable entry', () => {
    const s = memory({ virvi_auth: '{not json' })
    expect(readStoredAuth(s)).toBeNull()
    expect(s.has('virvi_auth')).toBe(false)
  })
})
