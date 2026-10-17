import { describe, it, expect, afterEach, vi } from 'vitest'
import { HttpDclDirectory, TtlCache, DirectoryUnavailableError } from '../src/analytics/dcl-directory.js'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('HttpDclDirectory caching', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('caches parcel rights; one /permissions fetch serves owner and deployers', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/operators')) return json({ owner: '0xAA', operator: null, updateOperator: null, updateManagers: [], approvedForAll: [] })
      if (url.includes('/permissions')) return json({ owner: '0xBB', permissions: { deployment: { type: 'allow-list', wallets: ['0xCC'] } } })
      return json(null, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    const dir = new HttpDclDirectory('https://cat', 'https://worlds')
    expect((await dir.getParcelRights('1,1'))?.owner).toBe('0xaa')
    expect((await dir.getParcelRights('1,1'))?.owner).toBe('0xaa')
    expect(await dir.getWorldOwner('Y.dcl.eth')).toBe('0xbb')
    expect(await dir.getWorldDeployers('y.dcl.eth')).toEqual(['0xcc'])
    expect(await dir.getWorldOwner('y.dcl.eth')).toBe('0xbb')
    expect(fetchMock.mock.calls.filter(([u]) => u.includes('/operators'))).toHaveLength(1)
    expect(fetchMock.mock.calls.filter(([u]) => u.includes('/permissions'))).toHaveLength(1)
  })

  it('deployer cache is keyed to the deployment entity', async () => {
    let entity = 'bafyA'
    let by = '0xAA'
    const fetchMock = vi.fn(async () => json({ deployments: [{ entityId: entity, deployedBy: by }] }))
    vi.stubGlobal('fetch', fetchMock)
    const dir = new HttpDclDirectory('https://cat', 'https://worlds')
    expect(await dir.getActiveDeployer('1,1', 'bafyA')).toBe('0xaa')
    expect(await dir.getActiveDeployer('1,1', 'bafyA')).toBe('0xaa')
    expect(await dir.getActiveDeployer('1,1')).toBe('0xaa')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    entity = 'bafyB'
    by = '0xBB'
    expect(await dir.getActiveDeployer('1,1', 'bafyB')).toBe('0xbb')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('upstream errors are not cached', async () => {
    let fail = true
    const fetchMock = vi.fn(async () => (fail ? json({}, 500) : json({ owner: '0xAA', updateManagers: [], approvedForAll: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const dir = new HttpDclDirectory('https://cat', 'https://worlds')
    await expect(dir.getParcelRights('2,2')).rejects.toBeInstanceOf(DirectoryUnavailableError)
    fail = false
    expect((await dir.getParcelRights('2,2'))?.owner).toBe('0xaa')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('HttpDclDirectory catalyst list and active scenes', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('parses the DAO catalyst list (https hosts only, no ports), caches it, and remembers a failure for a minute', async () => {
    let fail = false
    const fetchMock = vi.fn(async (url: string) => {
      if (!url.endsWith('/lambdas/contracts/servers')) return json(null, 404)
      if (fail) return json({}, 503)
      return json([{ baseUrl: 'https://Peer-EC1.decentraland.org' }, { baseUrl: 'https://peer.melonwave.com/' }, { baseUrl: 'http://plain.example' }, { baseUrl: 'https://port.example:8443' }, { baseUrl: 'not a url' }, {}])
    })
    vi.stubGlobal('fetch', fetchMock)
    const dir = new HttpDclDirectory('https://cat', 'https://worlds')
    expect(await dir.getCatalystHosts()).toEqual(['peer-ec1.decentraland.org', 'peer.melonwave.com'])
    expect(await dir.getCatalystHosts()).toEqual(['peer-ec1.decentraland.org', 'peer.melonwave.com'])
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.useFakeTimers({ toFake: ['Date'] })
    fail = true
    const down = new HttpDclDirectory('https://cat', 'https://worlds')
    await expect(down.getCatalystHosts()).rejects.toBeInstanceOf(DirectoryUnavailableError)
    await expect(down.getCatalystHosts()).rejects.toBeInstanceOf(DirectoryUnavailableError)
    expect(fetchMock).toHaveBeenCalledTimes(2) // the second refusal didn't fetch
    vi.setSystemTime(Date.now() + 61_000)
    fail = false
    expect(await down.getCatalystHosts()).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('caches active scene and World lookups briefly', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/entities/active') ? json([{ id: 'bafyA', metadata: { scene: { base: '1,1', parcels: ['1,1'] } } }]) : json({ configurations: { scenesUrn: ['urn:decentraland:entity:bafyW'] } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const dir = new HttpDclDirectory('https://cat', 'https://worlds')
    for (let i = 0; i < 3; i++) {
      expect((await dir.getActiveSceneAt('1,1'))?.entityId).toBe('bafyA')
      expect((await dir.getWorldScene(i % 2 ? 'W.dcl.eth' : 'w.dcl.eth'))?.sceneUrns).toHaveLength(1)
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('TtlCache', () => {
  it('expires entries after the TTL and stays bounded', () => {
    let now = 0
    const c = new TtlCache<number>(60_000, 2, () => now)
    c.set('a', 1)
    now = 59_999
    expect(c.get('a')).toEqual({ value: 1 })
    now = 60_000
    expect(c.get('a')).toBeUndefined()
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    expect(c.size).toBe(2)
    expect(c.get('a')).toBeUndefined()
    expect(c.get('c')).toEqual({ value: 3 })
  })
})
