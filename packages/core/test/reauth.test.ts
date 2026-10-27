import { describe, it, expect, vi, afterEach } from 'vitest'
import { VirviHttpClient } from '@virvixr/client'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const bearer = (init: RequestInit | undefined) => (init?.headers as Record<string, string> | undefined)?.Authorization

describe('VirviHttpClient re-signs an expired scene pass', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('on a 401 it signs in again once, then retries with the new token', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      bearer(init) === 'Bearer fresh' ? json({ items: [] }) : json({ error: 'Unauthorized' }, 401))
    vi.stubGlobal('fetch', fetchMock)
    const client = new VirviHttpClient('https://api.example')
    client.auth.setTokens('stale', null)
    const reauth = vi.fn(async () => { client.auth.setTokens('fresh', null) })
    client.reauthenticate = reauth
    expect(await client.getSceneLibrary('s1')).toEqual({ items: [] })
    expect(reauth).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a second 401 after signing in again is thrown, not retried forever', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Unauthorized' }, 401)))
    const client = new VirviHttpClient('https://api.example')
    client.auth.setTokens('stale', null)
    const reauth = vi.fn(async () => { client.auth.setTokens('still-bad', null) })
    client.reauthenticate = reauth
    await expect(client.getSceneLibrary('s1')).rejects.toThrow('HTTP 401')
    expect(reauth).toHaveBeenCalledTimes(1)
  })

  it('concurrent 401s share one new sign-in', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) =>
      bearer(init) === 'Bearer fresh' ? json({ items: [] }) : json({ error: 'Unauthorized' }, 401)))
    const client = new VirviHttpClient('https://api.example')
    client.auth.setTokens('stale', null)
    const reauth = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); client.auth.setTokens('fresh', null) })
    client.reauthenticate = reauth
    await Promise.all([client.getSceneLibrary('a'), client.getSceneLibrary('b'), client.getScenes()])
    expect(reauth).toHaveBeenCalledTimes(1)
  })

  it('without a re-auth hook (or a failing one) a 401 is thrown as before', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Unauthorized' }, 401)))
    const client = new VirviHttpClient('https://api.example')
    await expect(client.getSceneLibrary('s1')).rejects.toThrow('HTTP 401')
    client.reauthenticate = async () => { throw new Error('signedFetch failed') }
    await expect(client.getSceneLibrary('s1')).rejects.toThrow('HTTP 401')
  })
})
