import { describe, it, expect, vi, afterEach } from 'vitest'
import { VLMHttpClient } from 'vlm-client'

const call = (fetchMock: any, i = 0) => fetchMock.mock.calls[i] as [string, RequestInit]

describe('VLMHttpClient media + element calls', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('getMedia GETs /api/media and returns the assets', async () => {
    const assets = [{ id: 'a1', filename: 'duck.glb', contentType: 'model/gltf-binary', publicUrl: 'https://cdn.vlm.gg/u1/ab.glb', sizeBytes: 10 }]
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ assets }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new VLMHttpClient('https://api.example')
    const res = await client.getMedia()
    expect(res.assets).toEqual(assets)
    expect(call(fetchMock)[0]).toBe('https://api.example/api/media')
    expect(call(fetchMock)[1].method ?? 'GET').toBe('GET')
  })

  it('createElement POSTs type, name and properties to the preset', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ element: { id: 'e1' } }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new VLMHttpClient('https://api.example')
    const body = { type: 'image', name: 'cat.png', properties: { textureSrc: 'https://cdn.vlm.gg/u1/c.png' } }
    const res = await client.createElement('p1', body)
    expect(res.element.id).toBe('e1')
    expect(call(fetchMock)[0]).toBe('https://api.example/api/presets/p1/elements')
    expect(call(fetchMock)[1].method).toBe('POST')
    expect(JSON.parse(call(fetchMock)[1].body as string)).toEqual(body)
  })

  it('createInstance POSTs position, rotation and scale to the element', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ instance: { id: 'i1' } }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new VLMHttpClient('https://api.example')
    const body = { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 90, z: 0 }, scale: { x: 2, y: 2, z: 1 } }
    const res = await client.createInstance('e1', body)
    expect(res.instance.id).toBe('i1')
    expect(call(fetchMock)[0]).toBe('https://api.example/api/elements/e1/instances')
    expect(call(fetchMock)[1].method).toBe('POST')
    expect(JSON.parse(call(fetchMock)[1].body as string)).toEqual(body)
  })

  it('updateElement PUTs the patch', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ element: { id: 'e1', enabled: false } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new VLMHttpClient('https://api.example')
    await client.updateElement('e1', { enabled: false })
    expect(call(fetchMock)[0]).toBe('https://api.example/api/elements/e1')
    expect(call(fetchMock)[1].method).toBe('PUT')
    expect(call(fetchMock)[1].body).toBe(JSON.stringify({ enabled: false }))
  })

  it('deleteElement DELETEs the element and tolerates a 204', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new VLMHttpClient('https://api.example')
    await expect(client.deleteElement('e1')).resolves.toBeUndefined()
    expect(call(fetchMock)[0]).toBe('https://api.example/api/elements/e1')
    expect(call(fetchMock)[1].method).toBe('DELETE')
  })

  it('surfaces the HTTP status in errors (403 → mapped to friendly text by the HUD)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"Forbidden"}', { status: 403 })))
    const client = new VLMHttpClient('https://api.example')
    await expect(client.deleteElement('e1')).rejects.toThrow(/HTTP 403/)
  })
})
