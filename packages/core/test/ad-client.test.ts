import { describe, it, expect, vi } from 'vitest'
import { VLMHttpClient } from '@virvixr/client'

const REQ = { elementIds: ['e1'] } as any
const BATCH = { v: 1, sessionId: 's', events: [{ adId: 'a1', elementId: 'e1', level: 'screen', t: 1 }] } as any
const SERVE = { spaces: { e1: { paused: false, ads: [] } } }

function makeClient() {
  return new VLMHttpClient('https://api.example')
}

describe('VLMHttpClient ad calls', () => {
  it('getAds posts to /api/ads/serve and parses the response', async () => {
    const signedRequest = vi.fn(async () => ({ status: 200, body: JSON.stringify(SERVE) }))
    const res = await makeClient().getAds({ signedRequest } as any, REQ)
    expect(signedRequest).toHaveBeenCalledWith('https://api.example/api/ads/serve', { method: 'POST', body: JSON.stringify(REQ) })
    expect(res).toEqual(SERVE)
  })

  it('getAds returns null on 500 or a thrown request', async () => {
    const client = makeClient()
    expect(await client.getAds({ signedRequest: async () => ({ status: 500, body: '{}' }) } as any, REQ)).toBeNull()
    expect(await client.getAds({ signedRequest: async () => { throw new Error('x') } } as any, REQ)).toBeNull()
    expect(await client.getAds({} as any, REQ)).toBeNull()
  })

  it('sendAdEvents posts the batch and reports the status', async () => {
    const signedRequest = vi.fn(async () => ({ status: 200, body: '{"accepted":1}' }))
    expect(await makeClient().sendAdEvents({ signedRequest } as any, BATCH)).toEqual({ ok: true, status: 200 })
    expect(signedRequest).toHaveBeenCalledWith('https://api.example/api/ads/events', { method: 'POST', body: JSON.stringify(BATCH) })
    expect(await makeClient().sendAdEvents({ signedRequest: async () => ({ status: 400, body: '' }) } as any, BATCH)).toEqual({ ok: false, status: 400 })
    expect(await makeClient().sendAdEvents({ signedRequest: async () => ({ status: 500, body: '' }) } as any, BATCH)).toEqual({ ok: false, status: 500 })
    // network failure or no signed request: status 0
    expect(await makeClient().sendAdEvents({ signedRequest: async () => { throw new Error('x') } } as any, BATCH)).toEqual({ ok: false, status: 0 })
    expect(await makeClient().sendAdEvents({} as any, BATCH)).toEqual({ ok: false, status: 0 })
  })
})
