import { describe, it, expect } from 'vitest'
import { FlyApi, FlyError } from '../src/hyperfy/fly.js'

type Call = { url: string; method: string; headers: Record<string, string>; body: any }

function fakeFetch(respond: (c: Call) => { status?: number; body?: unknown } | Error) {
  const calls: Call[] = []
  const fn = (async (url: string, init: any) => {
    const call: Call = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const r = respond(call)
    if (r instanceof Error) throw r
    const status = r.status ?? 200
    const text = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
    return new Response(status === 204 ? null : text, { status })
  }) as unknown as typeof fetch
  return { fn, calls }
}

const mk = (f: typeof fetch) => new FlyApi({ token: 'FlyV1 fm2_secret', org: 'vlm-worlds', fetch: f })

describe('FlyApi', () => {
  it('createApp posts app_name and org_slug', async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 201 }))
    await mk(fn).createApp('vlm-w-moon')
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('https://api.machines.dev/v1/apps')
    expect(calls[0].body).toEqual({ app_name: 'vlm-w-moon', org_slug: 'vlm-worlds' })
  })

  it('createMachine sends the fixed machine config with image, env, region iad, autostop stop, autostart true', async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { id: 'm1', state: 'created' } }))
    const r = await mk(fn).createMachine('vlm-w-moon', { image: 'img:1', env: { A: 'b' } })
    expect(r).toEqual({ id: 'm1' })
    expect(calls[0].url).toBe('https://api.machines.dev/v1/apps/vlm-w-moon/machines')
    expect(calls[0].body).toEqual({
      region: 'iad',
      config: {
        image: 'img:1',
        env: { A: 'b' },
        guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 },
        services: [{
          protocol: 'tcp', internal_port: 3000, autostop: 'stop', autostart: true, min_machines_running: 0,
          ports: [{ port: 80, handlers: ['http'] }, { port: 443, handlers: ['tls', 'http'] }],
        }],
      },
    })
  })

  it('a machine spec with autostart false turns autostart off in the service', async () => {
    const { fn, calls } = fakeFetch(() => ({ body: {} }))
    await mk(fn).updateMachine('a', 'm1', { image: 'i', env: {}, autostart: false })
    expect(calls[0].body.config.services[0]).toMatchObject({ autostop: 'stop', autostart: false })
  })

  it('updateMachine, lists, env, stop, start and ip allocation hit the right routes', async () => {
    const { fn, calls } = fakeFetch((c) => {
      if (c.method === 'GET' && c.url.endsWith('/machines')) return { body: [{ id: 'm1', state: 'started', extra: 1 }] }
      if (c.method === 'GET') return { body: { id: 'm1', state: 'started', config: { env: { K: 'v' } } } }
      return { body: {} }
    })
    const api = mk(fn)
    await api.updateMachine('a', 'm1', { image: 'i', env: {} })
    expect(await api.listMachines('a')).toEqual([{ id: 'm1', state: 'started' }])
    expect(await api.getMachineEnv('a', 'm1')).toEqual({ K: 'v' })
    await api.stopMachine('a', 'm1')
    await api.startMachine('a', 'm1')
    await api.allocatePublicIps('a')
    const base = 'https://api.machines.dev/v1/apps/a'
    expect(calls.map((c) => `${c.method} ${c.url.replace(base, '')}`)).toEqual([
      'POST /machines/m1', 'GET /machines', 'GET /machines/m1', 'POST /machines/m1/stop',
      'POST /machines/m1/start', 'POST /ip_assignments', 'POST /ip_assignments',
    ])
    expect(calls[0].body.config.image).toBe('i')
    expect(calls.slice(5).map((c) => c.body)).toEqual([{ type: 'shared_v4' }, { type: 'v6' }])
  })

  it('deleteApp treats 404 as done', async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 404, body: { error: 'not found' } }))
    await expect(mk(fn).deleteApp('gone')).resolves.toBeUndefined()
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toBe('https://api.machines.dev/v1/apps/gone')
  })

  it('non-2xx and network errors become FlyError with status and Fly\'s message', async () => {
    const { fn } = fakeFetch(() => ({ status: 422, body: { error: 'We require your billing information, add a card' } }))
    const err = await mk(fn).createApp('x').catch((e) => e)
    expect(err).toBeInstanceOf(FlyError)
    expect(err.status).toBe(422)
    expect(err.message).toContain('422')
    expect(err.message).toContain('We require your billing information')
    expect(err.body).toContain('billing')

    const { fn: down } = fakeFetch(() => new Error('connect ECONNREFUSED'))
    const err2 = await mk(down).stopMachine('a', 'm').catch((e) => e)
    expect(err2).toBeInstanceOf(FlyError)
    expect(err2.status).toBe(0)
    expect(err2.message).toContain('ECONNREFUSED')

    const { fn: html } = fakeFetch(() => ({ status: 502, body: '<html>bad gateway</html>' }))
    const err3 = await mk(html).startMachine('a', 'm').catch((e) => e)
    expect(err3.status).toBe(502)
  })

  it('the token is sent as a bearer header and never appears in an error message', async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 401, body: { error: 'bad token FlyV1 fm2_secret' } }))
    const err = await mk(fn).createApp('x').catch((e) => e)
    expect(calls[0].headers.Authorization).toBe('Bearer FlyV1 fm2_secret')
    expect(err.message).not.toContain('fm2_secret')
    expect(err.body).not.toContain('fm2_secret')

    const { fn: down } = fakeFetch(() => new Error('failed with Bearer FlyV1 fm2_secret'))
    const err2 = await mk(down).createApp('x').catch((e) => e)
    expect(err2.message).not.toContain('fm2_secret')
  })

  it('allocatePrivateIp asks for one private_v6 (Flycast) address', async () => {
    const { fn, calls } = fakeFetch(() => ({ body: {} }))
    await mk(fn).allocatePrivateIp('vlm-w-moon')
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', 'https://api.machines.dev/v1/apps/vlm-w-moon/ip_assignments', { type: 'private_v6' }],
    ])
  })

  it('a request that takes longer than the timeout becomes FlyError status 0', async () => {
    const hang = (async (_url: string, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason))
      })) as unknown as typeof fetch
    const api = new FlyApi({ token: 'FlyV1 fm2_secret', org: 'vlm-worlds', fetch: hang, timeoutMs: 20 })
    const err = await api.createApp('slow').catch((e) => e)
    expect(err).toBeInstanceOf(FlyError)
    expect(err.status).toBe(0)
    expect(err.message).toMatch(/timed out/)
  })

  it('the default timeout is 30 s', async () => {
    let signal: AbortSignal | undefined
    const { fn } = fakeFetch(() => ({ status: 201 }))
    const spy = (async (url: string, init: any) => { signal = init.signal; return fn(url, init) }) as unknown as typeof fetch
    const realTimeout = AbortSignal.timeout
    const seen: number[] = []
    AbortSignal.timeout = (ms: number) => { seen.push(ms); return realTimeout.call(AbortSignal, ms) }
    try {
      await mk(spy).createApp('x')
    } finally {
      AbortSignal.timeout = realTimeout
    }
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(seen).toEqual([30_000])
  })

  it('a 2xx body that is not JSON becomes FlyError', async () => {
    const { fn } = fakeFetch(() => ({ status: 200, body: '<html>maintenance</html>' }))
    const err = await mk(fn).createMachine('a', { image: 'i', env: {} }).catch((e) => e)
    expect(err).toBeInstanceOf(FlyError)
    expect(err.status).toBe(200)
    expect(err.message).toMatch(/not JSON/)
  })
})
