import { describe, it, expect, afterEach, vi } from 'vitest'
import { Authenticator } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto.js'
import { createPayload } from '@dcl/crypto-middleware'
import { Wallet } from 'ethers'
import {
  buildEntity, chainSigner, dclHash, signedFetchPayload, verifyChain, virviSigner,
  type SceneMetadata,
} from '../src/services/dcl/entity.js'

const META: SceneMetadata = {
  display: { title: 'Test' },
  scene: { parcels: ['0,0'], base: '0,0' },
  main: 'bin/index.js',
  ecs7: true,
  runtimeVersion: '7',
  worldConfiguration: { name: 'test.dcl.eth' },
  spawnPoints: [],
}
// a real CIDv1: the builder validates hash format
const H = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq'
const TS = 1_700_000_000_000

async function ephemeralChain(wallet: ReturnType<typeof createUnsafeIdentity>, payload: string) {
  const ephemeral = createUnsafeIdentity()
  const identity = await Authenticator.initializeAuthChain(
    wallet.address, ephemeral, 10, async (m) => Authenticator.createSignature(wallet, m),
  )
  return Authenticator.signPayload(identity, payload)
}

describe('dclHash', () => {
  it('is a CIDv1 (bafk...) and stable', async () => {
    const h = await dclHash(new Uint8Array([1, 2, 3]))
    expect(h).toMatch(/^bafk/)
    expect(await dclHash(new Uint8Array([1, 2, 3]))).toBe(h)
  })
})

describe('buildEntity', () => {
  const existing = [{ file: 'bin/index.js', hash: H }]

  it('is deterministic and timestamp-sensitive', async () => {
    const a = await buildEntity({ pointers: ['0,0'], metadata: META, existing, newFiles: new Map(), timestamp: TS })
    const b = await buildEntity({ pointers: ['0,0'], metadata: META, existing, newFiles: new Map(), timestamp: TS })
    const c = await buildEntity({ pointers: ['0,0'], metadata: META, existing, newFiles: new Map(), timestamp: TS + 1 })
    expect(a.entityId).toBe(b.entityId)
    expect(c.entityId).not.toBe(a.entityId)
  })

  it('with no new files returns only the entity file, listing existing hashes', async () => {
    const r = await buildEntity({ pointers: ['0,0'], metadata: META, existing, newFiles: new Map(), timestamp: TS })
    expect([...r.files.keys()]).toEqual([r.entityId])
    const entity = JSON.parse(new TextDecoder().decode(r.files.get(r.entityId)!))
    expect(entity.type).toBe('scene')
    expect(entity.pointers).toEqual(['0,0'])
    expect(entity.timestamp).toBe(TS)
    expect(entity.metadata.main).toBe('bin/index.js')
    expect(entity.content).toEqual([{ file: 'bin/index.js', hash: H }])
  })

  it('puts a new GLB in files (by dclHash) and in the entity content', async () => {
    const glb = new Uint8Array([9, 8, 7, 6])
    const hash = await dclHash(glb)
    const r = await buildEntity({
      pointers: ['0,0'], metadata: META, existing, newFiles: new Map([['models/a.glb', glb]]), timestamp: TS,
    })
    expect(r.files.size).toBe(2)
    expect(r.files.get(hash)).toEqual(glb)
    expect(r.files.has(r.entityId)).toBe(true)
    const entity = JSON.parse(new TextDecoder().decode(r.files.get(r.entityId)!))
    expect(entity.content).toContainEqual({ file: 'models/a.glb', hash })
    expect(entity.content).toContainEqual({ file: 'bin/index.js', hash: H })
  })

  it('does not depend on the order of existing / new files', async () => {
    const f1 = new Uint8Array([1]); const f2 = new Uint8Array([2])
    const ex2 = [{ file: 'z.js', hash: H }, { file: 'a.js', hash: H }]
    const a = await buildEntity({ pointers: ['0,0'], metadata: META, existing: ex2, newFiles: new Map([['m/1.glb', f1], ['m/2.glb', f2]]), timestamp: TS })
    const b = await buildEntity({ pointers: ['0,0'], metadata: META, existing: [...ex2].reverse(), newFiles: new Map([['m/2.glb', f2], ['m/1.glb', f1]]), timestamp: TS })
    expect(a.entityId).toBe(b.entityId)
  })

  it('rejects a new file that reuses an existing path', async () => {
    await expect(buildEntity({
      pointers: ['0,0'], metadata: META, existing, newFiles: new Map([['bin/index.js', new Uint8Array([1])]]), timestamp: TS,
    })).rejects.toThrow(/bin\/index\.js/)
  })
})

describe('signatures', () => {
  const a = createUnsafeIdentity()
  const b = createUnsafeIdentity()

  it('signedFetchPayload matches the @dcl/crypto-middleware format', () => {
    expect(signedFetchPayload('POST', '/Entities', 1700000000000, '{"A":1}'))
      .toBe(createPayload('POST', '/Entities', '1700000000000', '{"A":1}'))
    expect(signedFetchPayload('POST', '/Entities', 1700000000000, '{"A":1}'))
      .toBe('post:/entities:1700000000000:{"A":1}')
  })

  it('verifyChain accepts the right signer and payload only', async () => {
    const { entityId } = await buildEntity({ pointers: ['0,0'], metadata: META, existing: [], newFiles: new Map(), timestamp: TS })
    const chain = await ephemeralChain(a, entityId)
    expect(chainSigner(chain)).toBe(a.address.toLowerCase())
    expect(await verifyChain(chain, entityId, a.address)).toBe(true)
    expect(await verifyChain(chain, entityId + 'x', a.address)).toBe(false)
    expect(await verifyChain(chain, entityId, b.address)).toBe(false)
  })

  it('chainSigner is null for an empty chain', () => {
    expect(chainSigner([])).toBeNull()
  })
})

describe('virviSigner', () => {
  afterEach(() => { delete process.env.VIRVI_DCL_DEPLOY_KEY; vi.resetModules() })

  async function load() {
    vi.resetModules()
    return import('../src/services/dcl/entity.js')
  }

  it('is null without VIRVI_DCL_DEPLOY_KEY', async () => {
    delete process.env.VIRVI_DCL_DEPLOY_KEY
    expect((await load()).virviSigner()).toBeNull()
  })

  it('signs ephemeral chains that verify against its address', async () => {
    const key = Wallet.createRandom().privateKey
    process.env.VIRVI_DCL_DEPLOY_KEY = key
    const m = await load()
    const s = m.virviSigner()!
    expect(s.address).toBe(new Wallet(key).address.toLowerCase())
    const chain = await s.signChain('x')
    expect(await m.verifyChain(chain, 'x', s.address)).toBe(true)
    expect(await m.verifyChain(chain, 'y', s.address)).toBe(false)
  })
})
