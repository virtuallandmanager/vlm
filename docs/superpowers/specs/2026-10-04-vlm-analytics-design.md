# VLM Analytics: Zero-Config Scene Analytics for Decentraland

**Date:** 2026-10-04
**Status:** Design approved in conversation; awaiting written-spec review
**Related:** `2026-10-04-vlm-venues-design.md` (event/booking reports reuse this data)

## 1. Goal

Any Decentraland creator can drop VLM into a scene — a one-line import, or a smart item in Creator Hub — and immediately collect thorough, privacy-respecting analytics without creating a VLM account first. The creator later signs in with a wallet that controls the scene's LAND or World and claims the data. The same data powers general scene analytics for every install and per-event / per-booking reports for venues.

This spec covers the whole analytics program so the pieces fit, but only **Sub-projects A, B and C** are specified to implementation depth. D and E get their own spec → plan → build cycles.

| # | Sub-project | Spec depth here |
|---|---|---|
| A | Collector SDK + HTTP ingest + scene identity + abuse limits + room analytics cleanup | **Full** |
| B | Storage, rollups, heatmaps, retention, privacy | **Full** |
| C | Zero-config scene registry + claiming | **Full** |
| D | Dashboard: charts, heatmaps on parcel map, live "here now", event/booking reports, CSV export | Outline |
| E | Install paths: one-line import package, Creator Hub Script smart item, starter scene, docs | Outline |

### Decisions already made

| Topic | Decision |
|---|---|
| Audience | Both: scene owners (any creator) and event/booking reports, from one dataset |
| Onboarding | Zero-config: collection starts on install; creator claims later by proving LAND/World control |
| Auto-collected | Visits & dwell; movement heatmaps; interactions (clicks, hovers, video, sound, giveaways); social & expression (emotes, camera mode, co-presence) |
| Transport | HTTP batches with flush rules (no analytics over Colyseus) |
| Identity | Per-scene salted hash by default; owner opt-in reveals wallets + display names, with in-world notice |
| IPs | Used transiently (rate limit, country lookup), never stored; country stored |
| Retention | Raw data kept for the claimer's tier window (7/30/90/365/unlimited days, `TIER_LIMITS.analyticsRetentionDays`); unclaimed scenes 30 days; preview scenes 7 days; rollups kept forever |

## 2. Current state (findings)

From review of `vlm-v2` at `edb1050`:

- Tables `analytics_sessions` and `analytics_actions` exist (`apps/server/src/db/schema.ts`) but **nothing writes to them**. `routes/analytics.ts` has two read-only endpoints; the dashboard (`apps/web/src/app/(dashboard)/analytics/page.tsx`) reads them and always shows zeros.
- Room handlers `session_start`, `session_action`, `session_end`, `send_player_position`, `path_segments_add` (`ws/VLMSceneRoom.ts`) persist nothing; `onLeave` never closes a session. `broadcastToHosts` relays every visitor's actions/positions to any client that claims `clientType: 'host'` in its join options (privacy leak).
- `vlm-core` sends `session_start` (without platform/device/guest fields), `session_end` on `destroy()`, and `recordAction()` only when the scene developer calls it. Nothing is collected automatically; there is no queue, batching or retry; `ColyseusManager.send` throws without a room.
- Install: `createVLM()` without a `sceneId` runs the owner setup flow (scene picker / auto-create) for **every visitor**. `scene.json` `vlm.sceneId` is read but not used to connect.
- The smart item package uses the SDK6 `asset.json` params schema, which current Creator Hub does not load.
- No indexes, aggregation, retention purge, export, consent or anonymization exist.

### Platform facts (from research spikes, 2026-10-04)

- Creator Hub supports a **Script component** (SDK 7.15+, Creator Hub 0.30+): a `.ts` class whose public properties appear as editable params. This is the path for the no-code smart item (Sub-project E). Unverified: whether custom items carry scripts between users; whether Creator Hub can add an npm dependency without a terminal; third-party catalog submission.
- Genesis City deploy rights = LAND/Estate owner, updateOperator, updateManagers, approvedForAll — exposed per parcel by `GET https://peer.decentraland.org/lambdas/parcels/{x}/{y}/operators`. Active scene per pointer: `POST https://peer.decentraland.org/content/entities/active` `{pointers}`.
- Worlds: `GET https://worlds-content-server.decentraland.org/world/{name}/permissions` returns `owner` and the deployment allow-list; `/world/{name}/about` returns the active scene URNs.
- Signed fetch proves the **player's** wallet, not the scene's origin. Any data a scene sends can be spoofed by someone running a custom client; ingestion can bound abuse but not authenticate origin.

---

## 3. Sub-project A: Collector SDK and ingest

### 3.1 Event envelope

```ts
interface AnalyticsEvent {
  t: number          // client epoch ms
  type: AnalyticsEventType
  seq: number        // per-session, monotonically increasing
  data?: Record<string, unknown>   // type-specific, ≤ 2 KB serialized
}

type AnalyticsEventType =
  | 'session.start'      // data: platform, device, realm, isGuest, cameraMode, sdkVersion
  | 'session.heartbeat'  // data: cameraMode, inScene (bool)
  | 'session.leave'      // data: reason: 'left_parcels' | 'destroy'
  | 'pos'                // data: x, y, z, ry (heading deg), m (moving bool)
  | 'interact'           // data: kind: 'click'|'hover', target: elementId|entityName, button
  | 'video'              // data: elementId, state: 'play'|'pause'|'end'|'error', src?
  | 'sound'              // data: elementId, state: 'play'|'stop'
  | 'emote'              // data: emote
  | 'giveaway'           // data: giveawayId, result
  | 'custom'             // data: name, props (from VLM.track())
```

Batch request body:

```ts
interface IngestBatch {
  v: 1
  sessionId: string            // client UUID, new per visit
  visitorId: string            // wallet (lowercased) for wallet users; persistent guest UUID for guests
  scene: {
    realm: string              // getRealm().realmInfo.realmName / baseUrl host
    isWorld: boolean
    worldName?: string
    baseParcel?: string        // "x,y"
    parcels?: string[]
    entityId?: string          // getSceneInformation().urn entity hash
    title?: string
  }
  events: AnalyticsEvent[]     // 1..100
}
```

### 3.2 Collection rules (SDK)

- **Sessions:** a session starts when the player first stands inside the scene's parcels and the collector has initialized; `session.leave` is emitted when the player leaves the parcels (detected by the per-frame position check) or on `destroy()`. Re-entering within 60 s continues the same session; later starts a new one.
- **Heartbeat:** every 15 s while in the scene.
- **Position:** sample every 3 s while the player moved > 0.5 m since the last sample, every 15 s while idle; only while inside the scene's parcels; coordinates relative to the scene's base parcel; rounded to 0.1 m; heading rounded to 5°.
- **Interactions:** VLM elements emit `interact` automatically via their pointer handlers; additionally the DCL collector polls the input system each frame for pointer down/hover on any entity with `PointerEvents`, reporting the entity's `Name` component (or entity number if none). Hovers are deduplicated per target per 10 s.
- **Video/sound:** VLM video and sound elements report state changes; the DCL collector also attaches `videoEventsSystem` listeners to non-VLM `VideoPlayer` entities it discovers.
- **Emotes:** read from the player's `AvatarEmoteCommand` changes.
- **Camera mode:** from `CameraMode`; included in `session.start` and each heartbeat.
- **Custom:** `vlm.track(name, props?)` (the existing `recordAction` becomes an alias).
- **Queue and flush:** in-memory queue, max 500 events (drop oldest `pos` first, then oldest `session.heartbeat`). Flush when any of: 5 s elapsed since last flush; 50 events queued; a high-priority event is queued (`session.start`, `session.leave`, `interact` click, `video`, `emote`, `giveaway`, `custom`). On failure retry with exponential backoff (1 s → 30 s, jittered); on 4xx other than 429 drop the batch and log once.
- **Transport:** `signedFetch` POST when available (DCL), plain `fetch` otherwise; the batch is the request body so it is covered by the signature.
- **Preview:** collection runs in preview too, tagged by realm; see §5.2.
- **Opt-in notice:** if the ingest response says `notice: true` for this scene (wallet visibility enabled) and the visitor hasn't seen it this session, the SDK shows a one-time on-screen notice ("This scene records visitor wallets and names for analytics — powered by VLM") via the adapter's UI. Until the notice has been shown, the SDK sends `noticeShown: false` in the batch and the server stores hashed identity only.

### 3.3 Platform adapter additions (`vlm-shared` `VLMPlatformAdapter`)

Optional capability methods (adapters without them simply don't produce those event types):

```ts
interface AnalyticsProbe {
  getPlayerPose(): { position: Vec3; headingDeg: number } | null
  getCameraMode(): 'first' | 'third' | null
  isInsideScene(position: Vec3): boolean
  onAnyPointerEvent(cb: (e: { kind: 'click' | 'hover'; target: string; button?: string }) => void): () => void
  onAnyVideoEvent(cb: (e: { target: string; state: string; src?: string }) => void): () => void
  onEmote(cb: (emote: string) => void): () => void
  postSigned(url: string, body: unknown): Promise<{ status: number; json: unknown }>
  showNotice(text: string): void
}
```

`VLMPlatformAdapter` gains `analytics?: AnalyticsProbe`. `DclAdapter` implements it.

### 3.4 SDK packaging for this sub-project

- Collector lives in `packages/vlm-core/src/analytics/` (`Collector`, `EventQueue`, `Transport`), platform-agnostic, driven by the adapter's `registerSystem`.
- `createVLM()` starts the collector by default (`analytics: false` disables).
- New analytics-only entry: `import { startVLMAnalytics } from 'vlm-adapter-dcl/analytics'` — no Colyseus, no HUD, no auth flow, no scene picker; small bundle. Sub-project E turns this into the one-line import and smart item.
- Fix: visitors never see the owner setup flow. `createVLM()` without a `sceneId` only shows setup UI when the authenticated wallet passes the claim check for this location (§5.3); everyone else just gets analytics.

### 3.5 Ingest endpoint

`POST /api/ingest` (no JWT; public):

1. **Size and shape:** body ≤ 256 KB; 1–100 events; each event ≤ 2 KB; unknown types rejected; `t` within ±10 min of server time (else clamped and flagged `skewed`).
2. **Signer:** if DCL signed-fetch headers verify, `signer = wallet` and the batch is **verified**; else **unverified** (guest/plain fetch). A verified signer must equal `visitorId` (else 400).
3. **Scene resolution:** resolve `scene` to an `analytics_scenes` row via the registry (§5.2). Unresolvable → 422 `{ error: 'unknown_scene' }`.
4. **Rate limits** (Redis in scalable/cloud modes, in-process otherwise):
   - per signer (or per IP for unverified): 1 request / 2 s burst 3, 200 events / min;
   - per scene: 5,000 events / min; above it, `pos` events are sampled (kept with probability 5000/rate) and other events kept;
   - per unverified IP: 60 events / min.
   429 with `retryAfter` when exceeded.
5. **Country:** derived from the request IP with an embedded GeoLite-style country database (MaxMind GeoLite2-Country or DB-IP Lite, bundled at build); IP is not stored or logged.
6. **Write:** insert events/positions, upsert the session (§4); respond `{ ok: true, notice: boolean, accepted: n }`.

### 3.6 Room cleanup

- `VLMSceneRoom` `session_start`, `session_action`, `session_end`, `send_player_position`, `path_segments_add` stop relaying analytics; they log a one-time deprecation warning per room. `broadcastToHosts` is removed.
- `clientType: 'host'` is honored only when the actor passes `getSceneAccess(...).level` in owner/admin/org/editor; otherwise the client is treated as `analytics`.
- Live "here now" comes from sessions with `last_seen_at > now − 60 s` (§4), read via REST.

## 4. Sub-project B: Storage, rollups, privacy

### 4.1 Tables

```ts
analytics_scenes {
  id uuid pk
  kind 'parcels' | 'world'
  locationKey text unique      // 'gc:<baseParcel>' | 'world:<name>' | 'preview:<signer>:<baseParcel>'
  realm text
  baseParcel text null
  parcels text[]
  worldName text null
  activeEntityId text null
  title text null
  salt bytea                   // 32 random bytes, never leaves the server
  claimedByUserId uuid null → users
  vlmSceneId uuid null → scenes
  claimedAt timestamptz null
  walletVisibility boolean default false
  isPreview boolean default false
  verifiedSessionShare real    // maintained by rollup job
  lastEntityCheckAt timestamptz
  createdAt, updatedAt
}

analytics_sessions (replaces the existing table; old one dropped — it holds no data)
{
  id uuid pk                   // = client sessionId
  sceneId uuid → analytics_scenes (cascade)
  visitorHash bytea            // HMAC-SHA256(salt, visitorId)
  wallet text null             // only when walletVisibility && noticeShown
  displayName text null        // same rule
  isGuest boolean
  verified boolean
  platform text, device text, realm text, country char(2) null, cameraMode text null
  isReturning boolean          // visitorHash seen in this scene before
  startedAt, lastSeenAt timestamptz, endedAt timestamptz null
  durationSec int              // lastSeenAt − startedAt, maintained on write
  eventCount int
  INDEX (sceneId, startedAt), INDEX (sceneId, lastSeenAt), INDEX (sceneId, visitorHash)
}

analytics_events  PARTITION BY RANGE (occurredAt), daily partitions
{
  sceneId uuid, sessionId uuid, visitorHash bytea,
  type text, occurredAt timestamptz, receivedAt timestamptz,
  verified boolean, data jsonb
  INDEX (sceneId, occurredAt), INDEX (sessionId)
}

analytics_positions  PARTITION BY RANGE (occurredAt), daily partitions
{
  sceneId uuid, sessionId uuid, occurredAt timestamptz,
  x real, y real, z real, heading smallint, moving boolean
  INDEX (sceneId, occurredAt)
}

analytics_rollup_hourly
{
  sceneId uuid, hour timestamptz, PRIMARY KEY (sceneId, hour)
  sessions int, uniqueVisitors int, newVisitors int, returningVisitors int,
  verifiedSessions int, peakConcurrency int,
  dwellAvgSec int, dwellP50Sec int, dwellP90Sec int,
  interactions jsonb   // { target: count } top 100
  video jsonb          // { elementId: { plays, watchSec } }
  emotes jsonb         // { emote: count }
  countries jsonb      // { CC: sessions }
  platforms jsonb      // { platform: sessions }
  cameraModes jsonb    // { first|third: sessions }
}

analytics_heatmap_daily
{
  sceneId uuid, day date, cellX smallint, cellZ smallint,   // 1 m cells relative to base parcel
  dwellSec int, visits int
  PRIMARY KEY (sceneId, day, cellX, cellZ)
}

analytics_copresence_daily
{
  sceneId uuid, day date, visitorA bytea, visitorB bytea,  // ordered pair of hashes
  overlapSec int
  PRIMARY KEY (sceneId, day, visitorA, visitorB)
}
```

Partitions are created ahead (today + 7 days) and dropped by the retention job via `DETACH`/`DROP PARTITION`. Partitioning and the partition-management SQL are raw SQL (Drizzle can't express them) applied idempotently at boot, like `ensureVenueConstraints`.

### 4.2 Session maintenance

On ingest: upsert the session row (`startedAt` = earliest event, `lastSeenAt` = latest, `eventCount += n`, `durationSec`), set `endedAt` on `session.leave`. A sweep (every 30 s, same job runner as the venue lifecycle sweep) closes sessions with `lastSeenAt < now − 60 s` and `endedAt` null by setting `endedAt = lastSeenAt`.

### 4.3 Rollups

A rollup job every 5 minutes recomputes the current and previous hour (and any hour touched by late events, tracked in a small `analytics_dirty_hours` table) from raw tables:

- **Concurrency:** peak number of sessions whose `[startedAt, coalesce(endedAt, lastSeenAt)]` overlap, computed at 1-minute resolution.
- **Dwell:** from sessions that started in the hour.
- **Heatmap:** each position sample adds `min(gap to next sample, 15 s)` dwell seconds to its 1 m cell; visits = distinct sessions per cell.
- **Co-presence:** for each pair of sessions in the same scene overlapping ≥ 5 min in a day, add overlap seconds to the pair of visitor hashes (capped at the top 1,000 pairs per scene-day).
- **Verified share:** `verifiedSessions / sessions` over the trailing 7 days into `analytics_scenes.verifiedSessionShare`.

### 4.4 Retention

Daily job: for each scene, `retentionDays` = the claimer's tier `analyticsRetentionDays` (Infinity → no purge), 30 if unclaimed, 7 if preview. Raw data older than `now − retentionDays` is purged — so claiming on a tier shorter than 30 days drops older raw data at the next purge (rollups keep the history). Raw `analytics_events`, `analytics_positions` and `analytics_sessions` older than retention are deleted (partition drop when the whole partition is past retention for every scene; otherwise row delete for the affected scenes). Rollups, heatmaps and co-presence are kept.

### 4.5 Privacy rules

- `visitorHash = HMAC-SHA256(scene.salt, lowercase(wallet) | guestUuid)`. Hashes from different scenes can't be joined.
- Plain `wallet` and `displayName` are stored only if `walletVisibility = true` for the scene **and** the batch reports `noticeShown: true`. Turning visibility on never reveals earlier data; turning it off nulls the plain columns for all sessions.
- IPs are never stored or logged by the ingest route (Fastify request logging for `/api/ingest` omits the IP).
- `POST /api/analytics/me/delete` (verified wallet JWT): for every scene, recompute the visitor's hash and delete their sessions, events, positions and co-presence rows; responds with counts. Also removes them from future rollups (existing rollup counts are not decremented).
- Docs gain a privacy page describing exactly what is collected; Terms need a data processing section before outside scene owners onboard (non-code task, tracked).

## 5. Sub-project C: Registry and claiming

### 5.1 Location keys

- Genesis City: `gc:<baseParcel>` (e.g. `gc:-12,34`), realm ignored for production realms (`main`, catalyst hosts).
- Worlds: `world:<lowercased name>`.
- Preview / localhost realms (`isPreview` or realm host `localhost`/`127.0.0.1`): `preview:<signer wallet or 'anon'>:<baseParcel>`; `isPreview = true`; never merged with production, retention 7 days, max 10,000 events/day.

### 5.2 Resolution and validation (ingest step 3)

- Look up `analytics_scenes` by `locationKey`. If found and `lastEntityCheckAt` < 10 min ago and `activeEntityId` matches the batch's `entityId` (when provided), accept.
- Otherwise validate against Decentraland:
  - Genesis City: `POST {catalyst}/content/entities/active { pointers: [baseParcel] }` → the active entity's `metadata.scene.parcels` must contain every parcel the batch claims and its `base` must equal `baseParcel`.
  - World: `GET worlds-content-server/world/{name}/about` must return 200 with a scene URN; if the batch has `entityId` it must be one of the active scene URNs.
  - On success, upsert the row (create with a fresh salt if new), set `activeEntityId`, `parcels`, `title`, `lastEntityCheckAt`.
  - On failure → 422. Validation results (success or failure) are cached for 10 minutes per location key so a burst of bad batches costs one upstream call.
- Upstream calls use a 3 s timeout; on upstream error with an existing row, accept (stale) and retry validation next time; with no row, 503 `retryAfter: 30`.

### 5.3 Claiming

`POST /api/analytics/claims` (JWT, verified wallet required) `{ locationKey }`:

- Genesis City: for every parcel in the row's `parcels`, `GET {catalyst}/lambdas/parcels/{x}/{y}/operators`; the wallet must appear as `owner`, `operator`, `updateOperator`, in `updateManagers`, or in `approvedForAll` for **all** parcels. If the endpoint omits Estate-level rights, fall back to the LAND-permissions subgraph for that parcel.
- World: `GET worlds-content-server/world/{name}/permissions` → `owner` must equal the wallet. Wallets in the deployment allow-list may be added later as viewers by the owner (not owners).
- On success: create a VLM scene (or link `vlmSceneId` if the claimer passes one they own), set `claimedByUserId`, `claimedAt`; the claimer becomes the VLM scene owner; existing collaborator roles on that VLM scene grant analytics read access (viewer+).
- `GET /api/analytics/claims/eligible` (JWT) lists unclaimed or claimable registry rows the wallet controls, by checking the wallet's lands via the same endpoints for rows with recent traffic (bounded to 50 checks per call).
- **Re-verification:** a daily job re-checks each claim; on failure it sets the claim to `lapsed` (owner keeps read-only access to data up to the lapse date for 30 days) and the location becomes claimable by the new controller.
- The `createVLM()` owner setup flow (§3.4) uses the same check in-world.

### 5.4 Read API (for D; minimal versions built here so data is verifiable)

All require analytics read access (claimer, VLM scene owner/admin/org/collaborator):

- `GET /api/analytics/scenes/:id/summary?from&to` — totals from rollups.
- `GET /api/analytics/scenes/:id/timeseries?from&to&bucket=hour|day&metrics=` — from rollups.
- `GET /api/analytics/scenes/:id/live` — current sessions (`lastSeenAt > now − 60 s`) count + positions of the last sample per live session (no identities unless visibility on).
- `GET /api/analytics/scenes/:id/heatmap?from&to` — summed cells.
- `GET /api/analytics/scenes/:id/sessions?cursor` — paged sessions (identity columns only when visibility on).
- Existing `routes/analytics.ts` endpoints are replaced by these.

## 6. Testing

- SDK: unit tests for the queue (caps, priority flush, backoff), sampling rules, session enter/leave with a fake adapter probe; vitest added to `vlm-core`.
- Server: ingest validation, signer/visitor match, unverified flag, rate limits, scene resolution with mocked Catalyst/worlds responses, notice/visibility rules, rollup correctness on fixture data (concurrency, dwell percentiles, heatmap cells, co-presence), retention purge, claim checks (owner/operator/manager/approvedForAll/world owner, partial parcel control rejected), deletion endpoint.
- Upstream Decentraland APIs are always mocked in tests (an injectable `DclDirectory` interface with a real HTTP implementation and a test fake).

## 7. Sub-project D: Dashboard and reports (outline)

Per-scene Analytics tab: summary cards, time-series charts, peak concurrency, dwell distribution, heatmap over a parcel-grid map with entry/exit points, top interactions, video watch time, emotes/camera mode, countries/platforms, new vs returning, verified-share badge, live "here now" view; event/booking reports (any time window, or a booking's live window) with a shareable read-only link; CSV export (gated at the existing `analytics_export` feature, pro tier); claim flow UI ("Claim a scene" listing eligible locations).

## 8. Sub-project E: Install paths (outline)

- **One-line import:** a published package (name TBD, e.g. `@vlm/dcl`) whose side-effect import starts analytics: `import '@vlm/dcl'`; optional `createVLM()` for live features.
- **Creator Hub smart item:** a Script-component item (`vlm.ts`) with params Enable analytics, Show visitor notice, VLM scene id (optional), Server URL; distributed as a downloadable custom item and a starter scene; validate script portability and the npm-dependency step first (spike).
- Replace the SDK6 `asset.json` package; docs for both paths.

## 9. Out of scope

Cross-scene network analytics for VLM itself, A/B testing, funnels, real-time alerting, non-DCL adapters' probes (Hyperfy etc. get the collector but no probe yet), and legal text.

## 10. Open questions

- Whether `/lambdas/parcels/{x}/{y}/operators` reflects Estate permissions fully (C; subgraph fallback planned).
- Exact signed-fetch metadata fields per Explorer version (A treats metadata as untrusted either way).
- Country database choice and licensing (GeoLite2 requires attribution and a license key; DB-IP Lite is CC-BY) — decide in the A plan.
- Creator Hub script portability and npm install step (E spike).
