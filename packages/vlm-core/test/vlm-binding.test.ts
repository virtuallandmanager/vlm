import { describe, it, expect, vi, afterEach } from 'vitest'
import { VLM } from '../src/VLM.js'

const adapter = {
  capabilities: { platformName: 'decentraland' },
  getPlatformUser: async () => ({ id: 'u' }),
  getSceneInfo: async () => ({ sceneId: null }),
  getEnvironment: async () => ({}),
  getAuthProof: async () => ({}),
} as any

describe('VLM.authenticate binding', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('a new sign-in starts with no binding, so a failed one never keeps the previous scene', async () => {
    const ok = { accessToken: 'a', refreshToken: 'r', user: { id: 'u', role: 'user' }, scene: { sceneId: 's1', locationId: 'l1' } }
    let fail = false
    vi.stubGlobal('fetch', vi.fn(async () => (fail ? new Response('{}', { status: 500 }) : new Response(JSON.stringify(ok), { status: 200 }))))
    const vlm = new VLM(adapter)
    await vlm.authenticate({ apiUrl: 'https://api.example' } as any)
    expect(vlm.binding).toEqual({ sceneId: 's1', locationId: 'l1' })
    fail = true
    await expect(vlm.authenticate({ apiUrl: 'https://api.example' } as any)).rejects.toBeTruthy()
    expect(vlm.binding).toBeNull()
  })
})
