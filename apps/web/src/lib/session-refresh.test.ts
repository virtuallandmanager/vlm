import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AUTH_KEY } from './auth-storage'
import { refreshStoredSession, _resetRefresh } from './session-refresh'

function memoryStorage(initial?: unknown) {
  const m = new Map<string, string>()
  if (initial) m.set(AUTH_KEY, JSON.stringify(initial))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    stored: () => (m.has(AUTH_KEY) ? JSON.parse(m.get(AUTH_KEY)!) : null),
  }
}
const user = { id: 'u1', displayName: 'Ana', email: 'ana@example.com', role: 'user' }
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

describe('refreshStoredSession', () => {
  beforeEach(() => _resetRefresh())

  it('swaps the stored refresh token for a new access token and keeps the rest of the session', async () => {
    const storage = memoryStorage({ token: 'old', refresh: 'r1', user })
    const post = vi.fn(async () => reply(200, { accessToken: 'new' }))
    expect(await refreshStoredSession(storage, post)).toEqual({ token: 'new' })
    expect(post).toHaveBeenCalledWith('r1')
    expect(storage.stored()).toEqual({ token: 'new', refresh: 'r1', user })
  })

  it('does nothing without a stored refresh token', async () => {
    const post = vi.fn()
    expect(await refreshStoredSession(memoryStorage({ token: 'old', user }), post)).toEqual({ refused: true })
    expect(await refreshStoredSession(memoryStorage(), post)).toEqual({ refused: true })
    expect(post).not.toHaveBeenCalled()
  })

  it('ends the session when the server refuses the refresh token', async () => {
    const storage = memoryStorage({ token: 'old', refresh: 'r1', user })
    expect(await refreshStoredSession(storage, async () => reply(401, { error: 'Invalid or expired refresh token' }))).toEqual({ refused: true })
    expect(storage.stored()).toBeNull()
  })

  it('keeps the session when the refresh could not be reached', async () => {
    const storage = memoryStorage({ token: 'old', refresh: 'r1', user })
    expect(await refreshStoredSession(storage, async () => { throw new TypeError('Failed to fetch') })).toEqual({ unreachable: true })
    expect(await refreshStoredSession(storage, async () => reply(503, {}))).toEqual({ unreachable: true })
    expect(storage.stored()).toEqual({ token: 'old', refresh: 'r1', user })
  })

  it('asks the server once for requests that expire together', async () => {
    const storage = memoryStorage({ token: 'old', refresh: 'r1', user })
    let release!: () => void
    const post = vi.fn(() => new Promise<ReturnType<typeof reply>>((r) => { release = () => r(reply(200, { accessToken: 'new' })) }))
    const all = Promise.all([1, 2, 3].map(() => refreshStoredSession(storage, post)))
    release()
    expect(await all).toEqual([{ token: 'new' }, { token: 'new' }, { token: 'new' }])
    expect(post).toHaveBeenCalledTimes(1)
  })
})
