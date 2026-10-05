# VLM Analytics — Collect, Store, Claim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any Decentraland scene running VLM automatically collects privacy-respecting analytics over batched HTTP, the server validates, stores and rolls them up, and the LAND/World controller can claim and read the data.

**Architecture:** A platform-agnostic collector in `vlm-core` (queue → uploader → transport) is driven each frame by an adapter-supplied `AnalyticsProbe`; the DCL adapter implements the probe and offers an analytics-only entry `startVLMAnalytics()`. The server exposes a public `POST /api/ingest` that checks the batch shape (a pure checker shared through `vlm-shared`), verifies the DCL signed-fetch signer, rate-limits, resolves the scene through a location-keyed registry validated against Decentraland's Catalyst/Worlds servers, and writes events, positions and sessions with per-scene salted visitor hashes. Background jobs close idle sessions, roll up hourly/daily aggregates and purge by retention. Claims are checked against public parcel/world permission endpoints through an injectable `DclDirectory`.

**Tech Stack:** Node 20, pnpm 9, TypeScript, Fastify 5, Drizzle 0.38 / Postgres 16, Vitest 3.2.7, DCL SDK 7 (`@dcl/sdk/ecs` 7.22), ethers 6, maxmind (mmdb reader).

**Spec:** `docs/superpowers/specs/2026-10-04-vlm-analytics-design.md` (Sub-projects A, B, C)

## Global Constraints

- Node ≥ 20: prefix commands with `export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH &&` (machine default is Node 16).
- Never let pnpm re-resolve unrelated dependencies. After any `pnpm add`, run `git diff -- pnpm-lock.yaml | grep -E '^[-+] .*@dcl/' ` — it must print nothing. If it does, restore the lockfile from HEAD and add only the new package's entries (as done in the previous branch).
- Event types, exactly: `session.start, session.heartbeat, session.leave, pos, interact, video, sound, emote, giveaway, custom`.
- Collector timing: flush every 5 s or at 50 events or immediately on a high-priority event (`session.start`, `session.leave`, `interact` with `kind: 'click'`, `video`, `emote`, `giveaway`, `custom`); queue max 500 (drop oldest `pos`, then oldest `session.heartbeat`, then oldest); heartbeat 15 s; position every 3 s if moved > 0.5 m since last sample, else every 15 s; positions rounded to 0.1 m, heading to 5°; re-entry within 60 s continues the session; hover dedupe 10 s per target; retry backoff 1 s → 30 s jittered; drop batch on 4xx other than 429.
- Ingest limits: body ≤ 256 KB; 1–100 events per batch; each event ≤ 2 KB serialized; client clock skew > ±10 min is clamped to server time and counted as skewed; per signer (or per IP when unverified) 1 request / 2 s with burst 3; per signer 200 events/min; per unverified IP 60 events/min; per scene 5,000 events/min with `pos` sampled above that; preview scenes max 10,000 events/day.
- Location keys: Genesis City `gc:<baseParcel>`; Worlds `world:<lowercased name>`; preview `preview:<signer wallet or 'anon'>:<baseParcel or world name>`.
- Registry validation results cached 10 min per location key; upstream timeout 3 s.
- Sessions close after 60 s without events; "live" = `lastSeenAt > now − 60 s`.
- Retention: claimed → claimer's tier `analyticsRetentionDays` (Infinity → never; self-hosted with all features unlocked → Infinity); unclaimed → 30 days; preview → 7 days. Rollups, heatmaps, co-presence kept forever.
- Privacy: `visitorHash = HMAC-SHA256(scene salt, lowercase(visitorId))` hex; plain `wallet`/`displayName` stored only when the scene's `walletVisibility` is on AND the batch says `noticeShown: true` AND the visitor is not a guest; turning visibility off nulls those columns for the scene; IP addresses are never stored or logged.
- Claims: Genesis City wallet must control every parcel (owner, operator, updateOperator, updateManagers, approvedForAll) or be the deployer of the currently active scene on every parcel; Worlds wallet must equal `/world/{name}/permissions` `owner`; claims re-verified daily; a lapsed claimer keeps read-only access for 30 days.
- The server never calls a client-provided URL: Catalyst and Worlds base URLs come from config only.

### Deviations from the spec (deliberate)

- **No Postgres partitioning in v1.** `analytics_events` / `analytics_positions` are plain tables with `(scene_id, occurred_at)` indexes and batched `DELETE` purges. Drizzle-kit push can't manage partitioned tables, and current volumes don't need them. Revisit when a table passes ~50 M rows.
- **Probe is poll-based** (`pollInteractions()`, `pollVideoEvents()`, `pollEmotes()` called each tick) instead of callback subscriptions — equivalent behavior, simpler to test.
- **Signed fetch does not sign the request body** (it signs method, path, timestamp and metadata). "Verified" therefore means "sent by that wallet's client"; duplicates and replays are bounded by a unique `(session_id, seq)` index.
- **Interaction targets** are the entity's DCL `Name` component value, or `entity:<number>`. Attributing clicks to VLM element ids is deferred to Sub-project D.
- **`sound` and `giveaway` events are typed and accepted but not auto-collected yet.** VLM sound elements don't expose play state to the adapter, and V2 giveaways aren't implemented. `Collector.giveaway()` exists for when they are.
- **Rate limits are per server instance** (in-memory token buckets). Redis-backed limits are deferred.
- **Estate fallback** uses "deployer of the active scene" instead of the LAND-permissions subgraph.
- **Dashboard wallet sign-in is added here** (`/api/auth/wallet/challenge` + `/verify`, EIP-191 `personal_sign`), because claims need a verified wallet and the dashboard has no wallet login. The same task closes the legacy-wallet follow-up from the venues branch: a verified login never lands on an account whose wallet record was never verified.
- **New read endpoints live under `/api/analytics/locations/...`** (analytics scene ids). The existing `/api/analytics/scenes/:vlmSceneId/recent` and `/sessions` keep their response shapes, re-implemented on the new tables, so the current dashboard page keeps working until Sub-project D replaces it.

## Review Focus

1. **Batch retried after a timeout that actually succeeded** — the server must not double-count events or session event counts. Test in Task 8 (same batch posted twice → counts unchanged).
2. **Visitor walks out and straight back in** — within 60 s it's one session (no second `session.start`); after 60 s a new session id. Test in Task 3.
3. **Unclaimed scene redeployed while visitors are inside** — batches carrying the old `entityId` get 422 after revalidation, new ones are accepted, history stays on the same location row. Test in Task 6.
4. **Owner turns wallet visibility off** — previously revealed wallets/names disappear for that scene; hashed data remains; new batches store no plain identity even with `noticeShown: true`. Test in Task 11.
5. **Decentraland API down** — ingest for a known scene keeps working (stale accept); a brand-new scene gets 503 with `retryAfter`; claims return 503, never a false "not owner". Tests in Tasks 6 and 10.

---

## File Structure

**Create — shared / SDK**
- `packages/vlm-shared/src/analytics.ts` — event types, limits, batch types, `checkBatch()`, `locationKeyFor()`, `isHighPriority()`.
- `packages/vlm-core/src/analytics/queue.ts` — `EventQueue`.
- `packages/vlm-core/src/analytics/transport.ts` — `AnalyticsTransport`, `createTransport()`.
- `packages/vlm-core/src/analytics/uploader.ts` — `Uploader` (flush rules, backoff).
- `packages/vlm-core/src/analytics/collector.ts` — `Collector` (sessions, sampling, probe polling, notice).
- `packages/vlm-core/src/analytics/index.ts` — barrel.
- `packages/vlm-core/vitest.config.ts`, `packages/vlm-core/test/*.test.ts`.
- `packages/vlm-adapter-dcl/src/analytics.ts` — `DclAnalyticsProbe`, `getAnalyticsSceneRef()`, `startVLMAnalytics()`.

**Create — server**
- `apps/server/src/analytics/access.ts` — `getAnalyticsAccess()`.
- `apps/server/src/analytics/dcl-directory.ts` — `DclDirectory`, HTTP implementation, `getDclDirectory()`/`setDclDirectory()`.
- `apps/server/src/analytics/registry.ts` — `resolveAnalyticsScene()`.
- `apps/server/src/analytics/limiter.ts` — `TokenBucketLimiter`, `checkIngestLimits()`.
- `apps/server/src/analytics/country.ts` — `CountryLookup`, `createCountryLookup()`.
- `apps/server/src/analytics/hash.ts` — `visitorHash()`.
- `apps/server/src/analytics/writer.ts` — `writeBatch()`.
- `apps/server/src/analytics/jobs.ts` — session close, rollups, retention, scheduler.
- `apps/server/src/analytics/claims.ts` — control checks, claim, eligibility, re-verify.
- `apps/server/src/auth/wallet-users.ts` — `resolveVerifiedWalletUser()`, `linkVerifiedWallet()`.
- `apps/server/src/routes/ingest.ts`, `routes/analytics-claims.ts`, `routes/analytics-read.ts`, `routes/wallet-auth.ts`.
- `apps/server/test/helpers/analytics.ts`, `test/helpers/fake-dcl.ts`, and one test file per task.

**Modify**
- `packages/vlm-shared/src/index.ts`, `src/platform.ts` (probe + `getAnalyticsScene`), `src/types/scene.ts` (`analytics?: boolean`).
- `packages/vlm-core/src/VLM.ts`, `src/index.ts`, `package.json`.
- `packages/vlm-adapter-dcl/src/index.ts`, `package.json`.
- `packages/vlm-client/src/http.ts` (`checkAnalyticsClaim()`).
- `apps/server/src/db/schema.ts`, `src/routes/analytics.ts`, `src/routes/auth.ts`, `src/app.ts`, `src/index.ts`, `src/config.ts`, `src/ws/VLMSceneRoom.ts`, `src/ws/scene-guard.ts`, `package.json`.
- `.env.example`, `apps/docs/src/content/docs/sdk/decentraland/install.md`, `apps/docs/src/content/docs/dashboard/analytics.md`; create `apps/docs/src/content/docs/privacy.md`.

---

### Task 1: Shared analytics contract and vlm-core test harness

**Files:**
- Create: `packages/vlm-shared/src/analytics.ts`, `packages/vlm-core/vitest.config.ts`, `packages/vlm-core/test/contract.test.ts`
- Modify: `packages/vlm-shared/src/index.ts`, `packages/vlm-core/package.json`

**Interfaces:**
- Produces: `ANALYTICS_EVENT_TYPES`, `AnalyticsEventType`, `ANALYTICS_LIMITS`, `AnalyticsEvent`, `AnalyticsSceneRef`, `IngestBatch`, `IngestResponse`, `PARCEL_RE`, `isHighPriority(e)`, `locationKeyFor(scene, signer)`, `checkBatch(input, nowMs) → BatchCheck`, `NOTICE_TEXT`.

- [ ] **Step 1: Add vitest to vlm-core**

```bash
export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH
cd packages/vlm-core && pnpm add -D vitest@3.2.7
git diff -- ../../pnpm-lock.yaml | grep -E '^[-+] .*@dcl/'   # must print nothing
```

Add to `packages/vlm-core/package.json` scripts: `"test": "vitest run"`.

Create `packages/vlm-core/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      'vlm-shared': resolve(here, '../vlm-shared/src/index.ts'),
      'vlm-client': resolve(here, '../vlm-client/src/index.ts'),
    },
  },
  test: { include: ['test/**/*.test.ts'] },
})
```

- [ ] **Step 2: Write the failing test `packages/vlm-core/test/contract.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { checkBatch, locationKeyFor, isHighPriority, ANALYTICS_LIMITS, type IngestBatch } from 'vlm-shared'

const NOW = Date.parse('2026-10-04T12:00:00Z')
const SID = '11111111-1111-4111-8111-111111111111'

function batch(overrides: Partial<IngestBatch> = {}): any {
  return {
    v: 1,
    sessionId: SID,
    visitorId: '0xABCDEF0000000000000000000000000000000001',
    isGuest: false,
    noticeShown: false,
    scene: { realm: 'main', isWorld: false, isPreview: false, baseParcel: '-12,34', parcels: ['-12,34', '-12,35'] },
    events: [{ t: NOW, type: 'session.start', seq: 0, data: { platform: 'desktop' } }],
    ...overrides,
  }
}

describe('checkBatch', () => {
  it('accepts a valid batch and lowercases wallet visitor ids', () => {
    const r = checkBatch(batch(), NOW)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.batch.visitorId).toBe('0xabcdef0000000000000000000000000000000001')
      expect(r.skewed).toBe(0)
    }
  })

  it.each([
    ['not an object', 'x'],
    ['wrong version', batch({ v: 2 as any })],
    ['bad session id', batch({ sessionId: 'nope' })],
    ['empty events', batch({ events: [] })],
    ['too many events', batch({ events: Array.from({ length: 101 }, (_, i) => ({ t: NOW, type: 'pos', seq: i })) })],
    ['unknown type', batch({ events: [{ t: NOW, type: 'mouse', seq: 0 } as any] })],
    ['negative seq', batch({ events: [{ t: NOW, type: 'pos', seq: -1 }] })],
    ['bad parcel', batch({ scene: { realm: 'main', isWorld: false, isPreview: false, baseParcel: '1;2' } })],
    ['world without name', batch({ scene: { realm: 'x.dcl.eth', isWorld: true, isPreview: false } })],
    ['oversized event', batch({ events: [{ t: NOW, type: 'custom', seq: 0, data: { name: 'x', props: { s: 'a'.repeat(3000) } } }] })],
  ])('rejects %s', (_label, input) => {
    expect(checkBatch(input, NOW).ok).toBe(false)
  })

  it('clamps events whose clock is more than 10 minutes off', () => {
    const r = checkBatch(batch({ events: [{ t: NOW - 11 * 60_000, type: 'pos', seq: 0, data: { x: 1, y: 0, z: 1 } }] }), NOW)
    expect(r.ok && r.batch.events[0].t).toBe(NOW)
    expect(r.ok && r.skewed).toBe(1)
  })
})

describe('locationKeyFor', () => {
  it('builds keys for parcels, worlds and preview', () => {
    expect(locationKeyFor({ realm: 'main', isWorld: false, isPreview: false, baseParcel: '-12,34' }, null)).toBe('gc:-12,34')
    expect(locationKeyFor({ realm: 'Foo.dcl.eth', isWorld: true, isPreview: false, worldName: 'Foo.dcl.eth' }, null)).toBe('world:foo.dcl.eth')
    expect(locationKeyFor({ realm: 'localhost', isWorld: false, isPreview: true, baseParcel: '0,0' }, '0xabc')).toBe('preview:0xabc:0,0')
    expect(locationKeyFor({ realm: 'localhost', isWorld: false, isPreview: true, baseParcel: '0,0' }, null)).toBe('preview:anon:0,0')
  })
})

describe('isHighPriority', () => {
  it('flags starts, leaves, clicks, video, emotes, giveaways, custom — not hovers, positions or heartbeats', () => {
    expect(isHighPriority({ type: 'session.start' })).toBe(true)
    expect(isHighPriority({ type: 'interact', data: { kind: 'click' } })).toBe(true)
    expect(isHighPriority({ type: 'interact', data: { kind: 'hover' } })).toBe(false)
    expect(isHighPriority({ type: 'pos' })).toBe(false)
    expect(isHighPriority({ type: 'session.heartbeat' })).toBe(false)
    expect(ANALYTICS_LIMITS.maxBatchEvents).toBe(100)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd packages/vlm-core && pnpm test`
Expected: FAIL — `checkBatch` is not exported from `vlm-shared`.

- [ ] **Step 4: Create `packages/vlm-shared/src/analytics.ts`**

```ts
export const ANALYTICS_EVENT_TYPES = [
  'session.start',
  'session.heartbeat',
  'session.leave',
  'pos',
  'interact',
  'video',
  'sound',
  'emote',
  'giveaway',
  'custom',
] as const
export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number]

export const ANALYTICS_LIMITS = {
  maxBatchEvents: 100,
  maxEventBytes: 2048,
  maxBodyBytes: 256 * 1024,
  maxQueue: 500,
  flushIntervalMs: 5_000,
  flushAtCount: 50,
  heartbeatMs: 15_000,
  posMovingMs: 3_000,
  posIdleMs: 15_000,
  posMinMoveM: 0.5,
  sessionResumeMs: 60_000,
  hoverDedupeMs: 10_000,
  clockSkewMs: 10 * 60_000,
  backoffMinMs: 1_000,
  backoffMaxMs: 30_000,
} as const

export const NOTICE_TEXT = 'This scene records visitor wallets and names for analytics — powered by VLM'

export interface AnalyticsEvent {
  t: number
  type: AnalyticsEventType
  seq: number
  data?: Record<string, unknown>
}

export interface AnalyticsSceneRef {
  realm: string
  isWorld: boolean
  isPreview: boolean
  worldName?: string
  baseParcel?: string
  parcels?: string[]
  entityId?: string
  title?: string
}

export interface IngestBatch {
  v: 1
  sessionId: string
  visitorId: string
  isGuest: boolean
  noticeShown: boolean
  displayName?: string
  scene: AnalyticsSceneRef
  events: AnalyticsEvent[]
}

export interface IngestResponse {
  ok: true
  accepted: number
  notice: boolean
}

export const PARCEL_RE = /^-?\d{1,3},-?\d{1,3}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WORLD_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i
const TYPES = new Set<string>(ANALYTICS_EVENT_TYPES)
const PRIORITY = new Set<AnalyticsEventType>(['session.start', 'session.leave', 'video', 'emote', 'giveaway', 'custom'])

export function isHighPriority(e: { type: AnalyticsEventType; data?: Record<string, unknown> }): boolean {
  return PRIORITY.has(e.type) || (e.type === 'interact' && e.data?.kind === 'click')
}

export function locationKeyFor(scene: AnalyticsSceneRef, signer: string | null): string {
  const place = scene.isWorld ? (scene.worldName ?? '').toLowerCase() : scene.baseParcel ?? ''
  if (scene.isPreview) return `preview:${signer ? signer.toLowerCase() : 'anon'}:${place || 'unknown'}`
  return scene.isWorld ? `world:${place}` : `gc:${place}`
}

export type BatchCheck = { ok: true; batch: IngestBatch; skewed: number } | { ok: false; error: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max

function checkScene(s: unknown): AnalyticsSceneRef | string {
  if (!isObj(s)) return 'scene must be an object'
  if (!str(s.realm, 200)) return 'scene.realm is required'
  if (typeof s.isWorld !== 'boolean' || typeof s.isPreview !== 'boolean') return 'scene.isWorld and scene.isPreview must be booleans'
  if (s.isWorld) {
    if (typeof s.worldName !== 'string' || !WORLD_RE.test(s.worldName)) return 'scene.worldName must be a .eth name'
  } else if (typeof s.baseParcel !== 'string' || !PARCEL_RE.test(s.baseParcel)) {
    return 'scene.baseParcel must look like "x,y"'
  }
  if (s.parcels !== undefined) {
    if (!Array.isArray(s.parcels) || s.parcels.length > 400 || !s.parcels.every((p) => typeof p === 'string' && PARCEL_RE.test(p))) {
      return 'scene.parcels must be up to 400 "x,y" strings'
    }
  }
  if (s.entityId !== undefined && !str(s.entityId, 200)) return 'scene.entityId must be a string'
  if (s.title !== undefined && typeof s.title !== 'string') return 'scene.title must be a string'
  return {
    realm: s.realm as string,
    isWorld: s.isWorld as boolean,
    isPreview: s.isPreview as boolean,
    worldName: s.worldName as string | undefined,
    baseParcel: s.baseParcel as string | undefined,
    parcels: s.parcels as string[] | undefined,
    entityId: s.entityId as string | undefined,
    title: typeof s.title === 'string' ? s.title.slice(0, 200) : undefined,
  }
}

export function checkBatch(input: unknown, nowMs: number): BatchCheck {
  if (!isObj(input)) return { ok: false, error: 'batch must be an object' }
  if (input.v !== 1) return { ok: false, error: 'v must be 1' }
  if (typeof input.sessionId !== 'string' || !UUID_RE.test(input.sessionId)) return { ok: false, error: 'sessionId must be a UUID' }
  if (!str(input.visitorId, 100)) return { ok: false, error: 'visitorId is required' }
  if (typeof input.isGuest !== 'boolean' || typeof input.noticeShown !== 'boolean') {
    return { ok: false, error: 'isGuest and noticeShown must be booleans' }
  }
  if (input.displayName !== undefined && (typeof input.displayName !== 'string' || input.displayName.length > 64)) {
    return { ok: false, error: 'displayName must be a string up to 64 characters' }
  }
  const scene = checkScene(input.scene)
  if (typeof scene === 'string') return { ok: false, error: scene }
  if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > ANALYTICS_LIMITS.maxBatchEvents) {
    return { ok: false, error: `events must contain 1-${ANALYTICS_LIMITS.maxBatchEvents} items` }
  }
  let skewed = 0
  const events: AnalyticsEvent[] = []
  for (const e of input.events) {
    if (!isObj(e) || typeof e.t !== 'number' || !Number.isFinite(e.t)) return { ok: false, error: 'event.t must be a number' }
    if (typeof e.type !== 'string' || !TYPES.has(e.type)) return { ok: false, error: `unknown event type: ${String(e.type)}` }
    if (!Number.isInteger(e.seq) || (e.seq as number) < 0) return { ok: false, error: 'event.seq must be a non-negative integer' }
    if (e.data !== undefined && !isObj(e.data)) return { ok: false, error: 'event.data must be an object' }
    if (JSON.stringify(e).length > ANALYTICS_LIMITS.maxEventBytes) return { ok: false, error: 'event exceeds 2 KB' }
    let t = e.t
    if (Math.abs(t - nowMs) > ANALYTICS_LIMITS.clockSkewMs) {
      t = nowMs
      skewed++
    }
    events.push({ t, type: e.type as AnalyticsEventType, seq: e.seq as number, data: e.data as Record<string, unknown> | undefined })
  }
  const visitorId = input.visitorId as string
  return {
    ok: true,
    skewed,
    batch: {
      v: 1,
      sessionId: (input.sessionId as string).toLowerCase(),
      visitorId: visitorId.startsWith('0x') ? visitorId.toLowerCase() : visitorId,
      isGuest: input.isGuest as boolean,
      noticeShown: input.noticeShown as boolean,
      displayName: input.displayName as string | undefined,
      scene,
      events,
    },
  }
}
```

Append to `packages/vlm-shared/src/index.ts`: `export * from './analytics.js';`

- [ ] **Step 5: Run tests and typecheck**

Run: `cd packages/vlm-core && pnpm test && cd ../vlm-shared && pnpm typecheck`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/vlm-shared packages/vlm-core pnpm-lock.yaml
git commit -m "feat(analytics): shared event contract, batch checker and location keys"
```

---

### Task 2: SDK event queue, transport and uploader

**Files:**
- Create: `packages/vlm-core/src/analytics/queue.ts`, `transport.ts`, `uploader.ts`, `packages/vlm-core/test/uploader.test.ts`

**Interfaces:**
- Consumes: `AnalyticsEvent`, `IngestBatch`, `IngestResponse`, `ANALYTICS_LIMITS`, `isHighPriority` (Task 1); `VLMPlatformAdapter.signedRequest?` (existing, `vlm-shared/src/platform.ts:18`).
- Produces:
  - `class EventQueue { constructor(maxSize?: number); size: number; push(sessionId: string, e: AnalyticsEvent): void; hasHighPriority(): boolean; take(max: number): { sessionId: string; events: AnalyticsEvent[] } | null; putBack(sessionId: string, events: AnalyticsEvent[]): void }`
  - `interface TransportResult { status: number; body?: unknown }`, `interface AnalyticsTransport { send(url: string, batch: IngestBatch): Promise<TransportResult> }`, `createTransport(adapter: { signedRequest?: VLMPlatformAdapter['signedRequest'] }, fetchImpl?: typeof fetch): AnalyticsTransport`
  - `class Uploader { constructor(opts: UploaderOptions); maybeFlush(force?: boolean): Promise<void> | null }` with `UploaderOptions = { url: string; queue: EventQueue; transport: AnalyticsTransport; envelope: (sessionId: string) => Omit<IngestBatch, 'events'>; now: () => number; random?: () => number; onResponse?: (r: IngestResponse) => void; log?: (msg: string) => void }`

- [ ] **Step 1: Write the failing test `packages/vlm-core/test/uploader.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { EventQueue } from '../src/analytics/queue.js'
import { Uploader } from '../src/analytics/uploader.js'
import type { AnalyticsTransport } from '../src/analytics/transport.js'
import type { AnalyticsEvent } from 'vlm-shared'

const ev = (type: AnalyticsEvent['type'], seq: number, data?: Record<string, unknown>): AnalyticsEvent => ({ t: 0, type, seq, data })

function setup(responses: Array<{ status: number; body?: unknown }>) {
  let now = 0
  const queue = new EventQueue(10)
  const sent: any[] = []
  const transport: AnalyticsTransport = {
    send: vi.fn(async (_url, batch) => {
      sent.push(batch)
      return responses.shift() ?? { status: 200, body: { ok: true, accepted: batch.events.length, notice: false } }
    }),
  }
  const onResponse = vi.fn()
  const up = new Uploader({
    url: 'http://x/api/ingest',
    queue,
    transport,
    envelope: (sessionId) => ({ v: 1, sessionId, visitorId: 'v', isGuest: true, noticeShown: false, scene: { realm: 'main', isWorld: false, isPreview: false, baseParcel: '0,0' } }),
    now: () => now,
    random: () => 1,
    onResponse,
  })
  return { queue, up, sent, transport, onResponse, advance: (ms: number) => (now += ms) }
}

describe('EventQueue', () => {
  it('evicts oldest pos, then oldest heartbeat, then oldest event when full', () => {
    const q = new EventQueue(3)
    q.push('s', ev('session.heartbeat', 0))
    q.push('s', ev('pos', 1))
    q.push('s', ev('custom', 2))
    q.push('s', ev('custom', 3)) // evicts pos
    q.push('s', ev('custom', 4)) // evicts heartbeat
    q.push('s', ev('custom', 5)) // evicts oldest (seq 2)
    expect(q.take(10)!.events.map((e) => e.seq)).toEqual([3, 4, 5])
  })

  it('take returns only the leading run of one session', () => {
    const q = new EventQueue(10)
    q.push('a', ev('pos', 0))
    q.push('a', ev('pos', 1))
    q.push('b', ev('session.start', 0))
    expect(q.take(10)).toEqual({ sessionId: 'a', events: [ev('pos', 0), ev('pos', 1)] })
    expect(q.take(10)!.sessionId).toBe('b')
  })
})

describe('Uploader', () => {
  it('waits for 5 s of low-priority events, then flushes', async () => {
    const s = setup([])
    s.queue.push('s', ev('pos', 0))
    expect(s.up.maybeFlush()).toBeNull()
    s.advance(5_000)
    await s.up.maybeFlush()
    expect(s.sent).toHaveLength(1)
  })

  it('flushes immediately for a high-priority event', async () => {
    const s = setup([])
    s.queue.push('s', ev('interact', 0, { kind: 'click', target: 'door' }))
    await s.up.maybeFlush()
    expect(s.sent).toHaveLength(1)
  })

  it('does not start a second send while one is in flight', async () => {
    const s = setup([])
    s.queue.push('s', ev('session.start', 0))
    const p = s.up.maybeFlush()
    s.queue.push('s', ev('session.leave', 1))
    expect(s.up.maybeFlush()).toBeNull()
    await p
  })

  it('puts events back and backs off on 5xx and network errors', async () => {
    const s = setup([{ status: 503 }, { status: 0 }])
    s.queue.push('s', ev('session.start', 0))
    await s.up.maybeFlush()
    expect(s.queue.size).toBe(1)
    expect(s.up.maybeFlush()).toBeNull() // inside 1 s backoff
    s.advance(1_000)
    await s.up.maybeFlush()
    expect(s.queue.size).toBe(1)
    s.advance(1_999)
    expect(s.up.maybeFlush()).toBeNull() // second failure → 2 s backoff
    s.advance(1)
    await s.up.maybeFlush()
    expect(s.queue.size).toBe(0)
  })

  it('honors retryAfter on 429', async () => {
    const s = setup([{ status: 429, body: { retryAfter: 7 } }])
    s.queue.push('s', ev('session.start', 0))
    await s.up.maybeFlush()
    s.advance(6_999)
    expect(s.up.maybeFlush()).toBeNull()
    s.advance(1)
    await s.up.maybeFlush()
    expect(s.sent).toHaveLength(2)
  })

  it('drops the batch on other 4xx', async () => {
    const s = setup([{ status: 422, body: { error: 'unknown_scene' } }])
    s.queue.push('s', ev('session.start', 0))
    await s.up.maybeFlush()
    expect(s.queue.size).toBe(0)
  })

  it('passes the server response to onResponse', async () => {
    const s = setup([{ status: 200, body: { ok: true, accepted: 1, notice: true } }])
    s.queue.push('s', ev('session.start', 0))
    await s.up.maybeFlush()
    expect(s.onResponse).toHaveBeenCalledWith({ ok: true, accepted: 1, notice: true })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/vlm-core && pnpm test test/uploader.test.ts`
Expected: FAIL — cannot find `../src/analytics/queue.js`.

- [ ] **Step 3: Create `packages/vlm-core/src/analytics/queue.ts`**

```ts
import { ANALYTICS_LIMITS, isHighPriority, type AnalyticsEvent } from 'vlm-shared'

interface Entry {
  sessionId: string
  event: AnalyticsEvent
}

export class EventQueue {
  private items: Entry[] = []

  constructor(private maxSize: number = ANALYTICS_LIMITS.maxQueue) {}

  get size(): number {
    return this.items.length
  }

  push(sessionId: string, event: AnalyticsEvent): void {
    this.items.push({ sessionId, event })
    this.trim()
  }

  hasHighPriority(): boolean {
    return this.items.some((i) => isHighPriority(i.event))
  }

  /** The leading run of events that share one session id, up to `max`. */
  take(max: number): { sessionId: string; events: AnalyticsEvent[] } | null {
    if (this.items.length === 0) return null
    const sessionId = this.items[0].sessionId
    let n = 0
    while (n < this.items.length && n < max && this.items[n].sessionId === sessionId) n++
    const taken = this.items.splice(0, n)
    return { sessionId, events: taken.map((i) => i.event) }
  }

  putBack(sessionId: string, events: AnalyticsEvent[]): void {
    this.items = [...events.map((event) => ({ sessionId, event })), ...this.items]
    this.trim()
  }

  private trim(): void {
    while (this.items.length > this.maxSize) {
      let i = this.items.findIndex((x) => x.event.type === 'pos')
      if (i < 0) i = this.items.findIndex((x) => x.event.type === 'session.heartbeat')
      if (i < 0) i = 0
      this.items.splice(i, 1)
    }
  }
}
```

- [ ] **Step 4: Create `packages/vlm-core/src/analytics/transport.ts`**

```ts
import type { IngestBatch, VLMPlatformAdapter } from 'vlm-shared'

export interface TransportResult {
  status: number
  body?: unknown
}

export interface AnalyticsTransport {
  send(url: string, batch: IngestBatch): Promise<TransportResult>
}

function parse(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined
  } catch {
    return undefined
  }
}

/** Signed fetch when the adapter has it (DCL), plain fetch otherwise. Network failures report status 0. */
export function createTransport(
  adapter: { signedRequest?: VLMPlatformAdapter['signedRequest'] },
  fetchImpl: typeof fetch | undefined = globalThis.fetch,
): AnalyticsTransport {
  return {
    async send(url, batch) {
      const body = JSON.stringify(batch)
      try {
        if (adapter.signedRequest) {
          const res = await adapter.signedRequest(url, { method: 'POST', body })
          return { status: res.status, body: parse(res.body) }
        }
        if (!fetchImpl) return { status: 0 }
        const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
        return { status: res.status, body: parse(await res.text()) }
      } catch {
        return { status: 0 }
      }
    },
  }
}
```

- [ ] **Step 5: Create `packages/vlm-core/src/analytics/uploader.ts`**

```ts
import { ANALYTICS_LIMITS, type IngestBatch, type IngestResponse } from 'vlm-shared'
import type { EventQueue } from './queue.js'
import type { AnalyticsTransport } from './transport.js'

export interface UploaderOptions {
  url: string
  queue: EventQueue
  transport: AnalyticsTransport
  envelope: (sessionId: string) => Omit<IngestBatch, 'events'>
  now: () => number
  random?: () => number
  onResponse?: (r: IngestResponse) => void
  log?: (msg: string) => void
}

export class Uploader {
  private inFlight = false
  private lastFlushAt: number
  private nextAttemptAt = 0
  private failures = 0
  private warnedRejected = false

  constructor(private opts: UploaderOptions) {
    this.lastFlushAt = opts.now()
  }

  /** Starts a send if one is due; returns its promise, or null if nothing was sent. */
  maybeFlush(force = false): Promise<void> | null {
    const { queue, now } = this.opts
    if (this.inFlight || queue.size === 0) return null
    const t = now()
    if (t < this.nextAttemptAt) return null
    const due =
      force ||
      queue.hasHighPriority() ||
      queue.size >= ANALYTICS_LIMITS.flushAtCount ||
      t - this.lastFlushAt >= ANALYTICS_LIMITS.flushIntervalMs
    if (!due) return null
    const taken = queue.take(ANALYTICS_LIMITS.maxBatchEvents)
    if (!taken) return null
    this.inFlight = true
    this.lastFlushAt = t
    return this.send(taken.sessionId, taken.events).finally(() => {
      this.inFlight = false
    })
  }

  private backoffMs(): number {
    const base = Math.min(ANALYTICS_LIMITS.backoffMaxMs, ANALYTICS_LIMITS.backoffMinMs * 2 ** (this.failures - 1))
    const r = this.opts.random ? this.opts.random() : Math.random()
    return Math.round(base * (0.5 + 0.5 * r))
  }

  private async send(sessionId: string, events: IngestBatch['events']): Promise<void> {
    const { transport, url, queue, envelope, now, onResponse, log } = this.opts
    const res = await transport.send(url, { ...envelope(sessionId), events })
    if (res.status >= 200 && res.status < 300) {
      this.failures = 0
      if (onResponse && res.body && typeof res.body === 'object') onResponse(res.body as IngestResponse)
      return
    }
    if (res.status === 429) {
      queue.putBack(sessionId, events)
      const retryAfter = (res.body as { retryAfter?: number } | undefined)?.retryAfter
      this.failures++
      this.nextAttemptAt = now() + (typeof retryAfter === 'number' ? retryAfter * 1000 : this.backoffMs())
      return
    }
    if (res.status === 0 || res.status >= 500) {
      queue.putBack(sessionId, events)
      this.failures++
      this.nextAttemptAt = now() + this.backoffMs()
      return
    }
    if (!this.warnedRejected) {
      this.warnedRejected = true
      log?.(`[VLM analytics] batch rejected (${res.status}): ${JSON.stringify(res.body)}`)
    }
  }
}
```

With `random: () => 1` the jitter factor is 1, so backoff is exactly 1 s, 2 s, 4 s … as the test expects.

- [ ] **Step 6: Run tests**

Run: `cd packages/vlm-core && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/vlm-core
git commit -m "feat(analytics): SDK event queue, transport and batching uploader"
```

---

### Task 3: SDK collector

**Files:**
- Create: `packages/vlm-core/src/analytics/collector.ts`, `packages/vlm-core/src/analytics/index.ts`, `packages/vlm-core/test/collector.test.ts`
- Modify: `packages/vlm-shared/src/platform.ts` (add `AnalyticsProbe`, `VLMPlatformAdapter.analytics?`, `getAnalyticsScene?`), `packages/vlm-core/src/index.ts`

**Interfaces:**
- Consumes: Task 1 contract, Task 2 `EventQueue`, `Uploader`, `createTransport`, `AnalyticsTransport`.
- Produces:
  - in `vlm-shared`: `interface AnalyticsProbe { getPlayerPose(): { position: Vec3; headingDeg: number } | null; getCameraMode(): 'first' | 'third' | null; isInsideScene(position: Vec3): boolean; pollInteractions(): Array<{ kind: 'click' | 'hover'; target: string }>; pollVideoEvents(): Array<{ target: string; state: 'play' | 'pause' | 'end' | 'error' }>; pollEmotes(): string[]; showNotice(text: string): void }`; `VLMPlatformAdapter` gains `analytics?: AnalyticsProbe` and `getAnalyticsScene?(): Promise<AnalyticsSceneRef>`.
  - in `vlm-core`: `class Collector { constructor(opts: CollectorOptions); tick(): void; track(name: string, props?: Record<string, unknown>): void; giveaway(giveawayId: string, result: string): void; destroy(): Promise<void>; readonly sessionId: string | null; readonly inside: boolean }` with `CollectorOptions = { apiUrl: string; probe: AnalyticsProbe; transport: AnalyticsTransport; scene: AnalyticsSceneRef; visitor: { visitorId: string; isGuest: boolean; displayName?: string }; context: { platform: string; device?: string; realm: string; sdkVersion: string }; now?: () => number; uuid?: () => string; random?: () => number; log?: (m: string) => void }`; `export * from './analytics/index.js'` from `vlm-core`.

- [ ] **Step 1: Add the probe types** to `packages/vlm-shared/src/platform.ts`. Add `import type { AnalyticsSceneRef } from './analytics.js';` at the top, these members inside `VLMPlatformAdapter` (after `signedRequest?`):

```ts
  /** Optional analytics probe; adapters without one produce no automatic analytics. */
  analytics?: AnalyticsProbe;
  /** Where this scene is, for analytics ingestion. */
  getAnalyticsScene?(): Promise<AnalyticsSceneRef>;
```

and this interface after `VLMPlatformAdapter`:

```ts
export interface AnalyticsProbe {
  getPlayerPose(): { position: Vec3; headingDeg: number } | null;
  getCameraMode(): 'first' | 'third' | null;
  isInsideScene(position: Vec3): boolean;
  pollInteractions(): Array<{ kind: 'click' | 'hover'; target: string }>;
  pollVideoEvents(): Array<{ target: string; state: 'play' | 'pause' | 'end' | 'error' }>;
  pollEmotes(): string[];
  showNotice(text: string): void;
}
```

(`Vec3` is already imported in `platform.ts`; if not, import it from `./types/math.js`.)

- [ ] **Step 2: Write the failing test `packages/vlm-core/test/collector.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { Collector } from '../src/analytics/collector.js'
import type { AnalyticsProbe, IngestBatch } from 'vlm-shared'

function rig(opts: { insideAt?: (x: number) => boolean } = {}) {
  let now = 0
  let pose: { position: { x: number; y: number; z: number }; headingDeg: number } | null = {
    position: { x: 8, y: 0, z: 8 },
    headingDeg: 92,
  }
  const pending = { interactions: [] as any[], video: [] as any[], emotes: [] as string[] }
  const probe: AnalyticsProbe = {
    getPlayerPose: () => pose,
    getCameraMode: () => 'third',
    isInsideScene: (p) => (opts.insideAt ? opts.insideAt(p.x) : p.x >= 0 && p.x < 16),
    pollInteractions: () => pending.interactions.splice(0),
    pollVideoEvents: () => pending.video.splice(0),
    pollEmotes: () => pending.emotes.splice(0),
    showNotice: vi.fn(),
  }
  const batches: IngestBatch[] = []
  let notice = false
  let ids = 0
  const c = new Collector({
    apiUrl: 'http://x',
    probe,
    transport: {
      send: async (_u, b) => {
        batches.push(b)
        return { status: 200, body: { ok: true, accepted: b.events.length, notice } }
      },
    },
    scene: { realm: 'main', isWorld: false, isPreview: false, baseParcel: '0,0', parcels: ['0,0'] },
    visitor: { visitorId: '0xabc', isGuest: false, displayName: 'Ana' },
    context: { platform: 'desktop', realm: 'main', sdkVersion: '2.0.0' },
    now: () => now,
    uuid: () => `00000000-0000-4000-8000-00000000000${++ids}`,
    random: () => 1,
  })
  const events = () => batches.flatMap((b) => b.events)
  const types = () => events().map((e) => e.type)
  const step = async (ms: number) => {
    now += ms
    c.tick()
    await new Promise((r) => setTimeout(r, 0))
  }
  return {
    c,
    probe,
    batches,
    events,
    types,
    step,
    move: (x: number, z = 8) => (pose = { position: { x, y: 0, z }, headingDeg: 92 }),
    vanish: () => (pose = null),
    pending,
    setNotice: (v: boolean) => (notice = v),
  }
}

describe('Collector', () => {
  it('starts a session on entering and sends session.start immediately with context', async () => {
    const r = rig()
    await r.step(0)
    expect(r.types()[0]).toBe('session.start')
    expect(r.events()[0].data).toMatchObject({ platform: 'desktop', realm: 'main', isGuest: false, cameraMode: 'third', sdkVersion: '2.0.0' })
    expect(r.batches[0].sessionId).toBe(r.c.sessionId)
  })

  it('samples position every 3 s when moving and every 15 s when idle, rounded', async () => {
    const r = rig()
    await r.step(0)
    for (let i = 1; i <= 3; i++) {
      r.move(8 + i)
      await r.step(3_000)
    }
    await r.step(5_000) // flush
    const moving = r.events().filter((e) => e.type === 'pos')
    expect(moving.length).toBeGreaterThanOrEqual(3)
    expect(moving[0].data).toMatchObject({ y: 0, z: 8, ry: 90, m: true })
    const before = moving.length
    for (let i = 0; i < 5; i++) await r.step(3_000) // idle 15 s
    await r.step(5_000)
    expect(r.events().filter((e) => e.type === 'pos').length).toBe(before + 1)
  })

  it('emits a heartbeat every 15 s while inside', async () => {
    const r = rig()
    await r.step(0)
    await r.step(15_000)
    await r.step(5_000)
    expect(r.types()).toContain('session.heartbeat')
  })

  it('leaving sends session.leave at once; returning within 60 s resumes the same session', async () => {
    const r = rig()
    await r.step(0)
    const first = r.c.sessionId
    r.move(40)
    await r.step(1_000)
    expect(r.types()).toContain('session.leave')
    r.move(8)
    await r.step(30_000)
    expect(r.c.sessionId).toBe(first)
    expect(r.types().filter((t) => t === 'session.start')).toHaveLength(1)
  })

  it('returning after 60 s starts a new session', async () => {
    const r = rig()
    await r.step(0)
    const first = r.c.sessionId
    r.move(40)
    await r.step(1_000)
    r.move(8)
    await r.step(61_000)
    expect(r.c.sessionId).not.toBe(first)
    expect(r.types().filter((t) => t === 'session.start')).toHaveLength(2)
  })

  it('records clicks immediately and dedupes hovers per target for 10 s', async () => {
    const r = rig()
    await r.step(0)
    r.pending.interactions.push({ kind: 'hover', target: 'door' }, { kind: 'hover', target: 'door' })
    await r.step(100)
    r.pending.interactions.push({ kind: 'hover', target: 'door' })
    await r.step(9_000)
    r.pending.interactions.push({ kind: 'click', target: 'door' })
    await r.step(100)
    const ints = r.events().filter((e) => e.type === 'interact')
    expect(ints.map((e) => e.data!.kind)).toEqual(['hover', 'click'])
  })

  it('records video and emotes, and custom events via track()', async () => {
    const r = rig()
    await r.step(0)
    r.pending.video.push({ target: 'screen', state: 'play' })
    r.pending.emotes.push('wave')
    r.c.track('bought_ticket', { tier: 'vip' })
    await r.step(100)
    await r.step(100)
    expect(r.events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'video', data: { target: 'screen', state: 'play' } }),
        expect.objectContaining({ type: 'emote', data: { emote: 'wave' } }),
        expect.objectContaining({ type: 'custom', data: { name: 'bought_ticket', props: { tier: 'vip' } } }),
      ]),
    )
  })

  it('ignores interactions and track() while outside the scene', async () => {
    const r = rig()
    r.move(40)
    r.c.track('x')
    r.pending.interactions.push({ kind: 'click', target: 'door' })
    await r.step(6_000)
    expect(r.batches).toHaveLength(0)
  })

  it('shows the notice once when the server asks, then sends identity', async () => {
    const r = rig()
    r.setNotice(true)
    await r.step(0)
    await r.step(100)
    expect(r.probe.showNotice).toHaveBeenCalledTimes(1)
    r.c.track('after')
    await r.step(100)
    const last = r.batches.at(-1)!
    expect(last.noticeShown).toBe(true)
    expect(last.displayName).toBe('Ana')
    expect(r.batches[0].noticeShown).toBe(false)
    expect(r.batches[0].displayName).toBeUndefined()
  })

  it('destroy() sends session.leave with reason destroy', async () => {
    const r = rig()
    await r.step(0)
    await r.c.destroy()
    const leave = r.events().find((e) => e.type === 'session.leave')
    expect(leave?.data).toEqual({ reason: 'destroy' })
  })

  it('does nothing when the player pose is unavailable', async () => {
    const r = rig()
    r.vanish()
    await r.step(6_000)
    expect(r.batches).toHaveLength(0)
  })

  it('numbers events per session starting at 0', async () => {
    const r = rig()
    await r.step(0) // session.start (0) + first position sample (1)
    r.c.track('a') // custom (2)
    await r.step(100)
    expect(r.types()).toEqual(['session.start', 'pos', 'custom'])
    expect(r.events().map((e) => e.seq)).toEqual([0, 1, 2])
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `cd packages/vlm-core && pnpm test test/collector.test.ts`
Expected: FAIL — cannot find `../src/analytics/collector.js`.

- [ ] **Step 4: Create `packages/vlm-core/src/analytics/collector.ts`**

```ts
import {
  ANALYTICS_LIMITS as L,
  NOTICE_TEXT,
  type AnalyticsEvent,
  type AnalyticsProbe,
  type AnalyticsSceneRef,
  type IngestResponse,
  type Vec3,
} from 'vlm-shared'
import { EventQueue } from './queue.js'
import { Uploader } from './uploader.js'
import type { AnalyticsTransport } from './transport.js'

export interface CollectorOptions {
  apiUrl: string
  probe: AnalyticsProbe
  transport: AnalyticsTransport
  scene: AnalyticsSceneRef
  visitor: { visitorId: string; isGuest: boolean; displayName?: string }
  context: { platform: string; device?: string; realm: string; sdkVersion: string }
  now?: () => number
  uuid?: () => string
  random?: () => number
  log?: (m: string) => void
}

function fallbackUuid(random: () => number): string {
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(random() * 16).toString(16)).join('')
  const variant = '89ab'[Math.floor(random() * 4)]
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`
}

const round = (n: number, step: number) => Math.round(n / step) * step
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

export class Collector {
  private queue = new EventQueue()
  private uploader: Uploader
  private now: () => number
  private uuid: () => string
  private _sessionId: string | null = null
  private _inside = false
  private seq = 0
  private leftAt = -Infinity
  private lastHeartbeatAt = 0
  private lastPosAt = -Infinity
  private lastPos: Vec3 | null = null
  private hoverSeen = new Map<string, number>()
  private noticeRequested = false
  private noticeShown = false

  constructor(private opts: CollectorOptions) {
    this.now = opts.now ?? (() => Date.now())
    const random = opts.random ?? Math.random
    const cryptoUuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID
    this.uuid = opts.uuid ?? (cryptoUuid ? () => cryptoUuid.call(globalThis.crypto) : () => fallbackUuid(random))
    this.uploader = new Uploader({
      url: `${opts.apiUrl.replace(/\/$/, '')}/api/ingest`,
      queue: this.queue,
      transport: opts.transport,
      now: this.now,
      random: opts.random,
      log: opts.log,
      envelope: (sessionId) => ({
        v: 1,
        sessionId,
        visitorId: opts.visitor.visitorId,
        isGuest: opts.visitor.isGuest,
        noticeShown: this.noticeShown,
        displayName: this.noticeShown ? opts.visitor.displayName : undefined,
        scene: opts.scene,
      }),
      onResponse: (r: IngestResponse) => {
        if (r.notice) this.noticeRequested = true
      },
    })
  }

  get sessionId(): string | null {
    return this._sessionId
  }

  get inside(): boolean {
    return this._inside
  }

  /** Call once per frame (the adapter's registerSystem). */
  tick(): void {
    const { probe } = this.opts
    const t = this.now()
    const pose = probe.getPlayerPose()
    const inside = !!pose && probe.isInsideScene(pose.position)
    let leaving = false

    if (inside && !this._inside) this.enter(t)
    else if (!inside && this._inside) {
      this.emit('session.leave', { reason: 'left_parcels' })
      this._inside = false
      this.leftAt = t
      leaving = true
    }

    if (this._inside && pose) {
      if (t - this.lastHeartbeatAt >= L.heartbeatMs) {
        this.emit('session.heartbeat', { cameraMode: probe.getCameraMode() })
        this.lastHeartbeatAt = t
      }
      const moved = !this.lastPos || dist(pose.position, this.lastPos) > L.posMinMoveM
      const interval = moved ? L.posMovingMs : L.posIdleMs
      if (t - this.lastPosAt >= interval) {
        this.emit('pos', {
          x: round(pose.position.x, 0.1),
          y: round(pose.position.y, 0.1),
          z: round(pose.position.z, 0.1),
          ry: ((round(pose.headingDeg, 5) % 360) + 360) % 360,
          m: moved,
        })
        this.lastPos = pose.position
        this.lastPosAt = t
      }
      for (const i of probe.pollInteractions()) {
        if (i.kind === 'hover') {
          const seen = this.hoverSeen.get(i.target)
          if (seen !== undefined && t - seen < L.hoverDedupeMs) continue
          this.hoverSeen.set(i.target, t)
        }
        this.emit('interact', { kind: i.kind, target: i.target })
      }
      for (const v of probe.pollVideoEvents()) this.emit('video', { target: v.target, state: v.state })
      for (const e of probe.pollEmotes()) this.emit('emote', { emote: e })
    } else {
      // Drain probe buffers so stale events aren't attributed later.
      probe.pollInteractions()
      probe.pollVideoEvents()
      probe.pollEmotes()
    }

    if (this.noticeRequested && !this.noticeShown) {
      probe.showNotice(NOTICE_TEXT)
      this.noticeShown = true
    }

    this.uploader.maybeFlush(leaving)
  }

  track(name: string, props?: Record<string, unknown>): void {
    if (!this._inside) return
    this.emit('custom', props === undefined ? { name } : { name, props })
  }

  giveaway(giveawayId: string, result: string): void {
    if (!this._inside) return
    this.emit('giveaway', { giveawayId, result })
  }

  async destroy(): Promise<void> {
    if (this._inside) {
      this.emit('session.leave', { reason: 'destroy' })
      this._inside = false
    }
    await this.uploader.maybeFlush(true)
  }

  private enter(t: number): void {
    this._inside = true
    if (this._sessionId && t - this.leftAt <= L.sessionResumeMs) return
    this._sessionId = this.uuid()
    this.seq = 0
    this.lastHeartbeatAt = t
    this.lastPosAt = -Infinity
    this.lastPos = null
    this.hoverSeen.clear()
    const { context, visitor, probe } = this.opts
    this.emit('session.start', {
      platform: context.platform,
      device: context.device,
      realm: context.realm,
      isGuest: visitor.isGuest,
      cameraMode: probe.getCameraMode(),
      sdkVersion: context.sdkVersion,
    })
  }

  private emit(type: AnalyticsEvent['type'], data?: Record<string, unknown>): void {
    if (!this._sessionId) return
    this.queue.push(this._sessionId, { t: this.now(), type, seq: this.seq++, data })
  }
}
```

Note: `session.leave` is emitted before `_inside` flips, and `emit` only needs a session id, so it is queued under the leaving session. The position test expects `ry: 90` for a heading of 92°.

- [ ] **Step 5: Barrel and export** — create `packages/vlm-core/src/analytics/index.ts`:

```ts
export { EventQueue } from './queue.js'
export { Uploader, type UploaderOptions } from './uploader.js'
export { createTransport, type AnalyticsTransport, type TransportResult } from './transport.js'
export { Collector, type CollectorOptions } from './collector.js'
```

Append to `packages/vlm-core/src/index.ts`: `export * from './analytics/index.js'`

- [ ] **Step 6: Run tests and typecheck**

Run: `cd packages/vlm-core && pnpm test && cd .. && pnpm --filter vlm-shared build && pnpm --filter vlm-core typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/vlm-shared packages/vlm-core
git commit -m "feat(analytics): SDK collector with sessions, sampling and probe polling"
```

---

### Task 4: Decentraland probe, analytics-only entry, VLM integration

**Files:**
- Create: `packages/vlm-adapter-dcl/src/analytics.ts`
- Modify: `packages/vlm-adapter-dcl/package.json` (exports), `packages/vlm-adapter-dcl/src/DclAdapter.ts` (implement `getAnalyticsScene`), `packages/vlm-core/src/VLM.ts`, `packages/vlm-shared/src/types/scene.ts`

**Interfaces:**
- Consumes: Task 3 `Collector`, `createTransport`, `AnalyticsProbe`; `DclAdapter` (existing).
- Produces:
  - `class DclAnalyticsProbe implements AnalyticsProbe { constructor(scene: { baseParcel?: string; parcels?: string[] }) }`
  - `getAnalyticsSceneRef(): Promise<AnalyticsSceneRef>`
  - `startVLMAnalytics(opts?: { env?: 'dev' | 'staging' | 'prod'; apiUrl?: string; adapter?: DclAdapter }): Promise<Collector | null>` exported from `vlm-adapter-dcl/analytics` and re-exported from `vlm-adapter-dcl`.
  - `VLM`: `attachAnalytics(c: Collector): void`, `track(name: string, props?: Record<string, unknown>): void`; `recordAction` becomes an alias of `track`; `resolveApiUrl(config: Partial<VLMInitConfig>): string` exported from `vlm-core`.
  - `VLMInitConfig.analytics?: boolean` (default on).

This task touches the DCL runtime, which can't run under Vitest. Verification is `tsc` against `@dcl/sdk` 7.22 typings plus a manual preview run.

- [ ] **Step 1: Config flag** — in `packages/vlm-shared/src/types/scene.ts`, add to `VLMInitConfig`:

```ts
  /** Automatic analytics (default true). */
  analytics?: boolean;
```

- [ ] **Step 2: `resolveApiUrl` and analytics hooks in `packages/vlm-core/src/VLM.ts`**

Export a helper next to `API_URLS`:

```ts
export function resolveApiUrl(config: Partial<VLMInitConfig> = {}): string {
  const env = config.env || 'prod'
  return config.apiUrl || API_URLS[env] || API_URLS.prod
}
```

Use it in `authenticate()` (`const apiUrl = resolveApiUrl(config)`). Add to the class:

```ts
  private analytics: import('./analytics/collector.js').Collector | null = null

  attachAnalytics(collector: import('./analytics/collector.js').Collector): void {
    this.analytics = collector
  }

  track(name: string, props?: Record<string, unknown>): void {
    this.analytics?.track(name, props)
  }
```

Replace `recordAction` with an alias:

```ts
  /** @deprecated use track() */
  recordAction(id: string, metadata?: Record<string, unknown>): void {
    this.track(id, metadata)
  }
```

Remove the `this.colyseus.send('session_start', …)` call in `connectToScene` and the `session_end` send in `destroy()`; in `destroy()` add `await this.analytics?.destroy()` before leaving the room. Export `resolveApiUrl` from `packages/vlm-core/src/index.ts` (`export { VLM, resolveApiUrl } from './VLM.js'` — keep the existing exports).

- [ ] **Step 3: Create `packages/vlm-adapter-dcl/src/analytics.ts`**

```ts
import {
  engine,
  Entity,
  Transform,
  CameraMode,
  CameraType,
  inputSystem,
  InputAction,
  PointerEventType,
  Name,
  VideoPlayer,
  videoEventsSystem,
  VideoState,
  AvatarEmoteCommand,
  TextShape,
  Billboard,
} from '@dcl/sdk/ecs'
import { Vector3, Color4 } from '@dcl/sdk/math'
import { Collector, createTransport, resolveApiUrl } from 'vlm-core'
import { PARCEL_RE, type AnalyticsProbe, type AnalyticsSceneRef, type Vec3 } from 'vlm-shared'
import { DclAdapter } from './DclAdapter'

const SDK_VERSION = '2.0.0'

function targetName(entity: number | undefined): string {
  if (entity === undefined) return 'unknown'
  const n = Name.getOrNull(entity as Entity)
  return n?.value || `entity:${entity}`
}

function headingFromQuaternion(q: { x: number; y: number; z: number; w: number }): number {
  const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x))
  return (yaw * 180) / Math.PI
}

export class DclAnalyticsProbe implements AnalyticsProbe {
  private base: [number, number]
  private parcels: Set<string>
  private lastClickTs = -1
  private lastHoverTs = -1
  private videoBuffer: Array<{ target: string; state: 'play' | 'pause' | 'end' | 'error' }> = []
  private registeredVideos = new Set<Entity>()
  private lastVideoScan = 0
  private lastEmoteTs = -1

  constructor(scene: { baseParcel?: string; parcels?: string[] }) {
    const [bx, by] = (scene.baseParcel && PARCEL_RE.test(scene.baseParcel) ? scene.baseParcel : '0,0').split(',').map(Number)
    this.base = [bx, by]
    this.parcels = new Set(scene.parcels && scene.parcels.length ? scene.parcels : [`${bx},${by}`])
  }

  getPlayerPose(): { position: Vec3; headingDeg: number } | null {
    const t = Transform.getOrNull(engine.PlayerEntity)
    if (!t) return null
    return { position: { x: t.position.x, y: t.position.y, z: t.position.z }, headingDeg: headingFromQuaternion(t.rotation) }
  }

  getCameraMode(): 'first' | 'third' | null {
    const c = CameraMode.getOrNull(engine.CameraEntity)
    if (!c) return null
    return c.mode === CameraType.CT_FIRST_PERSON ? 'first' : 'third'
  }

  isInsideScene(p: Vec3): boolean {
    const px = this.base[0] + Math.floor(p.x / 16)
    const py = this.base[1] + Math.floor(p.z / 16)
    return this.parcels.has(`${px},${py}`)
  }

  pollInteractions(): Array<{ kind: 'click' | 'hover'; target: string }> {
    const out: Array<{ kind: 'click' | 'hover'; target: string }> = []
    const click = inputSystem.getInputCommand(InputAction.IA_POINTER, PointerEventType.PET_DOWN)
    if (click && click.timestamp !== this.lastClickTs) {
      this.lastClickTs = click.timestamp
      out.push({ kind: 'click', target: targetName(click.hit?.entityId) })
    }
    const hover = inputSystem.getInputCommand(InputAction.IA_POINTER, PointerEventType.PET_HOVER_ENTER)
    if (hover && hover.timestamp !== this.lastHoverTs) {
      this.lastHoverTs = hover.timestamp
      out.push({ kind: 'hover', target: targetName(hover.hit?.entityId) })
    }
    return out
  }

  pollVideoEvents(): Array<{ target: string; state: 'play' | 'pause' | 'end' | 'error' }> {
    const now = Date.now()
    if (now - this.lastVideoScan > 1000) {
      this.lastVideoScan = now
      for (const [entity] of engine.getEntitiesWith(VideoPlayer)) {
        if (this.registeredVideos.has(entity)) continue
        this.registeredVideos.add(entity)
        videoEventsSystem.registerVideoEventsEntity(entity, (e) => {
          const target = targetName(entity)
          if (e.state === VideoState.VS_PLAYING) this.videoBuffer.push({ target, state: 'play' })
          else if (e.state === VideoState.VS_ERROR) this.videoBuffer.push({ target, state: 'error' })
          else if (e.state === VideoState.VS_PAUSED) {
            const ended = e.videoLength > 0 && e.currentOffset >= e.videoLength - 0.5
            this.videoBuffer.push({ target, state: ended ? 'end' : 'pause' })
          }
        })
      }
    }
    return this.videoBuffer.splice(0)
  }

  pollEmotes(): string[] {
    if (!AvatarEmoteCommand.has(engine.PlayerEntity)) return []
    const out: string[] = []
    let max = this.lastEmoteTs
    for (const cmd of AvatarEmoteCommand.get(engine.PlayerEntity).values()) {
      if (cmd.timestamp > this.lastEmoteTs) {
        out.push(cmd.emoteUrn)
        if (cmd.timestamp > max) max = cmd.timestamp
      }
    }
    this.lastEmoteTs = max
    return out
  }

  showNotice(text: string): void {
    const e = engine.addEntity()
    Transform.create(e, { parent: engine.CameraEntity, position: Vector3.create(0, -0.6, 2) })
    TextShape.create(e, { text, fontSize: 1.2, textColor: Color4.White(), outlineWidth: 0.1, outlineColor: Color4.Black() })
    Billboard.create(e)
    let left = 8
    const sys = (dt: number) => {
      left -= dt
      if (left <= 0) {
        engine.removeEntity(e)
        engine.removeSystem(sys)
      }
    }
    engine.addSystem(sys)
  }
}

export async function getAnalyticsSceneRef(): Promise<AnalyticsSceneRef> {
  const { getSceneInformation, getRealm } = await import('~system/Runtime' as any)
  const [info, realm] = await Promise.all([getSceneInformation({}), getRealm({})])
  const metadata = JSON.parse(info.metadataJson || '{}')
  const realmName: string = realm?.realmInfo?.realmName || ''
  const isWorld = /\.eth$/i.test(realmName)
  const entityId = typeof info.urn === 'string' ? info.urn.split(':').pop()?.split('?')[0] : undefined
  return {
    realm: realmName || 'unknown',
    isWorld,
    isPreview: !!realm?.realmInfo?.isPreview,
    worldName: isWorld ? realmName : undefined,
    baseParcel: metadata.scene?.base,
    parcels: metadata.scene?.parcels,
    entityId,
    title: metadata.display?.title,
  }
}

/** Analytics only: no realtime room, no HUD, no login flow. */
export async function startVLMAnalytics(
  opts: { env?: 'dev' | 'staging' | 'prod'; apiUrl?: string; adapter?: DclAdapter } = {},
): Promise<Collector | null> {
  try {
    const adapter = opts.adapter ?? new DclAdapter()
    const [user, env, scene] = await Promise.all([adapter.getPlatformUser(), adapter.getEnvironment(), getAnalyticsSceneRef()])
    const random = Math.random
    const visitorId = user.walletAddress || user.id || `guest-${Math.floor(random() * 1e12).toString(36)}`
    const collector = new Collector({
      apiUrl: resolveApiUrl(opts),
      probe: new DclAnalyticsProbe(scene),
      transport: createTransport(adapter),
      scene,
      visitor: { visitorId, isGuest: user.isGuest, displayName: user.displayName },
      context: {
        platform: 'decentraland',
        device: String((env.metadata as { subPlatform?: unknown } | undefined)?.subPlatform ?? ''),
        realm: scene.realm,
        sdkVersion: SDK_VERSION,
      },
      log: (m) => console.log(m),
    })
    adapter.registerSystem(() => collector.tick())
    return collector
  } catch (err) {
    console.log('[VLM analytics] disabled:', String(err))
    return null
  }
}
```

If `tsc` reports a name that 7.22 doesn't export (for example `Billboard` or `TextShape`), check `node_modules/.pnpm/@dcl+ecs@7.22.0/node_modules/@dcl/ecs/dist/index.d.ts` and use the exported name. Don't drop the feature.

- [ ] **Step 4: `DclAdapter.getAnalyticsScene`** — in `DclAdapter.ts` add:

```ts
  async getAnalyticsScene() {
    const { getAnalyticsSceneRef } = await import('./analytics.js')
    return getAnalyticsSceneRef()
  }
```

- [ ] **Step 5: Exports** — in `packages/vlm-adapter-dcl/package.json` add:

```json
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./analytics": { "types": "./dist/analytics.d.ts", "default": "./dist/analytics.js" }
  },
```

and in `src/index.ts` add `export { startVLMAnalytics, DclAnalyticsProbe, getAnalyticsSceneRef } from './analytics.js'`.

- [ ] **Step 6: `createVLM` starts analytics** — at the top of `createVLM` in `packages/vlm-adapter-dcl/src/index.ts`, after `const vlm = new VLM(adapter)`:

```ts
  if (config?.analytics !== false) {
    const collector = await startVLMAnalytics({ env: config?.env, apiUrl: config?.apiUrl, adapter })
    if (collector) vlm.attachAnalytics(collector)
  }
```

(Task 12 changes the visitor setup flow in this same function.)

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter vlm-shared build && pnpm --filter vlm-client build && pnpm --filter vlm-core build && pnpm --filter vlm-core test && pnpm --filter vlm-adapter-dcl typecheck`
Expected: all clean.

- [ ] **Step 8: Manual preview check (report results; do not block on it if the DCL CLI can't run here)**

In `test-scenes/dcl-test/src/index.ts`, temporarily replace the VLM setup with `import { startVLMAnalytics } from 'vlm-adapter-dcl/analytics'; startVLMAnalytics({ env: 'dev' })`, run the server (`pnpm --filter vlm-server dev`) and `cd test-scenes/dcl-test && npm run start`. Walk around for 20 s: the server log should show `POST /api/ingest` requests every ~5 s (they'll 404 until Task 8 — that's fine, it proves the client side). Revert the test-scene change before committing.

- [ ] **Step 9: Commit**

```bash
git add packages/vlm-shared packages/vlm-core packages/vlm-adapter-dcl
git commit -m "feat(analytics): Decentraland probe, startVLMAnalytics entry and VLM.track()"
```

---

### Task 5: Analytics schema, read access, compatibility endpoints

**Files:**
- Create: `apps/server/src/analytics/access.ts`, `apps/server/test/helpers/analytics.ts`, `apps/server/test/analytics-schema.test.ts`
- Modify: `apps/server/src/db/schema.ts` (replace `analyticsSessions`/`analyticsActions`), `apps/server/src/routes/analytics.ts` (rewrite)

**Interfaces:**
- Consumes: `getSceneAccess`, `isFullAccess` (`src/auth/permissions.ts`), `actorFromClaims`, `Actor`.
- Produces:
  - Tables: `analyticsScenes`, `analyticsSessions`, `analyticsEvents`, `analyticsPositions`, `analyticsDirtyHours`, `analyticsRollupHourly`, `analyticsHeatmapDaily`, `analyticsCopresenceDaily`; enums `analyticsSceneKindEnum`, `analyticsClaimStatusEnum`.
  - `getAnalyticsAccess(actor: Actor, analyticsSceneId: string, now?: Date): Promise<{ canRead: boolean; canManage: boolean; scene: typeof analyticsScenes.$inferSelect | null }>`
  - Test helpers: `createAnalyticsScene(opts?)`, `insertSession(sceneId, opts?)`.

- [ ] **Step 1: Write the failing test `apps/server/test/analytics-schema.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { analyticsEvents, sceneCollaborators } from '../src/db/schema.js'
import { getAnalyticsAccess } from '../src/analytics/access.js'
import { actorFromClaims } from '../src/auth/actor.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, tokenFor, testApp, type TestUser } from './helpers/factories.js'
import { createAnalyticsScene, insertSession } from './helpers/analytics.js'

const actor = (u: TestUser, extra = {}) => actorFromClaims({ id: u.id, role: u.role, wallet: u.wallet, verified: true, ...extra })

describe('analytics schema and access', () => {
  beforeEach(resetDb)

  it('dedupes events on (session_id, seq)', async () => {
    const s = await createAnalyticsScene()
    const row = { sceneId: s.id, sessionId: '11111111-1111-4111-8111-111111111111', seq: 0, visitorHash: 'h', type: 'custom', occurredAt: new Date(), verified: false, data: {} }
    await db.insert(analyticsEvents).values(row).onConflictDoNothing()
    const again = await db.insert(analyticsEvents).values(row).onConflictDoNothing().returning()
    expect(again).toHaveLength(0)
  })

  it('claimer reads and manages; lapsed claimer reads for 30 days only; strangers and unverified get nothing', async () => {
    const claimer = await createUser()
    const stranger = await createUser()
    const s = await createAnalyticsScene({ claimedByUserId: claimer.id, claimStatus: 'active' })
    expect(await getAnalyticsAccess(actor(claimer), s.id)).toMatchObject({ canRead: true, canManage: true })
    expect(await getAnalyticsAccess(actor(stranger), s.id)).toMatchObject({ canRead: false, canManage: false })
    expect(await getAnalyticsAccess(actor(claimer, { verified: false }), s.id)).toMatchObject({ canRead: false })

    const lapsed = await createAnalyticsScene({ claimedByUserId: claimer.id, claimStatus: 'lapsed', lapsedAt: new Date(Date.now() - 10 * 86400_000) })
    expect(await getAnalyticsAccess(actor(claimer), lapsed.id)).toMatchObject({ canRead: true, canManage: false })
    const old = await createAnalyticsScene({ claimedByUserId: claimer.id, claimStatus: 'lapsed', lapsedAt: new Date(Date.now() - 31 * 86400_000) })
    expect(await getAnalyticsAccess(actor(claimer), old.id)).toMatchObject({ canRead: false })
  })

  it('linked VLM scene owner manages, collaborators read', async () => {
    const owner = await createUser()
    const viewer = await createUser()
    const { scene } = await createScene(owner)
    await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: viewer.id, role: 'viewer' })
    const s = await createAnalyticsScene({ vlmSceneId: scene.id })
    expect(await getAnalyticsAccess(actor(owner), s.id)).toMatchObject({ canRead: true, canManage: true })
    expect(await getAnalyticsAccess(actor(viewer), s.id)).toMatchObject({ canRead: true, canManage: false })
  })
})

describe('compat endpoints keep the dashboard shape', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

  it('GET /api/analytics/scenes/:vlmSceneId/recent reads the new tables', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const s = await createAnalyticsScene({ vlmSceneId: scene.id })
    await insertSession(s.id, { lastSeenAt: new Date() })
    await insertSession(s.id, { lastSeenAt: new Date(Date.now() - 5 * 60_000), endedAt: new Date(Date.now() - 5 * 60_000) })
    const res = await app.inject({ method: 'GET', url: `/api/analytics/scenes/${scene.id}/recent`, headers: { authorization: `Bearer ${tokenFor(owner)}` } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ visitors: 2, activeSessions: 1 })
    expect(res.json().recentSessions).toHaveLength(2)
  })

  it('returns zeros for a VLM scene with no analytics yet, and 403 for strangers', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const { scene } = await createScene(owner)
    const ok = await app.inject({ method: 'GET', url: `/api/analytics/scenes/${scene.id}/recent`, headers: { authorization: `Bearer ${tokenFor(owner)}` } })
    expect(ok.json()).toEqual({ visitors: 0, actions: 0, activeSessions: 0, recentSessions: [] })
    const no = await app.inject({ method: 'GET', url: `/api/analytics/scenes/${scene.id}/sessions`, headers: { authorization: `Bearer ${tokenFor(stranger)}` } })
    expect(no.statusCode).toBe(403)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server && pnpm test test/analytics-schema.test.ts`
Expected: FAIL — `../src/analytics/access.js` not found.

- [ ] **Step 3: Replace the analytics tables in `apps/server/src/db/schema.ts`**

Delete `analyticsSessions`, `analyticsSessionsRelations`, `analyticsActions`, `analyticsActionsRelations` (the block under `// ── Analytics ──`). Add `bigserial`, `real`, `smallint`, `date` to the `drizzle-orm/pg-core` import if missing. Insert in their place:

```ts
// ── Analytics ────────────────────────────────────────────────────────────────

export const analyticsSceneKindEnum = pgEnum('analytics_scene_kind', ['parcels', 'world', 'preview'])
export const analyticsClaimStatusEnum = pgEnum('analytics_claim_status', ['active', 'lapsed'])

export const analyticsScenes = pgTable('analytics_scenes', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: analyticsSceneKindEnum('kind').notNull(),
  locationKey: text('location_key').notNull().unique(),
  realm: text('realm').notNull(),
  baseParcel: text('base_parcel'),
  parcels: text('parcels').array().notNull().default(sql`'{}'::text[]`),
  worldName: text('world_name'),
  activeEntityId: text('active_entity_id'),
  title: text('title'),
  salt: text('salt').notNull(), // 64 hex chars; never sent to clients
  claimedByUserId: uuid('claimed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  claimStatus: analyticsClaimStatusEnum('claim_status'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  lapsedAt: timestamp('lapsed_at', { withTimezone: true }),
  vlmSceneId: uuid('vlm_scene_id').references(() => scenes.id, { onDelete: 'set null' }),
  walletVisibility: boolean('wallet_visibility').notNull().default(false),
  isPreview: boolean('is_preview').notNull().default(false),
  verifiedSessionShare: real('verified_session_share').notNull().default(0),
  lastEntityCheckAt: timestamp('last_entity_check_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  vlmSceneIdx: index('analytics_scenes_vlm_scene_idx').on(t.vlmSceneId),
  claimerIdx: index('analytics_scenes_claimer_idx').on(t.claimedByUserId),
}))

export const analyticsSessions = pgTable('analytics_sessions', {
  id: uuid('id').primaryKey(), // client-generated session id
  sceneId: uuid('scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  visitorHash: text('visitor_hash').notNull(),
  wallet: text('wallet'),
  displayName: text('display_name'),
  isGuest: boolean('is_guest').notNull().default(false),
  verified: boolean('verified').notNull().default(false),
  platform: text('platform'),
  device: text('device'),
  realm: text('realm'),
  country: text('country'),
  cameraMode: text('camera_mode'),
  isReturning: boolean('is_returning').notNull().default(false),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  durationSec: integer('duration_sec').notNull().default(0),
  eventCount: integer('event_count').notNull().default(0),
}, (t) => ({
  sceneStartIdx: index('analytics_sessions_scene_started_idx').on(t.sceneId, t.startedAt),
  sceneSeenIdx: index('analytics_sessions_scene_seen_idx').on(t.sceneId, t.lastSeenAt),
  sceneVisitorIdx: index('analytics_sessions_scene_visitor_idx').on(t.sceneId, t.visitorHash),
}))

export const analyticsEvents = pgTable('analytics_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  sceneId: uuid('scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull(),
  seq: integer('seq').notNull(),
  visitorHash: text('visitor_hash').notNull(),
  type: text('type').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  verified: boolean('verified').notNull().default(false),
  data: jsonb('data'),
}, (t) => ({
  sessionSeqUq: uniqueIndex('analytics_events_session_seq_uq').on(t.sessionId, t.seq),
  sceneTimeIdx: index('analytics_events_scene_time_idx').on(t.sceneId, t.occurredAt),
}))

export const analyticsPositions = pgTable('analytics_positions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  sceneId: uuid('scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull(),
  seq: integer('seq').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  x: real('x').notNull(),
  y: real('y').notNull(),
  z: real('z').notNull(),
  heading: smallint('heading').notNull().default(0),
  moving: boolean('moving').notNull().default(false),
}, (t) => ({
  sessionSeqUq: uniqueIndex('analytics_positions_session_seq_uq').on(t.sessionId, t.seq),
  sceneTimeIdx: index('analytics_positions_scene_time_idx').on(t.sceneId, t.occurredAt),
}))

export const analyticsDirtyHours = pgTable('analytics_dirty_hours', {
  sceneId: uuid('scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  hour: timestamp('hour', { withTimezone: true }).notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.sceneId, t.hour] }) }))

export const analyticsRollupHourly = pgTable('analytics_rollup_hourly', {
  sceneId: uuid('scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  hour: timestamp('hour', { withTimezone: true }).notNull(),
  sessions: integer('sessions').notNull().default(0),
  uniqueVisitors: integer('unique_visitors').notNull().default(0),
  newVisitors: integer('new_visitors').notNull().default(0),
  returningVisitors: integer('returning_visitors').notNull().default(0),
  verifiedSessions: integer('verified_sessions').notNull().default(0),
  peakConcurrency: integer('peak_concurrency').notNull().default(0),
  dwellAvgSec: integer('dwell_avg_sec').notNull().default(0),
  dwellP50Sec: integer('dwell_p50_sec').notNull().default(0),
  dwellP90Sec: integer('dwell_p90_sec').notNull().default(0),
  interactions: jsonb('interactions').notNull().default({}),
  video: jsonb('video').notNull().default({}),
  emotes: jsonb('emotes').notNull().default({}),
  countries: jsonb('countries').notNull().default({}),
  platforms: jsonb('platforms').notNull().default({}),
  cameraModes: jsonb('camera_modes').notNull().default({}),
}, (t) => ({ pk: primaryKey({ columns: [t.sceneId, t.hour] }) }))

export const analyticsHeatmapDaily = pgTable('analytics_heatmap_daily', {
  sceneId: uuid('scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  day: date('day').notNull(),
  cellX: smallint('cell_x').notNull(),
  cellZ: smallint('cell_z').notNull(),
  dwellSec: integer('dwell_sec').notNull().default(0),
  visits: integer('visits').notNull().default(0),
}, (t) => ({ pk: primaryKey({ columns: [t.sceneId, t.day, t.cellX, t.cellZ] }) }))

export const analyticsCopresenceDaily = pgTable('analytics_copresence_daily', {
  sceneId: uuid('scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  day: date('day').notNull(),
  visitorA: text('visitor_a').notNull(),
  visitorB: text('visitor_b').notNull(),
  overlapSec: integer('overlap_sec').notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.sceneId, t.day, t.visitorA, t.visitorB] }) }))
```

Drizzle-kit push will drop the old `analytics_actions` table and recreate `analytics_sessions` with the new columns. Both tables hold no data (nothing ever wrote to them), so this is safe. Confirm with `grep -rn "analyticsActions" apps/server/src` that nothing else references the old table.

- [ ] **Step 4: Create `apps/server/src/analytics/access.ts`**

```ts
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsScenes } from '../db/schema.js'
import type { Actor } from '../auth/actor.js'
import { getSceneAccess, isFullAccess } from '../auth/permissions.js'

const LAPSE_GRACE_MS = 30 * 86400_000

export interface AnalyticsAccess {
  canRead: boolean
  canManage: boolean
  scene: typeof analyticsScenes.$inferSelect | null
}

const NONE = (scene: AnalyticsAccess['scene']): AnalyticsAccess => ({ canRead: false, canManage: false, scene })

export async function getAnalyticsAccess(actor: Actor, analyticsSceneId: string, now = new Date()): Promise<AnalyticsAccess> {
  const scene = (await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.id, analyticsSceneId) })) ?? null
  if (!scene || !actor.userId || !actor.verified) return NONE(scene)
  if (actor.role === 'admin') return { canRead: true, canManage: true, scene }
  if (scene.claimedByUserId === actor.userId) {
    if (scene.claimStatus === 'active') return { canRead: true, canManage: true, scene }
    if (scene.claimStatus === 'lapsed' && scene.lapsedAt && now.getTime() - scene.lapsedAt.getTime() < LAPSE_GRACE_MS) {
      return { canRead: true, canManage: false, scene }
    }
  }
  if (scene.vlmSceneId) {
    const access = await getSceneAccess(actor, scene.vlmSceneId, now)
    if (isFullAccess(access)) return { canRead: true, canManage: true, scene }
    if (access.level === 'editor' || access.level === 'viewer') return { canRead: true, canManage: false, scene }
  }
  return NONE(scene)
}
```

- [ ] **Step 5: Test helpers `apps/server/test/helpers/analytics.ts`**

```ts
import { randomBytes, randomUUID } from 'node:crypto'
import { db } from '../../src/db/connection.js'
import { analyticsScenes, analyticsSessions } from '../../src/db/schema.js'

let n = 0

export async function createAnalyticsScene(opts: Partial<typeof analyticsScenes.$inferInsert> = {}) {
  n++
  const [row] = await db
    .insert(analyticsScenes)
    .values({
      kind: 'parcels',
      locationKey: `gc:${n},${n}`,
      realm: 'main',
      baseParcel: `${n},${n}`,
      parcels: [`${n},${n}`],
      activeEntityId: `bafy${n}`,
      salt: randomBytes(32).toString('hex'),
      lastEntityCheckAt: new Date(),
      ...opts,
    })
    .returning()
  return row
}

export async function insertSession(sceneId: string, opts: Partial<typeof analyticsSessions.$inferInsert> = {}) {
  const startedAt = opts.startedAt ?? new Date(Date.now() - 2 * 60_000)
  const lastSeenAt = opts.lastSeenAt ?? new Date()
  const [row] = await db
    .insert(analyticsSessions)
    .values({
      id: randomUUID(),
      sceneId,
      visitorHash: opts.visitorHash ?? randomBytes(16).toString('hex'),
      platform: 'decentraland',
      startedAt,
      lastSeenAt,
      durationSec: Math.round((lastSeenAt.getTime() - startedAt.getTime()) / 1000),
      ...opts,
    })
    .returning()
  return row
}
```

- [ ] **Step 6: Rewrite `apps/server/src/routes/analytics.ts`** (same paths and response shapes; VLM scene id in the URL)

```ts
import type { FastifyInstance } from 'fastify'
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsEvents, analyticsScenes, analyticsSessions } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess } from '../auth/permissions.js'

const READ_LEVELS = new Set(['admin', 'owner', 'org', 'editor', 'viewer'])

/** Legacy dashboard endpoints keyed by VLM scene id, served from the new analytics tables. */
export default async function analyticsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  async function locate(request: { user: any }, vlmSceneId: string) {
    const access = await getSceneAccess(actorFromClaims(request.user), vlmSceneId)
    if (!READ_LEVELS.has(access.level)) return { allowed: false as const }
    const scene = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.vlmSceneId, vlmSceneId) })
    return { allowed: true as const, scene }
  }

  app.get<{ Params: { sceneId: string } }>('/api/analytics/scenes/:sceneId/recent', async (request, reply) => {
    const found = await locate(request, request.params.sceneId)
    if (!found.allowed) return reply.status(403).send({ error: 'Forbidden' })
    if (!found.scene) return reply.send({ visitors: 0, actions: 0, activeSessions: 0, recentSessions: [] })
    const sceneId = found.scene.id
    const since = new Date(Date.now() - 86400_000)
    const liveSince = new Date(Date.now() - 60_000)
    const [{ visitors }] = await db
      .select({ visitors: sql<number>`count(*)::int` })
      .from(analyticsSessions)
      .where(and(eq(analyticsSessions.sceneId, sceneId), gte(analyticsSessions.startedAt, since)))
    const [{ actions }] = await db
      .select({ actions: sql<number>`count(*)::int` })
      .from(analyticsEvents)
      .where(and(eq(analyticsEvents.sceneId, sceneId), gte(analyticsEvents.occurredAt, since)))
    const [{ active }] = await db
      .select({ active: sql<number>`count(*)::int` })
      .from(analyticsSessions)
      .where(and(eq(analyticsSessions.sceneId, sceneId), gte(analyticsSessions.lastSeenAt, liveSince)))
    const recentSessions = await db
      .select({
        id: analyticsSessions.id,
        displayName: analyticsSessions.displayName,
        platform: analyticsSessions.platform,
        startedAt: analyticsSessions.startedAt,
        endedAt: analyticsSessions.endedAt,
      })
      .from(analyticsSessions)
      .where(and(eq(analyticsSessions.sceneId, sceneId), gte(analyticsSessions.startedAt, since)))
      .orderBy(desc(analyticsSessions.startedAt))
      .limit(50)
    return reply.send({ visitors, actions, activeSessions: active, recentSessions })
  })

  app.get<{ Params: { sceneId: string }; Querystring: { limit?: string; offset?: string } }>(
    '/api/analytics/scenes/:sceneId/sessions',
    async (request, reply) => {
      const found = await locate(request, request.params.sceneId)
      if (!found.allowed) return reply.status(403).send({ error: 'Forbidden' })
      if (!found.scene) return reply.send({ sessions: [] })
      const limit = Math.min(Math.max(parseInt(request.query.limit || '50', 10) || 50, 1), 200)
      const offset = Math.max(parseInt(request.query.offset || '0', 10) || 0, 0)
      const rows = await db
        .select()
        .from(analyticsSessions)
        .where(eq(analyticsSessions.sceneId, found.scene.id))
        .orderBy(desc(analyticsSessions.startedAt))
        .limit(limit)
        .offset(offset)
      const ids = rows.map((r) => r.id)
      const events = ids.length
        ? await db
            .select()
            .from(analyticsEvents)
            .where(inArray(analyticsEvents.sessionId, ids))
            .orderBy(analyticsEvents.occurredAt)
            .limit(ids.length * 100)
        : []
      const bySession = new Map<string, typeof events>()
      for (const e of events) bySession.set(e.sessionId, [...(bySession.get(e.sessionId) ?? []), e])
      const sessions = rows.map((r) => ({
        ...r,
        actions: (bySession.get(r.id) ?? []).map((e) => ({
          name: e.type === 'custom' ? (e.data as { name?: string } | null)?.name ?? 'custom' : e.type,
          metadata: e.data,
          createdAt: e.occurredAt,
        })),
      }))
      return reply.send({ sessions })
    },
  )
}
```

- [ ] **Step 7: Run tests and typecheck**

Run: `cd apps/server && pnpm test && pnpm typecheck`
Expected: all PASS (existing 88 + new).

- [ ] **Step 8: Commit**

```bash
git add apps/server
git commit -m "feat(analytics): new analytics schema, read access rules and compat endpoints"
```

---

### Task 6: Decentraland directory and scene registry

**Files:**
- Create: `apps/server/src/analytics/dcl-directory.ts`, `apps/server/src/analytics/registry.ts`, `apps/server/test/helpers/fake-dcl.ts`, `apps/server/test/analytics-registry.test.ts`
- Modify: `apps/server/src/config.ts`

**Interfaces:**
- Consumes: `locationKeyFor`, `AnalyticsSceneRef` (Task 1); `analyticsScenes` (Task 5).
- Produces:
  - `interface DclDirectory { getActiveSceneAt(parcel: string): Promise<ActiveScene | null>; getActiveDeployer(parcel: string): Promise<string | null>; getWorldScene(name: string): Promise<{ sceneUrns: string[]; title?: string } | null>; getParcelRights(parcel: string): Promise<ParcelRights | null>; getWorldOwner(name: string): Promise<string | null> }` with `ActiveScene = { entityId: string; base: string; parcels: string[]; title?: string }`, `ParcelRights = { owner: string | null; operator: string | null; updateOperator: string | null; updateManagers: string[]; approvedForAll: string[] }`. All addresses lowercased. Network/5xx/timeout → throws `DirectoryUnavailableError`.
  - `getDclDirectory(): DclDirectory`, `setDclDirectory(d: DclDirectory | null): void`, `class DirectoryUnavailableError extends Error`.
  - `resolveAnalyticsScene(ref: AnalyticsSceneRef, signer: string | null, now?: Date): Promise<ResolveResult>` with `ResolveResult = { ok: true; scene: AnalyticsSceneRow } | { ok: false; status: 422 | 503; error: 'unknown_scene' | 'upstream_unavailable' }`; `clearRegistryCache(): void`.
  - Test helper `FakeDclDirectory` with public maps `scenes`, `deployers`, `worlds`, `rights`, `worldOwners`, `down: boolean`, `calls: number`.
  - `config.catalystUrl`, `config.worldsUrl`.

- [ ] **Step 1: Config** — add to `apps/server/src/config.ts`:

```ts
  // ── Decentraland directory (analytics scene validation & claims) ───────
  catalystUrl: env('DCL_CATALYST_URL') || 'https://peer.decentraland.org',
  worldsUrl: env('DCL_WORLDS_URL') || 'https://worlds-content-server.decentraland.org',
```

- [ ] **Step 2: Fake directory `apps/server/test/helpers/fake-dcl.ts`**

```ts
import { DirectoryUnavailableError, type ActiveScene, type DclDirectory, type ParcelRights } from '../../src/analytics/dcl-directory.js'

export class FakeDclDirectory implements DclDirectory {
  scenes = new Map<string, ActiveScene>() // every parcel → its active scene
  deployers = new Map<string, string>()
  worlds = new Map<string, { sceneUrns: string[]; title?: string }>()
  rights = new Map<string, ParcelRights>()
  worldOwners = new Map<string, string>()
  down = false
  calls = 0

  private hit() {
    this.calls++
    if (this.down) throw new DirectoryUnavailableError('fake directory down')
  }

  /** Register a scene across its parcels. */
  addScene(scene: ActiveScene, deployer?: string) {
    for (const p of scene.parcels) {
      this.scenes.set(p, scene)
      if (deployer) this.deployers.set(p, deployer.toLowerCase())
    }
  }

  async getActiveSceneAt(parcel: string) { this.hit(); return this.scenes.get(parcel) ?? null }
  async getActiveDeployer(parcel: string) { this.hit(); return this.deployers.get(parcel) ?? null }
  async getWorldScene(name: string) { this.hit(); return this.worlds.get(name.toLowerCase()) ?? null }
  async getParcelRights(parcel: string) { this.hit(); return this.rights.get(parcel) ?? null }
  async getWorldOwner(name: string) { this.hit(); return this.worldOwners.get(name.toLowerCase()) ?? null }
}
```

- [ ] **Step 3: Write the failing test `apps/server/test/analytics-registry.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { analyticsScenes } from '../src/db/schema.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { resolveAnalyticsScene, clearRegistryCache } from '../src/analytics/registry.js'
import { resetDb } from './helpers/db.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'

const gc = (extra = {}) => ({ realm: 'main', isWorld: false, isPreview: false, baseParcel: '10,10', parcels: ['10,10', '10,11'], ...extra })

describe('resolveAnalyticsScene', () => {
  let dir: FakeDclDirectory
  beforeEach(async () => {
    await resetDb()
    clearRegistryCache()
    dir = new FakeDclDirectory()
    setDclDirectory(dir)
  })
  afterEach(() => setDclDirectory(null))

  it('registers a deployed Genesis City scene on first sight with a fresh salt', async () => {
    dir.addScene({ entityId: 'bafyA', base: '10,10', parcels: ['10,10', '10,11'], title: 'Caldera' })
    const r = await resolveAnalyticsScene(gc({ entityId: 'bafyA' }), null)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scene).toMatchObject({ locationKey: 'gc:10,10', kind: 'parcels', activeEntityId: 'bafyA', title: 'Caldera' })
    expect(r.scene.salt).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a location with no scene, a wrong base, or parcels outside the scene', async () => {
    expect(await resolveAnalyticsScene(gc(), null)).toMatchObject({ ok: false, status: 422 })
    clearRegistryCache()
    dir.addScene({ entityId: 'bafyA', base: '10,11', parcels: ['10,10', '10,11'] })
    expect(await resolveAnalyticsScene(gc(), null)).toMatchObject({ ok: false, status: 422 })
    clearRegistryCache()
    dir.addScene({ entityId: 'bafyA', base: '10,10', parcels: ['10,10'] })
    expect(await resolveAnalyticsScene(gc(), null)).toMatchObject({ ok: false, status: 422 })
  })

  it('caches results for 10 minutes', async () => {
    dir.addScene({ entityId: 'bafyA', base: '10,10', parcels: ['10,10', '10,11'] })
    await resolveAnalyticsScene(gc(), null)
    const after = dir.calls
    await resolveAnalyticsScene(gc(), null)
    expect(dir.calls).toBe(after)
    await resolveAnalyticsScene(gc(), null, new Date(Date.now() + 11 * 60_000))
    expect(dir.calls).toBeGreaterThan(after)
  })

  it('redeploy: the old entity id is rejected, the new one accepted, same location row', async () => {
    dir.addScene({ entityId: 'bafyA', base: '10,10', parcels: ['10,10', '10,11'] })
    const first = await resolveAnalyticsScene(gc({ entityId: 'bafyA' }), null)
    dir.addScene({ entityId: 'bafyB', base: '10,10', parcels: ['10,10', '10,11'] })
    const stale = await resolveAnalyticsScene(gc({ entityId: 'bafyA' }), null, new Date(Date.now() + 11 * 60_000))
    expect(stale).toMatchObject({ ok: false, status: 422 })
    const fresh = await resolveAnalyticsScene(gc({ entityId: 'bafyB' }), null, new Date(Date.now() + 11 * 60_000))
    expect(fresh.ok && first.ok && fresh.scene.id === first.scene.id).toBe(true)
    expect(fresh.ok && fresh.scene.activeEntityId).toBe('bafyB')
  })

  it('upstream down: known scene accepted stale, unknown scene 503', async () => {
    dir.addScene({ entityId: 'bafyA', base: '10,10', parcels: ['10,10', '10,11'] })
    await resolveAnalyticsScene(gc(), null)
    dir.down = true
    expect((await resolveAnalyticsScene(gc(), null, new Date(Date.now() + 11 * 60_000))).ok).toBe(true)
    expect(await resolveAnalyticsScene(gc({ baseParcel: '50,50', parcels: ['50,50'] }), null)).toMatchObject({ ok: false, status: 503, error: 'upstream_unavailable' })
  })

  it('worlds: validated by the worlds server, keyed by lowercased name', async () => {
    dir.worlds.set('foo.dcl.eth', { sceneUrns: ['urn:decentraland:entity:bafyW?=&baseUrl=x'], title: 'Foo' })
    const r = await resolveAnalyticsScene({ realm: 'Foo.dcl.eth', isWorld: true, isPreview: false, worldName: 'Foo.dcl.eth', entityId: 'bafyW' }, null)
    expect(r.ok && r.scene.locationKey).toBe('world:foo.dcl.eth')
    expect(await resolveAnalyticsScene({ realm: 'nope.dcl.eth', isWorld: true, isPreview: false, worldName: 'nope.dcl.eth' }, null)).toMatchObject({ ok: false, status: 422 })
  })

  it('preview scenes skip validation and are keyed by signer', async () => {
    dir.down = true
    const r = await resolveAnalyticsScene({ realm: 'localhost', isWorld: false, isPreview: true, baseParcel: '0,0' }, '0xabc')
    expect(r.ok && r.scene).toMatchObject({ locationKey: 'preview:0xabc:0,0', kind: 'preview', isPreview: true })
  })

  it('concurrent first sightings create one row', async () => {
    dir.addScene({ entityId: 'bafyA', base: '10,10', parcels: ['10,10', '10,11'] })
    await Promise.all([resolveAnalyticsScene(gc(), null), resolveAnalyticsScene(gc(), null)])
    expect(await db.select().from(analyticsScenes).where(eq(analyticsScenes.locationKey, 'gc:10,10'))).toHaveLength(1)
  })
})
```

- [ ] **Step 4: Run to verify failure**

Run: `cd apps/server && pnpm test test/analytics-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Create `apps/server/src/analytics/dcl-directory.ts`**

```ts
import { config } from '../config.js'

export interface ActiveScene {
  entityId: string
  base: string
  parcels: string[]
  title?: string
}

export interface ParcelRights {
  owner: string | null
  operator: string | null
  updateOperator: string | null
  updateManagers: string[]
  approvedForAll: string[]
}

export interface DclDirectory {
  getActiveSceneAt(parcel: string): Promise<ActiveScene | null>
  getActiveDeployer(parcel: string): Promise<string | null>
  getWorldScene(name: string): Promise<{ sceneUrns: string[]; title?: string } | null>
  getParcelRights(parcel: string): Promise<ParcelRights | null>
  getWorldOwner(name: string): Promise<string | null>
}

export class DirectoryUnavailableError extends Error {}

const TIMEOUT_MS = 3_000
const lower = (v: unknown) => (typeof v === 'string' && v ? v.toLowerCase() : null)
const lowerList = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x: string) => x.toLowerCase()) : [])

async function getJson(url: string, init?: RequestInit): Promise<unknown | null> {
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (err) {
    throw new DirectoryUnavailableError(`${url}: ${(err as Error).message}`)
  }
  if (res.status === 404) return null
  if (res.status >= 500) throw new DirectoryUnavailableError(`${url}: HTTP ${res.status}`)
  if (!res.ok) return null
  return res.json()
}

export class HttpDclDirectory implements DclDirectory {
  constructor(private catalyst = config.catalystUrl, private worlds = config.worldsUrl) {}

  async getActiveSceneAt(parcel: string): Promise<ActiveScene | null> {
    const body = (await getJson(`${this.catalyst}/content/entities/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pointers: [parcel] }),
    })) as Array<{ id: string; metadata?: { scene?: { base?: string; parcels?: string[] }; display?: { title?: string } } }> | null
    const e = body?.[0]
    if (!e?.metadata?.scene?.base) return null
    return { entityId: e.id, base: e.metadata.scene.base, parcels: e.metadata.scene.parcels ?? [], title: e.metadata.display?.title }
  }

  async getActiveDeployer(parcel: string): Promise<string | null> {
    const q = new URLSearchParams({ pointer: parcel, onlyCurrentlyPointed: 'true', limit: '1' })
    const body = (await getJson(`${this.catalyst}/content/deployments?${q}`)) as { deployments?: Array<{ deployedBy?: string }> } | null
    return lower(body?.deployments?.[0]?.deployedBy)
  }

  async getWorldScene(name: string) {
    const body = (await getJson(`${this.worlds}/world/${encodeURIComponent(name.toLowerCase())}/about`)) as {
      configurations?: { scenesUrn?: string[] }
    } | null
    const urns = body?.configurations?.scenesUrn ?? []
    return urns.length ? { sceneUrns: urns } : null
  }

  async getParcelRights(parcel: string): Promise<ParcelRights | null> {
    const [x, y] = parcel.split(',')
    const body = (await getJson(`${this.catalyst}/lambdas/parcels/${x}/${y}/operators`)) as Record<string, unknown> | null
    if (!body) return null
    return {
      owner: lower(body.owner),
      operator: lower(body.operator),
      updateOperator: lower(body.updateOperator),
      updateManagers: lowerList(body.updateManagers),
      approvedForAll: lowerList(body.approvedForAll),
    }
  }

  async getWorldOwner(name: string): Promise<string | null> {
    const body = (await getJson(`${this.worlds}/world/${encodeURIComponent(name.toLowerCase())}/permissions`)) as { owner?: string } | null
    return lower(body?.owner)
  }
}

let current: DclDirectory | null = null

export function getDclDirectory(): DclDirectory {
  if (!current) current = new HttpDclDirectory()
  return current
}

/** Tests inject a fake; pass null to restore the HTTP implementation. */
export function setDclDirectory(d: DclDirectory | null): void {
  current = d
}
```

- [ ] **Step 6: Create `apps/server/src/analytics/registry.ts`**

```ts
import { randomBytes } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { locationKeyFor, type AnalyticsSceneRef } from 'vlm-shared'
import { db } from '../db/connection.js'
import { analyticsScenes } from '../db/schema.js'
import { DirectoryUnavailableError, getDclDirectory } from './dcl-directory.js'

export type AnalyticsSceneRow = typeof analyticsScenes.$inferSelect
export type ResolveResult =
  | { ok: true; scene: AnalyticsSceneRow }
  | { ok: false; status: 422 | 503; error: 'unknown_scene' | 'upstream_unavailable' }

const CACHE_MS = 10 * 60_000
// Positive results per location; negative results per location + claimed entity id, so a stale
// deployment's rejections never block batches from the new deployment at the same location.
const positive = new Map<string, { at: number; entityId: string | null }>()
const negative = new Map<string, number>()

export function clearRegistryCache(): void {
  positive.clear()
  negative.clear()
}

interface Validated {
  entityId: string | null
  parcels: string[]
  title?: string
}

async function validate(ref: AnalyticsSceneRef): Promise<Validated | null> {
  const dir = getDclDirectory()
  if (ref.isWorld) {
    const w = await dir.getWorldScene(ref.worldName!)
    if (!w) return null
    if (ref.entityId && !w.sceneUrns.some((u) => u.includes(ref.entityId!))) return null
    return { entityId: ref.entityId ?? null, parcels: ref.parcels ?? [], title: ref.title ?? w.title }
  }
  const active = await dir.getActiveSceneAt(ref.baseParcel!)
  if (!active || active.base !== ref.baseParcel) return null
  if (ref.parcels && !ref.parcels.every((p) => active.parcels.includes(p))) return null
  if (ref.entityId && ref.entityId !== active.entityId) return null
  return { entityId: active.entityId, parcels: active.parcels, title: active.title ?? ref.title }
}

async function upsert(key: string, ref: AnalyticsSceneRef, v: Validated, now: Date): Promise<AnalyticsSceneRow> {
  const [row] = await db
    .insert(analyticsScenes)
    .values({
      kind: ref.isPreview ? 'preview' : ref.isWorld ? 'world' : 'parcels',
      locationKey: key,
      realm: ref.realm,
      baseParcel: ref.baseParcel ?? null,
      parcels: v.parcels,
      worldName: ref.isWorld ? ref.worldName!.toLowerCase() : null,
      activeEntityId: v.entityId,
      title: v.title ?? null,
      salt: randomBytes(32).toString('hex'),
      isPreview: ref.isPreview,
      lastEntityCheckAt: now,
    })
    .onConflictDoUpdate({
      target: analyticsScenes.locationKey,
      set: {
        realm: ref.realm,
        parcels: v.parcels,
        activeEntityId: sql`coalesce(${v.entityId}, ${analyticsScenes.activeEntityId})`,
        title: sql`coalesce(${v.title ?? null}, ${analyticsScenes.title})`,
        lastEntityCheckAt: now,
        updatedAt: now,
      },
    })
    .returning()
  return row
}

export async function resolveAnalyticsScene(ref: AnalyticsSceneRef, signer: string | null, now = new Date()): Promise<ResolveResult> {
  const key = locationKeyFor(ref, signer)
  if (ref.isPreview) {
    return { ok: true, scene: await upsert(key, ref, { entityId: ref.entityId ?? null, parcels: ref.parcels ?? [], title: ref.title }, now) }
  }
  const negKey = `${key}|${ref.entityId ?? ''}`
  const rejectedAt = negative.get(negKey)
  if (rejectedAt !== undefined && now.getTime() - rejectedAt < CACHE_MS) return { ok: false, status: 422, error: 'unknown_scene' }
  const row = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, key) })
  const cached = positive.get(key)
  const fresh = cached && now.getTime() - cached.at < CACHE_MS
  if (fresh && row && (!ref.entityId || ref.entityId === cached!.entityId)) return { ok: true, scene: row }

  let v: Validated | null
  try {
    v = await validate(ref)
  } catch (err) {
    if (err instanceof DirectoryUnavailableError && row) return { ok: true, scene: row }
    if (err instanceof DirectoryUnavailableError) return { ok: false, status: 503, error: 'upstream_unavailable' }
    throw err
  }
  if (!v) {
    negative.set(negKey, now.getTime())
    return { ok: false, status: 422, error: 'unknown_scene' }
  }
  const scene = await upsert(key, ref, v, now)
  positive.set(key, { at: now.getTime(), entityId: scene.activeEntityId })
  return { ok: true, scene }
}
```

- [ ] **Step 7: Run tests and typecheck**

Run: `cd apps/server && pnpm test test/analytics-registry.test.ts && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server
git commit -m "feat(analytics): Decentraland directory client and location-keyed scene registry"
```

---

### Task 7: Ingest rate limiter and country lookup

**Files:**
- Create: `apps/server/src/analytics/limiter.ts`, `apps/server/src/analytics/country.ts`, `apps/server/test/analytics-limiter.test.ts`
- Modify: `apps/server/package.json` (add `maxmind`), `.env.example`

**Interfaces:**
- Produces:
  - `class TokenBucketLimiter { constructor(now?: () => number); take(key: string, cost: number, capacity: number, refillPerSec: number): { ok: boolean; retryAfterMs: number; available: number }; sweep(): void }`
  - `INGEST_LIMITS` constants; `checkIngestLimits(l: TokenBucketLimiter, input: { requesterKey: string; verified: boolean; sceneId: string; isPreview: boolean; eventCount: number; posCount: number; dayKey: string }): { ok: true; keepPosProbability: number } | { ok: false; retryAfterMs: number }`
  - `interface CountryLookup { lookup(ip: string, headers: Record<string, string | string[] | undefined>): string | null }`, `createCountryLookup(dbPath?: string): Promise<CountryLookup>`

- [ ] **Step 1: Add the mmdb reader**

```bash
cd apps/server && pnpm add maxmind@^4
git diff -- ../../pnpm-lock.yaml | grep -E '^[-+] .*@dcl/'   # must print nothing
```

- [ ] **Step 2: Write the failing test `apps/server/test/analytics-limiter.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { TokenBucketLimiter, checkIngestLimits } from '../src/analytics/limiter.js'
import { createCountryLookup } from '../src/analytics/country.js'

function limiter() {
  let now = 0
  const l = new TokenBucketLimiter(() => now)
  return { l, advance: (ms: number) => (now += ms) }
}

const input = (o: Partial<Parameters<typeof checkIngestLimits>[1]> = {}) => ({
  requesterKey: 'w:0xabc',
  verified: true,
  sceneId: 's1',
  isPreview: false,
  eventCount: 10,
  posCount: 5,
  dayKey: '2026-10-04',
  ...o,
})

describe('ingest limits', () => {
  it('allows a burst of 3 requests then one per 2 s', () => {
    const { l, advance } = limiter()
    for (let i = 0; i < 3; i++) expect(checkIngestLimits(l, input()).ok).toBe(true)
    const r = checkIngestLimits(l, input())
    expect(r.ok).toBe(false)
    expect(!r.ok && r.retryAfterMs).toBeGreaterThan(0)
    advance(2_000)
    expect(checkIngestLimits(l, input()).ok).toBe(true)
  })

  it('caps a verified signer at 200 events per minute', () => {
    const { l, advance } = limiter()
    expect(checkIngestLimits(l, input({ eventCount: 100 })).ok).toBe(true)
    advance(2_000)
    expect(checkIngestLimits(l, input({ eventCount: 100 })).ok).toBe(true)
    advance(2_000)
    expect(checkIngestLimits(l, input({ eventCount: 100 })).ok).toBe(false)
  })

  it('caps an unverified IP at 60 events per minute', () => {
    const { l } = limiter()
    expect(checkIngestLimits(l, input({ verified: false, requesterKey: 'ip:1.2.3.4', eventCount: 60 })).ok).toBe(true)
    expect(checkIngestLimits(l, input({ verified: false, requesterKey: 'ip:1.2.3.4', eventCount: 1 })).ok).toBe(false)
  })

  it('samples positions once a scene passes 5,000 events per minute, never other events', () => {
    const { l } = limiter()
    for (let i = 0; i < 50; i++) checkIngestLimits(l, input({ requesterKey: `w:${i}`, eventCount: 100, posCount: 90 }))
    const r = checkIngestLimits(l, input({ requesterKey: 'w:new', eventCount: 100, posCount: 90 }))
    expect(r.ok).toBe(true)
    expect(r.ok && r.keepPosProbability).toBeLessThan(1)
    expect(r.ok && r.keepPosProbability).toBeGreaterThan(0)
  })

  it('caps preview scenes at 10,000 events per day', () => {
    const { l, advance } = limiter()
    let accepted = 0
    for (let i = 0; i < 120; i++) {
      advance(2_000)
      const r = checkIngestLimits(l, input({ requesterKey: `w:${i}`, isPreview: true, eventCount: 100, posCount: 0 }))
      if (r.ok) accepted += 100
    }
    expect(accepted).toBe(10_000)
  })
})

describe('country lookup', () => {
  it('uses the cf-ipcountry header and ignores unknown codes', async () => {
    const c = await createCountryLookup(undefined)
    expect(c.lookup('1.2.3.4', { 'cf-ipcountry': 'de' })).toBe('DE')
    expect(c.lookup('1.2.3.4', { 'cf-ipcountry': 'XX' })).toBeNull()
    expect(c.lookup('1.2.3.4', {})).toBeNull()
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/server && pnpm test test/analytics-limiter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Create `apps/server/src/analytics/limiter.ts`**

```ts
interface Bucket {
  tokens: number
  at: number
  capacity: number
}

export class TokenBucketLimiter {
  private buckets = new Map<string, Bucket>()
  private counters = new Map<string, number>()

  constructor(private now: () => number = Date.now) {}

  private refill(key: string, capacity: number, refillPerSec: number): Bucket {
    const t = this.now()
    const b = this.buckets.get(key) ?? { tokens: capacity, at: t, capacity }
    b.tokens = Math.min(capacity, b.tokens + ((t - b.at) / 1000) * refillPerSec)
    b.at = t
    this.buckets.set(key, b)
    return b
  }

  peek(key: string, capacity: number, refillPerSec: number): number {
    return this.refill(key, capacity, refillPerSec).tokens
  }

  take(key: string, cost: number, capacity: number, refillPerSec: number): { ok: boolean; retryAfterMs: number; available: number } {
    const b = this.refill(key, capacity, refillPerSec)
    if (b.tokens >= cost) {
      b.tokens -= cost
      return { ok: true, retryAfterMs: 0, available: b.tokens }
    }
    return { ok: false, retryAfterMs: Math.ceil(((cost - b.tokens) / refillPerSec) * 1000), available: b.tokens }
  }

  /** Increment a plain counter (e.g. per-day caps) and return the new value. */
  count(key: string, by: number): number {
    const v = (this.counters.get(key) ?? 0) + by
    this.counters.set(key, v)
    return v
  }

  counter(key: string): number {
    return this.counters.get(key) ?? 0
  }

  /** Drop full buckets and old counters so memory stays bounded. */
  sweep(today?: string): void {
    for (const [k, b] of this.buckets) if (b.tokens >= b.capacity) this.buckets.delete(k)
    if (today) for (const k of this.counters.keys()) if (!k.endsWith(today)) this.counters.delete(k)
  }
}

export const INGEST_LIMITS = {
  request: { capacity: 3, refillPerSec: 0.5 },
  signerEvents: { capacity: 200, refillPerSec: 200 / 60 },
  unverifiedEvents: { capacity: 60, refillPerSec: 1 },
  sceneEvents: { capacity: 5_000, refillPerSec: 5_000 / 60 },
  previewDaily: 10_000,
} as const

export function checkIngestLimits(
  l: TokenBucketLimiter,
  i: { requesterKey: string; verified: boolean; sceneId: string; isPreview: boolean; eventCount: number; posCount: number; dayKey: string },
): { ok: true; keepPosProbability: number } | { ok: false; retryAfterMs: number } {
  const req = l.take(`req:${i.requesterKey}`, 1, INGEST_LIMITS.request.capacity, INGEST_LIMITS.request.refillPerSec)
  if (!req.ok) return { ok: false, retryAfterMs: req.retryAfterMs }

  const ev = i.verified ? INGEST_LIMITS.signerEvents : INGEST_LIMITS.unverifiedEvents
  const evs = l.take(`ev:${i.requesterKey}`, i.eventCount, ev.capacity, ev.refillPerSec)
  if (!evs.ok) return { ok: false, retryAfterMs: evs.retryAfterMs }

  if (i.isPreview) {
    const dayKey = `preview:${i.sceneId}:${i.dayKey}`
    if (l.counter(dayKey) + i.eventCount > INGEST_LIMITS.previewDaily) return { ok: false, retryAfterMs: 3_600_000 }
    l.count(dayKey, i.eventCount)
    return { ok: true, keepPosProbability: 1 }
  }

  const sceneKey = `scene:${i.sceneId}`
  const { capacity, refillPerSec } = INGEST_LIMITS.sceneEvents
  const available = l.peek(sceneKey, capacity, refillPerSec)
  if (available >= i.eventCount) {
    l.take(sceneKey, i.eventCount, capacity, refillPerSec)
    return { ok: true, keepPosProbability: 1 }
  }
  // Over the scene budget: keep every non-position event, sample positions with what's left.
  const nonPos = i.eventCount - i.posCount
  const spare = Math.max(0, available - nonPos)
  l.take(sceneKey, Math.min(available, i.eventCount), capacity, refillPerSec)
  const keep = i.posCount > 0 ? Math.max(0.05, Math.min(1, spare / i.posCount)) : 1
  return { ok: true, keepPosProbability: keep }
}
```

The burst test sends 3 requests at t=0. The 4th fails because the request bucket (capacity 3) is empty. Two seconds later it holds 1 token.

- [ ] **Step 5: Create `apps/server/src/analytics/country.ts`**

```ts
export interface CountryLookup {
  lookup(ip: string, headers: Record<string, string | string[] | undefined>): string | null
}

const VALID = /^[A-Z]{2}$/
const UNKNOWN = new Set(['XX', 'T1', 'ZZ'])

function normalize(code: unknown): string | null {
  if (typeof code !== 'string') return null
  const c = code.toUpperCase()
  return VALID.test(c) && !UNKNOWN.has(c) ? c : null
}

/**
 * Country from a CDN header (Cloudflare `cf-ipcountry`) or, when GEOIP_COUNTRY_DB_PATH points at an
 * mmdb country database (e.g. DB-IP Lite, CC-BY 4.0), from the IP. The IP itself is never kept.
 */
export async function createCountryLookup(dbPath: string | undefined = process.env.GEOIP_COUNTRY_DB_PATH): Promise<CountryLookup> {
  let reader: { get(ip: string): { country?: { iso_code?: string } } | null } | null = null
  if (dbPath) {
    try {
      const maxmind = await import('maxmind')
      reader = await maxmind.open(dbPath)
    } catch (err) {
      console.warn('[vlm-server] Country database could not be opened; countries will be header-only:', (err as Error).message)
    }
  }
  return {
    lookup(ip, headers) {
      const header = headers['cf-ipcountry']
      const fromHeader = normalize(Array.isArray(header) ? header[0] : header)
      if (fromHeader) return fromHeader
      if (!reader) return null
      try {
        return normalize(reader.get(ip)?.country?.iso_code)
      } catch {
        return null
      }
    },
  }
}
```

Add to `.env.example`, under an "Analytics" heading:

```
# Optional country database for analytics (mmdb, e.g. DB-IP Lite "dbip-country-lite" — CC-BY 4.0,
# attribution required). Without it, countries come only from a CDN header such as cf-ipcountry.
# GEOIP_COUNTRY_DB_PATH=/data/dbip-country-lite.mmdb
```

- [ ] **Step 6: Run tests and typecheck**

Run: `cd apps/server && pnpm test test/analytics-limiter.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server pnpm-lock.yaml .env.example
git commit -m "feat(analytics): ingest token-bucket limits and country lookup"
```

---

### Task 8: Ingest endpoint and writer

**Files:**
- Create: `apps/server/src/analytics/hash.ts`, `apps/server/src/analytics/writer.ts`, `apps/server/src/routes/ingest.ts`, `apps/server/test/analytics-ingest.test.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: `checkBatch`, `IngestBatch` (Task 1); `resolveAnalyticsScene` (Task 6); `TokenBucketLimiter`, `checkIngestLimits`, `createCountryLookup` (Task 7); `verifyDclSignedFetch`, `hasDclAuthHeaders` (`src/middleware/dcl-auth.ts`); schema (Task 5).
- Produces:
  - `visitorHash(saltHex: string, visitorId: string): string`
  - `writeBatch(input: { scene: AnalyticsSceneRow; batch: IngestBatch; verified: boolean; country: string | null; keepPosProbability: number; random?: () => number }): Promise<{ accepted: number }>`; throws `SessionSceneMismatchError` when the session id already belongs to another scene.
  - `POST /api/ingest` → `200 { ok: true, accepted, notice }`, `400 { error }`, `409 { error: 'session_scene_mismatch' }`, `422 { error: 'unknown_scene' }`, `429 { error: 'rate_limited', retryAfter }`, `503 { error: 'upstream_unavailable', retryAfter: 30 }`.
  - `setIngestLimiter(l: TokenBucketLimiter)` (test hook) exported from `routes/ingest.ts`.

- [ ] **Step 1: Write the failing test `apps/server/test/analytics-ingest.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { analyticsEvents, analyticsPositions, analyticsSessions, analyticsScenes, analyticsDirtyHours } from '../src/db/schema.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { clearRegistryCache } from '../src/analytics/registry.js'
import { visitorHash } from '../src/analytics/hash.js'
import { TokenBucketLimiter } from '../src/analytics/limiter.js'
import { setIngestLimiter } from '../src/routes/ingest.js'
import { resetDb } from './helpers/db.js'
import { testApp } from './helpers/factories.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'

vi.mock('../src/middleware/dcl-auth.js', () => ({
  hasDclAuthHeaders: (h: Record<string, unknown>) => !!h['x-identity-auth-chain-0'],
  verifyDclSignedFetch: async (_m: string, _p: string, h: Record<string, string>) => {
    const v = h['x-identity-auth-chain-0']
    if (typeof v === 'string' && v.startsWith('valid:')) return { walletAddress: v.slice(6), metadata: {} }
    throw new Error('bad signature')
  },
}))

const WALLET = '0x00000000000000000000000000000000000000aa'
const SID = '22222222-2222-4222-8222-222222222222'
const signed = (w = WALLET) => ({ 'x-identity-auth-chain-0': `valid:${w}` })

function batch(o: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    v: 1,
    sessionId: SID,
    visitorId: WALLET,
    isGuest: false,
    noticeShown: false,
    scene: { realm: 'main', isWorld: false, isPreview: false, baseParcel: '10,10', parcels: ['10,10'], entityId: 'bafyA' },
    events: [
      { t: now - 3000, type: 'session.start', seq: 0, data: { platform: 'decentraland', device: 'desktop', realm: 'main', cameraMode: 'third', isGuest: false } },
      { t: now - 2000, type: 'pos', seq: 1, data: { x: 3.2, y: 0, z: 4.1, ry: 90, m: true } },
      { t: now - 1000, type: 'interact', seq: 2, data: { kind: 'click', target: 'door' } },
    ],
    ...o,
  }
}

describe('POST /api/ingest', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let dir: FakeDclDirectory
  beforeEach(async () => {
    await resetDb()
    clearRegistryCache()
    setIngestLimiter(new TokenBucketLimiter())
    dir = new FakeDclDirectory()
    dir.addScene({ entityId: 'bafyA', base: '10,10', parcels: ['10,10'], title: 'Caldera' })
    setDclDirectory(dir)
    app = await testApp()
  })
  afterEach(async () => {
    setDclDirectory(null)
    await app.close()
  })

  const post = (body: unknown, headers: Record<string, string> = signed()) =>
    app.inject({ method: 'POST', url: '/api/ingest', payload: body as any, headers })

  it('stores a verified batch: session, events, positions, dirty hours, hashed identity only', async () => {
    const res = await post(batch())
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, accepted: 3, notice: false })
    const scene = (await db.select().from(analyticsScenes))[0]
    const [session] = await db.select().from(analyticsSessions)
    expect(session).toMatchObject({ id: SID, sceneId: scene.id, verified: true, isGuest: false, platform: 'decentraland', device: 'desktop', cameraMode: 'third', eventCount: 3, wallet: null, displayName: null, isReturning: false })
    expect(session.visitorHash).toBe(visitorHash(scene.salt, WALLET))
    expect(await db.select().from(analyticsEvents)).toHaveLength(2) // session.start + interact
    const [p] = await db.select().from(analyticsPositions)
    expect(p).toMatchObject({ x: 3.2, z: 4.1, heading: 90, moving: true })
    expect((await db.select().from(analyticsDirtyHours)).length).toBeGreaterThanOrEqual(1)
  })

  it('retrying the same batch does not double count', async () => {
    await post(batch())
    const again = await post(batch())
    expect(again.statusCode).toBe(200)
    expect(again.json().accepted).toBe(0)
    const [session] = await db.select().from(analyticsSessions)
    expect(session.eventCount).toBe(3)
    expect(await db.select().from(analyticsEvents)).toHaveLength(2)
  })

  it('unsigned batches are stored as unverified', async () => {
    const res = await post(batch(), {})
    expect(res.statusCode).toBe(200)
    expect((await db.select().from(analyticsSessions))[0].verified).toBe(false)
  })

  it('a signer that does not match visitorId is rejected', async () => {
    expect((await post(batch(), signed('0x00000000000000000000000000000000000000bb'))).statusCode).toBe(400)
  })

  it('bad shape → 400, unknown scene → 422, directory down for a new scene → 503', async () => {
    expect((await post({ v: 1 })).statusCode).toBe(400)
    expect((await post(batch({ scene: { realm: 'main', isWorld: false, isPreview: false, baseParcel: '99,99' } }))).statusCode).toBe(422)
    dir.down = true
    const r = await post(batch({ scene: { realm: 'main', isWorld: false, isPreview: false, baseParcel: '77,77' } }))
    expect(r.statusCode).toBe(503)
    expect(r.json().retryAfter).toBe(30)
  })

  it('session.leave closes the session; later events reopen it', async () => {
    await post(batch())
    await post(batch({ events: [{ t: Date.now(), type: 'session.leave', seq: 3, data: { reason: 'left_parcels' } }] }))
    expect((await db.select().from(analyticsSessions))[0].endedAt).not.toBeNull()
    await post(batch({ events: [{ t: Date.now() + 1000, type: 'session.heartbeat', seq: 4, data: {} }] }))
    expect((await db.select().from(analyticsSessions))[0].endedAt).toBeNull()
  })

  it('a session id reused for another scene is rejected with 409', async () => {
    await post(batch())
    dir.addScene({ entityId: 'bafyC', base: '20,20', parcels: ['20,20'] })
    const r = await post(batch({ scene: { realm: 'main', isWorld: false, isPreview: false, baseParcel: '20,20', parcels: ['20,20'] }, events: [{ t: Date.now(), type: 'session.heartbeat', seq: 9, data: {} }] }))
    expect(r.statusCode).toBe(409)
  })

  it('marks returning visitors', async () => {
    await post(batch())
    await post(batch({ sessionId: '33333333-3333-4333-8333-333333333333' }))
    const rows = await db.select().from(analyticsSessions).where(eq(analyticsSessions.id, '33333333-3333-4333-8333-333333333333'))
    expect(rows[0].isReturning).toBe(true)
  })

  it('stores plain identity only when visibility is on, the notice was shown, and the visitor is not a guest', async () => {
    await post(batch())
    await db.update(analyticsScenes).set({ walletVisibility: true })
    const res = await post(batch({ sessionId: '44444444-4444-4444-8444-444444444444', noticeShown: true, displayName: 'Ana' }))
    expect(res.json().notice).toBe(true)
    const [s] = await db.select().from(analyticsSessions).where(eq(analyticsSessions.id, '44444444-4444-4444-8444-444444444444'))
    expect(s).toMatchObject({ wallet: WALLET, displayName: 'Ana' })
    await post(batch({ sessionId: '55555555-5555-4555-8555-555555555555', noticeShown: false, displayName: 'Ana' }))
    const [hidden] = await db.select().from(analyticsSessions).where(eq(analyticsSessions.id, '55555555-5555-4555-8555-555555555555'))
    expect(hidden).toMatchObject({ wallet: null, displayName: null })
  })

  it('rate limits with 429 and retryAfter', async () => {
    for (let i = 0; i < 3; i++) await post(batch({ sessionId: `6666666${i}-6666-4666-8666-666666666666` }))
    const r = await post(batch({ sessionId: '66666669-6666-4666-8666-666666666666' }))
    expect(r.statusCode).toBe(429)
    expect(r.json().retryAfter).toBeGreaterThan(0)
  })

  it('never stores the IP address', async () => {
    await post(batch(), { ...signed(), 'x-forwarded-for': '203.0.113.9' })
    const dump = JSON.stringify(await db.select().from(analyticsSessions)) + JSON.stringify(await db.select().from(analyticsEvents))
    expect(dump).not.toContain('203.0.113.9')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server && pnpm test test/analytics-ingest.test.ts`
Expected: FAIL — module not found / 404.

- [ ] **Step 3: Create `apps/server/src/analytics/hash.ts`**

```ts
import { createHmac } from 'node:crypto'

/** Per-scene pseudonymous visitor id: HMAC-SHA256(salt, lowercase(visitorId)), hex. */
export function visitorHash(saltHex: string, visitorId: string): string {
  return createHmac('sha256', Buffer.from(saltHex, 'hex')).update(visitorId.toLowerCase()).digest('hex')
}
```

- [ ] **Step 4: Create `apps/server/src/analytics/writer.ts`**

```ts
import { and, eq, ne, sql } from 'drizzle-orm'
import type { IngestBatch } from 'vlm-shared'
import { db } from '../db/connection.js'
import { analyticsDirtyHours, analyticsEvents, analyticsPositions, analyticsSessions } from '../db/schema.js'
import type { AnalyticsSceneRow } from './registry.js'
import { visitorHash } from './hash.js'

export class SessionSceneMismatchError extends Error {}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const text = (v: unknown, max = 64) => (typeof v === 'string' && v ? v.slice(0, max) : null)
const hourOf = (t: number) => new Date(Math.floor(t / 3_600_000) * 3_600_000)

export async function writeBatch(input: {
  scene: AnalyticsSceneRow
  batch: IngestBatch
  verified: boolean
  country: string | null
  keepPosProbability: number
  random?: () => number
}): Promise<{ accepted: number }> {
  const { scene, batch, verified, country, keepPosProbability } = input
  const random = input.random ?? Math.random
  const hash = visitorHash(scene.salt, batch.visitorId)
  const reveal = scene.walletVisibility && batch.noticeShown && !batch.isGuest
  const times = batch.events.map((e) => e.t)
  const startedAt = new Date(Math.min(...times))
  const lastSeenAt = new Date(Math.max(...times))
  const leave = batch.events.filter((e) => e.type === 'session.leave').map((e) => e.t)
  const start = batch.events.find((e) => e.type === 'session.start')?.data ?? {}

  const positions = batch.events
    .filter((e) => e.type === 'pos')
    .filter(() => keepPosProbability >= 1 || random() < keepPosProbability)
    .map((e) => ({ e, x: num(e.data?.x), y: num(e.data?.y), z: num(e.data?.z) }))
    .filter((p) => p.x !== null && p.y !== null && p.z !== null)
  const others = batch.events.filter((e) => e.type !== 'pos')

  return db.transaction(async (tx) => {
    const insertedEvents = others.length
      ? await tx
          .insert(analyticsEvents)
          .values(
            others.map((e) => ({
              sceneId: scene.id,
              sessionId: batch.sessionId,
              seq: e.seq,
              visitorHash: hash,
              type: e.type,
              occurredAt: new Date(e.t),
              verified,
              data: e.data ?? null,
            })),
          )
          .onConflictDoNothing()
          .returning({ id: analyticsEvents.id })
      : []
    const insertedPositions = positions.length
      ? await tx
          .insert(analyticsPositions)
          .values(
            positions.map(({ e, x, y, z }) => ({
              sceneId: scene.id,
              sessionId: batch.sessionId,
              seq: e.seq,
              occurredAt: new Date(e.t),
              x: x!,
              y: y!,
              z: z!,
              heading: Math.round(num(e.data?.ry) ?? 0) % 360,
              moving: e.data?.m === true,
            })),
          )
          .onConflictDoNothing()
          .returning({ id: analyticsPositions.id })
      : []
    const accepted = insertedEvents.length + insertedPositions.length

    const [prior] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(analyticsSessions)
      .where(and(eq(analyticsSessions.sceneId, scene.id), eq(analyticsSessions.visitorHash, hash), ne(analyticsSessions.id, batch.sessionId)))

    const endedAt = leave.length ? new Date(Math.max(...leave)) : null
    const upserted = await tx
      .insert(analyticsSessions)
      .values({
        id: batch.sessionId,
        sceneId: scene.id,
        visitorHash: hash,
        wallet: reveal ? batch.visitorId : null,
        displayName: reveal ? text(batch.displayName) : null,
        isGuest: batch.isGuest,
        verified,
        platform: text(start.platform),
        device: text(start.device),
        realm: text(start.realm, 200),
        country,
        cameraMode: text(start.cameraMode, 16),
        isReturning: prior.n > 0,
        startedAt,
        lastSeenAt,
        endedAt,
        durationSec: Math.round((lastSeenAt.getTime() - startedAt.getTime()) / 1000),
        eventCount: accepted,
      })
      .onConflictDoUpdate({
        target: analyticsSessions.id,
        set: {
          startedAt: sql`least(${analyticsSessions.startedAt}, excluded.started_at)`,
          lastSeenAt: sql`greatest(${analyticsSessions.lastSeenAt}, excluded.last_seen_at)`,
          endedAt: sql`case
            when excluded.ended_at is not null then excluded.ended_at
            when ${analyticsSessions.endedAt} is not null and excluded.last_seen_at > ${analyticsSessions.endedAt} then null
            else ${analyticsSessions.endedAt} end`,
          durationSec: sql`extract(epoch from (greatest(${analyticsSessions.lastSeenAt}, excluded.last_seen_at) - least(${analyticsSessions.startedAt}, excluded.started_at)))::int`,
          eventCount: sql`${analyticsSessions.eventCount} + excluded.event_count`,
          verified: sql`${analyticsSessions.verified} or excluded.verified`,
          wallet: sql`coalesce(excluded.wallet, ${analyticsSessions.wallet})`,
          displayName: sql`coalesce(excluded.display_name, ${analyticsSessions.displayName})`,
          platform: sql`coalesce(${analyticsSessions.platform}, excluded.platform)`,
          device: sql`coalesce(${analyticsSessions.device}, excluded.device)`,
          realm: sql`coalesce(${analyticsSessions.realm}, excluded.realm)`,
          country: sql`coalesce(${analyticsSessions.country}, excluded.country)`,
          cameraMode: sql`coalesce(excluded.camera_mode, ${analyticsSessions.cameraMode})`,
        },
        setWhere: sql`${analyticsSessions.sceneId} = excluded.scene_id`,
      })
      .returning({ id: analyticsSessions.id })
    if (upserted.length === 0) throw new SessionSceneMismatchError('session belongs to another scene')

    const hours = [...new Set(times.map((t) => hourOf(t).getTime()))].map((h) => ({ sceneId: scene.id, hour: new Date(h) }))
    await tx.insert(analyticsDirtyHours).values(hours).onConflictDoNothing()
    return { accepted }
  })
}
```

Note on `endedAt` with an out-of-order leave: a leave event retried after newer heartbeats can set `endedAt` earlier than `lastSeenAt`. That's acceptable: the session-close sweep treats `endedAt` as authoritative.

- [ ] **Step 5: Create `apps/server/src/routes/ingest.ts`**

```ts
import type { FastifyInstance } from 'fastify'
import { ANALYTICS_LIMITS, checkBatch } from 'vlm-shared'
import { hasDclAuthHeaders, verifyDclSignedFetch } from '../middleware/dcl-auth.js'
import { resolveAnalyticsScene } from '../analytics/registry.js'
import { TokenBucketLimiter, checkIngestLimits } from '../analytics/limiter.js'
import { createCountryLookup, type CountryLookup } from '../analytics/country.js'
import { writeBatch, SessionSceneMismatchError } from '../analytics/writer.js'

let limiter = new TokenBucketLimiter()
let sweepTimer: NodeJS.Timeout | null = null

/** Test hook. */
export function setIngestLimiter(l: TokenBucketLimiter): void {
  limiter = l
}

export default async function ingestRoutes(app: FastifyInstance) {
  const country: CountryLookup = await createCountryLookup()
  if (!sweepTimer) {
    sweepTimer = setInterval(() => limiter.sweep(new Date().toISOString().slice(0, 10)), 60_000)
    sweepTimer.unref()
  }

  app.post(
    '/api/ingest',
    {
      bodyLimit: ANALYTICS_LIMITS.maxBodyBytes,
      logLevel: 'warn', // keep per-request logs (which include the client IP) out of the logs
      config: { rateLimit: false },
    },
    async (request, reply) => {
      const checked = checkBatch(request.body, Date.now())
      if (!checked.ok) return reply.status(400).send({ error: checked.error })
      const { batch } = checked

      let signer: string | null = null
      const headers = request.headers as Record<string, string | string[] | undefined>
      if (hasDclAuthHeaders(headers)) {
        try {
          signer = (await verifyDclSignedFetch(request.method, request.url.split('?')[0], headers)).walletAddress.toLowerCase()
        } catch {
          signer = null
        }
      }
      if (signer && signer !== batch.visitorId.toLowerCase()) {
        return reply.status(400).send({ error: 'signed wallet does not match visitorId' })
      }
      const verified = !!signer

      const resolved = await resolveAnalyticsScene(batch.scene, signer)
      if (!resolved.ok) {
        return reply
          .status(resolved.status)
          .send(resolved.status === 503 ? { error: resolved.error, retryAfter: 30 } : { error: resolved.error })
      }

      const posCount = batch.events.filter((e) => e.type === 'pos').length
      const limit = checkIngestLimits(limiter, {
        requesterKey: signer ? `w:${signer}` : `ip:${request.ip}`,
        verified,
        sceneId: resolved.scene.id,
        isPreview: resolved.scene.isPreview,
        eventCount: batch.events.length,
        posCount,
        dayKey: new Date().toISOString().slice(0, 10),
      })
      if (!limit.ok) {
        return reply.status(429).send({ error: 'rate_limited', retryAfter: Math.ceil(limit.retryAfterMs / 1000) })
      }

      try {
        const { accepted } = await writeBatch({
          scene: resolved.scene,
          batch,
          verified,
          country: country.lookup(request.ip, headers),
          keepPosProbability: limit.keepPosProbability,
        })
        return reply.send({ ok: true, accepted, notice: resolved.scene.walletVisibility })
      } catch (err) {
        if (err instanceof SessionSceneMismatchError) return reply.status(409).send({ error: 'session_scene_mismatch' })
        throw err
      }
    },
  )
}
```

Register in `apps/server/src/app.ts`: `import ingestRoutes from './routes/ingest.js'` and `await app.register(ingestRoutes)` next to the other routes. `request.ip` uses Fastify's `trustProxy` setting. If the deployment sits behind a proxy (Railway does), `buildApp` must pass `trustProxy: true` to `Fastify({...})`. Add that option, so per-IP limits key on the real client, and mention it in the report.

- [ ] **Step 6: Run tests and typecheck**

Run: `cd apps/server && pnpm test test/analytics-ingest.test.ts && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server
git commit -m "feat(analytics): public ingest endpoint with signer check, limits and deduped writes"
```

---

### Task 9: Background jobs — session close, rollups, retention

**Files:**
- Create: `apps/server/src/analytics/jobs.ts`, `apps/server/test/analytics-jobs.test.ts`
- Modify: `apps/server/src/index.ts`, `apps/server/src/config.ts`

**Interfaces:**
- Consumes: schema (Task 5); `getSubscription` (`src/integrations/stripe.ts`); `config.allFeaturesUnlocked`.
- Produces:
  - `runSessionCloseSweep(now?: Date): Promise<number>` (sessions closed)
  - `rollupHour(sceneId: string, hour: Date): Promise<void>`, `rollupDay(sceneId: string, day: string): Promise<void>` (`day` = `YYYY-MM-DD` UTC)
  - `runRollups(now?: Date): Promise<{ hours: number; days: number }>`
  - `retentionDaysFor(scene: AnalyticsSceneRow): Promise<number>` and `runRetention(now?: Date): Promise<{ deleted: number }>`
  - `registerDailyJob(name: string, fn: (now: Date) => Promise<unknown>): void` (Task 10 adds claim re-verification)
  - `startAnalyticsJobs(): () => void`; `config.analyticsJobsEnabled` (env `ANALYTICS_JOBS`, default `true`; tests set `false` via `LIFECYCLE_SWEEP_MS=0` pattern → use `ANALYTICS_JOBS=false` in `vitest.config.ts` env)

- [ ] **Step 1: Write the failing test `apps/server/test/analytics-jobs.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import {
  analyticsSessions,
  analyticsEvents,
  analyticsPositions,
  analyticsRollupHourly,
  analyticsHeatmapDaily,
  analyticsCopresenceDaily,
  analyticsDirtyHours,
  analyticsScenes,
} from '../src/db/schema.js'
import { runSessionCloseSweep, rollupHour, rollupDay, runRollups, runRetention } from '../src/analytics/jobs.js'
import { resetDb } from './helpers/db.js'
import { createUser } from './helpers/factories.js'
import { createAnalyticsScene, insertSession } from './helpers/analytics.js'

const H = new Date('2026-10-01T10:00:00Z')
const at = (min: number, sec = 0) => new Date(H.getTime() + min * 60_000 + sec * 1000)

describe('analytics jobs', () => {
  beforeEach(resetDb)

  it('closes sessions idle for more than 60 s', async () => {
    const s = await createAnalyticsScene()
    const idle = await insertSession(s.id, { lastSeenAt: new Date(Date.now() - 61_000) })
    const live = await insertSession(s.id, { lastSeenAt: new Date(Date.now() - 10_000) })
    expect(await runSessionCloseSweep()).toBe(1)
    const rows = await db.select().from(analyticsSessions)
    expect(rows.find((r) => r.id === idle.id)!.endedAt?.getTime()).toBe(idle.lastSeenAt.getTime())
    expect(rows.find((r) => r.id === live.id)!.endedAt).toBeNull()
  })

  it('hourly rollup: counts, uniques, new vs returning, verified, dwell percentiles, peak concurrency, breakdowns', async () => {
    const s = await createAnalyticsScene()
    const a = await insertSession(s.id, { visitorHash: 'A', startedAt: at(0), lastSeenAt: at(10), endedAt: at(10), durationSec: 600, verified: true, country: 'DE', cameraMode: 'third' })
    await insertSession(s.id, { visitorHash: 'B', startedAt: at(5), lastSeenAt: at(8), endedAt: at(8), durationSec: 180, isReturning: true, country: 'DE', cameraMode: 'first' })
    await insertSession(s.id, { visitorHash: 'A', startedAt: at(30), lastSeenAt: at(31), endedAt: at(31), durationSec: 60, isReturning: true, country: 'US' })
    await db.insert(analyticsEvents).values([
      { sceneId: s.id, sessionId: a.id, seq: 1, visitorHash: 'A', type: 'interact', occurredAt: at(1), data: { kind: 'click', target: 'door' } },
      { sceneId: s.id, sessionId: a.id, seq: 2, visitorHash: 'A', type: 'interact', occurredAt: at(2), data: { kind: 'click', target: 'door' } },
      { sceneId: s.id, sessionId: a.id, seq: 3, visitorHash: 'A', type: 'interact', occurredAt: at(2), data: { kind: 'hover', target: 'door' } },
      { sceneId: s.id, sessionId: a.id, seq: 4, visitorHash: 'A', type: 'emote', occurredAt: at(3), data: { emote: 'wave' } },
      { sceneId: s.id, sessionId: a.id, seq: 5, visitorHash: 'A', type: 'video', occurredAt: at(4), data: { target: 'screen', state: 'play' } },
      { sceneId: s.id, sessionId: a.id, seq: 6, visitorHash: 'A', type: 'video', occurredAt: at(6), data: { target: 'screen', state: 'pause' } },
    ])
    await rollupHour(s.id, H)
    const [r] = await db.select().from(analyticsRollupHourly).where(eq(analyticsRollupHourly.sceneId, s.id))
    expect(r).toMatchObject({ sessions: 3, uniqueVisitors: 2, newVisitors: 1, returningVisitors: 2, verifiedSessions: 1, peakConcurrency: 2 })
    expect(r.dwellP50Sec).toBe(180)
    expect(r.interactions).toEqual({ door: 2 })
    expect(r.emotes).toEqual({ wave: 1 })
    expect(r.video).toEqual({ screen: { plays: 1, watchSec: 120 } })
    expect(r.countries).toEqual({ DE: 2, US: 1 })
    expect(r.cameraModes).toEqual({ third: 1, first: 1 })
  })

  it('daily heatmap uses 1 m cells and capped gaps; co-presence needs 5 minutes of overlap', async () => {
    const s = await createAnalyticsScene()
    const a = await insertSession(s.id, { visitorHash: 'A', startedAt: at(0), lastSeenAt: at(10), endedAt: at(10) })
    await insertSession(s.id, { visitorHash: 'B', startedAt: at(2), lastSeenAt: at(9), endedAt: at(9) })
    await insertSession(s.id, { visitorHash: 'C', startedAt: at(9), lastSeenAt: at(12), endedAt: at(12) })
    await db.insert(analyticsPositions).values([
      { sceneId: s.id, sessionId: a.id, seq: 1, occurredAt: at(0, 0), x: 3.4, y: 0, z: 4.9 },
      { sceneId: s.id, sessionId: a.id, seq: 2, occurredAt: at(0, 3), x: 3.6, y: 0, z: 4.1 },
      { sceneId: s.id, sessionId: a.id, seq: 3, occurredAt: at(1, 0), x: 8.0, y: 0, z: 8.0 },
    ])
    await rollupDay(s.id, '2026-10-01')
    const cells = await db.select().from(analyticsHeatmapDaily).where(eq(analyticsHeatmapDaily.sceneId, s.id))
    const cell = (x: number, z: number) => cells.find((c) => c.cellX === x && c.cellZ === z)
    expect(cell(3, 4)).toMatchObject({ dwellSec: 3 + 15, visits: 1 }) // 3 s gap + gap capped at 15 s
    expect(cell(8, 8)).toMatchObject({ dwellSec: 3, visits: 1 }) // last sample counts 3 s
    const pairs = await db.select().from(analyticsCopresenceDaily)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ visitorA: 'A', visitorB: 'B', overlapSec: 420 })
  })

  it('runRollups processes dirty hours and clears them', async () => {
    const s = await createAnalyticsScene()
    await insertSession(s.id, { startedAt: at(0), lastSeenAt: at(1), endedAt: at(1) })
    await db.insert(analyticsDirtyHours).values({ sceneId: s.id, hour: H })
    expect(await runRollups(new Date('2026-10-01T12:00:00Z'))).toEqual({ hours: 1, days: 1 })
    expect(await db.select().from(analyticsDirtyHours)).toHaveLength(0)
    expect(await db.select().from(analyticsRollupHourly)).toHaveLength(1)
  })

  it('retention: unclaimed 30 days, preview 7, claimed by tier; rollups survive', async () => {
    const now = new Date('2026-10-04T00:00:00Z')
    const old = new Date(now.getTime() - 40 * 86400_000)
    const mid = new Date(now.getTime() - 10 * 86400_000)
    const unclaimed = await createAnalyticsScene()
    const preview = await createAnalyticsScene({ kind: 'preview', isPreview: true })
    const owner = await createUser()
    const claimed = await createAnalyticsScene({ claimedByUserId: owner.id, claimStatus: 'active' })
    for (const sc of [unclaimed, preview, claimed]) {
      await insertSession(sc.id, { startedAt: old, lastSeenAt: old })
      await insertSession(sc.id, { startedAt: mid, lastSeenAt: mid })
      await db.insert(analyticsRollupHourly).values({ sceneId: sc.id, hour: old, sessions: 1 })
    }
    await runRetention(now)
    const left = async (id: string) => (await db.select().from(analyticsSessions).where(eq(analyticsSessions.sceneId, id))).length
    expect(await left(unclaimed.id)).toBe(1) // 40-day-old gone, 10-day kept
    expect(await left(preview.id)).toBe(0) // both older than 7 days
    // Test env runs with all features unlocked (no Stripe key) → claimed scenes keep everything
    expect(await left(claimed.id)).toBe(2)
    expect(await db.select().from(analyticsRollupHourly)).toHaveLength(3)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server && pnpm test test/analytics-jobs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Config and test env** — in `config.ts` add `analyticsJobsEnabled: env('ANALYTICS_JOBS') !== 'false',`; in `apps/server/vitest.config.ts` `test.env` add `ANALYTICS_JOBS: 'false'`.

- [ ] **Step 4: Create `apps/server/src/analytics/jobs.ts`**

```ts
import { and, eq, gte, isNull, lt, lte, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import {
  analyticsCopresenceDaily,
  analyticsDirtyHours,
  analyticsEvents,
  analyticsHeatmapDaily,
  analyticsPositions,
  analyticsRollupHourly,
  analyticsScenes,
  analyticsSessions,
} from '../db/schema.js'
import { config } from '../config.js'
import { getSubscription } from '../integrations/stripe.js'
import type { AnalyticsSceneRow } from './registry.js'

const HOUR = 3_600_000
const DAY = 86_400_000
const rowsOf = <T>(r: unknown) => r as unknown as T[]

/** Run fn only on the server that wins a Postgres advisory lock (no-op elsewhere). */
async function withJobLock<T>(key: number, fn: () => Promise<T>): Promise<T | null> {
  return db.transaction(async (tx) => {
    const [row] = rowsOf<{ locked: boolean }>(await tx.execute(sql`select pg_try_advisory_xact_lock(${key}) as locked`))
    if (!row?.locked) return null
    return fn()
  })
}

export async function runSessionCloseSweep(now = new Date()): Promise<number> {
  const closed = await db
    .update(analyticsSessions)
    .set({ endedAt: sql`${analyticsSessions.lastSeenAt}` })
    .where(and(isNull(analyticsSessions.endedAt), lt(analyticsSessions.lastSeenAt, new Date(now.getTime() - 60_000))))
    .returning({ id: analyticsSessions.id })
  return closed.length
}

async function jsonCounts(query: ReturnType<typeof sql>): Promise<Record<string, number>> {
  const rows = rowsOf<{ k: string | null; n: number }>(await db.execute(query))
  const out: Record<string, number> = {}
  for (const r of rows) if (r.k) out[r.k] = Number(r.n)
  return out
}

export async function rollupHour(sceneId: string, hour: Date): Promise<void> {
  const h0 = hour
  const h1 = new Date(hour.getTime() + HOUR)
  const inHour = sql`scene_id = ${sceneId} and started_at >= ${h0} and started_at < ${h1}`

  const [base] = rowsOf<Record<string, number | null>>(
    await db.execute(sql`
      select count(*)::int as sessions,
             count(distinct visitor_hash)::int as unique_visitors,
             count(*) filter (where not is_returning)::int as new_visitors,
             count(*) filter (where is_returning)::int as returning_visitors,
             count(*) filter (where verified)::int as verified_sessions,
             coalesce(round(avg(duration_sec)), 0)::int as dwell_avg,
             coalesce(round(percentile_cont(0.5) within group (order by duration_sec)), 0)::int as dwell_p50,
             coalesce(round(percentile_cont(0.9) within group (order by duration_sec)), 0)::int as dwell_p90
      from analytics_sessions where ${inHour}`),
  )

  const [peak] = rowsOf<{ peak: number }>(
    await db.execute(sql`
      select coalesce(max(c), 0)::int as peak from (
        select m, count(s.id) as c
        from generate_series(${h0}::timestamptz, ${h1}::timestamptz - interval '1 minute', interval '1 minute') m
        join analytics_sessions s
          on s.scene_id = ${sceneId}
         and s.started_at < m + interval '1 minute'
         and coalesce(s.ended_at, s.last_seen_at) >= m
        group by m
      ) x`),
  )

  const evIn = sql`scene_id = ${sceneId} and occurred_at >= ${h0} and occurred_at < ${h1}`
  const interactions = await jsonCounts(sql`
    select data->>'target' as k, count(*)::int as n from analytics_events
    where ${evIn} and type = 'interact' and data->>'kind' = 'click'
    group by 1 order by 2 desc limit 100`)
  const emotes = await jsonCounts(sql`
    select data->>'emote' as k, count(*)::int as n from analytics_events where ${evIn} and type = 'emote' group by 1`)
  const countries = await jsonCounts(sql`select country as k, count(*)::int as n from analytics_sessions where ${inHour} group by 1`)
  const platforms = await jsonCounts(sql`select platform as k, count(*)::int as n from analytics_sessions where ${inHour} group by 1`)
  const cameraModes = await jsonCounts(sql`select camera_mode as k, count(*)::int as n from analytics_sessions where ${inHour} group by 1`)

  const videoRows = rowsOf<{ target: string; plays: number; watch: number }>(
    await db.execute(sql`
      select target, count(*) filter (where state = 'play')::int as plays,
             coalesce(round(sum(case when state = 'play' then least(extract(epoch from (next_at - occurred_at)), 3600) end)), 0)::int as watch
      from (
        select data->>'target' as target, data->>'state' as state, occurred_at,
               lead(occurred_at) over (partition by session_id, data->>'target' order by occurred_at, seq) as next_at
        from analytics_events where ${evIn} and type = 'video'
      ) v group by target`),
  )
  const video: Record<string, { plays: number; watchSec: number }> = {}
  for (const v of videoRows) video[v.target] = { plays: Number(v.plays), watchSec: Number(v.watch) }

  const values = {
    sessions: Number(base.sessions),
    uniqueVisitors: Number(base.unique_visitors),
    newVisitors: Number(base.new_visitors),
    returningVisitors: Number(base.returning_visitors),
    verifiedSessions: Number(base.verified_sessions),
    peakConcurrency: Number(peak.peak),
    dwellAvgSec: Number(base.dwell_avg),
    dwellP50Sec: Number(base.dwell_p50),
    dwellP90Sec: Number(base.dwell_p90),
    interactions,
    video,
    emotes,
    countries,
    platforms,
    cameraModes,
  }
  await db
    .insert(analyticsRollupHourly)
    .values({ sceneId, hour: h0, ...values })
    .onConflictDoUpdate({ target: [analyticsRollupHourly.sceneId, analyticsRollupHourly.hour], set: values })
}

export async function rollupDay(sceneId: string, day: string): Promise<void> {
  const d0 = new Date(`${day}T00:00:00Z`)
  const d1 = new Date(d0.getTime() + DAY)
  await db.transaction(async (tx) => {
    await tx.delete(analyticsHeatmapDaily).where(and(eq(analyticsHeatmapDaily.sceneId, sceneId), eq(analyticsHeatmapDaily.day, day)))
    await tx.execute(sql`
      insert into analytics_heatmap_daily (scene_id, day, cell_x, cell_z, dwell_sec, visits)
      select ${sceneId}, ${day}::date, floor(x)::int, floor(z)::int,
             round(sum(least(coalesce(gap, 3), 15)))::int, count(distinct session_id)::int
      from (
        select session_id, x, z,
               extract(epoch from (lead(occurred_at) over (partition by session_id order by occurred_at, seq) - occurred_at)) as gap
        from analytics_positions
        where scene_id = ${sceneId} and occurred_at >= ${d0} and occurred_at < ${d1}
      ) p
      group by 3, 4`)

    await tx.delete(analyticsCopresenceDaily).where(and(eq(analyticsCopresenceDaily.sceneId, sceneId), eq(analyticsCopresenceDaily.day, day)))
    await tx.execute(sql`
      insert into analytics_copresence_daily (scene_id, day, visitor_a, visitor_b, overlap_sec)
      select ${sceneId}, ${day}::date, va, vb, overlap from (
        select least(a.visitor_hash, b.visitor_hash) as va, greatest(a.visitor_hash, b.visitor_hash) as vb,
               round(sum(extract(epoch from (
                 least(coalesce(a.ended_at, a.last_seen_at), coalesce(b.ended_at, b.last_seen_at)) - greatest(a.started_at, b.started_at)
               ))))::int as overlap
        from analytics_sessions a
        join analytics_sessions b
          on b.scene_id = a.scene_id and a.id < b.id and a.visitor_hash <> b.visitor_hash
         and a.started_at < coalesce(b.ended_at, b.last_seen_at)
         and b.started_at < coalesce(a.ended_at, a.last_seen_at)
        where a.scene_id = ${sceneId} and a.started_at >= ${d0} and a.started_at < ${d1}
        group by 1, 2
      ) x where overlap >= 300 order by overlap desc limit 1000
      on conflict do nothing`)
  })

  await db.execute(sql`
    update analytics_scenes set verified_session_share = coalesce((
      select avg(case when verified then 1.0 else 0.0 end) from analytics_sessions
      where scene_id = ${sceneId} and started_at >= ${new Date(d1.getTime() - 7 * DAY)}
    ), 0) where id = ${sceneId}`)
}

export async function runRollups(now = new Date()): Promise<{ hours: number; days: number }> {
  const dirty = await db.select().from(analyticsDirtyHours).where(lte(analyticsDirtyHours.hour, now))
  const days = new Map<string, Set<string>>()
  for (const d of dirty) {
    await rollupHour(d.sceneId, d.hour)
    const day = d.hour.toISOString().slice(0, 10)
    if (!days.has(d.sceneId)) days.set(d.sceneId, new Set())
    days.get(d.sceneId)!.add(day)
  }
  let dayCount = 0
  for (const [sceneId, set] of days) {
    for (const day of set) {
      await rollupDay(sceneId, day)
      dayCount++
    }
  }
  for (const d of dirty) {
    // Keep the current hour dirty so it's recomputed as more events arrive.
    if (d.hour.getTime() + HOUR <= now.getTime()) {
      await db.delete(analyticsDirtyHours).where(and(eq(analyticsDirtyHours.sceneId, d.sceneId), eq(analyticsDirtyHours.hour, d.hour)))
    }
  }
  return { hours: dirty.length, days: dayCount }
}

export async function retentionDaysFor(scene: AnalyticsSceneRow): Promise<number> {
  if (scene.isPreview) return 7
  if (!scene.claimedByUserId || scene.claimStatus !== 'active') return 30
  if (config.allFeaturesUnlocked) return Infinity
  const sub = await getSubscription(scene.claimedByUserId)
  return sub.limits.analyticsRetentionDays
}

async function deleteOlder(table: 'analytics_events' | 'analytics_positions' | 'analytics_sessions', sceneId: string, cutoff: Date) {
  const col = table === 'analytics_sessions' ? sql.raw('last_seen_at') : sql.raw('occurred_at')
  let total = 0
  for (;;) {
    const rows = rowsOf<{ id: unknown }>(
      await db.execute(sql`
        delete from ${sql.raw(table)} where ctid in (
          select ctid from ${sql.raw(table)} where scene_id = ${sceneId} and ${col} < ${cutoff} limit 10000
        ) returning 1 as id`),
    )
    total += rows.length
    if (rows.length < 10000) return total
  }
}

export async function runRetention(now = new Date()): Promise<{ deleted: number }> {
  const scenes = await db.select().from(analyticsScenes)
  let deleted = 0
  for (const scene of scenes) {
    const days = await retentionDaysFor(scene)
    if (!Number.isFinite(days)) continue
    const cutoff = new Date(now.getTime() - days * DAY)
    deleted += await deleteOlder('analytics_events', scene.id, cutoff)
    deleted += await deleteOlder('analytics_positions', scene.id, cutoff)
    deleted += await deleteOlder('analytics_sessions', scene.id, cutoff)
  }
  return { deleted }
}

const dailyJobs: Array<{ name: string; fn: (now: Date) => Promise<unknown> }> = [{ name: 'retention', fn: runRetention }]

export function registerDailyJob(name: string, fn: (now: Date) => Promise<unknown>): void {
  dailyJobs.push({ name, fn })
}

export function startAnalyticsJobs(): () => void {
  if (!config.analyticsJobsEnabled) return () => {}
  const timers: NodeJS.Timeout[] = []
  const every = (ms: number, key: number, name: string, fn: () => Promise<unknown>) => {
    let running = false
    const t = setInterval(async () => {
      if (running) return
      running = true
      try {
        await withJobLock(key, fn)
      } catch (err) {
        console.error(`[vlm-server] analytics job ${name} failed:`, err)
      } finally {
        running = false
      }
    }, ms)
    t.unref()
    timers.push(t)
  }
  every(30_000, 71001, 'session-close', () => runSessionCloseSweep())
  every(5 * 60_000, 71002, 'rollups', () => runRollups())
  every(60 * 60_000, 71003, 'daily', async () => {
    // Runs hourly but each daily job only does work once per UTC day.
    const today = new Date().toISOString().slice(0, 10)
    for (const job of dailyJobs) {
      if (lastDailyRun.get(job.name) === today) continue
      await job.fn(new Date())
      lastDailyRun.set(job.name, today)
    }
  })
  return () => timers.forEach(clearInterval)
}

const lastDailyRun = new Map<string, string>()
```

In the heatmap test, the (3,4) cell gets the 3-second gap to the second sample plus a gap capped at 15 seconds (57 seconds to the third sample, capped). That's 18 seconds. The final sample at (8,8) has no next sample and counts the 3-second default. Co-presence: A (0–10 min) and B (2–9 min) overlap for 7 minutes (420 seconds). B and C overlap for 0 minutes and A and C for 1 minute, so neither pair passes the 5-minute bar.

Note `withJobLock` runs `fn` while the transaction holding the lock is open, so `fn`'s own queries use other pool connections. That's fine with the default pool size. Don't nest more locks inside `fn`.

- [ ] **Step 5: Start the jobs** — in `apps/server/src/index.ts`, after `startLifecycleSweep(...)`:

```ts
  startAnalyticsJobs()
  console.log('[vlm-server] Analytics jobs started')
```

(import from `./analytics/jobs.js`).

- [ ] **Step 6: Run tests and typecheck**

Run: `cd apps/server && pnpm test test/analytics-jobs.test.ts && pnpm test && pnpm typecheck`
Expected: PASS. If `percentile_cont` returns a numeric string, keep the `Number(...)` conversions as written.

- [ ] **Step 7: Commit**

```bash
git add apps/server
git commit -m "feat(analytics): session close, hourly/daily rollups, heatmaps, co-presence, retention"
```

---

### Task 10: Wallet sign-in, claims and daily re-verification

**Files:**
- Create: `apps/server/src/auth/wallet-users.ts`, `apps/server/src/routes/wallet-auth.ts`, `apps/server/src/analytics/claims.ts`, `apps/server/src/routes/analytics-claims.ts`, `apps/server/test/analytics-claims.test.ts`
- Modify: `apps/server/src/db/schema.ts` (`walletChallenges`), `apps/server/src/routes/auth.ts` (platform route uses `resolveVerifiedWalletUser`), `apps/server/src/app.ts`, `apps/server/src/analytics/jobs.ts` (register re-verify)

**Interfaces:**
- Consumes: `getDclDirectory`, `DirectoryUnavailableError` (Task 6); `analyticsScenes`, `getAnalyticsAccess` (Task 5); `registerDailyJob` (Task 9); `initialRoleForNewUser`, `linkWalletGrants`.
- Produces:
  - `resolveVerifiedWalletUser(wallet: string, displayName: string): Promise<User>`: returns the verified owner. A wallet record that was never verified is re-homed onto a fresh user.
  - `linkVerifiedWallet(userId: string, wallet: string): Promise<'linked' | 'already' | 'conflict'>`
  - `POST /api/auth/wallet/challenge { address } → { nonce, message }`; `POST /api/auth/wallet/verify { address, nonce, signature } → { user, accessToken, refreshToken }` (with a Bearer token: links the wallet to that user and returns `{ linked: true }`).
  - `verifiedWalletsOf(userId: string): Promise<string[]>`
  - `controls(scene: AnalyticsSceneRow, wallet: string): Promise<boolean>` (throws `DirectoryUnavailableError`)
  - `POST /api/analytics/claims { locationKey, vlmSceneId? }`, `GET /api/analytics/claims/eligible`, `GET /api/analytics/claims/check?locationKey=`
  - `reverifyClaims(now?: Date): Promise<{ checked: number; lapsed: number }>`

- [ ] **Step 1: Schema** — add to `schema.ts`:

```ts
export const walletChallenges = pgTable('wallet_challenges', {
  nonce: text('nonce').primaryKey(),
  address: text('address').notNull(),
  message: text('message').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})
```

- [ ] **Step 2: Write the failing test `apps/server/test/analytics-claims.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Wallet } from 'ethers'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { analyticsScenes, userAuthMethods, users, scenes } from '../src/db/schema.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { reverifyClaims } from '../src/analytics/claims.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'

const rights = (o: Partial<{ owner: string; operator: string; updateOperator: string; updateManagers: string[]; approvedForAll: string[] }> = {}) => ({
  owner: null, operator: null, updateOperator: null, updateManagers: [], approvedForAll: [], ...o,
})

describe('wallet sign-in', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

  async function signIn(wallet: Wallet, bearer?: string) {
    const ch = await app.inject({ method: 'POST', url: '/api/auth/wallet/challenge', payload: { address: wallet.address } })
    const { nonce, message } = ch.json()
    const signature = await wallet.signMessage(message)
    return app.inject({
      method: 'POST',
      url: '/api/auth/wallet/verify',
      payload: { address: wallet.address, nonce, signature },
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    })
  }

  it('signs in with a personal_sign signature and marks the wallet verified', async () => {
    const w = Wallet.createRandom()
    const res = await signIn(w)
    expect(res.statusCode).toBe(200)
    const m = await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, w.address.toLowerCase()) })
    expect((m!.metadata as any).verified).toBe(true)
  })

  it('rejects a wrong signature and a reused nonce', async () => {
    const w = Wallet.createRandom()
    const other = Wallet.createRandom()
    const ch = await app.inject({ method: 'POST', url: '/api/auth/wallet/challenge', payload: { address: w.address } })
    const { nonce, message } = ch.json()
    const bad = await app.inject({ method: 'POST', url: '/api/auth/wallet/verify', payload: { address: w.address, nonce, signature: await other.signMessage(message) } })
    expect(bad.statusCode).toBe(401)
    const good = await app.inject({ method: 'POST', url: '/api/auth/wallet/verify', payload: { address: w.address, nonce, signature: await w.signMessage(message) } })
    expect(good.statusCode).toBe(401) // nonce consumed by the failed attempt
  })

  it('a legacy unverified wallet record is re-homed to a new user, not the squatter', async () => {
    const w = Wallet.createRandom()
    const squatter = await createUser()
    await db.insert(userAuthMethods).values({ userId: squatter.id, type: 'wallet', identifier: w.address.toLowerCase(), metadata: { verified: false } })
    const res = await signIn(w)
    expect(res.json().user.id).not.toBe(squatter.id)
    const m = await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, w.address.toLowerCase()) })
    expect(m!.userId).toBe(res.json().user.id)
  })

  it('with a Bearer token, links the wallet to the signed-in email user', async () => {
    const u = await createUser()
    const w = Wallet.createRandom()
    const res = await signIn(w, tokenFor(u))
    expect(res.json()).toMatchObject({ linked: true })
    const m = await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, w.address.toLowerCase()) })
    expect(m!.userId).toBe(u.id)
  })
})

describe('claims', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let dir: FakeDclDirectory
  beforeEach(async () => {
    await resetDb()
    dir = new FakeDclDirectory()
    setDclDirectory(dir)
    app = await testApp()
  })
  afterEach(async () => {
    setDclDirectory(null)
    await app.close()
  })

  const W = '0x00000000000000000000000000000000000000c1'
  const claim = (u: any, locationKey: string) =>
    app.inject({ method: 'POST', url: '/api/analytics/claims', payload: { locationKey }, headers: { authorization: `Bearer ${tokenFor(u)}` } })

  it.each([
    ['owner', { owner: W }],
    ['operator', { operator: W }],
    ['updateOperator', { updateOperator: W }],
    ['updateManager', { updateManagers: [W] }],
    ['approvedForAll', { approvedForAll: [W] }],
  ])('Genesis City: %s of every parcel can claim; a VLM scene is created and linked', async (_l, r) => {
    const u = await createUser({ wallet: W })
    const s = await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1', '1,2'], title: 'Arbor' })
    dir.rights.set('1,1', rights(r))
    dir.rights.set('1,2', rights(r))
    const res = await claim(u, 'gc:1,1')
    expect(res.statusCode).toBe(200)
    const row = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.id, s.id) })
    expect(row).toMatchObject({ claimedByUserId: u.id, claimStatus: 'active' })
    const vlm = await db.query.scenes.findFirst({ where: eq(scenes.id, row!.vlmSceneId!) })
    expect(vlm).toMatchObject({ ownerId: u.id, name: 'Arbor' })
  })

  it('controlling only some parcels is not enough; deployer of the active scene on every parcel is', async () => {
    const u = await createUser({ wallet: W })
    await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1', '1,2'] })
    dir.rights.set('1,1', rights({ owner: W }))
    dir.rights.set('1,2', rights({ owner: '0x0000000000000000000000000000000000000999' }))
    expect((await claim(u, 'gc:1,1')).statusCode).toBe(403)
    dir.deployers.set('1,1', W)
    dir.deployers.set('1,2', W)
    expect((await claim(u, 'gc:1,1')).statusCode).toBe(200)
  })

  it('worlds: only the name owner can claim', async () => {
    const u = await createUser({ wallet: W })
    await createAnalyticsScene({ kind: 'world', locationKey: 'world:foo.dcl.eth', worldName: 'foo.dcl.eth', baseParcel: null, parcels: [] })
    dir.worldOwners.set('foo.dcl.eth', '0x0000000000000000000000000000000000000999')
    expect((await claim(u, 'world:foo.dcl.eth')).statusCode).toBe(403)
    dir.worldOwners.set('foo.dcl.eth', W)
    expect((await claim(u, 'world:foo.dcl.eth')).statusCode).toBe(200)
  })

  it('users without a verified wallet get 403; unknown locations 404; directory down 503 (never a false "not owner")', async () => {
    const emailOnly = await createUser()
    await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1'] })
    expect((await claim(emailOnly, 'gc:1,1')).statusCode).toBe(403)
    const u = await createUser({ wallet: W })
    expect((await claim(u, 'gc:9,9')).statusCode).toBe(404)
    dir.down = true
    expect((await claim(u, 'gc:1,1')).statusCode).toBe(503)
  })

  it('an active claim by someone else blocks a new claim (409)', async () => {
    const holder = await createUser()
    const u = await createUser({ wallet: W })
    await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1'], claimedByUserId: holder.id, claimStatus: 'active' })
    dir.rights.set('1,1', rights({ owner: W }))
    expect((await claim(u, 'gc:1,1')).statusCode).toBe(409)
  })

  it('check endpoint reports eligibility for in-world setup', async () => {
    const u = await createUser({ wallet: W })
    await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1'] })
    dir.rights.set('1,1', rights({ owner: W }))
    const res = await app.inject({ method: 'GET', url: '/api/analytics/claims/check?locationKey=gc:1,1', headers: { authorization: `Bearer ${tokenFor(u)}` } })
    expect(res.json()).toEqual({ eligible: true, claimed: false, mine: false })
  })

  it('daily re-verification lapses claims the wallet no longer controls', async () => {
    const u = await createUser({ wallet: W })
    const s = await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1'], claimedByUserId: u.id, claimStatus: 'active' })
    dir.rights.set('1,1', rights({ owner: '0x0000000000000000000000000000000000000999' }))
    expect(await reverifyClaims()).toEqual({ checked: 1, lapsed: 1 })
    const row = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.id, s.id) })
    expect(row).toMatchObject({ claimStatus: 'lapsed' })
    expect(row!.lapsedAt).not.toBeNull()
  })

  it('re-verification leaves claims alone when the directory is down', async () => {
    const u = await createUser({ wallet: W })
    await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1'], claimedByUserId: u.id, claimStatus: 'active' })
    dir.down = true
    expect(await reverifyClaims()).toEqual({ checked: 1, lapsed: 0 })
  })
})
```

`createUser({ wallet })` writes the wallet auth method with `metadata: { verified: true }` (Task 1 helper of the previous plan), which `verifiedWalletsOf` relies on.

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/server && pnpm test test/analytics-claims.test.ts`
Expected: FAIL — routes 404 / modules not found.

- [ ] **Step 4: Create `apps/server/src/auth/wallet-users.ts`**

```ts
import { and, eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { userAuthMethods, users } from '../db/schema.js'
import { initialRoleForNewUser } from './roles.js'

const isVerified = (m: { metadata: unknown }) => (m.metadata as { verified?: unknown } | null)?.verified === true

async function findWalletMethod(wallet: string) {
  return db.query.userAuthMethods.findFirst({
    where: and(eq(userAuthMethods.type, 'wallet'), eq(userAuthMethods.identifier, wallet.toLowerCase())),
    with: { user: true },
  })
}

/**
 * The user that owns this proven wallet. A wallet record that was never verified (created by the old,
 * unsafe login route) is re-homed onto a fresh user so a squatter never receives the real owner's login.
 */
export async function resolveVerifiedWalletUser(wallet: string, displayName: string) {
  const w = wallet.toLowerCase()
  const existing = await findWalletMethod(w)
  if (existing && isVerified(existing)) return existing.user
  const [user] = await db.insert(users).values({ displayName, email: null, role: await initialRoleForNewUser() }).returning()
  if (existing) {
    await db
      .update(userAuthMethods)
      .set({ userId: user.id, metadata: { ...(existing.metadata as object), verified: true, rehomedFrom: existing.userId } })
      .where(eq(userAuthMethods.id, existing.id))
  } else {
    await db.insert(userAuthMethods).values({ userId: user.id, type: 'wallet', identifier: w, metadata: { verified: true } })
  }
  return user
}

/** Attach a proven wallet to an existing (e.g. email) user. */
export async function linkVerifiedWallet(userId: string, wallet: string): Promise<'linked' | 'already' | 'conflict'> {
  const w = wallet.toLowerCase()
  const existing = await findWalletMethod(w)
  if (existing && existing.userId === userId && isVerified(existing)) return 'already'
  if (existing && isVerified(existing) && existing.userId !== userId) return 'conflict'
  if (existing) {
    await db
      .update(userAuthMethods)
      .set({ userId, metadata: { ...(existing.metadata as object), verified: true, rehomedFrom: existing.userId } })
      .where(eq(userAuthMethods.id, existing.id))
  } else {
    await db.insert(userAuthMethods).values({ userId, type: 'wallet', identifier: w, metadata: { verified: true } })
  }
  return 'linked'
}
```

Check that `userAuthMethods` has an `id` column (`grep -n "userAuthMethods = pgTable" -A10 apps/server/src/db/schema.ts`). If its key is composite, update by `(type, identifier)` instead.

In `routes/auth.ts`, the platform route's verified branch currently finds or creates the wallet user inline. Replace that with `dbUser = await resolveVerifiedWalletUser(verifiedWallet, displayName)`. Keep the preview (`preview:` identifier) branch as it is.

- [ ] **Step 5: Create `apps/server/src/routes/wallet-auth.ts`**

```ts
import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { verifyMessage } from 'ethers'
import { db } from '../db/connection.js'
import { walletChallenges } from '../db/schema.js'
import { config } from '../config.js'
import { linkWalletGrants } from '../auth/permissions.js'
import { linkVerifiedWallet, resolveVerifiedWalletUser } from '../auth/wallet-users.js'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const TTL_MS = 5 * 60_000

export default async function walletAuthRoutes(app: FastifyInstance) {
  app.post<{ Body: { address?: string } }>('/api/auth/wallet/challenge', async (request, reply) => {
    const address = request.body?.address
    if (!address || !ADDRESS_RE.test(address)) return reply.status(400).send({ error: 'address must be a 0x wallet address' })
    const nonce = randomBytes(16).toString('hex')
    const message = `VLM wants you to sign in with your wallet.\n\nAddress: ${address.toLowerCase()}\nNonce: ${nonce}\nIssued: ${new Date().toISOString()}`
    await db.insert(walletChallenges).values({ nonce, address: address.toLowerCase(), message, expiresAt: new Date(Date.now() + TTL_MS) })
    return reply.send({ nonce, message })
  })

  app.post<{ Body: { address?: string; nonce?: string; signature?: string } }>('/api/auth/wallet/verify', async (request, reply) => {
    const { address, nonce, signature } = request.body ?? {}
    if (!address || !ADDRESS_RE.test(address) || !nonce || !signature) return reply.status(400).send({ error: 'address, nonce and signature are required' })
    // Single use: delete first so a failed attempt also burns the nonce.
    const [challenge] = await db.delete(walletChallenges).where(eq(walletChallenges.nonce, nonce)).returning()
    if (!challenge || challenge.expiresAt < new Date() || challenge.address !== address.toLowerCase()) {
      return reply.status(401).send({ error: 'Challenge expired or invalid' })
    }
    let recovered: string
    try {
      recovered = verifyMessage(challenge.message, signature).toLowerCase()
    } catch {
      return reply.status(401).send({ error: 'Invalid signature' })
    }
    if (recovered !== challenge.address) return reply.status(401).send({ error: 'Invalid signature' })

    const auth = request.headers.authorization
    if (auth?.startsWith('Bearer ')) {
      try {
        const claims = app.jwt.verify<{ id: string; refresh?: boolean; guest?: boolean }>(auth.slice(7))
        if (!claims.refresh && !claims.guest) {
          const result = await linkVerifiedWallet(claims.id, recovered)
          if (result === 'conflict') return reply.status(409).send({ error: 'That wallet is linked to another account' })
          await linkWalletGrants(claims.id, recovered)
          return reply.send({ linked: true })
        }
      } catch {
        return reply.status(401).send({ error: 'Invalid token' })
      }
    }

    const user = await resolveVerifiedWalletUser(recovered, `${recovered.slice(0, 6)}…${recovered.slice(-4)}`)
    await linkWalletGrants(user.id, recovered)
    const claims = { id: user.id, email: user.email, role: user.role, orgId: user.activeOrgId || null, wallet: recovered, verified: true }
    return reply.send({
      user: { id: user.id, displayName: user.displayName, email: user.email, role: user.role },
      accessToken: app.jwt.sign(claims, { expiresIn: config.jwtAccessExpiry }),
      refreshToken: app.jwt.sign({ ...claims, refresh: true }, { expiresIn: config.jwtRefreshExpiry }),
    })
  })
}
```

Register it in `app.ts` inside the stricter-rate-limit auth scope (next to `authRoutes`).

- [ ] **Step 6: Create `apps/server/src/analytics/claims.ts`**

```ts
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsScenes, scenePresets, scenes, userAuthMethods } from '../db/schema.js'
import { DirectoryUnavailableError, getDclDirectory } from './dcl-directory.js'
import type { AnalyticsSceneRow } from './registry.js'

export async function verifiedWalletsOf(userId: string): Promise<string[]> {
  const rows = await db.query.userAuthMethods.findMany({
    where: and(eq(userAuthMethods.userId, userId), eq(userAuthMethods.type, 'wallet'), sql`${userAuthMethods.metadata}->>'verified' = 'true'`),
  })
  return rows.map((r) => r.identifier).filter((id) => /^0x[0-9a-f]{40}$/.test(id))
}

/** Does this wallet control the scene's location? Throws DirectoryUnavailableError if Decentraland can't answer. */
export async function controls(scene: AnalyticsSceneRow, wallet: string): Promise<boolean> {
  const w = wallet.toLowerCase()
  const dir = getDclDirectory()
  if (scene.kind === 'preview') return scene.locationKey.startsWith(`preview:${w}:`)
  if (scene.kind === 'world') return (await dir.getWorldOwner(scene.worldName!)) === w
  const parcels = scene.parcels.length ? scene.parcels : scene.baseParcel ? [scene.baseParcel] : []
  if (!parcels.length) return false
  let viaRights = true
  for (const p of parcels) {
    const r = await dir.getParcelRights(p)
    const ok = !!r && [r.owner, r.operator, r.updateOperator, ...r.updateManagers, ...r.approvedForAll].includes(w)
    if (!ok) {
      viaRights = false
      break
    }
  }
  if (viaRights) return true
  for (const p of parcels) if ((await dir.getActiveDeployer(p)) !== w) return false
  return true
}

export async function controlsAny(scene: AnalyticsSceneRow, wallets: string[]): Promise<boolean> {
  for (const w of wallets) if (await controls(scene, w)) return true
  return false
}

export class ClaimError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export async function claimScene(userId: string, locationKey: string, vlmSceneId?: string): Promise<AnalyticsSceneRow> {
  const scene = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, locationKey) })
  if (!scene) throw new ClaimError(404, 'No analytics have been recorded at that location yet')
  if (scene.claimStatus === 'active' && scene.claimedByUserId && scene.claimedByUserId !== userId) {
    throw new ClaimError(409, 'This scene has already been claimed')
  }
  const wallets = await verifiedWalletsOf(userId)
  if (!wallets.length) throw new ClaimError(403, 'Sign in with the wallet that controls this LAND or World first')
  let ok: boolean
  try {
    ok = await controlsAny(scene, wallets)
  } catch (err) {
    if (err instanceof DirectoryUnavailableError) throw new ClaimError(503, 'Decentraland is not responding; try again shortly')
    throw err
  }
  if (!ok) throw new ClaimError(403, 'None of your verified wallets control this location')

  let linkTo = vlmSceneId ?? scene.vlmSceneId ?? null
  if (linkTo) {
    const owned = await db.query.scenes.findFirst({ where: and(eq(scenes.id, linkTo), eq(scenes.ownerId, userId)) })
    if (!owned) linkTo = null
  }
  if (!linkTo) {
    const [created] = await db.insert(scenes).values({ ownerId: userId, name: scene.title || scene.locationKey }).returning()
    const [preset] = await db.insert(scenePresets).values({ sceneId: created.id, name: 'Default' }).returning()
    await db.update(scenes).set({ activePresetId: preset.id }).where(eq(scenes.id, created.id))
    linkTo = created.id
  }
  const [updated] = await db
    .update(analyticsScenes)
    .set({ claimedByUserId: userId, claimStatus: 'active', claimedAt: new Date(), lapsedAt: null, vlmSceneId: linkTo, updatedAt: new Date() })
    .where(eq(analyticsScenes.id, scene.id))
    .returning()
  return updated
}

export async function reverifyClaims(now = new Date()): Promise<{ checked: number; lapsed: number }> {
  const claimed = await db.select().from(analyticsScenes).where(and(eq(analyticsScenes.claimStatus, 'active'), isNotNull(analyticsScenes.claimedByUserId)))
  let lapsed = 0
  for (const scene of claimed) {
    try {
      const ok = await controlsAny(scene, await verifiedWalletsOf(scene.claimedByUserId!))
      if (!ok) {
        await db.update(analyticsScenes).set({ claimStatus: 'lapsed', lapsedAt: now, updatedAt: now }).where(eq(analyticsScenes.id, scene.id))
        lapsed++
      }
    } catch (err) {
      if (!(err instanceof DirectoryUnavailableError)) throw err
    }
  }
  return { checked: claimed.length, lapsed }
}
```

A lapsed scene is claimable again. `claimScene` only blocks on an **active** claim by someone else.

- [ ] **Step 7: Create `apps/server/src/routes/analytics-claims.ts`**

```ts
import type { FastifyInstance } from 'fastify'
import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsScenes, analyticsSessions } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { DirectoryUnavailableError } from '../analytics/dcl-directory.js'
import { ClaimError, claimScene, controlsAny, verifiedWalletsOf } from '../analytics/claims.js'

export default async function analyticsClaimRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  const userOf = (request: { user: any }) => {
    const a = actorFromClaims(request.user)
    return a.userId && a.verified ? a.userId : null
  }

  app.post<{ Body: { locationKey?: string; vlmSceneId?: string } }>('/api/analytics/claims', async (request, reply) => {
    const userId = userOf(request)
    if (!userId) return reply.status(403).send({ error: 'Forbidden' })
    if (!request.body?.locationKey) return reply.status(400).send({ error: 'locationKey is required' })
    try {
      return reply.send({ scene: await claimScene(userId, request.body.locationKey, request.body.vlmSceneId) })
    } catch (err) {
      if (err instanceof ClaimError) return reply.status(err.status).send({ error: err.message })
      throw err
    }
  })

  app.get<{ Querystring: { locationKey?: string } }>('/api/analytics/claims/check', async (request, reply) => {
    const userId = userOf(request)
    const key = request.query.locationKey
    if (!userId || !key) return reply.send({ eligible: false, claimed: false, mine: false })
    const scene = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, key) })
    if (!scene) return reply.send({ eligible: false, claimed: false, mine: false })
    const claimed = scene.claimStatus === 'active'
    const mine = claimed && scene.claimedByUserId === userId
    try {
      const eligible = mine || (!claimed && (await controlsAny(scene, await verifiedWalletsOf(userId))))
      return reply.send({ eligible, claimed, mine })
    } catch (err) {
      if (err instanceof DirectoryUnavailableError) return reply.status(503).send({ error: 'upstream_unavailable', retryAfter: 30 })
      throw err
    }
  })

  app.get('/api/analytics/claims/eligible', async (request, reply) => {
    const userId = userOf(request)
    if (!userId) return reply.send({ scenes: [] })
    const wallets = await verifiedWalletsOf(userId)
    if (!wallets.length) return reply.send({ scenes: [] })
    const since = new Date(Date.now() - 30 * 86400_000)
    const candidates = await db
      .selectDistinct({ id: analyticsScenes.id })
      .from(analyticsScenes)
      .innerJoin(analyticsSessions, eq(analyticsSessions.sceneId, analyticsScenes.id))
      .where(and(or(isNull(analyticsScenes.claimStatus), eq(analyticsScenes.claimStatus, 'lapsed')), gte(analyticsSessions.lastSeenAt, since)))
      .limit(50)
    if (!candidates.length) return reply.send({ scenes: [] })
    const rows = await db.select().from(analyticsScenes).where(inArray(analyticsScenes.id, candidates.map((c) => c.id)))
    const out = []
    for (const scene of rows) {
      try {
        if (await controlsAny(scene, wallets)) out.push({ id: scene.id, locationKey: scene.locationKey, title: scene.title, kind: scene.kind })
      } catch (err) {
        if (err instanceof DirectoryUnavailableError) return reply.status(503).send({ error: 'upstream_unavailable', retryAfter: 30 })
        throw err
      }
    }
    return reply.send({ scenes: out })
  })
}
```

Register in `app.ts` (`import analyticsClaimRoutes from './routes/analytics-claims.js'`). In `apps/server/src/analytics/jobs.ts`, register the re-verify job at module load: `import { reverifyClaims } from './claims.js'` and `registerDailyJob('claim-reverify', reverifyClaims)`. If that creates an import cycle, do the registration in `index.ts` right before `startAnalyticsJobs()`.

- [ ] **Step 8: Run tests and typecheck**

Run: `cd apps/server && pnpm test test/analytics-claims.test.ts && pnpm test && pnpm typecheck`
Expected: PASS. The full suite includes `auth-platform.test.ts` and `venues.test.ts`, which exercise the changed platform route.

- [ ] **Step 9: Commit**

```bash
git add apps/server
git commit -m "feat(analytics): wallet sign-in, LAND/World claims and daily claim re-verification"
```

---

### Task 11: Analytics read API, wallet visibility and delete-my-data

**Files:**
- Create: `apps/server/src/routes/analytics-read.ts`, `apps/server/test/analytics-read.test.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: `getAnalyticsAccess` (Task 5); `visitorHash` (Task 8); `verifiedWalletsOf` (Task 10); rollup tables (Task 9).
- Produces (all `authenticate`d; `:id` = analytics scene id; 403 without read access):
  - `GET /api/analytics/locations` → `{ scenes: [{ id, locationKey, kind, title, claimStatus, walletVisibility, verifiedSessionShare }] }` (those the user can read)
  - `GET /api/analytics/locations/:id/summary?from&to` → `{ sessions, uniqueVisitors, newVisitors, returningVisitors, peakConcurrency, dwellAvgSec, verifiedShare, interactions, emotes, countries, platforms }`
  - `GET /api/analytics/locations/:id/timeseries?from&to&bucket=hour|day` → `{ points: [{ t, sessions, uniqueVisitors, peakConcurrency, dwellAvgSec }] }`
  - `GET /api/analytics/locations/:id/live` → `{ count, positions: [{ x, z }] }`
  - `GET /api/analytics/locations/:id/heatmap?from&to` → `{ cells: [{ x, z, dwellSec, visits }] }`
  - `GET /api/analytics/locations/:id/sessions?cursor` → `{ sessions, nextCursor }`
  - `PATCH /api/analytics/locations/:id { walletVisibility }` (manage access) → `{ scene }`
  - `POST /api/analytics/me/delete` → `{ deleted: { sessions, events, positions, copresence } }`

`from`/`to` default to the last 7 days; invalid dates → 400.

- [ ] **Step 1: Write the failing test `apps/server/test/analytics-read.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { analyticsEvents, analyticsHeatmapDaily, analyticsPositions, analyticsRollupHourly, analyticsScenes, analyticsSessions, analyticsCopresenceDaily } from '../src/db/schema.js'
import { visitorHash } from '../src/analytics/hash.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'
import { createAnalyticsScene, insertSession } from './helpers/analytics.js'

describe('analytics read API', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

  const get = (u: any, url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tokenFor(u)}` } })

  async function owned() {
    const owner = await createUser()
    const s = await createAnalyticsScene({ claimedByUserId: owner.id, claimStatus: 'active' })
    return { owner, s }
  }

  it('summary and timeseries come from rollups; strangers get 403', async () => {
    const { owner, s } = await owned()
    const h = new Date(Date.now() - 2 * 3600_000)
    h.setUTCMinutes(0, 0, 0)
    await db.insert(analyticsRollupHourly).values([
      { sceneId: s.id, hour: h, sessions: 3, uniqueVisitors: 2, peakConcurrency: 2, dwellAvgSec: 100, interactions: { door: 2 }, countries: { DE: 3 } },
      { sceneId: s.id, hour: new Date(h.getTime() + 3600_000), sessions: 1, uniqueVisitors: 1, peakConcurrency: 1, dwellAvgSec: 300, interactions: { door: 1, bar: 4 }, countries: { US: 1 } },
    ])
    await insertSession(s.id, { visitorHash: 'A', startedAt: h })
    await insertSession(s.id, { visitorHash: 'B', startedAt: h })
    await insertSession(s.id, { visitorHash: 'A', startedAt: new Date(h.getTime() + 3600_000) })
    const sum = await get(owner, `/api/analytics/locations/${s.id}/summary`)
    expect(sum.statusCode).toBe(200)
    expect(sum.json()).toMatchObject({ sessions: 4, uniqueVisitors: 2, peakConcurrency: 2, dwellAvgSec: 150, interactions: { door: 3, bar: 4 }, countries: { DE: 3, US: 1 } })
    const ts = await get(owner, `/api/analytics/locations/${s.id}/timeseries?bucket=hour`)
    expect(ts.json().points).toHaveLength(2)
    const stranger = await createUser()
    expect((await get(stranger, `/api/analytics/locations/${s.id}/summary`)).statusCode).toBe(403)
  })

  it('rejects invalid date ranges', async () => {
    const { owner, s } = await owned()
    expect((await get(owner, `/api/analytics/locations/${s.id}/summary?from=nope`)).statusCode).toBe(400)
  })

  it('live returns current sessions with their latest position only', async () => {
    const { owner, s } = await owned()
    const live = await insertSession(s.id, { lastSeenAt: new Date() })
    await insertSession(s.id, { lastSeenAt: new Date(Date.now() - 5 * 60_000) })
    await db.insert(analyticsPositions).values([
      { sceneId: s.id, sessionId: live.id, seq: 1, occurredAt: new Date(Date.now() - 6000), x: 1, y: 0, z: 1 },
      { sceneId: s.id, sessionId: live.id, seq: 2, occurredAt: new Date(Date.now() - 3000), x: 2, y: 0, z: 3 },
    ])
    expect((await get(owner, `/api/analytics/locations/${s.id}/live`)).json()).toEqual({ count: 1, positions: [{ x: 2, z: 3 }] })
  })

  it('heatmap sums cells over the range', async () => {
    const { owner, s } = await owned()
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10)
    await db.insert(analyticsHeatmapDaily).values([
      { sceneId: s.id, day: today, cellX: 3, cellZ: 4, dwellSec: 10, visits: 1 },
      { sceneId: s.id, day: yesterday, cellX: 3, cellZ: 4, dwellSec: 5, visits: 2 },
    ])
    expect((await get(owner, `/api/analytics/locations/${s.id}/heatmap`)).json().cells).toEqual([{ x: 3, z: 4, dwellSec: 15, visits: 3 }])
  })

  it('turning wallet visibility off removes revealed identities; only managers may change it', async () => {
    const { owner, s } = await owned()
    await db.update(analyticsScenes).set({ walletVisibility: true }).where(eq(analyticsScenes.id, s.id))
    await insertSession(s.id, { wallet: '0xabc', displayName: 'Ana' })
    const viewerUser = await createUser()
    const deny = await app.inject({ method: 'PATCH', url: `/api/analytics/locations/${s.id}`, payload: { walletVisibility: false }, headers: { authorization: `Bearer ${tokenFor(viewerUser)}` } })
    expect(deny.statusCode).toBe(403)
    const res = await app.inject({ method: 'PATCH', url: `/api/analytics/locations/${s.id}`, payload: { walletVisibility: false }, headers: { authorization: `Bearer ${tokenFor(owner)}` } })
    expect(res.statusCode).toBe(200)
    const [row] = await db.select().from(analyticsSessions)
    expect(row).toMatchObject({ wallet: null, displayName: null })
    expect(row.visitorHash).toBeTruthy()
  })

  it('sessions are paged with a cursor', async () => {
    const { owner, s } = await owned()
    for (let i = 0; i < 3; i++) await insertSession(s.id, { startedAt: new Date(Date.now() - (i + 1) * 60_000) })
    const p1 = (await get(owner, `/api/analytics/locations/${s.id}/sessions?limit=2`)).json()
    expect(p1.sessions).toHaveLength(2)
    const p2 = (await get(owner, `/api/analytics/locations/${s.id}/sessions?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`)).json()
    expect(p2.sessions).toHaveLength(1)
    expect(p2.nextCursor).toBeNull()
  })

  it('locations lists only scenes the user can read', async () => {
    const { owner, s } = await owned()
    await createAnalyticsScene()
    expect((await get(owner, '/api/analytics/locations')).json().scenes.map((x: any) => x.id)).toEqual([s.id])
  })

  it('delete-my-data removes the visitor everywhere using each scene salt', async () => {
    const W = '0x00000000000000000000000000000000000000d1'
    const me = await createUser({ wallet: W })
    const a = await createAnalyticsScene()
    const b = await createAnalyticsScene()
    for (const sc of [a, b]) {
      const h = visitorHash(sc.salt, W)
      const sess = await insertSession(sc.id, { visitorHash: h })
      await db.insert(analyticsEvents).values({ sceneId: sc.id, sessionId: sess.id, seq: 0, visitorHash: h, type: 'custom', occurredAt: new Date() })
      await db.insert(analyticsPositions).values({ sceneId: sc.id, sessionId: sess.id, seq: 1, occurredAt: new Date(), x: 1, y: 0, z: 1 })
      await db.insert(analyticsCopresenceDaily).values({ sceneId: sc.id, day: '2026-10-01', visitorA: h, visitorB: 'other', overlapSec: 400 })
      await insertSession(sc.id, { visitorHash: 'someone-else' })
    }
    const res = await app.inject({ method: 'POST', url: '/api/analytics/me/delete', headers: { authorization: `Bearer ${tokenFor(me)}` } })
    expect(res.json().deleted).toEqual({ sessions: 2, events: 2, positions: 2, copresence: 2 })
    expect(await db.select().from(analyticsSessions)).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server && pnpm test test/analytics-read.test.ts`
Expected: FAIL — 404s.

- [ ] **Step 3: Create `apps/server/src/routes/analytics-read.ts`**

```ts
import type { FastifyInstance, FastifyReply } from 'fastify'
import { and, desc, eq, gte, inArray, lt, lte, or, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import {
  analyticsCopresenceDaily,
  analyticsEvents,
  analyticsHeatmapDaily,
  analyticsPositions,
  analyticsRollupHourly,
  analyticsScenes,
  analyticsSessions,
} from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getAnalyticsAccess } from '../analytics/access.js'
import { verifiedWalletsOf } from '../analytics/claims.js'
import { visitorHash } from '../analytics/hash.js'

const DAY = 86_400_000
const rowsOf = <T>(r: unknown) => r as unknown as T[]

function range(q: { from?: string; to?: string }): { from: Date; to: Date } | null {
  const to = q.to ? new Date(q.to) : new Date()
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 7 * DAY)
  if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime()) || from > to) return null
  return { from, to }
}

function mergeCounts(objs: unknown[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const o of objs) for (const [k, v] of Object.entries((o as Record<string, number>) ?? {})) out[k] = (out[k] ?? 0) + Number(v)
  return out
}

export default async function analyticsReadRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  async function guard(request: { user: any }, reply: FastifyReply, id: string, manage = false) {
    const access = await getAnalyticsAccess(actorFromClaims(request.user), id)
    if (!access.scene) {
      reply.status(404).send({ error: 'Not found' })
      return null
    }
    if (!(manage ? access.canManage : access.canRead)) {
      reply.status(403).send({ error: 'Forbidden' })
      return null
    }
    return access.scene
  }

  app.get('/api/analytics/locations', async (request, reply) => {
    const actor = actorFromClaims(request.user)
    const all = await db.select().from(analyticsScenes)
    const readable = []
    for (const s of all) if ((await getAnalyticsAccess(actor, s.id)).canRead) readable.push(s)
    return reply.send({
      scenes: readable.map((s) => ({
        id: s.id,
        locationKey: s.locationKey,
        kind: s.kind,
        title: s.title,
        claimStatus: s.claimStatus,
        walletVisibility: s.walletVisibility,
        verifiedSessionShare: s.verifiedSessionShare,
      })),
    })
  })

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/api/analytics/locations/:id/summary', async (request, reply) => {
    const r = range(request.query)
    if (!r) return reply.status(400).send({ error: 'from/to must be ISO dates with from <= to' })
    const scene = await guard(request, reply, request.params.id)
    if (!scene) return
    const rows = await db
      .select()
      .from(analyticsRollupHourly)
      .where(and(eq(analyticsRollupHourly.sceneId, scene.id), gte(analyticsRollupHourly.hour, r.from), lte(analyticsRollupHourly.hour, r.to)))
    const sessions = rows.reduce((a, x) => a + x.sessions, 0)
    const [u] = rowsOf<{ n: number }>(
      await db.execute(sql`select count(distinct visitor_hash)::int as n from analytics_sessions where scene_id = ${scene.id} and started_at >= ${r.from} and started_at <= ${r.to}`),
    )
    return reply.send({
      sessions,
      uniqueVisitors: Number(u.n),
      newVisitors: rows.reduce((a, x) => a + x.newVisitors, 0),
      returningVisitors: rows.reduce((a, x) => a + x.returningVisitors, 0),
      peakConcurrency: rows.reduce((a, x) => Math.max(a, x.peakConcurrency), 0),
      dwellAvgSec: sessions ? Math.round(rows.reduce((a, x) => a + x.dwellAvgSec * x.sessions, 0) / sessions) : 0,
      verifiedShare: scene.verifiedSessionShare,
      interactions: mergeCounts(rows.map((x) => x.interactions)),
      emotes: mergeCounts(rows.map((x) => x.emotes)),
      countries: mergeCounts(rows.map((x) => x.countries)),
      platforms: mergeCounts(rows.map((x) => x.platforms)),
    })
  })

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; bucket?: string } }>(
    '/api/analytics/locations/:id/timeseries',
    async (request, reply) => {
      const r = range(request.query)
      const bucket = request.query.bucket === 'day' ? 'day' : 'hour'
      if (!r) return reply.status(400).send({ error: 'from/to must be ISO dates with from <= to' })
      const scene = await guard(request, reply, request.params.id)
      if (!scene) return
      const points = rowsOf<{ t: Date; sessions: number; unique_visitors: number; peak: number; dwell: number }>(
        await db.execute(sql`
          select date_trunc(${bucket}, hour) as t, sum(sessions)::int as sessions, sum(unique_visitors)::int as unique_visitors,
                 max(peak_concurrency)::int as peak,
                 coalesce(round(sum(dwell_avg_sec * sessions)::numeric / nullif(sum(sessions), 0)), 0)::int as dwell
          from analytics_rollup_hourly
          where scene_id = ${scene.id} and hour >= ${r.from} and hour <= ${r.to}
          group by 1 order by 1`),
      )
      return reply.send({
        points: points.map((p) => ({ t: p.t, sessions: Number(p.sessions), uniqueVisitors: Number(p.unique_visitors), peakConcurrency: Number(p.peak), dwellAvgSec: Number(p.dwell) })),
      })
    },
  )

  app.get<{ Params: { id: string } }>('/api/analytics/locations/:id/live', async (request, reply) => {
    const scene = await guard(request, reply, request.params.id)
    if (!scene) return
    const since = new Date(Date.now() - 60_000)
    const live = await db
      .select({ id: analyticsSessions.id })
      .from(analyticsSessions)
      .where(and(eq(analyticsSessions.sceneId, scene.id), gte(analyticsSessions.lastSeenAt, since)))
    const ids = live.map((s) => s.id)
    const positions = ids.length
      ? rowsOf<{ x: number; z: number }>(
          await db.execute(sql`
            select distinct on (session_id) x, z from analytics_positions
            where scene_id = ${scene.id} and session_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
            order by session_id, occurred_at desc`),
        )
      : []
    return reply.send({ count: ids.length, positions: positions.map((p) => ({ x: Number(p.x), z: Number(p.z) })) })
  })

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/api/analytics/locations/:id/heatmap', async (request, reply) => {
    const r = range(request.query)
    if (!r) return reply.status(400).send({ error: 'from/to must be ISO dates with from <= to' })
    const scene = await guard(request, reply, request.params.id)
    if (!scene) return
    const cells = rowsOf<{ x: number; z: number; dwell: number; visits: number }>(
      await db.execute(sql`
        select cell_x as x, cell_z as z, sum(dwell_sec)::int as dwell, sum(visits)::int as visits
        from analytics_heatmap_daily
        where scene_id = ${scene.id} and day >= ${r.from.toISOString().slice(0, 10)}::date and day <= ${r.to.toISOString().slice(0, 10)}::date
        group by 1, 2 order by 1, 2`),
    )
    return reply.send({ cells: cells.map((c) => ({ x: Number(c.x), z: Number(c.z), dwellSec: Number(c.dwell), visits: Number(c.visits) })) })
  })

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>('/api/analytics/locations/:id/sessions', async (request, reply) => {
    const scene = await guard(request, reply, request.params.id)
    if (!scene) return
    const limit = Math.min(Math.max(parseInt(request.query.limit || '50', 10) || 50, 1), 200)
    let where = eq(analyticsSessions.sceneId, scene.id)
    if (request.query.cursor) {
      const [ts, id] = request.query.cursor.split('|')
      const t = new Date(ts)
      if (Number.isNaN(t.getTime()) || !id) return reply.status(400).send({ error: 'invalid cursor' })
      where = and(where, or(lt(analyticsSessions.startedAt, t), and(eq(analyticsSessions.startedAt, t), lt(analyticsSessions.id, id))))!
    }
    const rows = await db
      .select()
      .from(analyticsSessions)
      .where(where)
      .orderBy(desc(analyticsSessions.startedAt), desc(analyticsSessions.id))
      .limit(limit + 1)
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return reply.send({
      sessions: page.map(({ visitorHash: _h, ...s }) => s),
      nextCursor: rows.length > limit && last ? `${last.startedAt.toISOString()}|${last.id}` : null,
    })
  })

  app.patch<{ Params: { id: string }; Body: { walletVisibility?: unknown } }>('/api/analytics/locations/:id', async (request, reply) => {
    if (typeof request.body?.walletVisibility !== 'boolean') return reply.status(400).send({ error: 'walletVisibility must be a boolean' })
    const scene = await guard(request, reply, request.params.id, true)
    if (!scene) return
    const on = request.body.walletVisibility
    const [updated] = await db.update(analyticsScenes).set({ walletVisibility: on, updatedAt: new Date() }).where(eq(analyticsScenes.id, scene.id)).returning()
    if (!on) await db.update(analyticsSessions).set({ wallet: null, displayName: null }).where(eq(analyticsSessions.sceneId, scene.id))
    return reply.send({ scene: { id: updated.id, walletVisibility: updated.walletVisibility } })
  })

  app.post('/api/analytics/me/delete', async (request, reply) => {
    const actor = actorFromClaims(request.user)
    if (!actor.userId || !actor.verified) return reply.status(403).send({ error: 'Forbidden' })
    const wallets = new Set(await verifiedWalletsOf(actor.userId))
    if (actor.wallet) wallets.add(actor.wallet)
    if (!wallets.size) return reply.status(400).send({ error: 'Sign in with your wallet to delete your visitor data' })
    const deleted = { sessions: 0, events: 0, positions: 0, copresence: 0 }
    const all = await db.select({ id: analyticsScenes.id, salt: analyticsScenes.salt }).from(analyticsScenes)
    for (const scene of all) {
      const hashes = [...wallets].map((w) => visitorHash(scene.salt, w))
      const sessions = await db
        .delete(analyticsSessions)
        .where(and(eq(analyticsSessions.sceneId, scene.id), inArray(analyticsSessions.visitorHash, hashes)))
        .returning({ id: analyticsSessions.id })
      deleted.sessions += sessions.length
      deleted.events += (await db.delete(analyticsEvents).where(and(eq(analyticsEvents.sceneId, scene.id), inArray(analyticsEvents.visitorHash, hashes))).returning({ id: analyticsEvents.id })).length
      if (sessions.length) {
        deleted.positions += (
          await db
            .delete(analyticsPositions)
            .where(and(eq(analyticsPositions.sceneId, scene.id), inArray(analyticsPositions.sessionId, sessions.map((s) => s.id))))
            .returning({ id: analyticsPositions.id })
        ).length
      }
      deleted.copresence += (
        await db
          .delete(analyticsCopresenceDaily)
          .where(and(eq(analyticsCopresenceDaily.sceneId, scene.id), or(inArray(analyticsCopresenceDaily.visitorA, hashes), inArray(analyticsCopresenceDaily.visitorB, hashes))))
          .returning({ day: analyticsCopresenceDaily.day })
      ).length
    }
    return reply.send({ deleted })
  })
}
```

Register in `app.ts`. The `/api/analytics/locations` list checks access per scene. That's fine at today's scale; it gets revisited in Sub-project D.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd apps/server && pnpm test test/analytics-read.test.ts && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(analytics): read API, wallet visibility toggle and delete-my-data"
```

---

### Task 12: Room cleanup, visitor-safe `createVLM`, docs

**Files:**
- Modify: `apps/server/src/ws/VLMSceneRoom.ts`, `apps/server/src/ws/scene-guard.ts`, `packages/vlm-client/src/http.ts`, `packages/vlm-adapter-dcl/src/index.ts`, `apps/docs/src/content/docs/sdk/decentraland/install.md`, `apps/docs/src/content/docs/dashboard/analytics.md`
- Create: `apps/docs/src/content/docs/privacy.md`
- Test: `apps/server/test/scene-room.test.ts` (add cases)

**Interfaces:**
- Consumes: `/api/analytics/claims/check` (Task 10); `locationKeyFor` (Task 1); `startVLMAnalytics`, `getAnalyticsSceneRef` (Task 4).
- Produces: `VLMHttpClient.checkAnalyticsClaim(locationKey: string): Promise<{ eligible: boolean; claimed: boolean; mine: boolean }>`.

- [ ] **Step 1: Add the failing room tests** — append to `apps/server/test/scene-room.test.ts` inside the top-level `describe` (it already has `startGameServer`, `joinScene`, `createUser`, `createScene`, `tokenFor`). `joinScene` joins as `clientType: 'analytics'`, so add a `host` join inline:

```ts
  it('a client claiming clientType host without edit access is treated as a visitor', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const { Client } = await import('colyseus.js')
    const stranger = await createUser()
    const c = new Client(gs.url)
    const hostRoom = await c.joinOrCreate('vlm_scene', { sceneId: scene.id, sessionToken: tokenFor(stranger), clientType: 'host' })
    const got: string[] = []
    hostRoom.onMessage('*', (type: string | number) => got.push(String(type)))
    const visitor = await joinScene(gs.url, scene.id)
    visitor.room.send('session_action', { action: 'x' })
    visitor.room.send('send_player_position', { x: 1 })
    await new Promise((r) => setTimeout(r, 400))
    expect(got).not.toContain('add_session_action')
    expect(got).not.toContain('send_player_position')
    hostRoom.leave()
  })

  it('legacy analytics messages are accepted and ignored (no error, no relay)', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const host = await joinScene(gs.url, scene.id, tokenFor(owner))
    const visitor = await joinScene(gs.url, scene.id)
    visitor.room.send('session_start', {})
    visitor.room.send('path_segments_add', { pathSegments: [] })
    await visitor.expectNone('vlm_error')
    await host.expectNone('add_session_action')
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server && pnpm test test/scene-room.test.ts`
Expected: the host-relay test FAILS (`send_player_position` is relayed to the fake host).

- [ ] **Step 3: Room changes in `apps/server/src/ws/VLMSceneRoom.ts`**

- Replace the bodies of the `session_start`, `session_action`, `session_end`, `send_player_position`, `request_player_position` and `path_segments_add` handlers with a single helper:

```ts
  private warnedDeprecated = new Set<string>()
  private deprecatedAnalytics(type: string) {
    if (this.warnedDeprecated.has(type)) return
    this.warnedDeprecated.add(type)
    console.warn(`[VLMSceneRoom] '${type}' is deprecated — analytics now go to POST /api/ingest (scene ${this.sceneId})`)
  }
```

  Each handler then becomes `this.onMessage('<type>', () => this.deprecatedAnalytics('<type>'))`.
- Delete `broadcastToHosts` and every call to it.
- In `onJoin`, decide `clientType` from access instead of the join option:

```ts
    const requested = options.clientType || 'analytics'
    const access = await this.getAccess(client)
    const canHost = ['admin', 'owner', 'org', 'editor'].includes(access.level)
    const clientType = requested === 'host' && canHost ? 'host' : 'analytics'
```

  (`getAccess` already exists in the room; keep the rest of `onJoin` as it is.)
- In `apps/server/src/ws/scene-guard.ts`, the `OPEN` set keeps these message types (they're harmless no-ops now). Update the comment above it to say they're deprecated analytics messages.

- [ ] **Step 4: Run the room tests**

Run: `cd apps/server && pnpm test test/scene-room.test.ts && pnpm test`
Expected: PASS.

- [ ] **Step 5: HTTP client** — add to `packages/vlm-client/src/http.ts` (in the class, near the scene methods):

```ts
  async checkAnalyticsClaim(locationKey: string): Promise<{ eligible: boolean; claimed: boolean; mine: boolean }> {
    return this._fetch(`/api/analytics/claims/check?locationKey=${encodeURIComponent(locationKey)}`)
  }
```

- [ ] **Step 6: Visitor-safe `createVLM`** — in `packages/vlm-adapter-dcl/src/index.ts`:

1. Keep analytics start (Task 4) at the very top.
2. Move the HUD renderer creation into a helper `ensureRenderer()` that creates `DclHUDRenderer` the first time it's called. When `config.sceneId` is set, call it immediately (current behavior).
3. In the no-`sceneId` branch, after `await vlm.authenticate(...)`:

```ts
    const user = await adapter.getPlatformUser()
    const sceneRef = await getAnalyticsSceneRef()
    const wallet = user.isGuest ? null : (user.walletAddress || '').toLowerCase() || null
    let eligible = false
    if (wallet) {
      try {
        eligible = (await vlm.httpClient.checkAnalyticsClaim(locationKeyFor(sceneRef, wallet))).eligible
      } catch {
        eligible = false
      }
    }
    if (!eligible) {
      console.log('[VLM] Analytics running; setup tools are only shown to this LAND or World owner')
      return vlm
    }
    const renderer = ensureRenderer()
    // …existing two-phase flow continues unchanged, using `renderer`…
```

   Import `locationKeyFor` from `vlm-shared` and `getAnalyticsSceneRef` from `./analytics.js`. A visitor gets analytics and nothing else: no HUD, no scene list, no auto-created scene. The `error` path at the bottom must also call `ensureRenderer()` only when `config.sceneId` was given. Otherwise it just logs.

4. A brand-new LAND owner whose location has no analytics row yet gets `eligible: false` (no row exists). Their first visit creates the row through ingest within about 5 seconds. Retry the check once, 10 seconds later, before giving up:

```ts
    if (!eligible && wallet) {
      await new Promise((r) => setTimeout(r, 10_000))
      try { eligible = (await vlm.httpClient.checkAnalyticsClaim(locationKeyFor(sceneRef, wallet))).eligible } catch {}
    }
```

   DCL's runtime supports `setTimeout`. If `tsc` complains in the adapter, use an `engine` system timer instead, like `showNotice` does.

- [ ] **Step 7: Typecheck the SDK**

Run: `pnpm --filter vlm-shared build && pnpm --filter vlm-client build && pnpm --filter vlm-core build && pnpm --filter vlm-adapter-dcl typecheck && pnpm --filter vlm-core test`
Expected: clean.

- [ ] **Step 8: Docs**

`apps/docs/src/content/docs/privacy.md`:

```md
---
title: Privacy & visitor data
description: What VLM analytics collect in Decentraland scenes, and how to delete your data.
---

## What is collected
When a scene uses VLM, the scene sends anonymous usage events to VLM while you're inside its parcels: when you arrive and leave, where you walk (sampled every few seconds), what you click or hover, videos you play, emotes, and camera mode.

## How you're identified
- By default VLM stores a **per-scene pseudonym**: a keyed hash of your wallet (or guest id). It can't be linked across scenes and it isn't your wallet address.
- **Display names and wallet addresses are only stored** if the scene owner turns on wallet visibility. When they do, the scene shows a notice when you enter, and only data collected after that notice includes your wallet and name.
- **IP addresses are never stored.** VLM uses them briefly to limit abuse and to look up your country, then discards them.

## Retention
Raw events are kept for the scene owner's plan (7–365 days), 30 days for unclaimed scenes, and 7 days for local previews. Aggregated statistics (counts, heatmaps) are kept longer and contain no identities.

## Deleting your data
Sign in to the VLM dashboard with your wallet and use **Delete my visitor data**, or call `POST /api/analytics/me/delete` with your session token. This removes your sessions, events and positions from every scene.
```

In `sdk/decentraland/install.md`, add a section near the top:

```md
## Analytics only (one line)

```ts
import { startVLMAnalytics } from 'vlm-adapter-dcl/analytics'
startVLMAnalytics()
```

This starts collecting visits, movement, interactions, video and emote analytics. No VLM account is needed. When you're ready, sign in to the dashboard with the wallet that owns the LAND or World and **claim** the scene to see its data. `createVLM()` also starts analytics by default (`createVLM({ analytics: false })` turns it off). Visitors never see VLM setup screens: only the LAND or World owner does.

Track your own events with `vlm.track('bought_ticket', { tier: 'vip' })`.
```

Also fix the docs drift the survey found in the same file: replace `vlm.setState` / `vlm.getState` with `vlm.setUserState` / `vlm.getUserState`.

In `dashboard/analytics.md`, replace the feature list with what exists now: claims, summary, timeseries, live, heatmap, sessions, wallet visibility. Note that the charts UI arrives with the next dashboard update, and that the API endpoints are listed under `/api/analytics/locations/...`.

- [ ] **Step 9: Full verification**

Run: `cd ~/-VLM/vlm-v2 && export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH && pnpm --filter vlm-shared build && pnpm --filter vlm-server test && pnpm --filter vlm-core test && pnpm typecheck`
Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add apps packages
git commit -m "feat(analytics): retire room analytics, visitor-safe createVLM, privacy and install docs"
```
