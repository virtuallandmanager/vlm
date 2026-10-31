import { describe, it, expect, vi, beforeEach } from 'vitest'

// React's hooks, faked just enough to render a hook twice: memoized values are kept per call position and reused
// while their deps are unchanged, as React does between renders.
const slots: { deps: unknown[]; value: unknown }[] = []
let cursor = 0
const memo = (make: () => unknown, deps: unknown[]) => {
  const slot = slots[cursor]
  cursor++
  if (slot && slot.deps.length === deps.length && slot.deps.every((d, i) => Object.is(d, deps[i]))) return slot.value
  const value = make()
  slots[cursor - 1] = { deps, value }
  return value
}
vi.mock('react', () => ({
  useCallback: (fn: unknown, deps: unknown[]) => memo(() => fn, deps),
  useMemo: (make: () => unknown, deps: unknown[]) => memo(make, deps),
}))
let token = 't1'
const logout = () => {}
vi.mock('./auth', () => ({ useAuth: () => ({ token, logout }) }))

const { useApi } = await import('./api')
const render = () => { cursor = 0; return useApi() }

describe('useApi', () => {
  beforeEach(() => { slots.length = 0; token = 't1' })

  it('returns the same api between renders, so effects that depend on it run once', () => {
    const first = render()
    const second = render()
    expect(second).toBe(first)
    expect(second.getSceneCollaborators).toBe(first.getSceneCollaborators)
  })

  it('returns a new api when the session changes', () => {
    const first = render()
    token = 't2'
    expect(render()).not.toBe(first)
  })
})
