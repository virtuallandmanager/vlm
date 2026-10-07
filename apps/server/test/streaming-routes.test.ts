// apps/server/test/streaming-routes.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { streamingServers } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { resetDb } from './helpers/db.js'
import { createUser, tokenFor, testApp } from './helpers/factories.js'

const KEY = 'test-webhook-secret'
const PLAYLIST = 'https://live.vlm.gg/streams/k1/playlist.m3u8'

async function stream(ownerId: string, streamKey = 'k1', status: 'ready' | 'live' | 'offline' = 'ready') {
  const [row] = await db.insert(streamingServers).values({
    ownerId, name: 'Main', status, streamKey,
    rtmpUrl: `rtmp://ingest.vlm.gg/live/${streamKey}`,
    hlsPlaylistUrl: `https://live.vlm.gg/streams/${streamKey}/playlist.m3u8`,
  }).returning()
  return row
}

describe('streaming routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const prevMode = config.mode
  beforeEach(async () => {
    await resetDb()
    process.env.STREAMING_WEBHOOK_KEY = KEY
    app = await testApp()
  })
  afterEach(async () => {
    delete process.env.STREAMING_WEBHOOK_KEY
    ;(config as any).mode = prevMode
    await app.close()
  })
  const media = (method: 'GET' | 'POST', url: string, payload?: unknown, key: string | null = KEY) =>
    app.inject({ method, url, payload: payload as any, headers: key === null ? {} : { 'x-webhook-key': key } })

  it('authorize: known key 200, unknown 403, missing/wrong secret 401, no key 400', async () => {
    const owner = await createUser()
    await stream(owner.id)
    expect((await media('POST', '/api/streaming/authorize', { streamKey: 'k1' })).json()).toEqual({ ok: true })
    const unknown = await media('POST', '/api/streaming/authorize', { streamKey: 'nope' })
    expect(unknown.statusCode).toBe(403)
    expect(unknown.json()).toEqual({ error: 'unknown_key' })
    expect((await media('POST', '/api/streaming/authorize', { streamKey: 'k1' }, null)).statusCode).toBe(401)
    expect((await media('POST', '/api/streaming/authorize', { streamKey: 'k1' }, 'wrong')).statusCode).toBe(401)
    expect((await media('POST', '/api/streaming/authorize', {})).statusCode).toBe(400)
  })

  it('a deleted stream key is no longer authorized', async () => {
    const owner = await createUser()
    const row = await stream(owner.id)
    const del = await app.inject({ method: 'DELETE', url: `/api/streaming/${row.id}`, headers: { authorization: `Bearer ${tokenFor(owner)}` } })
    expect(del.statusCode).toBe(204)
    expect((await media('POST', '/api/streaming/authorize', { streamKey: 'k1' })).statusCode).toBe(403)
  })

  it('no secret configured: 503 in cloud mode, open off-cloud', async () => {
    delete process.env.STREAMING_WEBHOOK_KEY
    const owner = await createUser()
    await stream(owner.id)
    ;(config as any).mode = 'cloud'
    const res = await media('POST', '/api/streaming/webhook', { streamKey: 'k1', status: 'live' }, null)
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ error: 'webhook_not_configured' })
    expect((await media('POST', '/api/streaming/authorize', { streamKey: 'k1' }, null)).statusCode).toBe(503)
    ;(config as any).mode = 'single'
    expect((await media('POST', '/api/streaming/authorize', { streamKey: 'k1' }, null)).statusCode).toBe(200)
  })

  it('webhook requires the secret and never overwrites the playback URL', async () => {
    const owner = await createUser()
    const row = await stream(owner.id)
    expect((await media('POST', '/api/streaming/webhook', { streamKey: 'k1', status: 'live' }, null)).statusCode).toBe(401)
    const res = await media('POST', '/api/streaming/webhook', { streamKey: 'k1', status: 'live', hlsUrl: 'http://localhost:8000/streams/k1/playlist.m3u8' })
    expect(res.statusCode).toBe(200)
    const after = await db.query.streamingServers.findFirst({ where: eq(streamingServers.id, row.id) })
    expect(after!.status).toBe('live')
    expect(after!.hlsPlaylistUrl).toBe(PLAYLIST)
  })

  it('live-keys lists only live rows and needs the secret', async () => {
    const owner = await createUser()
    await stream(owner.id, 'k1', 'live')
    await stream(owner.id, 'k2', 'ready')
    expect((await media('GET', '/api/streaming/live-keys')).json()).toEqual({ streamKeys: ['k1'] })
    expect((await media('GET', '/api/streaming/live-keys', undefined, null)).statusCode).toBe(401)
  })

  it('get and sessions are owner/admin only (strangers get 404)', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const admin = await createUser({ role: 'admin' })
    const row = await stream(owner.id)
    const as = (u: Awaited<ReturnType<typeof createUser>>, url: string) =>
      app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tokenFor(u)}` } })
    for (const url of [`/api/streaming/${row.id}`, `/api/streaming/${row.id}/sessions`]) {
      expect((await as(owner, url)).statusCode).toBe(200)
      expect((await as(admin, url)).statusCode).toBe(200)
      const s = await as(stranger, url)
      expect(s.statusCode).toBe(404)
      expect(s.body).not.toContain('k1')
    }
  })
})
