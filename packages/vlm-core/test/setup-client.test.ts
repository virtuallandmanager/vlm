import { describe, it, expect, vi, afterEach } from 'vitest'
import { VLMHttpClient } from 'vlm-client'

const REF = { realm: 'main', isWorld: false, isPreview: false, baseParcel: '1,1', parcels: ['1,1'] }

describe('VLMHttpClient setup calls', () => {
  it('getSetupStatus posts the scene ref through the signed request and parses the state', async () => {
    const signedRequest = vi.fn(async () => ({ status: 200, body: JSON.stringify({ state: 'member', sceneId: 's1', role: 'host' }) }))
    const client = new VLMHttpClient('https://api.example')
    const res = await client.getSetupStatus(REF as any, { signedRequest } as any)
    expect(res).toEqual({ state: 'member', sceneId: 's1', role: 'host' })
    expect(signedRequest).toHaveBeenCalledWith('https://api.example/api/setup/status', { method: 'POST', body: JSON.stringify({ scene: REF }) })
  })

  it('getSetupStatus treats failures as none, and adapters without signed requests as none', async () => {
    const client = new VLMHttpClient('https://api.example')
    expect(await client.getSetupStatus(REF as any, { signedRequest: async () => { throw new Error('x') } } as any)).toEqual({ state: 'none' })
    expect(await client.getSetupStatus(REF as any, {} as any)).toEqual({ state: 'none' })
  })

  it('setUpHere returns the scene id, or the error with status', async () => {
    const client = new VLMHttpClient('https://api.example')
    expect(await client.setUpHere(REF as any, { signedRequest: async () => ({ status: 200, body: '{"sceneId":"s9"}' }) } as any)).toEqual({ sceneId: 's9' })
    expect(await client.setUpHere(REF as any, { signedRequest: async () => ({ status: 409, body: '{"error":"already_set_up","host":"0xab…cd"}' }) } as any)).toEqual({
      error: 'already_set_up', host: '0xab…cd', status: 409,
    })
  })
})

describe('VLMHttpClient role calls', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('removeSceneRole tolerates a 204 with no body', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new VLMHttpClient('https://api.example')
    await expect(client.removeSceneRole('s1', '0xabc')).resolves.toBeUndefined()
    expect((fetchMock.mock.calls[0] as any)[0]).toBe('https://api.example/api/scenes/s1/roles/0xabc')
    expect((fetchMock.mock.calls[0] as any)[1].method).toBe('DELETE')
  })

  it('addSceneRole posts wallet and role', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ role: { wallet: '0xabc', role: 'editor', userId: null } }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new VLMHttpClient('https://api.example')
    const res = await client.addSceneRole('s1', '0xabc', 'editor')
    expect(res.role.role).toBe('editor')
    expect((fetchMock.mock.calls[0] as any)[1].body).toBe(JSON.stringify({ wallet: '0xabc', role: 'editor' }))
  })
})
