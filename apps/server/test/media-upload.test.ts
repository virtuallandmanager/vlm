import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'
import { classifyUpload, IMAGE_MAX_BYTES, MODEL_MAX_BYTES } from '../src/storage/upload-policy.js'

describe('classifyUpload', () => {
  it('enforces image size boundary', () => {
    expect(classifyUpload('a.png', 'image/png', IMAGE_MAX_BYTES)).toEqual({ ok: true, contentType: 'image/png' })
    expect(classifyUpload('a.png', 'image/png', IMAGE_MAX_BYTES + 1)).toEqual({ ok: false, status: 413, error: 'too_large' })
  })
  it('accepts GLB by extension case-insensitively and normalizes type', () => {
    expect(classifyUpload('DUCK.GLB', 'application/octet-stream', 10)).toEqual({ ok: true, contentType: 'model/gltf-binary' })
    expect(classifyUpload('duck.glb', 'model/gltf-binary', MODEL_MAX_BYTES)).toEqual({ ok: true, contentType: 'model/gltf-binary' })
    expect(classifyUpload('duck.glb', 'model/gltf-binary', MODEL_MAX_BYTES + 1)).toMatchObject({ ok: false, status: 413 })
  })
  it('rejects other types', () => {
    expect(classifyUpload('a.html', 'text/html', 5)).toEqual({ ok: false, status: 415, error: 'unsupported_type' })
    expect(classifyUpload('a.bin', 'application/octet-stream', 5)).toMatchObject({ ok: false, status: 415 })
    expect(classifyUpload('a.svg', 'image/svg+xml', 5)).toMatchObject({ ok: false, status: 415 })
  })
})

describe('POST /api/media/upload', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

  async function upload(filename: string, contentType: string, bytes: number) {
    const user = await createUser()
    return app.inject({
      method: 'POST',
      url: '/api/media/upload',
      headers: { authorization: `Bearer ${tokenFor(user)}` },
      payload: { filename, contentType, data: Buffer.alloc(bytes, 1).toString('base64') },
    })
  }

  it('accepts a small PNG', async () => {
    const res = await upload('a.png', 'image/png', 1024)
    expect(res.statusCode).toBe(201)
    expect(res.json().asset.contentType).toBe('image/png')
  })
  it('stores octet-stream .glb as model/gltf-binary', async () => {
    const res = await upload('duck.glb', 'application/octet-stream', 1024)
    expect(res.statusCode).toBe(201)
    expect(res.json().asset.contentType).toBe('model/gltf-binary')
    expect(res.json().asset.storageKey).toMatch(/\.glb$/)
  })
  it('rejects text/html with 415', async () => {
    const res = await upload('a.html', 'text/html', 100)
    expect(res.statusCode).toBe(415)
    expect(res.json().error).toBe('unsupported_type')
  })
  it('rejects an 11 MB PNG with 413', async () => {
    const res = await upload('big.png', 'image/png', 11 * 1024 * 1024)
    expect(res.statusCode).toBe(413)
    expect(res.json().error).toBe('too_large')
  })
  it('rejects a 51 MB GLB with 413', async () => {
    const res = await upload('big.glb', 'model/gltf-binary', 51 * 1024 * 1024)
    expect(res.statusCode).toBe(413)
  })
})
