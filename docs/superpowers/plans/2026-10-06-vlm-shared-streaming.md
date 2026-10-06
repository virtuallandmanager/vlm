# VLM Shared Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A creator streams from OBS to `rtmp://ingest.vlm.gg/live/<key>` and every in-world screen whose live URL is that stream's playback URL switches to live (and back) for everyone, including late joiners; only provisioned keys can publish.

**Architecture:** One Fly.io machine runs `apps/streaming` (Node-Media-Server + FFmpeg → HLS on a volume) behind two fixed Cloudflare DNS-only records. The media server checks every publish against a new API endpoint before transcoding, and reports live/offline to the API webhook. The API publishes a global `streams` presence-bus event; every scene room re-broadcasts it as `scene_video_status` to clients whose active-preset videos use that URL, and marks those videos `isLive` when it serializes them.

**Tech Stack:** Fastify + Drizzle + Postgres (vitest, real DB), Colyseus rooms with presence pub/sub, Node-Media-Server 2.7 + FFmpeg, `node --test` via `tsx`, Docker + Fly.io (`fly.toml`).

**Spec:** `docs/superpowers/specs/2026-10-06-vlm-shared-streaming-design.md`

## Global Constraints

- Node 20 for dev: `export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH`.
- Server tests: `cd apps/server && npx vitest run <file>`; full `pnpm --filter vlm-server test`. Test helpers: `createUser(opts)`, `tokenFor(user)`, `createScene(owner)` → `{ scene, preset }`, `createElement(presetId, { type, name, properties })`, `testApp()`, `startGameServer()` / `joinScene(url, sceneId, token)` (`waitFor`, `expectNone`).
- Names: `ingest.vlm.gg` (RTMP, TCP 1935), `live.vlm.gg` (HTTPS HLS). OBS server `rtmp://ingest.vlm.gg/live`; playback `https://live.vlm.gg/streams/<key>/playlist.m3u8`.
- Fly: app `vlm-streaming`, region `iad`, volume at `/data`, `OUTPUT_DIR=/data/streams`, dedicated IPv4, always on.
- Media-server ↔ API auth: header `X-Webhook-Key` = `STREAMING_WEBHOOK_KEY` (API) = `VLM_WEBHOOK_KEY` (media server). Key set → must match (401). Key unset → 503 `webhook_not_configured` in cloud mode, open otherwise (local dev).
- Authorize: 5 s timeout; anything but `200 { ok: true }` rejects the publish (fail closed).
- Live-status client message: `scene_video_status { elementId, status: 'live' | 'offline', url }`. Bus topic `streams`, event `{ type: 'stream_status', playlistUrl, live }`.
- URL match: exact string equality after `trim()`.
- The webhook never writes `hls_playlist_url`.
- HLS output removed 60 s after a stream ends unless the key re-publishes.
- No new dependencies (tsx/typescript/node-media-server already present). Don't deploy, don't create Fly apps or DNS records, don't push.
- Commit after each task; end every commit message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **Publisher disconnects while authorize is in flight** → no FFmpeg, no `live` webhook, no orphan state (Task 3 test).
2. **Same playback URL on two screens, or in two different scenes** → every matching screen in every scene's active preset switches (Task 2 test).
3. **`liveSrc` pasted with surrounding whitespace** → still matches (Task 2 test).
4. **Key re-publishes within the 60 s cleanup window** → its new HLS output is not deleted (Task 3 test).
5. **More concurrent publishes than the machine can transcode** → the extra publish is refused cleanly instead of degrading every stream (`MAX_STREAMS`, default 4; Task 3 test). (Plan-level addition: one shared machine runs one libx264 720p encode per stream.)

---

## File structure

| File | Responsibility |
|---|---|
| `apps/server/src/routes/streaming.ts` (modify) | media-server auth helper, `authorize`, `live-keys`, webhook hardening + bus publish, owner checks |
| `apps/server/src/realtime/bus.ts` (modify) | `STREAMS_TOPIC`, `StreamStatusEvent`, `publishStreamStatus` |
| `apps/server/src/streaming/live-status.ts` (create) | `normalizeUrl`, `withLiveStatus(preset)`, `withLiveVideo(element)` |
| `apps/server/src/ws/VLMSceneRoom.ts` (modify) | subscribe to `streams`, broadcast `scene_video_status`, mark serialized videos live |
| `apps/streaming/src/ingest.ts` (create) | publish lifecycle state machine (authorize → transcode → notify; cleanup; capacity) |
| `apps/streaming/src/vlm-api.ts` (create) | API client: `authorize`, `notify`, `liveKeys` |
| `apps/streaming/src/sweep.ts` (create) | startup offline sweep with retries |
| `apps/streaming/src/hls.ts` (create) | confined HLS path resolution |
| `apps/streaming/src/index.ts` (modify) | wiring only |
| `apps/streaming/Dockerfile`, `apps/streaming/fly.toml`, `apps/streaming/DEPLOY.md` (create) | deployable image, Fly config, runbook |
| `apps/web/src/app/(dashboard)/streaming/page.tsx` (modify) | OBS server / playback URL labels |

---

### Task 1: Streaming API hardening (auth, authorize, live-keys, owner checks)

**Files:**
- Modify: `apps/server/src/routes/streaming.ts`
- Test: `apps/server/test/streaming-routes.test.ts` (create)

**Interfaces:**
- Produces: `export function mediaServerAuth(headers: Record<string, unknown>): { ok: true } | { ok: false; status: 401 | 503; error: string }` (exported from `routes/streaming.ts`); routes `POST /api/streaming/authorize` → `200 { ok: true }` / `403 { error: 'unknown_key' }` / `400`; `GET /api/streaming/live-keys` → `{ streamKeys: string[] }`.

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/server && npx vitest run test/streaming-routes.test.ts`
Expected: FAIL — authorize/live-keys 404, playback URL overwritten, strangers get 200.

- [ ] **Step 3: Implement**

In `apps/server/src/routes/streaming.ts`:

1. Imports: add `import { timingSafeEqual } from 'node:crypto'` (keep `randomBytes`), and `and` is not needed.
2. Above `export default`, add:

```ts
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Media server → API auth (`X-Webhook-Key` = STREAMING_WEBHOOK_KEY). With no key configured the
 * endpoints are open off-cloud (local dev) and refuse in cloud mode — never open in production.
 */
export function mediaServerAuth(headers: Record<string, unknown>): { ok: true } | { ok: false; status: 401 | 503; error: string } {
  const key = process.env.STREAMING_WEBHOOK_KEY
  if (!key) return config.mode === 'cloud' ? { ok: false, status: 503, error: 'webhook_not_configured' } : { ok: true }
  const provided = headers['x-webhook-key']
  if (typeof provided !== 'string' || !safeEqual(provided, key)) return { ok: false, status: 401, error: 'Invalid webhook key' }
  return { ok: true }
}
```

3. `GET /api/streaming/:id`: replace the `if (!server)` block with
```ts
      if (!server || (server.ownerId !== request.user.id && request.user.role !== 'admin')) {
        return reply.status(404).send({ error: 'Streaming server not found' })
      }
```
4. `GET /api/streaming/:id/sessions`: before selecting sessions add
```ts
      const server = await db.query.streamingServers.findFirst({ where: eq(streamingServers.id, id) })
      if (!server || (server.ownerId !== request.user.id && request.user.role !== 'admin')) {
        return reply.status(404).send({ error: 'Streaming server not found' })
      }
```
5. Add, before the webhook route:
```ts
  // ── Authorize a publish (from media server) ───────────────────────────
  app.post('/api/streaming/authorize', async (request, reply) => {
    const auth = mediaServerAuth(request.headers as Record<string, unknown>)
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error })
    const streamKey = (request.body as { streamKey?: unknown } | undefined)?.streamKey
    if (typeof streamKey !== 'string' || !streamKey) return reply.status(400).send({ error: 'streamKey is required' })
    const [row] = await db
      .select({ id: streamingServers.id })
      .from(streamingServers)
      .where(eq(streamingServers.streamKey, streamKey))
      .limit(1)
    if (!row) return reply.status(403).send({ error: 'unknown_key' })
    return reply.send({ ok: true })
  })

  // ── Keys the API thinks are live (media server startup sweep) ─────────
  app.get('/api/streaming/live-keys', async (request, reply) => {
    const auth = mediaServerAuth(request.headers as Record<string, unknown>)
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error })
    const rows = await db
      .select({ streamKey: streamingServers.streamKey })
      .from(streamingServers)
      .where(eq(streamingServers.status, 'live'))
    return reply.send({ streamKeys: rows.flatMap((r) => (r.streamKey ? [r.streamKey] : [])) })
  })
```
6. Webhook: replace the `// Verify webhook key if configured` block with
```ts
    const auth = mediaServerAuth(request.headers as Record<string, unknown>)
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error })
```
remove `hlsUrl` from the body type, change the live update to `.set({ status: 'live' })`, and the live platform-callback `url` to `server.hlsPlaylistUrl`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/server && npx vitest run test/streaming-routes.test.ts && npx tsc --noEmit -p .`
Expected: 6 passed; no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/streaming.ts apps/server/test/streaming-routes.test.ts
git commit -m "fix(streaming): authorize publishes, require the webhook secret, keep the playback URL, owner-only reads

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Live status reaches scene rooms (bus event, room broadcast, isLive on serialize)

**Files:**
- Modify: `apps/server/src/realtime/bus.ts`, `apps/server/src/routes/streaming.ts` (webhook), `apps/server/src/ws/VLMSceneRoom.ts`
- Create: `apps/server/src/streaming/live-status.ts`
- Test: `apps/server/test/stream-live.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 `mediaServerAuth`, webhook.
- Produces: `export const STREAMS_TOPIC = 'streams'`; `export interface StreamStatusEvent { type: 'stream_status'; playlistUrl: string; live: boolean }`; `export async function publishStreamStatus(e: { playlistUrl: string; live: boolean }): Promise<void>` (bus.ts). `normalizeUrl(u: unknown): string`, `withLiveStatus<P extends { videos: Record<string, unknown>[] }>(preset: P): Promise<P>`, `withLiveVideo<E extends Record<string, unknown>>(element: E): Promise<E>` (live-status.ts).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/server/test/stream-live.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { scenePresets, streamingServers } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement, tokenFor, testApp } from './helpers/factories.js'
import { startGameServer, joinScene } from './helpers/game-server.js'

const KEY = 'test-webhook-secret'
const URL_A = 'https://live.vlm.gg/streams/ka/playlist.m3u8'
const URL_B = 'https://live.vlm.gg/streams/kb/playlist.m3u8'
const video = (presetId: string, liveSrc: string, name = 'Screen') =>
  createElement(presetId, { type: 'video', name, properties: { liveSrc, enableLiveStream: true, offType: 1, offImageSrc: 'https://x/off.png', playlist: [] } })

describe('stream live status in scene rooms', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    process.env.STREAMING_WEBHOOK_KEY = KEY
    gs = await startGameServer()
    app = await testApp()
  })
  afterEach(async () => {
    delete process.env.STREAMING_WEBHOOK_KEY
    await app.close()
    await gs.stop()
  })
  const webhook = (streamKey: string, status: 'live' | 'offline') =>
    app.inject({ method: 'POST', url: '/api/streaming/webhook', headers: { 'x-webhook-key': KEY }, payload: { streamKey, status } })
  async function provision(ownerId: string, key: string, url: string) {
    await db.insert(streamingServers).values({ ownerId, name: key, status: 'ready', streamKey: key, rtmpUrl: `rtmp://ingest.vlm.gg/live/${key}`, hlsPlaylistUrl: url })
  }

  it('live/offline reach every matching active-preset screen in every scene, and nothing else', async () => {
    const host = await createUser()
    await provision(host.id, 'ka', URL_A)
    const s1 = await createScene(host)
    const s2 = await createScene(host)
    const a1 = await video(s1.preset.id, URL_A, 'Main')
    const a2 = await video(s1.preset.id, `  ${URL_A} `, 'Side') // pasted with whitespace
    await video(s1.preset.id, URL_B, 'Other')
    const [inactive] = await db.insert(scenePresets).values({ sceneId: s1.scene.id, name: 'Inactive' }).returning()
    await video(inactive.id, URL_A, 'Hidden')
    const b1 = await video(s2.preset.id, URL_A)

    const c1 = await joinScene(gs.url, s1.scene.id, tokenFor(host))
    const c2 = await joinScene(gs.url, s2.scene.id)
    await c1.waitFor('scene_preset_update')
    await c2.waitFor('scene_preset_update')

    expect((await webhook('ka', 'live')).statusCode).toBe(200)
    const got = [await c1.waitFor('scene_video_status'), await c1.waitFor('scene_video_status')]
    expect(got.map((m) => m.elementId).sort()).toEqual([a1.id, a2.id].sort())
    for (const m of got) expect(m).toMatchObject({ status: 'live', url: URL_A })
    await c1.expectNone('scene_video_status', 300)
    expect(await c2.waitFor('scene_video_status')).toEqual({ elementId: b1.id, status: 'live', url: URL_A })

    await webhook('ka', 'offline')
    expect(await c2.waitFor('scene_video_status')).toEqual({ elementId: b1.id, status: 'offline', url: URL_A })
  })

  it('a client joining mid-stream gets isLive on the matching video only', async () => {
    const host = await createUser()
    await provision(host.id, 'ka', URL_A)
    const { scene, preset } = await createScene(host)
    const a = await video(preset.id, URL_A)
    const b = await video(preset.id, URL_B, 'Other')
    await webhook('ka', 'live')
    const c = await joinScene(gs.url, scene.id)
    const init = await c.waitFor('scene_preset_update')
    const byId = Object.fromEntries(init.scenePreset.videos.map((v: any) => [v.sk, v]))
    expect(byId[a.id].isLive).toBe(true)
    expect(byId[b.id].isLive).toBeUndefined()
  })

  it('an upsert during a stream keeps isLive', async () => {
    const host = await createUser()
    await provision(host.id, 'ka', URL_A)
    const { scene, preset } = await createScene(host)
    const a = await video(preset.id, URL_A)
    await webhook('ka', 'live')
    const c = await joinScene(gs.url, scene.id, tokenFor(host))
    await c.waitFor('scene_preset_update')
    await app.inject({ method: 'PUT', url: `/api/elements/${a.id}`, headers: { authorization: `Bearer ${tokenFor(host)}` }, payload: { name: 'Renamed' } })
    const msg = await c.waitFor('scene_preset_update')
    expect(msg).toMatchObject({ action: 'upsert', element: 'video', elementData: { sk: a.id, name: 'Renamed', isLive: true } })
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/server && npx vitest run test/stream-live.test.ts`
Expected: FAIL — timed out waiting for `scene_video_status`; `isLive` undefined.

- [ ] **Step 3: Implement the bus event**

Append to `apps/server/src/realtime/bus.ts`:

```ts
/** Global topic: a stream went live/offline. Any scene may show it, so every scene room listens. */
export const STREAMS_TOPIC = 'streams'
export interface StreamStatusEvent {
  type: 'stream_status'
  playlistUrl: string
  live: boolean
}

export async function publishStreamStatus(e: Omit<StreamStatusEvent, 'type'>): Promise<void> {
  if (!presence) return
  try {
    await presence.publish(STREAMS_TOPIC, { type: 'stream_status', ...e })
  } catch (err) {
    console.error('[bus] stream_status publish failed:', err)
  }
}
```

- [ ] **Step 4: Implement live-status helpers**

```ts
// apps/server/src/streaming/live-status.ts
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { streamingServers } from '../db/schema.js'

/** URLs are compared exactly after trimming (creators paste them). */
export const normalizeUrl = (u: unknown): string => (typeof u === 'string' ? u.trim() : '')

async function liveUrls(): Promise<Set<string>> {
  const rows = await db
    .select({ url: streamingServers.hlsPlaylistUrl })
    .from(streamingServers)
    .where(eq(streamingServers.status, 'live'))
  return new Set(rows.map((r) => normalizeUrl(r.url)).filter(Boolean))
}

const mark = <E extends Record<string, unknown>>(v: E, live: Set<string>): E => {
  const src = normalizeUrl(v.liveSrc)
  return src && live.has(src) ? { ...v, isLive: true } : v
}

/** Serialized preset with `isLive: true` on videos whose liveSrc is a live VLM stream (no query when no video has a liveSrc). */
export async function withLiveStatus<P extends { videos: Record<string, unknown>[] }>(preset: P): Promise<P> {
  if (!preset.videos.some((v) => normalizeUrl(v.liveSrc))) return preset
  const live = await liveUrls()
  return live.size ? { ...preset, videos: preset.videos.map((v) => mark(v, live)) } : preset
}

/** Same for one serialized video element. */
export async function withLiveVideo<E extends Record<string, unknown>>(element: E): Promise<E> {
  if (!normalizeUrl(element.liveSrc)) return element
  return mark(element, await liveUrls())
}
```

- [ ] **Step 5: Publish from the webhook**

In `apps/server/src/routes/streaming.ts` add `import { publishStreamStatus } from '../realtime/bus.js'`; at the end of the `live` branch add
```ts
      if (server.hlsPlaylistUrl) await publishStreamStatus({ playlistUrl: server.hlsPlaylistUrl, live: true })
```
and at the end of the offline branch
```ts
      if (server.hlsPlaylistUrl) await publishStreamStatus({ playlistUrl: server.hlsPlaylistUrl, live: false })
```

- [ ] **Step 6: Room subscription and serialization**

In `apps/server/src/ws/VLMSceneRoom.ts`:
1. `import { eq, and } from 'drizzle-orm'`; `import { venueTopic, STREAMS_TOPIC, type VenueEvent, type StreamStatusEvent } from '../realtime/bus.js'`; `import { normalizeUrl, withLiveStatus, withLiveVideo } from '../streaming/live-status.js'`.
2. Field next to `onVenueEventBound`: `private onStreamEventBound = (e: StreamStatusEvent) => this.onStreamEvent(e)`.
3. `onCreate`, after the venue subscribe: `if (this.sceneId) this.presence.subscribe(STREAMS_TOPIC, this.onStreamEventBound)`. `onDispose`, after the venue unsubscribe: `if (this.sceneId) this.presence.unsubscribe(STREAMS_TOPIC, this.onStreamEventBound)`.
4. New method next to `broadcastElementChange`:
```ts
  /** A VLM stream went live/offline: tell clients about each active-preset screen that plays it. */
  private async onStreamEvent(e: StreamStatusEvent) {
    try {
      if (e?.type !== 'stream_status') return
      const presetId = await this.getActivePresetId()
      if (!presetId) return
      const url = normalizeUrl(e.playlistUrl)
      const videos = await db
        .select()
        .from(sceneElements)
        .where(and(eq(sceneElements.presetId, presetId), eq(sceneElements.type, 'video')))
      for (const v of videos) {
        if (normalizeUrl(serializeSingleElement(v).liveSrc) !== url) continue
        this.broadcast('scene_video_status', { elementId: v.id, status: e.live ? 'live' : 'offline', url: e.playlistUrl })
      }
    } catch (err) {
      console.error('[VLMSceneRoom] stream event failed:', err)
    }
  }
```
5. Wrap every serialization: `serializePreset(preset)` → `await withLiveStatus(serializePreset(preset))` at the three sites (room `scene_change_preset` handler, `preset_changed` venue event, `sendInitData`); in `broadcastElementChange`, `elementData: serializeSingleElement(element)` →
```ts
      elementData: element.type === 'video' ? await withLiveVideo(serializeSingleElement(element)) : serializeSingleElement(element),
```

- [ ] **Step 7: Run to verify they pass**

Run: `cd apps/server && npx vitest run test/stream-live.test.ts test/live-updates.test.ts test/scene-room.test.ts && npx tsc --noEmit -p .`
Expected: all pass; no type errors.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/realtime/bus.ts apps/server/src/streaming/live-status.ts apps/server/src/ws/VLMSceneRoom.ts apps/server/src/routes/streaming.ts apps/server/test/stream-live.test.ts
git commit -m "feat(streaming): live/offline switches matching in-world screens; late joiners see live

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Media server — checked publishes, offline sweep, safe HLS serving

**Files:**
- Create: `apps/streaming/src/ingest.ts`, `apps/streaming/src/vlm-api.ts`, `apps/streaming/src/sweep.ts`, `apps/streaming/src/hls.ts`
- Modify: `apps/streaming/src/index.ts` (wiring), `apps/streaming/package.json` (`start`, `test`)
- Test: `apps/streaming/test/ingest.test.ts`, `apps/streaming/test/vlm-api.test.ts`, `apps/streaming/test/sweep.test.ts`, `apps/streaming/test/hls.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 routes (`/api/streaming/authorize`, `/api/streaming/webhook`, `/api/streaming/live-keys`, header `X-Webhook-Key`).
- Produces (module-internal to apps/streaming):
  - `keyFromPath(streamPath: string): string` — last path segment if `/^[A-Za-z0-9_-]{1,128}$/`, else `''`.
  - `createIngest(deps: IngestDeps): { onPrePublish(sessionId: string, streamPath: string): Promise<void>; onDonePublish(sessionId: string): Promise<void>; isLive(streamKey: string): boolean; liveCount(): number }` with `IngestDeps = { authorize(k): Promise<boolean>; notify(k, status: 'live' | 'offline'): Promise<void>; startTranscode(k, streamPath): void; stopTranscode(k): void; reject(sessionId): void; removeOutput(k): void; cleanupDelayMs?: number; maxStreams?: number }`.
  - `createApiClient({ apiUrl, webhookKey, fetch?, timeoutMs? }): { authorize(k): Promise<boolean>; notify(k, status): Promise<void>; liveKeys(): Promise<string[]> }`.
  - `sweepStaleLive({ liveKeys, notify, isLive, attempts?, delayMs?, sleep? }): Promise<number>` (returns keys marked offline).
  - `resolveHlsPath(outputDir: string, urlPath: string): string | null`.

- [ ] **Step 1: Package scripts and import fix**

`apps/streaming/package.json` scripts: `"start": "node dist/index.js"`, add `"test": "node --import tsx --test test/*.test.ts"`. In `src/index.ts` change `import { Transcoder } from './transcoder'` to `'./transcoder.js'` (the built ESM output can't resolve extensionless imports).

- [ ] **Step 2: Write the failing tests**

```ts
// apps/streaming/test/ingest.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIngest, keyFromPath } from '../src/ingest.js'

function deps(authorize: (k: string) => Promise<boolean>, extra: Record<string, unknown> = {}) {
  const log: string[] = []
  return {
    log,
    d: {
      authorize,
      notify: async (k: string, s: string) => { log.push(`notify:${k}:${s}`) },
      startTranscode: (k: string) => { log.push(`start:${k}`) },
      stopTranscode: (k: string) => { log.push(`stop:${k}`) },
      reject: (id: string) => { log.push(`reject:${id}`) },
      removeOutput: (k: string) => { log.push(`rm:${k}`) },
      cleanupDelayMs: 20,
      ...extra,
    },
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('keyFromPath', () => {
  assert.equal(keyFromPath('/live/abc_123-x'), 'abc_123-x')
  assert.equal(keyFromPath('/live/../etc'), 'etc')
  assert.equal(keyFromPath('/live/bad key'), '')
  assert.equal(keyFromPath('/live/'), '')
})

test('authorized publish starts transcoding then notifies live; done stops, notifies offline, cleans up later', async () => {
  const { d, log } = deps(async () => true)
  const ing = createIngest(d)
  await ing.onPrePublish('s1', '/live/k1')
  assert.deepEqual(log, ['start:k1', 'notify:k1:live'])
  assert.equal(ing.isLive('k1'), true)
  await ing.onDonePublish('s1')
  assert.deepEqual(log.slice(2), ['stop:k1', 'notify:k1:offline'])
  await sleep(40)
  assert.equal(log.at(-1), 'rm:k1')
  assert.equal(ing.isLive('k1'), false)
})

for (const [name, authorize] of [
  ['denied', async () => false],
  ['throws (timeout / network)', async () => { throw new Error('timeout') }],
] as const) {
  test(`publish rejected when authorize ${name}: no transcode, no webhook`, async () => {
    const { d, log } = deps(authorize as () => Promise<boolean>)
    const ing = createIngest(d)
    await ing.onPrePublish('s1', '/live/k1')
    assert.deepEqual(log, ['reject:s1'])
    await ing.onDonePublish('s1')
    assert.deepEqual(log, ['reject:s1'])
  })
}

test('invalid key path is rejected without calling authorize', async () => {
  let called = false
  const { d, log } = deps(async () => { called = true; return true })
  await createIngest(d).onPrePublish('s1', '/live/bad key')
  assert.equal(called, false)
  assert.deepEqual(log, ['reject:s1'])
})

test('publisher leaves while authorize is in flight: nothing starts', async () => {
  let release!: (v: boolean) => void
  const { d, log } = deps(() => new Promise<boolean>((r) => { release = r }))
  const ing = createIngest(d)
  const pending = ing.onPrePublish('s1', '/live/k1')
  await ing.onDonePublish('s1')
  release(true)
  await pending
  assert.deepEqual(log, [])
  assert.equal(ing.isLive('k1'), false)
})

test('re-publish within the cleanup window keeps the new output', async () => {
  const { d, log } = deps(async () => true)
  const ing = createIngest(d)
  await ing.onPrePublish('s1', '/live/k1')
  await ing.onDonePublish('s1')
  await ing.onPrePublish('s2', '/live/k1')
  await sleep(40)
  assert.ok(!log.includes('rm:k1'), log.join(','))
})

test('capacity: publishes beyond maxStreams are rejected', async () => {
  const { d, log } = deps(async () => true, { maxStreams: 1 })
  const ing = createIngest(d)
  await ing.onPrePublish('s1', '/live/k1')
  await ing.onPrePublish('s2', '/live/k2')
  assert.ok(log.includes('reject:s2'))
  assert.ok(!log.includes('start:k2'))
  assert.equal(ing.liveCount(), 1)
})
```

```ts
// apps/streaming/test/vlm-api.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApiClient } from '../src/vlm-api.js'

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

test('authorize is true only for 200 { ok: true }, sends the secret and the key', async () => {
  const calls: [string, RequestInit][] = []
  const fetch = async (url: any, init: any) => { calls.push([String(url), init]); return res(200, { ok: true }) }
  const api = createApiClient({ apiUrl: 'https://api.test/', webhookKey: 'sec', fetch })
  assert.equal(await api.authorize('k1'), true)
  assert.equal(calls[0][0], 'https://api.test/api/streaming/authorize')
  assert.equal((calls[0][1].headers as any)['X-Webhook-Key'], 'sec')
  assert.equal(calls[0][1].body, JSON.stringify({ streamKey: 'k1' }))
  for (const r of [res(403, { error: 'unknown_key' }), res(401, {}), res(200, { ok: false }), new Response('oops', { status: 200 })]) {
    assert.equal(await createApiClient({ apiUrl: 'https://api.test', webhookKey: 'sec', fetch: async () => r }).authorize('k1'), false)
  }
})

test('authorize times out (fail closed)', async () => {
  const fetch = (_u: any, init: any) => new Promise<Response>((_, reject) => {
    const keep = setTimeout(() => {}, 2000)
    init.signal.addEventListener('abort', () => { clearTimeout(keep); reject(init.signal.reason) })
  })
  const api = createApiClient({ apiUrl: 'https://api.test', webhookKey: 'sec', fetch, timeoutMs: 30 })
  await assert.rejects(api.authorize('k1'))
})

test('notify posts streamKey/status; liveKeys returns the list', async () => {
  const bodies: any[] = []
  const fetch = async (url: any, init: any) => {
    if (String(url).endsWith('/live-keys')) return res(200, { streamKeys: ['a', 'b'] })
    bodies.push(JSON.parse(init.body))
    return res(200, { ok: true })
  }
  const api = createApiClient({ apiUrl: 'https://api.test', webhookKey: 'sec', fetch })
  await api.notify('k1', 'offline')
  assert.equal(bodies[0].streamKey, 'k1')
  assert.equal(bodies[0].status, 'offline')
  assert.ok(!('hlsUrl' in bodies[0]))
  assert.deepEqual(await api.liveKeys(), ['a', 'b'])
})
```

```ts
// apps/streaming/test/sweep.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sweepStaleLive } from '../src/sweep.js'

test('marks every listed key not live here as offline', async () => {
  const sent: string[] = []
  const n = await sweepStaleLive({
    liveKeys: async () => ['a', 'b'],
    notify: async (k, s) => { sent.push(`${k}:${s}`) },
    isLive: (k) => k === 'b',
    sleep: async () => {},
  })
  assert.equal(n, 1)
  assert.deepEqual(sent, ['a:offline'])
})

test('retries when the API is unreachable, then gives up', async () => {
  let tries = 0
  const n = await sweepStaleLive({
    liveKeys: async () => { tries++; throw new Error('down') },
    notify: async () => {},
    isLive: () => false,
    attempts: 3,
    sleep: async () => {},
  })
  assert.equal(tries, 3)
  assert.equal(n, 0)
})
```

```ts
// apps/streaming/test/hls.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { resolveHlsPath } from '../src/hls.js'

const OUT = path.resolve('/data/streams')

test('resolves playlist and segments inside the output dir', () => {
  assert.equal(resolveHlsPath(OUT, '/streams/k1/playlist.m3u8'), path.join(OUT, 'k1/playlist.m3u8'))
  assert.equal(resolveHlsPath(OUT, '/streams/k1/seg_001.ts?x=1'), path.join(OUT, 'k1/seg_001.ts'))
})

test('rejects traversal, encoded traversal, other prefixes and other extensions', () => {
  for (const u of ['/streams/../secret.m3u8', '/streams/%2e%2e/secret.m3u8', '/streams/k1/../../etc/x.ts', '/other/k1/playlist.m3u8', '/streams/k1/notes.txt', '/streams/%E0%A4%A']) {
    assert.equal(resolveHlsPath(OUT, u), null, u)
  }
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd apps/streaming && pnpm test`
Expected: FAIL — cannot find modules `../src/ingest.js` etc.

- [ ] **Step 4: Implement the modules**

```ts
// apps/streaming/src/ingest.ts
/**
 * Publish lifecycle: a publish is transcoded and reported live only after the VLM API authorizes
 * its key (fail closed). Node-Media-Server emits prePublish synchronously, so a rejected publisher
 * is dropped via `reject` once the check answers.
 */
export interface IngestDeps {
  authorize(streamKey: string): Promise<boolean>
  notify(streamKey: string, status: 'live' | 'offline'): Promise<void>
  startTranscode(streamKey: string, streamPath: string): void
  stopTranscode(streamKey: string): void
  reject(sessionId: string): void
  removeOutput(streamKey: string): void
  /** HLS output is deleted this long after a stream ends (default 60 s). */
  cleanupDelayMs?: number
  /** Concurrent transcodes this machine accepts (default 4). */
  maxStreams?: number
}

export function keyFromPath(streamPath: string): string {
  const k = streamPath.split('/').pop() ?? ''
  return /^[A-Za-z0-9_-]{1,128}$/.test(k) ? k : ''
}

export function createIngest(deps: IngestDeps) {
  const sessions = new Map<string, { streamKey: string; authorized: boolean; closed: boolean }>()
  const cleanups = new Map<string, ReturnType<typeof setTimeout>>()
  const live = new Set<string>()
  const maxStreams = deps.maxStreams ?? 4

  async function onPrePublish(sessionId: string, streamPath: string): Promise<void> {
    const streamKey = keyFromPath(streamPath)
    if (!streamKey) {
      deps.reject(sessionId)
      return
    }
    const s = { streamKey, authorized: false, closed: false }
    sessions.set(sessionId, s)
    let ok = false
    try {
      ok = await deps.authorize(streamKey)
    } catch {
      ok = false
    }
    if (s.closed) return // the publisher left while we checked
    if (!ok || live.has(streamKey) || live.size >= maxStreams) {
      sessions.delete(sessionId)
      deps.reject(sessionId)
      return
    }
    s.authorized = true
    const pending = cleanups.get(streamKey)
    if (pending) {
      clearTimeout(pending)
      cleanups.delete(streamKey)
    }
    live.add(streamKey)
    deps.startTranscode(streamKey, streamPath)
    await deps.notify(streamKey, 'live').catch(() => {})
  }

  async function onDonePublish(sessionId: string): Promise<void> {
    const s = sessions.get(sessionId)
    if (!s) return
    sessions.delete(sessionId)
    s.closed = true
    if (!s.authorized) return
    live.delete(s.streamKey)
    deps.stopTranscode(s.streamKey)
    const timer = setTimeout(() => {
      cleanups.delete(s.streamKey)
      if (!live.has(s.streamKey)) deps.removeOutput(s.streamKey)
    }, deps.cleanupDelayMs ?? 60_000)
    cleanups.set(s.streamKey, timer)
    await deps.notify(s.streamKey, 'offline').catch(() => {})
  }

  return { onPrePublish, onDonePublish, isLive: (k: string) => live.has(k), liveCount: () => live.size }
}
```

(`live.has(streamKey)` also refuses a second simultaneous publisher on the same key.)

```ts
// apps/streaming/src/vlm-api.ts
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export function createApiClient(opts: { apiUrl: string; webhookKey: string; fetch?: FetchFn; timeoutMs?: number }) {
  const base = opts.apiUrl.replace(/\/+$/, '')
  const fetchFn: FetchFn = opts.fetch ?? ((u, i) => globalThis.fetch(u, i))
  const timeoutMs = opts.timeoutMs ?? 5000
  const headers = { 'Content-Type': 'application/json', ...(opts.webhookKey ? { 'X-Webhook-Key': opts.webhookKey } : {}) }
  const call = (path: string, init: RequestInit = {}) =>
    fetchFn(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) })

  return {
    /** True only for 200 { ok: true }. Throws on timeout/network errors (callers treat that as "no"). */
    async authorize(streamKey: string): Promise<boolean> {
      const res = await call('/api/streaming/authorize', { method: 'POST', body: JSON.stringify({ streamKey }) })
      if (res.status !== 200) return false
      const body = (await res.json().catch(() => null)) as { ok?: unknown } | null
      return body?.ok === true
    },
    async notify(streamKey: string, status: 'live' | 'offline'): Promise<void> {
      try {
        const res = await call('/api/streaming/webhook', { method: 'POST', body: JSON.stringify({ streamKey, status, timestamp: Date.now() }) })
        if (!res.ok) console.error(`[webhook] VLM API returned ${res.status}`)
      } catch (err) {
        console.error('[webhook] Failed to notify VLM API:', err)
      }
    },
    async liveKeys(): Promise<string[]> {
      const res = await call('/api/streaming/live-keys')
      if (!res.ok) throw new Error(`live-keys HTTP ${res.status}`)
      const body = (await res.json()) as { streamKeys?: unknown }
      return Array.isArray(body.streamKeys) ? body.streamKeys.filter((k): k is string => typeof k === 'string') : []
    },
  }
}
```

```ts
// apps/streaming/src/sweep.ts
/** At startup: streams the API thinks are live but aren't publishing here get an offline webhook. */
export async function sweepStaleLive(opts: {
  liveKeys(): Promise<string[]>
  notify(streamKey: string, status: 'offline'): Promise<void>
  isLive(streamKey: string): boolean
  attempts?: number
  delayMs?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<number> {
  const attempts = opts.attempts ?? 5
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  for (let i = 0; i < attempts; i++) {
    try {
      const keys = (await opts.liveKeys()).filter((k) => !opts.isLive(k))
      for (const k of keys) await opts.notify(k, 'offline')
      return keys.length
    } catch (err) {
      console.error(`[sweep] attempt ${i + 1}/${attempts} failed:`, err)
      if (i < attempts - 1) await sleep(opts.delayMs ?? 30_000)
    }
  }
  return 0
}
```

```ts
// apps/streaming/src/hls.ts
import path from 'node:path'

const HLS_EXT = new Set(['.m3u8', '.ts', '.mp4'])

/** `/streams/<key>/<file>` → absolute path inside outputDir, or null (traversal, bad encoding, other files). */
export function resolveHlsPath(outputDir: string, urlPath: string): string | null {
  const raw = urlPath.split('?')[0]
  if (!raw.startsWith('/streams/')) return null
  let rel: string
  try {
    rel = decodeURIComponent(raw.slice('/streams/'.length))
  } catch {
    return null
  }
  const root = path.resolve(outputDir)
  const abs = path.resolve(root, rel)
  if (!abs.startsWith(root + path.sep)) return null
  if (!HLS_EXT.has(path.extname(abs))) return null
  return abs
}
```

- [ ] **Step 5: Wire `src/index.ts`**

Replace the `activeStreams` map, both `nms.on(...)` handlers, the `/streams/` branch of the HTTP server, `notifyVLMApi`, and the `/status` endpoint's use of `activeStreams` with:

```ts
import { createReadStream, rmSync } from 'node:fs'
import { createIngest } from './ingest.js'
import { createApiClient } from './vlm-api.js'
import { sweepStaleLive } from './sweep.js'
import { resolveHlsPath } from './hls.js'

const MAX_STREAMS = parseInt(process.env.MAX_STREAMS || '4')
const api = createApiClient({ apiUrl: VLM_API_URL, webhookKey: VLM_WEBHOOK_KEY })
const ingest = createIngest({
  authorize: (k) => api.authorize(k),
  notify: (k, s) => api.notify(k, s),
  startTranscode: (streamKey, streamPath) =>
    transcoder.start({ streamKey, rtmpUrl: `rtmp://127.0.0.1:${RTMP_PORT}${streamPath}`, outputDir: join(OUTPUT_DIR, streamKey), abr: ENABLE_ABR }),
  stopTranscode: (k) => transcoder.stop(k),
  reject: (id) => nms.getSession(id)?.reject(),
  removeOutput: (k) => rmSync(join(OUTPUT_DIR, k), { recursive: true, force: true }),
  maxStreams: MAX_STREAMS,
})

nms.on('prePublish', (id: string, streamPath: string) => {
  void ingest.onPrePublish(id, streamPath)
})
nms.on('donePublish', (id: string) => {
  void ingest.onDonePublish(id)
})
```

HLS branch:
```ts
  if (url.startsWith('/streams/')) {
    const filePath = resolveHlsPath(OUTPUT_DIR, url)
    const mime = filePath ? MIME_TYPES[extname(filePath)] : undefined
    if (!filePath || !mime || !existsSync(filePath)) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': extname(filePath) === '.m3u8' ? 'no-cache' : 'max-age=10',
    })
    createReadStream(filePath).on('error', () => res.destroy()).pipe(res)
    return
  }
```

`/status` returns `{ streams: transcoder.getActiveStreams().map((streamKey) => ({ streamKey, hlsUrl: `/streams/${streamKey}/playlist.m3u8` })) }`. Remove `readFileSync` from imports. After `httpServer.listen(...)`:
```ts
void sweepStaleLive({ liveKeys: () => api.liveKeys(), notify: (k, s) => api.notify(k, s), isLive: (k) => ingest.isLive(k) })
  .then((n) => console.log(`[vlm-streaming] startup sweep: ${n} stale live stream(s) marked offline`))
```
Update the header comment's env list with `MAX_STREAMS — concurrent transcodes (default: 4)`.

- [ ] **Step 6: Run to verify they pass**

Run: `cd apps/streaming && pnpm test && pnpm build && node -e "import('./dist/ingest.js').then(m => console.log(typeof m.createIngest))"`
Expected: all tests pass; build clean; prints `function` (proves the ESM output resolves).

- [ ] **Step 7: Commit**

```bash
git add apps/streaming/src apps/streaming/test apps/streaming/package.json
git commit -m "feat(streaming server): authorize publishes before transcoding, offline sweep, confined HLS serving

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Deployable image, Fly config, runbook

**Files:**
- Create: `apps/streaming/Dockerfile`, `apps/streaming/fly.toml`, `apps/streaming/DEPLOY.md`
- Modify: `apps/docs/src/content/docs/self-hosting/environment-variables.md` (streaming rows)

**Interfaces:**
- Consumes: Task 3 `pnpm --filter vlm-streaming build` → `apps/streaming/dist/index.js`; env `RTMP_PORT`, `HTTP_PORT`, `OUTPUT_DIR`, `VLM_API_URL`, `VLM_WEBHOOK_KEY`, `MAX_STREAMS`.

- [ ] **Step 1: Dockerfile (build context = repo root; copies only what it needs so stale `dist`/`tsbuildinfo` never reach the build)**

```dockerfile
# apps/streaming/Dockerfile — build from the repo root:
#   docker build -f apps/streaming/Dockerfile .
FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/streaming/package.json apps/streaming/
RUN pnpm install --frozen-lockfile --filter vlm-streaming
COPY apps/streaming/tsconfig.json apps/streaming/
COPY apps/streaming/src apps/streaming/src
RUN pnpm --filter vlm-streaming build && pnpm --filter vlm-streaming deploy --prod /out

FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out ./
ENV NODE_ENV=production RTMP_PORT=1935 HTTP_PORT=8000 OUTPUT_DIR=/data/streams
EXPOSE 1935 8000
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Build and smoke-test the image**

Run: `docker build -f apps/streaming/Dockerfile -t vlm-streaming:test . && docker run --rm -d --name vlm-streaming-test -p 18000:8000 -e OUTPUT_DIR=/tmp/streams vlm-streaming:test && sleep 3 && curl -s localhost:18000/health && docker run --rm vlm-streaming:test ffmpeg -version | head -1; docker rm -f vlm-streaming-test`
Expected: `{"status":"ok",...}` and an `ffmpeg version` line. (If `pnpm deploy` fails because the build output isn't included, add `"files": ["dist"]` to `apps/streaming/package.json` and rebuild.)

- [ ] **Step 3: fly.toml**

```toml
# apps/streaming/fly.toml — deploy from the repo root:
#   fly deploy . --config apps/streaming/fly.toml
app = "vlm-streaming"
primary_region = "iad"

[build]
  dockerfile = "apps/streaming/Dockerfile"

[env]
  RTMP_PORT = "1935"
  HTTP_PORT = "8000"
  OUTPUT_DIR = "/data/streams"
  VLM_API_URL = "https://api.vlm.gg"
  MAX_STREAMS = "4"

[mounts]
  source = "vlm_streams"
  destination = "/data"

# HLS playback: https://live.vlm.gg (Fly TLS)
[http_service]
  internal_port = 8000
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    grace_period = "15s"
    interval = "30s"
    method = "GET"
    path = "/health"
    timeout = "5s"

# RTMP ingest: rtmp://ingest.vlm.gg:1935 (raw TCP, needs the dedicated IPv4)
[[services]]
  protocol = "tcp"
  internal_port = 1935
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

  [[services.ports]]
    port = 1935

[[vm]]
  size = "performance-2x"
```

Run: `fly config validate --config apps/streaming/fly.toml` (works without an app/login for syntax; if it demands auth, record that and skip).
Expected: valid (or a recorded auth requirement).

- [ ] **Step 4: Runbook `apps/streaming/DEPLOY.md`**

Write these sections (exact commands):
1. **Create** — `fly apps create vlm-streaming`; `fly volumes create vlm_streams --app vlm-streaming --region iad --size 10`; `fly ips allocate-v4 --app vlm-streaming` (dedicated, billed monthly — required for RTMP on 1935); `fly ips allocate-v6 --app vlm-streaming`.
2. **Secrets** — generate once `openssl rand -hex 32`; `fly secrets set VLM_WEBHOOK_KEY=<secret> --app vlm-streaming`; Railway API service: `STREAMING_WEBHOOK_KEY=<same secret>`, `RTMP_INGEST_URL=rtmp://ingest.vlm.gg/live`, `HLS_BASE_URL=https://live.vlm.gg/streams`, `ENABLE_STREAMING=true` (cloud mode enables it already).
3. **Deploy** — from the repo root: `fly deploy . --config apps/streaming/fly.toml`.
4. **DNS (Cloudflare, DNS only / grey cloud)** — `ingest` A → the v4 from `fly ips list`; `live` A → same v4, `live` AAAA → the v6; then `fly certs add live.vlm.gg --app vlm-streaming` and wait for `fly certs show live.vlm.gg` to say Issued. Never proxy (orange cloud) either record: RTMP can't pass Cloudflare's proxy and the cert check needs direct DNS.
5. **Verify** — `curl https://live.vlm.gg/health`; provision a stream on the dashboard; OBS Server `rtmp://ingest.vlm.gg/live`, Stream Key = the key; paste the playback URL into a test-scene video's Live URL with live streaming enabled; go live → the screen switches; stop → it goes back; an unknown key is refused (`fly logs` shows `[rtmp reject]`).
6. **Capacity** — one `performance-2x` machine runs about `MAX_STREAMS=4` concurrent 720p transcodes; raise the VM size and `MAX_STREAMS` together.
7. **Existing streams** — rows provisioned before the env change still hold `localhost` URLs; delete and re-provision them.

Docs: in `environment-variables.md` streaming table add rows for `HLS_BASE_URL` (playback base, e.g. `https://live.vlm.gg/streams`) and `STREAMING_WEBHOOK_KEY` (shared secret with the media server; required in cloud mode), keeping the existing row style.

- [ ] **Step 5: Commit**

```bash
git add apps/streaming/Dockerfile apps/streaming/fly.toml apps/streaming/DEPLOY.md apps/docs/src/content/docs/self-hosting/environment-variables.md apps/streaming/package.json
git commit -m "chore(streaming): Dockerfile, Fly config and deploy runbook for ingest.vlm.gg / live.vlm.gg

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Dashboard labels

**Files:**
- Modify: `apps/web/src/app/(dashboard)/streaming/page.tsx:392-415`

**Interfaces:**
- Consumes: server row fields `rtmpUrl` (`<ingest>/<key>`), `streamKey`, `hlsPlaylistUrl`.

- [ ] **Step 1: Implement**

Replace the "RTMP URL" block so OBS gets the server without the key (the key stays behind the existing reveal field), and relabel the HLS block:

```tsx
          <div>
            <p className="text-xs text-gray-400 mb-1">OBS Server</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-gray-800 px-3 py-1.5 text-sm font-mono text-gray-300 truncate">
                {obsServer || '--'}
              </code>
              {obsServer && <CopyButton text={obsServer} />}
            </div>
          </div>
```
with, near the top of that component's render (where `server` is in scope):
```tsx
  // rtmpUrl is "<ingest>/<streamKey>"; OBS wants the server and the key separately
  const obsServer = server.rtmpUrl && server.streamKey && server.rtmpUrl.endsWith(`/${server.streamKey}`)
    ? server.rtmpUrl.slice(0, -(server.streamKey.length + 1))
    : server.rtmpUrl
```
HLS label: `HLS Playlist URL` → `Playback URL — paste into a video screen's Live URL`. If the list row at line ~287 also prints `server.rtmpUrl`, apply the same `obsServer` computation there (it shows the key unmasked in the list).

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter vlm-web exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/(dashboard)/streaming/page.tsx"
git commit -m "feat(web): OBS server without the key, playback URL label on the Streaming page

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Full verification

- [ ] Run: `pnpm turbo test` — expected: all tasks successful (vlm-streaming tests now included).
- [ ] Run: `pnpm --filter vlm-streaming typecheck && pnpm --filter vlm-server exec tsc --noEmit && pnpm --filter vlm-web exec tsc --noEmit` — expected: clean.
- [ ] Run the Task 4 Step 2 docker smoke test again on the final tree — expected: health ok, ffmpeg present.
- [ ] Manual (user, after deploying per DEPLOY.md): the spec §5 manual checklist.
