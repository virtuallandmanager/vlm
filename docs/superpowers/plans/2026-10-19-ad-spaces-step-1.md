# Ad Spaces and In-World Delivery (Ad Platform Step 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owners can place ad spaces and switch video screens to ad modes. VLM admins create house and partner ads and assign them by hand. Scenes show the ads under the live-stream and player-experience rules and report four measurement levels to vlm.gg, and admins see a per-ad report.

**Architecture:**
- **Shared vocabulary:** a new `ad_space` element type and two new video offline modes in `vlm-shared`.
- **Server:** a new `ads` module serves ads and records measurement on its own signed endpoints, `/api/ads/serve` and `/api/ads/events`, separate from the scene room and from `/api/ingest`, so self-hosted scenes can call vlm.gg directly later.
- **In-world:** `vlm-core` gets pure, tested rotation and measurement logic plus an `AdSpaceManager`. The DCL adapter gets the few platform hooks the logic needs: hover, camera pose, video end and a text label.

**Tech Stack:** TypeScript, Fastify, drizzle and Postgres, vitest, Decentraland SDK7 (`@dcl/sdk/ecs`), Next.js (apps/web).

**Spec:** `docs/superpowers/specs/2026-10-19-ad-platform-design.md`. This plan covers build-order step 1 only.

## Global Constraints

- Ad formats are image or video only. Shapes are exactly `'16:9' | '1:1' | '9:16' | '2:5'`. Every ad space has exactly one shape, and a creative only shows in a space with its exact shape (never stretched or cropped).
- Video ads only play when no stream is live and enabled in the scene. While one is live:
  - a `both` space shows image ads only;
  - a video-only space shows its fallback image, or disappears completely with no panel and no collider;
  - video screens in an ads mode switch to the stream.

  Everything resumes when the stream ends.
- During a venue booking, ads on that venue's rentable screens pause.
- House ads fill any space with no partner ad, and pay owners nothing.
- The paid view is level 2, "on screen". Only verified-wallet players count toward paid numbers. Each wallet counts once per ad per day at each level. Players who haven't moved for a while stop counting. Unverified players and guests are recorded as a separate unpaid number.
- Player experience:
  - video ads play muted;
  - frequency cap per visitor per ad;
  - a limit on concurrent video ads per scene;
  - a small visible "Ad" label on every ad;
  - a minimum ad space size.
- Do not change subscription billing (`apps/server/src/routes/billing.ts`, the subscription paths of `apps/server/src/integrations/stripe.ts`).
- Owner content settings (family-friendly / allow all / approve only), review, buying, payouts and self-hosted linking belong to later steps. Don't build them here. Do keep ad serving and measurement on their own `/api/ads/*` endpoints.
- New DB enum values and tables need both `apps/server/src/db/schema.ts` and the idempotent fallback block in `apps/server/entrypoint.sh` (copy the "Catalog packs" block pattern; enum values use `ALTER TYPE element_type ADD VALUE IF NOT EXISTS 'ad_space'`).
- Node 20 for server, core and web: `export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH`.

## Fixed values (the spec leaves these to the builder; this plan decides them)

All of these live in `packages/vlm-shared/src/ads.ts` as `AD_LIMITS`:

| Name | Value | Meaning |
|---|---|---|
| `imageSeconds` | 10 | how long an image ad shows |
| `freqCapPerHour` | 6 | times one visitor sees the same ad per hour (per scene runtime) |
| `maxVideoAdsPerScene` | 2 | video ads playing at once in one scene |
| `idleMs` | 60_000 | no movement for this long stops counting |
| `minShortSideM` | 0.5 | an instance whose shorter side (scale) is below this shows no ads |
| `onScreenMaxDistanceM` | 25 | |
| `onScreenHalfAngleDeg` | 35 | from camera forward to ad centre |
| `onScreenMinApparent` | 0.04 | shorter side ÷ distance |
| `onScreenMinMs` | 1000 | in view continuously this long to count as level 2 |
| `hoverMaxDistanceM` | 20 | |
| `serveRefreshMs` | 300_000 | |
| `eventsFlushMs` | 10_000 | |
| `eventsFlushCount` | 20 | |
| `maxEventsPerBatch` | 50 | |
| `playlistItemsBetweenAds` | 1 | in playlist + ads mode, one ad after every playlist video |

## Review Focus

1. **A space with no creative in its shape, or no ads at all.** It shows its fallback image, or is hidden with no collider. Never a blank or black panel. Test: Task 8, `ad space with nothing to show hides itself`.
2. **A stream goes live while a video ad is playing.** The video ad stops at once, and the space switches to an image ad, its fallback, or hidden. When the stream ends, video ads come back. Test: Task 8, `stream going live stops video ads and ending it restores them`.
3. **`/api/ads/serve` or `/api/ads/events` called with element ids from another scene.** The serve call rejects those ids, and the events call ignores them, so one scene can't read or count another's spaces. Test: Task 4, `rejects element ids that are not in the signed scene`.
4. **Replayed or duplicated events, and events for an ad that isn't placed on that element.** They are counted once per wallet per ad per level per day, and mismatched ad and element pairs are dropped. Test: Task 4, `counts a wallet once per ad per level per day and drops unplaced pairs`.
5. **vlm.gg unreachable, or serve fails.** Spaces show their fallback or hide, the scene keeps running, and it retries on the next refresh. Test: Task 8, `serve failure shows fallback and retries on next refresh`.

---

### Task 1: Shared ad vocabulary and wire types

**Files:**
- Create: `packages/vlm-shared/src/ads.ts`
- Modify: `packages/vlm-shared/src/enums/index.ts` (`ElementType`, `VideoSourceType`)
- Modify: `packages/vlm-shared/src/types/elements.ts` (`AdSpaceProperties`, `VideoProperties.adShape`)
- Modify: `packages/vlm-shared/src/types/storage.ts` (`adSpaces`)
- Modify: `packages/vlm-shared/src/index.ts` (export `ads.ts`)
- Test: `packages/vlm-core/test/ad-contract.test.ts`

**Interfaces:**
- Produces:
  - `ElementType.AD_SPACE = 'ad_space'`
  - `VideoSourceType.ADS = 4`, `VideoSourceType.PLAYLIST_ADS = 5`
  - `type AdShape = '16:9' | '1:1' | '9:16' | '2:5'`, `AD_SHAPES: readonly AdShape[]`
  - `type AdFormats = 'image' | 'video' | 'both'`
  - `interface AdSpaceProperties { shape: AdShape; formats: AdFormats; fallbackImageSrc?: string }`
  - `VideoProperties.adShape?: AdShape` (defaults to `'16:9'`)
  - `AD_LIMITS` (the table above)
  - `interface AdItem { adId: string; creativeId: string; kind: 'image' | 'video'; url: string; clickUrl: string; house: boolean }`
  - `interface AdServeRequest { elementIds: string[] }`
  - `interface AdServeResponse { spaces: Record<string, { paused: boolean; ads: AdItem[] }> }`
  - `type AdLevel = 'scene' | 'screen' | 'look' | 'click'`
  - `interface AdEvent { adId: string; elementId: string; level: AdLevel; t: number; dwellMs?: number }`
  - `interface AdEventBatch { v: 1; sessionId: string; events: AdEvent[] }`
  - `checkAdEventBatch(body: unknown): { ok: true; batch: AdEventBatch } | { ok: false; error: string }`
  - `VLMStorage.adSpaces`

- [ ] **Step 1: Write the failing test.** In `ad-contract.test.ts`:
  - `checkAdEventBatch accepts a valid batch`
  - `checkAdEventBatch rejects unknown level, more than 50 events, missing sessionId, and dwellMs on a non-look event`
  - `AD_SHAPES is exactly the four shapes`: `expect([...AD_SHAPES]).toEqual(['16:9','1:1','9:16','2:5'])`
  - `video modes`: `expect(VideoSourceType.ADS).toBe(4)` and `expect(VideoSourceType.PLAYLIST_ADS).toBe(5)`
- [ ] **Step 2: Run it.** `cd packages/vlm-core && npx vitest run test/ad-contract.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement the types and `checkAdEventBatch`** in the files above. Validation copies the style of `checkBatch` in `packages/vlm-shared/src/analytics.ts`.
- [ ] **Step 4: Run it.** Same command → PASS. Then `pnpm --filter vlm-shared typecheck` → clean.
- [ ] **Step 5: Commit.** `feat(shared): ad space element, ad video modes and ad wire types`.

### Task 2: Server schema, element plumbing and serializer

**Files:**
- Modify: `apps/server/src/db/schema.ts`:
  - `elementTypeEnum` gets `'ad_space'`;
  - new tables `ads`, `adCreatives`, `adPlacements`, `adEvents`.
- Modify: `apps/server/entrypoint.sh` (fallback SQL for the enum value and the four tables).
- Modify: `apps/server/src/routes/scenes.ts:61` (`CreateElementBody.type` union).
- Modify: `apps/server/src/services/scene-serializer.ts:133` (`adSpaces: byType('ad_space')`).
- Modify: `apps/server/src/auth/permissions.ts:172` (`ad_space` → `'screens'`).
- Modify: `apps/server/src/ws/VLMSceneRoom.ts` (empty init preset keys ~547 get `adSpaces: []`).
- Modify: `apps/server/test/helpers/factories.ts:80` (`createElement` type union).
- Test: `apps/server/test/ads-schema.test.ts`

**Tables** (column names are snake_case in SQL):
- `ads`:
  - `id` uuid pk; `name` text not null;
  - `kind` text not null, `'house' | 'partner'`; `clickUrl` text not null;
  - `status` text not null, default `'active'` (`'active' | 'paused'`);
  - `startsAt` and `endsAt` timestamptz, nullable;
  - `createdBy` uuid → users, set null; `createdAt` and `updatedAt`.
- `adCreatives`:
  - `id`; `adId` → ads, cascade; `shape` text not null; `kind` text not null, `'image' | 'video'`;
  - `mediaAssetId` → media_assets, set null; `url` text not null; `createdAt`.
- `adPlacements`:
  - `adId` → ads, cascade; `elementId` → scene_elements, cascade;
  - primary key (`adId`, `elementId`).
- `adEvents`:
  - `id` bigserial; `adId` → ads, cascade; `elementId` uuid; `sceneId` uuid → scenes, cascade;
  - `level` text not null; `day` date not null;
  - `viewerKey` text not null (`w:<wallet>` or `u:<sessionId>`); `verified` boolean not null; `house` boolean not null;
  - `dwellMs` int, nullable; `occurredAt` timestamptz not null;
  - unique (`adId`, `level`, `day`, `viewerKey`);
  - index (`adId`, `day`).

**Interfaces:**
- Produces: drizzle tables `ads`, `adCreatives`, `adPlacements`, `adEvents`. The preset JSON gains `adSpaces: SceneElement[]`.

- [ ] **Step 1: Write the failing test.** In `ads-schema.test.ts`:
  - `an ad_space element round-trips through POST /api/presets/:id/elements and appears in the serialized preset under adSpaces`. Use `createScene`, then POST `{ type:'ad_space', properties:{ shape:'2:5', formats:'both' } }`, then `serializePreset` → `adSpaces[0].shape === '2:5'`.
  - `ad_space changes need the screens scope`. Call `scopesForElementChange('ad_space', …)` and assert the result contains `'screens'`.
  - `ad_events allows one row per ad, level, day and viewer`. The second insert with `onConflictDoNothing` leaves 1 row.
- [ ] **Step 2: Run it.** `cd apps/server && npx vitest run test/ads-schema.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the schema and plumbing** in the files above.
- [ ] **Step 4: Run it, then the whole server suite.** `npx vitest run test/ads-schema.test.ts` → PASS. Then `npx vitest run` → all pass.
- [ ] **Step 5: Commit.** `feat(server): ad_space element and ad tables`.

### Task 3: Ad selection

**Files:**
- Create: `apps/server/src/ads/select.ts`
- Create: `apps/server/src/ads/booking.ts`
- Test: `apps/server/test/ads-select.test.ts`

**Interfaces:**
- Produces:
  - `selectAdsForElements(sceneId: string, elementIds: string[], now: Date): Promise<AdServeResponse['spaces']>`.
  - `isUnderActiveBooking(sceneId: string, element: { id: string; clonedFromId: string | null }, now: Date): Promise<boolean>` (in `booking.ts`). A booking counts when its `status` is in (`confirmed`, `live`), `startsAt <= now < endsAt`, its venue's `sceneId` matches, and `element.id` or `element.clonedFromId` is in `rentableElementIds`.

**Rules, in order, for each element:**
1. **Booking.** Under an active booking → `{ paused: true, ads: [] }`.
2. **Space settings.**
   - An `ad_space` element uses its `properties.shape` and `properties.formats`.
   - A `video` element whose `offType` is 4 or 5 uses `adShape ?? '16:9'` and `'both'`.
   - Any other element is skipped (not in the result).
3. **Eligible ads.**
   - The ad's `status` is `'active'` and `now` is within `[startsAt, endsAt)`; a null bound is open.
   - The ad has a creative with the space's shape and a kind its `formats` allow.
4. **Partner first, then house.**
   - Partner ads placed on this element, or on its `clonedFromId`, come first.
   - If there are none, every eligible house ad is used.
   - One `AdItem` per (ad, creative). Order is stable by `adId`, then `creativeId`.
   - `house` is set from `kind`.

- [ ] **Step 1: Write the failing tests.**
  - `returns only creatives in the space's shape`
  - `formats image excludes video creatives and video excludes images`
  - `a video screen in ads mode is a 16:9 space with both formats, and other video modes are skipped`
  - `partner ads placed on the element win over house ads`
  - `house ads fill a space with no partner placement`
  - `paused and out-of-date ads are excluded`
  - `an element under an active venue booking is paused`
  - `a placement on the original element applies to its booking-preset clone`
- [ ] **Step 2: Run them.** `npx vitest run test/ads-select.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `select.ts` and `booking.ts`.
- [ ] **Step 4: Run them.** → PASS.
- [ ] **Step 5: Commit.** `feat(server): ad selection with booking pause`.

### Task 4: `/api/ads/serve` and `/api/ads/events`

**Files:**
- Create: `apps/server/src/routes/ads.ts`
- Create: `apps/server/src/ads/events.ts`
- Modify: `apps/server/src/app.ts` (register inside the `withRawJson(scope)` scope, like `routes/auth.ts`)
- Test: `apps/server/test/ads-serve.test.ts`

**Interfaces:**
- Consumes: `selectAdsForElements` (Task 3); `verifyDclSceneRequest` (`middleware/dcl-auth.ts:58`); `bindSceneRequest` (`auth/scene-binding.ts:26`); `checkAdEventBatch` (Task 1).
- Produces:
  - `POST /api/ads/serve` with body `AdServeRequest` → `AdServeResponse`.
  - `POST /api/ads/events` with body `AdEventBatch` → `{ accepted: number }`.
  - `recordAdEvents(sceneId: string, viewer: { wallet: string | null; isGuest: boolean; sessionId: string }, events: AdEvent[], now: Date): Promise<number>` in `events.ts`.

**Behaviour:**
- **Signed requests only.** Both routes require a valid DCL signed scene request; anything else → 401.
- **Scene binding.** `bindSceneRequest` resolves the VLM scene. No bound scene → 404 `scene_not_found`.
- **Serve** only accepts element ids from the bound scene's active preset (direct, or through `clonedFromId` for booking presets). Any other id → 400 `element_not_in_scene`. At most 50 ids.
- **Events:**
  - **Dropped silently:**
    - events whose element isn't in the scene;
    - events whose ad isn't currently selectable for that element under Task 3's rules, ignoring booking. This is what stops someone claiming views of an ad on a space that isn't showing it.
  - **Viewer key:** `w:<wallet>` when the scene request is verified and not a guest, otherwise `u:<sessionId>`. `verified` is set to match.
  - **Rows:** each event inserts with `onConflictDoNothing` on the unique key. `day` is the UTC date of `now`. `dwellMs` only applies to `look`.
  - **Response:** `accepted` counts the rows actually inserted.

- [ ] **Step 1: Write the failing tests.** Use `signedSceneHeaders` from `test/helpers/dcl-sign.ts`, and bind the scene as the existing scene-pass tests do.
  - `serve returns the selected ads for the signed scene's elements`
  - `rejects element ids that are not in the signed scene` (400, and nothing about the other scene leaks)
  - `rejects unsigned requests` (401 on both routes)
  - `counts a wallet once per ad per level per day and drops unplaced pairs`: the same batch sent twice gives `accepted` of N then 0; an event for an ad placed on another element is not stored.
  - `guest and unsigned-wallet viewers are stored as unverified with a session key`
  - `dwellMs is kept for look events only`
- [ ] **Step 2: Run them.** `npx vitest run test/ads-serve.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `routes/ads.ts` and `ads/events.ts`, and register them in `app.ts`.
- [ ] **Step 4: Run them, then the whole server suite.** → PASS. Add `/api/ads/serve` and `/api/ads/events` to whatever list `test/scene-pass-guard.test.ts` keeps for signed or public routes, if it requires one.
- [ ] **Step 5: Commit.** `feat(server): signed ad serve and ad event endpoints`.

### Task 5: Admin ads API

**Files:**
- Create: `apps/server/src/routes/admin-ads.ts` (same `authenticate` and `requireAdmin` hooks as `routes/admin.ts:20`)
- Create: `apps/server/src/ads/report.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/admin-ads.test.ts`

**Interfaces:**
- Produces, all admin-only:
  - `GET /api/admin/ads` → `{ ads: AdminAd[] }`, where `AdminAd = { id, name, kind, clickUrl, status, startsAt, endsAt, creatives: { id, shape, kind, url }[], placements: string[] }`
  - `POST /api/admin/ads` with `{ name, kind, clickUrl, startsAt?, endsAt? }` → `{ ad: AdminAd }`
  - `PATCH /api/admin/ads/:id` with any of `{ name, clickUrl, status, startsAt, endsAt }` → `{ ad }`
  - `POST /api/admin/ads/:id/creatives` with `{ mediaAssetId, shape }` → `{ creative }`. The kind comes from the media's `contentType` (`image/*` → image, `video/*` → video, anything else → 400). The media must be `status:'ready'`, and `url` is its `publicUrl`.
  - `DELETE /api/admin/ads/:id/creatives/:creativeId`
  - `PUT /api/admin/ads/:id/placements` with `{ elementIds }` → `{ ad }`. Partner ads only; a house ad → 400 `house_ads_go_everywhere`. Every id must be an `ad_space` element, or a `video` element.
  - `GET /api/admin/ads/spaces` → `{ spaces: { elementId, sceneId, sceneName, name, type, shape }[] }`. Lists every `ad_space` element and every video element in an ads mode.
  - `GET /api/admin/ads/:id/report` → `AdReport = { totals: LevelCounts; byDay: ({ day: string } & LevelCounts)[]; bySpace: ({ elementId: string; sceneName: string } & LevelCounts)[]; avgLookMs: number | null }`. Here `LevelCounts = { scene, screen, look, click, unverified: { scene, screen, look, click } }`. Verified counts fill the top-level fields; unverified ones fill `unverified`. `click` doesn't count toward the click rate unless it is verified.
- **Validation:**
  - `clickUrl` must be `https://`, otherwise 400 `click_url_must_be_https`.
  - `shape` must be one of `AD_SHAPES`.
  - `kind` must be `house` or `partner`.

- [ ] **Step 1: Write the failing tests.**
  - `non-admins get 403 on every admin ads route`
  - `create, update, pause an ad`
  - `attaching a creative takes its kind and url from the media asset and refuses non-image or non-video media`
  - `rejects a non-https click url and an unknown shape`
  - `placements only on partner ads and only on ad-capable elements`
  - `spaces lists ad_space elements and video screens in ads modes`
  - `report splits verified and unverified counts by day and by space`. Seed `ad_events` directly.
  - Add these routes to `test/cross-account-walk.test.ts` if it enumerates admin routes.
- [ ] **Step 2: Run them.** `npx vitest run test/admin-ads.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `routes/admin-ads.ts` and `ads/report.ts`.
- [ ] **Step 4: Run them, then the whole server suite.** → PASS.
- [ ] **Step 5: Commit.** `feat(server): admin ads, creatives, placements and report`.

### Task 6: Client calls for ads

**Files:**
- Modify: `packages/vlm-client/src/http.ts` (next to `checkAnalyticsClaimSigned`, line 186)
- Test: `packages/vlm-core/test/ad-client.test.ts`

**Interfaces:**
- Produces:
  - `VLMHttpClient.getAds(adapter: VLMPlatformAdapter, req: AdServeRequest): Promise<AdServeResponse | null>`. It returns `null` on any failure or non-200, and never throws.
  - `VLMHttpClient.sendAdEvents(adapter, batch: AdEventBatch): Promise<boolean>`.
  - Both use `adapter.signedRequest` and POST to `${apiUrl}/api/ads/serve` and `/api/ads/events`.

- [ ] **Step 1: Write the failing tests.** Use a fake adapter whose `signedRequest` records calls.
  - `getAds posts to /api/ads/serve and parses the response`
  - `getAds returns null on 500 or a thrown request`
  - `sendAdEvents posts the batch`
- [ ] **Step 2: Run them.** `cd packages/vlm-core && npx vitest run test/ad-client.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** → PASS.
- [ ] **Step 5: Commit.** `feat(client): signed ad serve and event calls`.

### Task 7: Rotation and measurement logic (pure)

**Files:**
- Create: `packages/vlm-core/src/ads/rotation.ts`
- Create: `packages/vlm-core/src/ads/tracker.ts`
- Test: `packages/vlm-core/test/ad-rotation.test.ts`
- Test: `packages/vlm-core/test/ad-tracker.test.ts`

**Interfaces:**
- Produces:
  - `class AdRotation`:
    - `constructor(items: AdItem[], opts?: { now?: () => number })`
    - `setItems(items: AdItem[]): void`
    - `next(allowVideo: boolean): AdItem | null`. It picks the next item in order, skipping videos when `allowVideo` is false and skipping items already shown `freqCapPerHour` times in the last hour. It never repeats the previous item when another eligible one exists, and returns `null` when nothing is eligible.
  - `durationMs(item: AdItem): number | null`: image → `imageSeconds * 1000`; video → `null`, meaning "until the video ends".
  - `isOnScreen(camera: { position: Vec3; rotation: Quat }, ad: { position: Vec3; shortSideM: number }): boolean`. It applies `onScreenMaxDistanceM`, `onScreenHalfAngleDeg` (camera forward is +Z rotated by the camera quaternion) and `onScreenMinApparent`.
  - `class AdTracker`:
    - `constructor(opts: { send: (events: AdEvent[]) => Promise<boolean>; now?: () => number })`
    - `showing(spaceKey: string, elementId: string, adId: string | null): void`
    - `tick(input: { inScene: boolean; moved: boolean; camera: {position:Vec3;rotation:Quat} | null; spaces: Record<string, { position: Vec3; shortSideM: number }> }): void`
    - `hoverStart(spaceKey: string): void`, `hoverEnd(spaceKey: string): void`, `click(spaceKey: string): void`
    - `flush(): Promise<void>`
- **Tracker rules:**
  - **Levels:**
    - `scene`: emitted when an ad starts showing while the player is in the scene.
    - `screen`: once the ad has been `isOnScreen` continuously for `onScreenMinMs`.
    - `look`: on `hoverEnd`, with `dwellMs` set to the hover length.
    - `click`: on `click`.
  - **Once per session:** each (adId, level) is emitted at most once.
  - **Idle:** when no `moved` tick has arrived for `idleMs`, nothing new is emitted until the player moves again.
  - **House ads** are tracked like any other.
  - **Flushing:** every `eventsFlushMs`, or at `eventsFlushCount` events, with at most `maxEventsPerBatch` per send. A failed send keeps the events for the next flush, capped at 200 queued (the oldest are dropped).

- [ ] **Step 1: Write the failing tests.**
  - rotation:
    - `rotation never repeats back to back when two ads are eligible`
    - `rotation skips videos when video is not allowed`
    - `rotation respects the hourly frequency cap`
    - `rotation returns null when nothing is eligible`
  - geometry:
    - `isOnScreen is false beyond 25 m, outside 35 degrees, or when apparent size is under 0.04`
  - tracker:
    - `tracker emits scene once, screen after 1 s on screen, look with dwell, click`
    - `tracker emits each level once per session per ad`
    - `tracker stops emitting while idle and resumes on movement`
    - `tracker batches and keeps events after a failed send`
- [ ] **Step 2: Run them.** `npx vitest run test/ad-rotation.test.ts test/ad-tracker.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** → PASS.
- [ ] **Step 5: Commit.** `feat(core): ad rotation and measurement logic`.

### Task 8: AdSpaceManager, video ad modes and scene wiring

**Files:**
- Create: `packages/vlm-core/src/managers/AdSpaceManager.ts` (modeled on `managers/ImageManager.ts`)
- Modify: `packages/vlm-shared/src/platform.ts`. Add optional adapter methods:
  - `onPointerHover?(entity, onEnter: () => void, onLeave: () => void, maxDistance: number): void`
  - `getCameraPose?(): { position: Vec3; rotation: Quat } | null`
  - `onVideoEnded?(entity, cb: () => void): void`
  - `setText?(entity, text: string, opts: { fontSize: number }): void`
- Modify: `packages/vlm-core/src/managers/VideoManager.ts:129` `applyMediaState`:
  - modes 4 and 5;
  - the playlist advances on `onVideoEnded` (this also fixes today's mode 2, where `playlistIndex` never changes).
- Modify: `packages/vlm-core/src/SceneManager.ts` (register the `adSpace` manager; `initPreset` reads `preset.adSpaces`; `isStreamLive()`; pass live changes from `handleVideoStatus` to the ad manager).
- Modify: `packages/vlm-core/src/VLM.ts` (an ad host that owns serve refresh and the `AdTracker`; started after scene init; refresh every `serveRefreshMs` and on preset change).
- Test: `packages/vlm-core/test/ad-space-manager.test.ts`, using the hand-mocked adapter pattern from `test/video-upsert.test.ts`.

**Interfaces:**
- Consumes: `AdRotation`, `AdTracker`, `durationMs` (Task 7); `getAds` and `sendAdEvents` (Task 6).
- Produces:
  - `SceneManager.isStreamLive(): boolean`. True when any video config has `isLive && enableLiveStream && liveSrc`.
  - `AdHost`, used by `AdSpaceManager` and `VideoManager`:
    - `attach(key: string, elementId: string, entity: EntityHandle, space: { shape: AdShape; formats: AdFormats; shortSideM: number }): void`
    - `detach(key): void`
    - `nextFor(key, allowVideo: boolean): AdItem | null`
    - `videoSlot(): boolean` and `releaseVideoSlot(): void`. These enforce `maxVideoAdsPerScene`.

**Rendering rules:**
- **The ad:**
  - an image ad sets the plane's material to the creative;
  - a video ad uses `createVideoPlayer` with volume 0 and no loop, and advances on `onVideoEnded`.
- **"Ad" label:** a child entity with `setText('Ad', { fontSize: 1 })`, at the top-left corner of the plane.
- **Click:** `onPointerDown` (hover text "Open link") calls `openUrl(clickUrl)`, then `tracker.click`.
- **Hover:** `onPointerHover`, at `hoverMaxDistanceM`, calls `tracker.hoverStart` and `tracker.hoverEnd`.
- **Video allowed** only when `!isStreamLive() && space.formats !== 'image' && videoSlot()`.
- **Nothing to show:** no paused state, no eligible item, the instance's shorter side below `minShortSideM`, or the serve failed. Then:
  - with a `fallbackImageSrc`, show it (no label, no click);
  - otherwise hide the plane completely: no renderer and no collider (the adapter's equivalent of `removeCollider` plus removing the plane).
- **Video screens in mode 4** behave as a 16:9 `both` space hosted on the screen entity.
- **Mode 5** plays the owner's playlist. After every `playlistItemsBetweenAds` playlist videos it asks `nextFor`; with an ad it plays the ad, then resumes the playlist at the next index. Without one, it continues the playlist.
- **A live stream** takes over both modes as today (`isLive` branch first).

- [ ] **Step 1: Write the failing tests.**
  - `ad space with nothing to show hides itself` (no renderer, no collider) and `shows its fallback image when it has one`
  - `stream going live stops video ads and ending it restores them`: a `both` space switches to an image ad; a video-only space switches to fallback or hidden.
  - `serve failure shows fallback and retries on next refresh`
  - `video ads are muted and limited to two per scene`
  - `an instance smaller than 0.5 m on its short side shows no ads`
  - `paused space shows fallback or hides`
  - `playlist + ads plays an ad after each playlist video, then resumes the playlist`
  - `playlist mode now advances to the next video when one ends`
  - `clicking an ad opens its link and records a click`
- [ ] **Step 2: Run them.** `npx vitest run test/ad-space-manager.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the whole core suite.** `npx vitest run` → all pass.
- [ ] **Step 5: Commit.** `feat(core): ad spaces, ad video modes and live-stream rules`.

### Task 9: DCL adapter hooks

**Files:**
- Modify: `packages/vlm-adapter-dcl/src/DclAdapter.ts`
- Modify: `packages/vlm-adapter-dcl/src/index.ts:55` (`LAYOUT_TYPES` includes `ad_space`)
- Modify: `packages/vlm-adapter-dcl/src/transform/outline.ts:27,45`, `transform/picks.ts:108` and `transform/gizmo.ts:56`. They treat `ad_space` as a flat plane, like `image`.

**Adapter methods:**
- **`onPointerHover`:** `pointerEventsSystem.onPointerHoverEnter` and `onPointerHoverLeave` with `maxDistance`. If the installed SDK lacks them, poll `inputSystem.getInputCommand(IA_POINTER, PET_HOVER_ENTER/LEAVE)` filtered by `hit.entityId`, inside one registered system.
- **`getCameraPose`:** the `Transform` of `engine.CameraEntity`.
- **`onVideoEnded`:** on the video-player entity (`videoPlayerEntities` map), watch `videoEventsSystem` state. It counts as ended on `VS_PAUSED` with `videoLength > 0 && currentOffset >= videoLength - 0.5`, the same test as in `analytics.ts:108`.
- **`setText`:** `TextShape` on the entity.

No unit tests here; the package has none.

- [ ] **Step 1: Implement** the methods and the `LAYOUT_TYPES` and transform changes.
- [ ] **Step 2: Typecheck.** `pnpm --filter vlm-adapter-dcl typecheck` → clean.
- [ ] **Step 3: Manual check** in `test-scenes/dcl-smart-item-test` against a local server. Steps:
  1. Place a 2:5 ad space and a video screen in "Ads" mode.
  2. Create a house image ad and a partner video ad as admin, and assign the partner ad to the screen.
  3. Confirm: rotation, the "Ad" label, no audio, hover and click (the link prompt).
  4. Toggle a live stream and confirm the screen switches and the video-only space hides.
  5. Confirm `GET /api/admin/ads/:id/report` shows scene, screen, look and click counts.
  6. Record what was seen in the commit message.
- [ ] **Step 4: Commit.** `feat(adapter-dcl): hover, camera pose, video end and text for ads`.

### Task 10: Dashboard editors and admin ads page

**Files:**
- Modify: `apps/web/src/app/(dashboard)/scenes/[sceneId]/client.tsx`:
  - `ElementType` at 14 and `TABS` at 50 get an "Ad spaces" tab;
  - `OFF_TYPES` at 70 becomes `{ value, label }[]` with None 0, Image 1, Playlist 2, Ads 4, Playlist + ads 5;
  - new `AdSpaceElementEditor` with shape and formats selects and a fallback image (reuse the image editor's media picker);
  - `handleAddElement` default properties `{ shape:'16:9', formats:'both' }`;
  - the render switch case at 1508.
- Create: `apps/web/src/app/(dashboard)/admin/ads/page.tsx`. Copy the `admin/catalog/page.tsx` pattern: list ads; create an ad; upload a creative through the existing media upload and attach it with a shape; choose placements from `GET /api/admin/ads/spaces`; pause and resume; show the report.
- Modify: `apps/web/src/app/(dashboard)/admin/page.tsx:137` (link).
- Modify: `apps/web/src/lib/api.ts` (one method per Task 5 route, next to `getAdminCatalogPacks`).
- Create: `apps/web/src/lib/ads.ts`
- Test: `apps/web/src/lib/ads.test.ts`

**Interfaces:**
- Produces, in `lib/ads.ts`:
  - `shapeLabel(shape: AdShape): string` (`'16:9 landscape'`, `'1:1 square'`, `'9:16 portrait'`, `'2:5 tall'`)
  - `isHttpsUrl(s: string): boolean`
  - `clickRate(c: LevelCounts): string`: verified clicks ÷ verified screen, as `'1.3%'`, or `'—'` when screen is 0.

- [ ] **Step 1: Write the failing tests** in `ads.test.ts` for the three helpers.
- [ ] **Step 2: Run them.** `cd apps/web && npx vitest run src/lib/ads.test.ts` → FAIL.
- [ ] **Step 3: Implement** the helpers and the UI.
- [ ] **Step 4: Run the web suite and typecheck.** `npx vitest run` → pass, and `npx tsc --noEmit -p .` → clean.
- [ ] **Step 5: Commit.** `feat(web): ad space editor, ad video modes and admin ads page`.

### Task 11: Docs

**Files:**
- Create: `apps/docs/src/content/docs/dashboard/ad-spaces.md`

It covers:
- placing an ad space, the shapes, and the images, videos or both setting;
- the fallback image, and the two video screen modes;
- what happens during a live stream and during venue bookings;
- the "Ad" label and muted video;
- the admin ads page.

Match the voice of `dashboard/catalog-packs.md`.

- [ ] **Step 1: Write the page.**
- [ ] **Step 2: Commit.** `docs: ad spaces`.

---

## Deferred to later steps (from the spec, deliberately not here)

- **Step 2:** the owner's family-friendly / allow all / approve-only setting, the review queue and labels.
- **Step 3:** buying, network targeting by venue type, pricing, "new spaces start on the network", fewer network ads for rarely-seen spaces, invite-only checkout, spend caps, and self-hosted linking.
- **Step 4:** Stripe Connect payouts and the earnings ledger. Partner deals in step 1 are paid to owners manually, using the per-space delivery the report already gives.
