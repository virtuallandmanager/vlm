import { describe, it, expect, vi } from 'vitest'
import { runHandoff } from './handoff'

const base = 'https://vlm.gg/auth/handoff/#code=SECRET&next=%2Fanalytics%2F%3Fscene%3Dabc'

function deps(status: number) {
  const calls: string[] = []
  return {
    calls,
    d: {
      href: base,
      replaceUrl: vi.fn((u: string) => calls.push(`replace:${u}`)),
      exchange: vi.fn(async (c: string) => { calls.push(`exchange:${c}`); return status === 200 ? { status, body: { accessToken: 'a', refreshToken: 'r', user: { id: 'u' } } } : { status } }),
      saveSession: vi.fn(),
      go: vi.fn((u: string) => calls.push(`go:${u}`)),
    },
  }
}

describe('runHandoff', () => {
  it('reads the code from the fragment and strips the whole fragment before exchanging, then signs in and goes to next', async () => {
    const { calls, d } = deps(200)
    expect(await runHandoff(d)).toBe('signed-in')
    expect(calls[0]).toBe('replace:/auth/handoff/')
    expect(calls[1]).toBe('exchange:SECRET')
    expect(d.saveSession).toHaveBeenCalledWith({ token: 'a', refresh: 'r', user: { id: 'u' } })
    expect(calls.at(-1)).toBe('go:/analytics/?scene=abc')
  })
  it('a used or expired code (410) falls back to sign-in with the same next', async () => {
    const { calls, d } = deps(410)
    expect(await runHandoff(d)).toBe('fallback')
    expect(d.saveSession).not.toHaveBeenCalled()
    expect(calls.at(-1)).toBe(`go:/?next=${encodeURIComponent('/analytics/?scene=abc')}`)
  })
  it('an off-site next is ignored', async () => {
    const { d } = deps(200)
    d.href = 'https://vlm.gg/auth/handoff/#code=X&next=%2F%2Fevil.com'
    await runHandoff(d)
    expect(d.go).toHaveBeenLastCalledWith('/analytics/')
  })
  it('a code in the query string is never exchanged, and is removed from the address bar', async () => {
    const { calls, d } = deps(200)
    d.href = 'https://vlm.gg/auth/handoff/?code=SECRET&next=%2Fanalytics%2F%3Fscene%3Dabc'
    expect(await runHandoff(d)).toBe('fallback')
    expect(d.exchange).not.toHaveBeenCalled()
    expect(calls[0]).toBe('replace:/auth/handoff/')
    expect(calls.at(-1)).toBe('go:/?next=%2Fanalytics%2F')
  })
})
