import { describe, it, expect, afterEach, vi } from 'vitest'
import { ensureNetworkPolyfills, ColyseusManager } from 'vlm-client'
import { VLM } from '../src/VLM.js'

const g = globalThis as any
const saved = { URL: g.URL, XMLHttpRequest: g.XMLHttpRequest, fetch: g.fetch }

afterEach(() => {
  g.URL = saved.URL
  g.XMLHttpRequest = saved.XMLHttpRequest
  g.fetch = saved.fetch
  vi.restoreAllMocks()
})

describe('ensureNetworkPolyfills (runtimes without URL / XMLHttpRequest, e.g. Decentraland)', () => {
  it('installs a URL that parses ws/http endpoints the way colyseus.js reads them', () => {
    delete g.URL
    ensureNetworkPolyfills()
    const u = new g.URL('ws://localhost:3010')
    expect(u.protocol).toBe('ws:')
    expect(u.hostname).toBe('localhost')
    expect(u.port).toBe('3010')
    expect(u.host).toBe('localhost:3010')
    const p = new g.URL('wss://api.vlm.gg/sub/path?x=1')
    expect(p.pathname).toBe('/sub/path')
    expect(p.search).toBe('?x=1')
    expect(p.port).toBe('')
  })

  it('leaves a native URL alone', () => {
    const native = g.URL
    ensureNetworkPolyfills()
    expect(g.URL).toBe(native)
  })

  it('installs a fetch-backed XMLHttpRequest that httpie can drive', async () => {
    delete g.XMLHttpRequest
    g.fetch = vi.fn(async (_url: string, init: any) => ({
      status: 200,
      statusText: 'OK',
      headers: new Map([['content-type', 'application/json']]),
      text: async () => JSON.stringify({ echo: JSON.parse(init.body), method: init.method, auth: init.headers.Authorization }),
    }))
    ensureNetworkPolyfills()
    const req = new g.XMLHttpRequest()
    const done = new Promise<void>((resolve, reject) => {
      req.onload = () => resolve()
      req.onerror = (e: unknown) => reject(e)
    })
    req.open('POST', 'http://localhost:3010/matchmake/joinOrCreate/vlm_scene')
    req.withCredentials = true
    req.setRequestHeader('Authorization', 'Bearer t')
    req.send(JSON.stringify({ sceneId: 's1' }))
    await done
    expect(req.status).toBe(200)
    expect(req.getAllResponseHeaders()).toContain('content-type: application/json')
    expect(JSON.parse(req.response)).toEqual({ echo: { sceneId: 's1' }, method: 'POST', auth: 'Bearer t' })
  })

  it('reports network failures through onerror', async () => {
    delete g.XMLHttpRequest
    g.fetch = vi.fn(async () => {
      throw new Error('offline')
    })
    ensureNetworkPolyfills()
    const req = new g.XMLHttpRequest()
    const err = await new Promise<any>((resolve) => {
      req.onerror = resolve
      req.open('GET', 'http://localhost:3010/x')
      req.send()
    })
    expect(err.type).toBe('error')
  })

  it('ColyseusManager.connect installs the polyfills before creating the client', () => {
    delete g.URL
    delete g.XMLHttpRequest
    new ColyseusManager().connect('ws://localhost:3010')
    expect(typeof g.URL).toBe('function')
    expect(typeof g.XMLHttpRequest).toBe('function')
  })
})

describe('VLM.connectToScene', () => {
  it('moves to the error state (instead of hanging in "connecting") when starting the connection throws', async () => {
    vi.spyOn(ColyseusManager.prototype, 'connect').mockImplementation(() => {
      throw new Error('boom')
    })
    const vlm = new VLM({ capabilities: { platformName: 'test' } } as any)
    const states: string[] = []
    vlm.onStateChange((s) => states.push(s))
    await expect(vlm.connectToScene('scene-1')).rejects.toThrow('boom')
    expect(states).toEqual(['connecting', 'error'])
  })
})
