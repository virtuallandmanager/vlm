import { describe, it, expect, vi, afterEach } from 'vitest'
import { VLM } from '../src/VLM.js'

const pass = (n: number, sceneId: string | null = 's1') =>
  ({ accessToken: `pass${n}`, refreshToken: null, user: { id: 'u', role: 'user' }, scene: { sceneId, locationId: 'l1' } })

function signedAdapter(answers: Array<object | Error>) {
  const signedRequest = vi.fn(async () => {
    const a = answers.length > 1 ? answers.shift()! : answers[0]
    if (a instanceof Error) throw a
    return { status: 200, body: JSON.stringify(a) }
  })
  const adapter = {
    capabilities: { platformName: 'decentraland' },
    getPlatformUser: async () => ({ id: 'u' }),
    getSceneInfo: async () => ({ sceneId: null }),
    getEnvironment: async () => ({}),
    getAuthProof: async () => ({}),
    signedRequest,
    systems: new Set<(dt: number) => void>(),
    registerSystem(fn: (dt: number) => void) { this.systems.add(fn) },
    unregisterSystem(fn: (dt: number) => void) { this.systems.delete(fn) },
  } as any
  return { adapter, signedRequest }
}

const cfg = { apiUrl: 'https://api.example' } as any

/** Move the clock and run one frame of every registered system. */
async function later(adapter: any, ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
  for (const fn of [...adapter.systems]) fn(ms / 1000)
  await vi.advanceTimersByTimeAsync(0)
}

describe('scene pass renewal', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('renews every 10 min with a signed request and hands the new pass to the room', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const { adapter, signedRequest } = signedAdapter([pass(1), pass(2)])
    const vlm = new VLM(adapter)
    await vlm.authenticate(cfg)
    const colyseus = (vlm as any).colyseus
    vi.spyOn(colyseus, 'getRoom').mockReturnValue({})
    const send = vi.spyOn(colyseus, 'send').mockImplementation(() => {})
    await later(adapter, 10 * 60_000)
    expect(signedRequest).toHaveBeenCalledTimes(2)
    expect(vlm.httpClient.auth.token).toBe('pass2')
    expect(send).toHaveBeenCalledWith('auth_renew', { sessionToken: 'pass2' })
    expect(fetchMock).not.toHaveBeenCalled()
    await vlm.destroy()
    expect(adapter.systems.size).toBe(0)
  })

  it('a failed or guest re-sign keeps the current pass and never falls back to an unverified sign-in', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const { adapter } = signedAdapter([pass(1), new Error('explorer busy'), { accessToken: 'guest', refreshToken: null, user: { id: 'g', role: 'viewer' }, guest: true }])
    const vlm = new VLM(adapter)
    await vlm.authenticate(cfg)
    await later(adapter, 10 * 60_000)
    await later(adapter, 10 * 60_000)
    expect(vlm.httpClient.auth.token).toBe('pass1')
    expect(vlm.binding).toEqual({ sceneId: 's1', locationId: 'l1' })
    expect(fetchMock).not.toHaveBeenCalled()
    await vlm.destroy()
  })

  it('guests and visitor passes are not renewed', async () => {
    vi.useFakeTimers()
    const { adapter, signedRequest } = signedAdapter([pass(1, null)])
    const vlm = new VLM(adapter)
    await vlm.authenticate(cfg)
    await later(adapter, 30 * 60_000)
    expect(signedRequest).toHaveBeenCalledTimes(1)
    expect(adapter.systems.size).toBe(0)
  })

  it('a re-sign on a replaced client never overwrites the newer sign-in', async () => {
    const { adapter } = signedAdapter([pass(1, 's1'), pass(2, 's2'), pass(3, 's1')])
    const vlm = new VLM(adapter)
    await vlm.authenticate(cfg)
    const old = vlm.httpClient
    await vlm.authenticate(cfg)
    await old.reauthenticate!()
    expect(vlm.binding?.sceneId).toBe('s2')
    expect(vlm.httpClient.auth.token).toBe('pass2')
    await vlm.destroy()
  })
})
