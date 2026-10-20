# VLM App for Hyperfy, Scene Feed and "Connect your own world" (Hyperfy Project 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VLM user connects a Hyperfy world they run themselves to one of their scenes. They get a world key and a downloadable VLM app (`.hyp`). Once installed, the app shows that scene's screens, images, models and sounds in the world and follows dashboard and in-world edits within about a second.

**Architecture:**
- **New `hyperfy_worlds` records** with hashed keys, and a key-authenticated HTTP long-poll feed. The feed returns the scene's whole serialized active preset whenever its content hash changes.
- **A per-scene "scene changed" signal** on the existing realtime bus wakes waiting polls. REST edits, room edits, preset switches and stream status all publish it.
- **The app is a new package, `packages/vlm-hyperfy-app`.** It holds pure, tested modules (coordinate mapping, snapshot diffing) that esbuild bundles into a single Hyperfy script. The script's server half polls VLM and hands snapshots to visitors' browsers, which render them with Hyperfy nodes.

**Tech Stack:** TypeScript, Fastify, drizzle and Postgres, vitest, esbuild, Hyperfy 0.16 app scripting, Next.js.

**Spec:** `docs/superpowers/specs/2026-10-19-hyperfy-worlds-design.md`. This plan covers project 1 only; hosting is project 2.

## Global Constraints

- **Hyperfy version:** 0.16 (`dev` at b4081eb). Scripts get only the sandbox globals: `world`, `app`, `fetch`, `props`, `setTimeout`, `Math`, `Date.now`, `num`, `uuid`, three.js math types. They have no `WebSocket` (unless patched), no `TextEncoder`, no `setInterval` and no `crypto`. The app must use none of these.
- **The old adapter is replaced.** The VLM app is a small Hyperfy script, not a port of `vlm-core`. `packages/vlm-adapter-hyperfy` (old React Hyperfy) is removed.
- **Self-run worlds don't depend on the hosting gate.** `hyperfyHosting()` still gates only hosted worlds, and connecting a self-run world never consults it.
- **Self-run worlds don't count toward `TIER_LIMITS.hyperfyInstances`.**
- **Plan access:** creating one needs a plan that can deploy (`requireFeature('deployment')`) plus full access to the scene.
- **World key:** random, stored as a SHA-256 hash, shown once, and rotatable. Its format is `vlmw_` + 32 random bytes as hex.
- **Visitors are unverified.** Hyperfy players have no wallets, so their sessions are recorded as unverified analytics, posted by the app's server half with the world key. Visitors' browsers never talk to VLM.
- **Protocol version:** `HYPERFY_FEED_VERSION = 1`. The app sends it on every request, and the feed answers version 1. The next release keeps answering version 1.
- **Off limits:** don't change subscription or billing code. Never print secrets (world keys, `.env`).

## Fixed values (in `packages/vlm-shared/src/hyperfy.ts` as `HYPERFY_FEED`)

| Name | Value |
|---|---|
| `version` | 1 |
| `holdMs` | 25_000 (long-poll hold) |
| `retryMinMs` / `retryMaxMs` | 1_000 / 30_000 (app back-off on failure) |
| `lastSeenThrottleMs` | 60_000 (how often a poll updates `lastSeenAt`) |
| `analyticsFlushMs` | 15_000 |
| `positionSampleMs` | 5_000 |
| `keyPrefix` | `'vlmw_'` |

## Decisions this plan makes (the spec leaves them to the builder)

- **Whole snapshots, not deltas.** The feed returns the whole serialized active preset (`serializePreset` plus `withLiveStatus`) with a `version` that is the SHA-256 of its JSON. The app diffs it locally by element and instance id. This replaces the spec's "same `scene_preset_update` messages as JSON" with a simpler, loss-proof contract. Scenes are small, so snapshots stay cheap. A world that misses a change can never stay wrong.
- **Long-poll only in project 1.** The WebSocket transport comes with hosted worlds in project 2. Colyseus' transport owns the HTTP server's upgrades today, and only hosted worlds have the patched `WebSocket`.
- **Coordinates.** VLM (Decentraland) is left-handed: Y up, +Z forward. Hyperfy (three.js) is right-handed: Y up, +Z toward the viewer. Mapping:
  - position `(x, y, z)` → `(x, y, -z)`;
  - rotation in degrees `(rx, ry, rz)` → radians `(-rx, -ry, rz)`, order `'XYZ'`;
  - scale is unchanged.
- **Rendering per element type:**
  - **Video:** shows `liveSrc` when `isLive && enableLiveStream`. Otherwise offType 2 shows `playlist[0]` looped, offType 1 shows `offImageSrc` as an image, and anything else shows nothing. Ad modes 4 and 5 show nothing in project 1. Width and height come from `scale.x` and `scale.y`, at `volume`.
  - **Image:** `textureSrc`, with width and height from `scale.x` and `scale.y`.
  - **Model:** `world.load('model', modelSrc)`.
  - **Sound:** `audioSrc` at `volume`, looped.
  - **Clicks:** a `clickEvent` of type EXTERNAL (1) opens its URL with `world.open`. Other click types are ignored.
  - **Skipped:** NFTs, widgets, claim points and ad spaces.
- **Unsupported media is skipped.** A video `src` that isn't `.mp4` or `.m3u8`, or an image that isn't png, jpg/jpeg or webp (judged by the URL path's extension), is skipped, never crashing the app.
- **Hyperfy apps need a model.** The `.hyp` carries a minimal valid GLB with an empty scene (`packages/vlm-hyperfy-app/assets/empty.glb`, generated by a script, not hand-made).
- **App props:** `feedUrl` (default `https://api.vlm.gg`) and `worldKey`, both text fields declared with `app.configure`.

## Review Focus

1. **The scene has no active preset, or was deleted, while worlds are connected.** The feed returns an empty snapshot (or 404 `scene_not_found` if the scene is gone), and the app clears the world without crashing. Test: Task 4, `feed returns an empty snapshot for a scene with no active preset`.
2. **The key is rotated or the world removed while the app is polling.** The feed answers 401, and the app keeps the last scene on screen while backing off up to 30 s, rather than tight-looping. Test: Task 7, `poller backs off on 401 and keeps the last snapshot`.
3. **Several edits land while a poll is waiting or between polls.** The world always ends on the latest state, never an intermediate one. Test: Task 4, `a poll that started before two quick edits returns the latest version`.
4. **Media Hyperfy can't play** (a gif image, a webm video, a missing src). That element is skipped and the rest render. Test: Task 6, `plan skips unsupported media and keeps the rest`.
5. **Polls that end** by timeout, client disconnect or server close don't leak bus subscriptions. Test: Task 4, `feed subscriptions are released after timeout and after client abort`.

---

### Task 1: Shared Hyperfy vocabulary

**Files:**
- Create: `packages/vlm-shared/src/hyperfy.ts`; export it from `packages/vlm-shared/src/index.ts`
- Test: `packages/vlm-core/test/hyperfy-contract.test.ts`

**Interfaces:**
- Produces:
  - `HYPERFY_FEED` (the table above, `as const`)
  - `interface HyperfyFeedResponse { v: 1; version: string; scene: SerializedScene | null }`, where `SerializedScene` is the preset JSON shape: `{ videos, images, models, sounds }` arrays of serialized elements, and other keys are allowed.
  - `interface HyperfyWorldSummary { id: string; sceneId: string; name: string; kind: 'self'; createdAt: string; lastSeenAt: string | null }`
  - `interface HyperfyAnalyticsBatch { v: 1; events: HyperfyVisitEvent[] }`, where `HyperfyVisitEvent = { type: 'enter' | 'leave' | 'pos'; playerId: string; t: number; x?: number; y?: number; z?: number }`
  - `checkHyperfyAnalyticsBatch(body: unknown): { ok: true; batch: HyperfyAnalyticsBatch } | { ok: false; error: string }`. It allows at most 200 events and a `playerId` of at most 100 characters, and requires `x`, `y` and `z` on `pos` events only.

- [ ] **Step 1: Write the failing tests:**
  - `HYPERFY_FEED values`: version 1, holdMs 25000, keyPrefix `'vlmw_'`;
  - `checkHyperfyAnalyticsBatch accepts enter/leave/pos`;
  - `rejects pos without coordinates, coordinates on enter, more than 200 events, unknown type`.
- [ ] **Step 2: Run them.** `cd packages/vlm-core && npx vitest run test/hyperfy-contract.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** → PASS. Then `pnpm --filter vlm-shared build`.
- [ ] **Step 5: Commit.** `feat(shared): Hyperfy feed and world types`.

### Task 2: World records, keys and the connect API

**Files:**
- Modify: `apps/server/src/db/schema.ts`: a new table `hyperfyWorlds` (`hyperfy_worlds`):
  - `id` uuid pk;
  - `sceneId` → scenes, cascade;
  - `ownerId` → users, cascade;
  - `name` text not null;
  - `kind` text not null, default `'self'`;
  - `keyHash` text not null unique;
  - `keyPrefix` text not null (the first 12 characters, for display);
  - `lastSeenAt` timestamptz, nullable;
  - `createdAt`.
- Modify: `apps/server/entrypoint.sh` (idempotent fallback block, like the "Catalog packs" one).
- Create: `apps/server/src/hyperfy/worlds.ts` and `apps/server/src/routes/hyperfy-worlds.ts`. Register them in `app.ts`.
- Test: `apps/server/test/hyperfy-worlds.test.ts`

**Interfaces:**
- Produces:
  - `createWorldKey(): { raw: string; hash: string; prefix: string }`
  - `hashWorldKey(raw: string): string` (SHA-256 hex, like `routes/api-keys.ts:45-50`)
  - `findWorldByKey(raw: string): Promise<HyperfyWorldRow | null>`
- Routes (`authenticate` plus `requireFeature('deployment')`; scene access via `getSceneAccess`, full access required):
  - `POST /api/hyperfy/worlds` with `{ sceneId, name }` → 201 `{ world: HyperfyWorldSummary, key: string }` (the key is returned only here and on rotate)
  - `GET /api/hyperfy/worlds?sceneId=` → `{ worlds: HyperfyWorldSummary[] }`
  - `POST /api/hyperfy/worlds/:id/rotate-key` → `{ world, key }`
  - `DELETE /api/hyperfy/worlds/:id` → `{ deleted: true }`
- None of these consult `hyperfyHosting()`.

- [ ] **Step 1: Write the failing tests:**
  - `creating a world returns a vlmw_ key once and stores only its hash`;
  - `findWorldByKey finds it, and fails after rotate-key`;
  - `listing never includes the key`;
  - `another user can't list, rotate or delete it` (404);
  - `connecting works while Hyperfy hosting is unavailable (cloud mode)`;
  - `free plan is refused by the deployment feature gate`, following the existing gate tests' setup.

  Add the `:id` routes to `test/cross-account-walk.test.ts` if it lists every param route.
- [ ] **Step 2: Run them.** `cd apps/server && npx vitest run test/hyperfy-worlds.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, then the whole server suite.** → PASS.
- [ ] **Step 5: Commit.** `feat(server): connect-your-own Hyperfy world records and keys`.

### Task 3: The scene-changed signal and the feed snapshot

**Files:**
- Modify: `apps/server/src/realtime/bus.ts`. Add `subscribe`/`unsubscribe` to `BusPresence`, and add:
  - `sceneFeedTopic(sceneId) = 'feed:' + sceneId`
  - `publishSceneTouched(sceneId)`
  - `onSceneTouched(sceneId, cb): () => void` (returns an unsubscribe)
- Publish `publishSceneTouched` from:
  - `elementChanged()` in `routes/scenes.ts:50`;
  - every `preset_changed` publisher (`venues/service.ts`, `venues/lifecycle.ts`, and the active-preset change route);
  - `VLMSceneRoom`'s persisted edit paths: `scene_preset_update` create/update/updateAll/delete and `scene_change_preset`, after the database write;
  - stream status changes: for `publishStreamStatus`, touch every scene with a video whose `liveSrc` matches. Do it in the same place the room resolves this today (`VLMSceneRoom.onStreamEvent`), or with a shared helper.
- Create: `apps/server/src/hyperfy/snapshot.ts`
- Test: `apps/server/test/hyperfy-snapshot.test.ts`

**Interfaces:**
- Produces:
  - `sceneSnapshot(sceneId: string): Promise<{ version: string; scene: SerializedScene | null } | null>`
  - It returns `null` when the scene doesn't exist, and `{ scene: null }` when it has no active preset.
  - `version` is the SHA-256 hex of `JSON.stringify(scene)`. The JSON is the serialized active preset wrapped with `withLiveStatus` (`streaming/live-status.ts`).

- [ ] **Step 1: Write the failing tests:**
  - `snapshot version changes when an element is edited through REST, and stays the same otherwise`;
  - `onSceneTouched fires for a REST element edit, a preset switch, and an edit sent in a scene room` (use `startGameServer`/`joinScene` from `test/helpers/game-server.ts`);
  - `a stream going live touches scenes whose video uses that stream`;
  - `snapshot is null for a missing scene and has scene null with no active preset`.
- [ ] **Step 2: Run them.** → FAIL.
- [ ] **Step 3: Implement.** Make sure the room doesn't rebroadcast its own touches. It doesn't subscribe to `feed:` topics.
- [ ] **Step 4: Run them, then the whole server suite.** → PASS.
- [ ] **Step 5: Commit.** `feat(server): scene-changed signal and Hyperfy feed snapshot`.

### Task 4: `GET /api/hyperfy/feed`

**Files:**
- Create: `apps/server/src/routes/hyperfy-feed.ts`; register it in `app.ts`
- Test: `apps/server/test/hyperfy-feed.test.ts`

**Interfaces:**
- Consumes: `findWorldByKey` (Task 2); `sceneSnapshot`, `onSceneTouched` (Task 3).
- Produces: `GET /api/hyperfy/feed?since=<version>`. It takes headers `Authorization: Bearer vlmw_…` and `X-VLM-App-Version: 1`, and answers `HyperfyFeedResponse`.
- **Behaviour:**
  - A missing or unknown key → 401 `invalid_world_key`.
  - A missing scene → 404 `scene_not_found`.
  - If `since` is absent or differs from the current version → answer at once.
  - Otherwise wait up to `holdMs` for `onSceneTouched`. On each touch, recompute the snapshot and answer if its version differs. When the hold expires, answer with the same version.
  - Always unsubscribe on answer, timeout or client close (`request.raw.on('close')`).
  - Update `lastSeenAt` at most once per `lastSeenThrottleMs`.
  - The route is exempt from the bearer-session guard. Add it to `PUBLIC_EXACT` in `test/scene-pass-guard.test.ts` if required, with the comment "world-key auth".
- **Testing time:** `holdMs` can be overridden in tests through an exported `setFeedHoldMs(ms)` test hook, like `setIngestLimiter`.

- [ ] **Step 1: Write the failing tests:**
  - `answers at once without since, and when since is stale`;
  - `holds, then answers within 1 s of a REST edit with the new version`;
  - `a poll that started before two quick edits returns the latest version`;
  - `answers unchanged after the hold` (hold set to 200 ms);
  - `401 for a bad key and after rotate-key`;
  - `feed returns an empty snapshot for a scene with no active preset`;
  - `feed subscriptions are released after timeout and after client abort` (assert the bus subscriber count for the topic is back to 0);
  - `lastSeenAt is updated, at most once a minute`.
- [ ] **Step 2: Run them.** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, then the whole server suite.** → PASS.
- [ ] **Step 5: Commit.** `feat(server): Hyperfy scene feed (long-poll)`.

### Task 5: Hyperfy visitor analytics

**Files:**
- Modify: `apps/server/src/db/schema.ts`. Add the `'hyperfy'` value to `analyticsSceneKindEnum`, and its fallback `ALTER TYPE … ADD VALUE IF NOT EXISTS` in `entrypoint.sh`.
- Create: `apps/server/src/hyperfy/analytics.ts` and the `POST /api/hyperfy/analytics` route in `routes/hyperfy-feed.ts`
- Test: `apps/server/test/hyperfy-analytics.test.ts`

**Interfaces:**
- Consumes: `checkHyperfyAnalyticsBatch` (Task 1), `findWorldByKey` (Task 2), and the analytics tables and writer (`analytics/writer.ts` `writeBatch`, or direct inserts if `writeBatch` is DCL-shaped; say which in the report).
- Produces: `POST /api/hyperfy/analytics`, world-key auth, body `HyperfyAnalyticsBatch` → `{ accepted: number }`.
- **The world's analytics location:** one `analytics_scenes` row per world, `kind 'hyperfy'`, `locationKey 'hyperfy:' + worldId`, title equal to the world name, and `vlmSceneId` equal to the world's scene. It is created on the first batch.
- **Sessions:** `enter` opens a session (`isGuest true`, `verified false`, `platform 'hyperfy'`, visitor `hyperfy:<playerId>`), `leave` ends it, and `pos` adds a position. An analytics session id is derived from (worldId, playerId, the enter's `t`).
- **Dashboard:** the location appears in the analytics overview with the existing "World" chip handling. Add `hyperfy: 'Hyperfy'` to `KIND_LABEL` in `apps/web/src/app/(dashboard)/analytics/LocationList.tsx`.

- [ ] **Step 1: Write the failing tests:**
  - `a batch of enter, pos, leave creates one unverified session with a position and a duration`;
  - `the world gets one analytics location linked to its scene`;
  - `401 for a bad key`;
  - `rejects an invalid batch`.
- [ ] **Step 2: Run them.** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, then the whole server suite.** → PASS.
- [ ] **Step 5: Commit.** `feat(server): Hyperfy visitor analytics`.

### Task 6: App package: mapping and render plan (pure)

**Files:**
- Create: `packages/vlm-hyperfy-app/package.json` (name `vlm-hyperfy-app`, private, `test` = `vitest run`, depends on `vlm-shared` as a workspace dependency and on vitest and esbuild as dev dependencies), `tsconfig.json`, `src/transform.ts`, `src/plan.ts`
- Test: `packages/vlm-hyperfy-app/test/transform.test.ts`, `packages/vlm-hyperfy-app/test/plan.test.ts`

**Interfaces:**
- Produces:
  - `toHyperfyTransform(t: { position: Vec3; rotation: Vec3; scale: Vec3 }): { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] }`. It applies the mapping in "Decisions" (rotation in radians, order XYZ).
  - `type RenderItem = { key: string; kind: 'video' | 'image' | 'model' | 'audio'; src: string; loop: boolean; volume: number; width: number; height: number; transform: ReturnType<typeof toHyperfyTransform>; clickUrl: string | null }`. `key` is `${elementId}:${instanceId}`. For video, image and model, `src` is the URL to show.
  - `planScene(scene: SerializedScene | null): RenderItem[]`, applying the per-type rules and skips in "Decisions", for enabled elements and instances only.
  - `diffPlans(prev: RenderItem[], next: RenderItem[]): { add: RenderItem[]; remove: string[]; update: RenderItem[] }`. `update` covers items whose key exists in both but whose fields differ.

- [ ] **Step 1: Write the failing tests:**
  - transform:
    - `position z is mirrored`;
    - `rotation degrees become radians with x and y negated`;
    - `scale is unchanged`;
    - `a 90° yaw in VLM faces the same way after mapping` (forward vector check);
  - plan:
    - `live video shows liveSrc`;
    - `playlist mode shows the first playlist item looped`;
    - `off image mode becomes an image item`;
    - `ad modes and none show nothing`;
    - `disabled elements and instances are skipped`;
    - `plan skips unsupported media and keeps the rest` (gif image, webm video, empty src);
    - `external click events carry their url`;
    - `null scene plans nothing`;
    - `diffPlans reports adds, removes and changed items only`.
- [ ] **Step 2: Run them.** `pnpm install`, then `cd packages/vlm-hyperfy-app && npx vitest run` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** → PASS.
- [ ] **Step 5: Commit.** `feat(hyperfy-app): coordinate mapping and render plan`.

### Task 7: App script, poller and the `.hyp` build

**Files:**
- Create:
  - `packages/vlm-hyperfy-app/src/poller.ts`
  - `packages/vlm-hyperfy-app/src/visits.ts`
  - `packages/vlm-hyperfy-app/src/app.ts` (the Hyperfy entry)
  - `packages/vlm-hyperfy-app/scripts/make-empty-glb.mjs`
  - `packages/vlm-hyperfy-app/scripts/build-hyp.mjs`
  - `packages/vlm-hyperfy-app/assets/empty.glb` (generated)
  - the output `packages/vlm-hyperfy-app/dist/vlm.hyp`
- Add scripts to package.json: `build` = make the GLB if missing, esbuild-bundle `src/app.ts` to one IIFE script, then build the `.hyp`.
- Test: `packages/vlm-hyperfy-app/test/poller.test.ts`, `packages/vlm-hyperfy-app/test/hyp.test.ts`

**Interfaces:**
- Consumes: `planScene`, `diffPlans`, `toHyperfyTransform` (Task 6); `HYPERFY_FEED`, `HyperfyFeedResponse`, `HyperfyAnalyticsBatch` (Task 1).
- Produces:
  - **`class FeedPoller`:**
    - constructor `(opts: { feedUrl: string; worldKey: string; fetch: (url: string, init: object) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> } | undefined>; setTimeout: (fn: () => void, ms: number) => unknown; onSnapshot: (r: HyperfyFeedResponse) => void })`
    - methods `start()` and `stop()`
    - **Request:** loops `GET ${feedUrl}/api/hyperfy/feed?since=<last version>` with the bearer key and the version header.
    - **Snapshots:** calls `onSnapshot` only when the version changes.
    - **Failures:** on a thrown, undefined (Hyperfy's fetch swallows errors) or non-2xx response, it backs off by doubling from `retryMinMs` to `retryMaxMs`, keeping the last snapshot.
  - **`class VisitRecorder`:** queues enter, leave and pos events (pos sampled every `positionSampleMs` for each present player) and posts them to `/api/hyperfy/analytics` every `analyticsFlushMs`. On failure it keeps up to 1,000 events, dropping the oldest.
  - **`app.ts`, server side** (`world.isServer`):
    - starts a `FeedPoller` from `props.feedUrl`/`props.worldKey`;
    - keeps the latest snapshot;
    - on `onSnapshot`, sends it to all clients (`app.send('vlm:scene', response)`);
    - on a client's `vlm:hello`, sends the latest to that player (`app.sendTo`);
    - runs a `VisitRecorder` fed by `world.on('enter'|'leave')` and `world.getPlayers()` positions.
  - **`app.ts`, client side:**
    - sends `vlm:hello` on start;
    - on `vlm:scene`, applies `diffPlans` between the current and new plan;
    - creates `video`/`image`/`audio` nodes with `app.create`, or loads models with `world.load('model', src)` and `app.add`;
    - applies the transform, sizes planes from width and height, and sets `onPointerDown` to `world.open(clickUrl)` when present;
    - removes nodes on remove, and replaces on update (remove, then add).
  - **`app.configure`** declares the `feedUrl` and `worldKey` text props.
  - **`.hyp` builder:** writes the Hyperfy `.hyp` format (4-byte LE header length, JSON header `{ blueprint, assets }`, asset bytes in order). It follows `src/core/extras/appTools.js` in Hyperfy and the probe tool at `/private/tmp/claude-501/-Users-unknower/b9939c47-0269-41f1-b9f9-52b05b9552d9/scratchpad/hyperfy-spike/harness/inject-probe.mjs`.
    - Asset URLs are `asset://<sha256>.<ext>`.
    - The blueprint is `{ name: 'VLM', model: <glb url>, script: <js url>, props: { feedUrl: 'https://api.vlm.gg', worldKey: '' }, preload: false }`.

- [ ] **Step 1: Write the failing tests:**
  - poller (fake fetch and fake timers):
    - `sends since and the world key, and calls onSnapshot only on a new version`;
    - `poller backs off on 401 and keeps the last snapshot` (delays 1 s, 2 s, 4 s … capped at 30 s);
    - `an undefined response from Hyperfy's fetch counts as a failure`;
    - `recovers to immediate polling after a success`;
  - hyp:
    - `build output parses back into a blueprint with model, script and the two props, and every asset url is the sha256 of its bytes`;
    - `the bundled script references no forbidden globals` (no `WebSocket`, `TextEncoder`, `setInterval`, `crypto`, `require` or `import` in the output text).
- [ ] **Step 2: Run them.** → FAIL.
- [ ] **Step 3: Implement.** Then run `pnpm --filter vlm-hyperfy-app build`.
- [ ] **Step 4: Run them.** → PASS.
- [ ] **Step 5: Commit.** `feat(hyperfy-app): VLM app script, feed poller and .hyp build`. Commit `dist/vlm.hyp` and `assets/empty.glb`; they are small.

### Task 8: Download route

**Files:**
- Create: `GET /api/hyperfy/app.hyp` in `apps/server/src/routes/hyperfy-worlds.ts`. It serves `packages/vlm-hyperfy-app/dist/vlm.hyp` with `Content-Type: application/octet-stream` and `Content-Disposition: attachment; filename="vlm.hyp"`. It is public.
- Modify: the server Dockerfile or build, if it doesn't already copy `packages/*/dist` (check the root `Dockerfile`).
- Test: in `apps/server/test/hyperfy-worlds.test.ts`

- [ ] **Step 1: Write the failing test.** `app.hyp downloads the built app` (200, attachment header, body begins with the 4-byte header length matching the JSON header). Add it to `PUBLIC_EXACT` if required.
- [ ] **Step 2: Run it.** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it.** → PASS.
- [ ] **Step 5: Commit.** `feat(server): download the VLM Hyperfy app`.

### Task 9: Dashboard: "Connect your own Hyperfy world"

**Files:**
- Modify: `apps/web/src/app/(dashboard)/deploy/page.tsx`. Add a "Your Hyperfy worlds" section for the selected scene, separate from the hosted-deploy form and shown even when hosting is unavailable. It has:
  - a list with name, key prefix, and last seen ("Never connected" when `lastSeenAt` is null);
  - a "Connect a world" form with a name;
  - after creating or rotating, a one-time panel showing the key with a copy button, the warning "You won't see this key again", a "Download VLM app (.hyp)" link to `/api/hyperfy/app.hyp`, and the setup steps;
  - "New key" and "Remove" actions with a confirm.
- Modify: `apps/web/src/lib/api.ts` (one method per Task 2 route)
- Create: `apps/web/src/lib/hyperfy.ts`
- Test: `apps/web/src/lib/hyperfy.test.ts`

**Interfaces:**
- Produces:
  - `lastSeenLabel(iso: string | null, now: Date): string`, returning `'Never connected'`, `'Connected just now'` (under 2 minutes), `'Last seen 5 min ago'`, `'Last seen 3 h ago'` or `'Last seen Oct 18'`.
  - `setupSteps(feedUrl: string): string[]`, with exact copy:
    1. `"Download the VLM app and drag vlm.hyp into your Hyperfy world."`
    2. `` `Open the app's settings and paste your world key into World key.` ``
    3. `` `Leave Feed URL as ${feedUrl} unless VLM support tells you otherwise.` ``
    4. `"Your scene appears within a few seconds and follows your edits."`

- [ ] **Step 1: Write the failing tests** for both helpers.
- [ ] **Step 2: Run them.** `cd apps/web && npx vitest run src/lib/hyperfy.test.ts` → FAIL.
- [ ] **Step 3: Implement** the helpers and the UI, matching the dashboard's graphite and cyan style (`components/ui.tsx`).
- [ ] **Step 4: Run them.** Run the web suite and `npx tsc --noEmit -p .` → pass.
- [ ] **Step 5: Commit.** `feat(web): connect your own Hyperfy world`.

### Task 10: Remove the old adapter and rewrite the docs

**Files:**
- Delete: `packages/vlm-adapter-hyperfy/`. Refresh `pnpm-lock.yaml` with `pnpm install`.
- Rewrite: `apps/docs/src/content/docs/sdk/hyperfy/install.md`. Cover connecting a world from the dashboard, installing `vlm.hyp`, the two props, what renders (screens, images, models, sounds, external links), what doesn't yet (ads, NFTs, widgets, claim points), that edits appear within about a second, and that visitors count as unverified in analytics. Match the voice of `apps/docs/src/content/docs/dashboard/catalog-packs.md`.
- Check that every quickstart or concepts link to the Hyperfy page still resolves.

- [ ] **Step 1: Delete, then reinstall.** `pnpm -r build` and the server, core and web suites all pass.
- [ ] **Step 2: Write the docs page.**
- [ ] **Step 3: Commit.** `chore: replace the old Hyperfy adapter; docs for the VLM Hyperfy app`.

### Task 11: End-to-end world check (run by the controller)

Run a local VLM server and a local Hyperfy world (`/private/tmp/claude-501/-Users-unknower/b9939c47-0269-41f1-b9f9-52b05b9552d9/scratchpad/hyperfy-spike/src`, `npm run build`, then `node build/index.js` with the env from the spike). Steps:
1. Connect a world in the dashboard.
2. Seed the app: put `dist/vlm.hyp` in as the world's `src/world/scene.hyp` on a fresh world, with props pre-set by a variant of the probe-injection script, or drag it in via the browser.
3. Open the world in headless Chrome.
4. Confirm that an image, a looped video, a model and a sound render.
5. Confirm that a dashboard edit to an image's position appears within 2 s.
6. Confirm that removing the world in the dashboard makes the feed return 401 while the world keeps its last scene.
7. Confirm that an analytics session appears.

Record what was seen in the plan's ledger.
