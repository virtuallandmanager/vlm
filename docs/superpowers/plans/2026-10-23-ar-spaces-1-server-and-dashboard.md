# AR spaces 1: server and dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the Quest app needs from VLM: AR spaces, floors and ring markers in the database, the dashboard to set them up and download print files, a public space feed, headset pairing with an AR pass for builders, "Just this place" adjustments, the AR draft relay, AR analytics, and the `vlm.gg/s/<code>` page with Android app links.

**Architecture:** New `apps/server/src/ar/` modules (pure logic plus drizzle queries) behind new route files `apps/server/src/routes/ar-*.ts`. The ring codec and marker layout are ported from the spike's Python to TypeScript in `packages/vlm-shared/src/ring-marker/`, so the server's print files and the dashboard's SVG preview draw from one source. Headset builders get a short-lived scene pass with `via: 'ar'`, minted from a paired device, which opts into the existing scene and library routes the same way the Hyperfy HUD pass does.

**Tech Stack:** Fastify 5, drizzle-orm (push, no migrations), Colyseus 0.15, vitest 3 with real Postgres (`vlm_test`), Next.js 15 static export, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-10-22-ar-builder-and-visitor-modes-design.md`, which builds on `2026-10-21-ar-spaces-design.md` and `2026-10-22-ring-marker-design.md`. Executors read all three. This is plan 1 of 3; plans 2 (`2026-10-23-ar-spaces-2-quest-visitor.md`) and 3 (`2026-10-23-ar-spaces-3-quest-builder.md`) build the Quest app against the API this plan produces.

## Global Constraints

- Work in a new worktree `/Users/unknower/-VLM/vlm-v2/.worktrees/ar-spaces` on branch `feature/ar-spaces`, created from `main`. Never touch the main checkout `/Users/unknower/-VLM/vlm-v2` (it is on `fix/large-scenes-and-empty-delete`).
- Never use bare `git stash`. Never push, deploy, publish or merge without the owner's say-so.
- Tests use `vlm_test` only (`apps/server/vitest.config.ts`); never the shared dev DB `vlm`.
- Off limits: billing code (`apps/server/src/billing`, subscription logic).
- Never log tokens, device secrets, pairing codes or world keys. Store only SHA-256 hashes of codes and secrets, compared with `timingSafeEqual`.
- Breaking changes are fine (VLM has no users yet); no compatibility shims.
- Who can build (set up spaces, save alignment, edit in AR): access level `admin`, `owner`, `cohost` or `editor` from `getSceneAccess`. Booking hosts, renters and other grants can't.
- Marker code: the 32-bit marker ID written as 7 characters of Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`). Marker IDs are random, never sequential. Format version 0.
- Default printed diameter 140 mm; maximum 256 mm. Base 4.0 mm thick, raised parts 0.6 mm; filament change at 4.0 mm.
- Floor-height warning: more than 0.5 m between a saved alignment's floor and the floor's stated height.
- Draft keep time on the headset: 10 minutes.
- AR analytics platform string: `ar-quest`.
- Commit trailers on every commit:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_018ds2NZXw5KLxDpVm9B3ABD
  ```

## Review Focus

1. **A pass for one scene used on another scene's space** (an AR pass minted for space A sent to space B's routes): every AR builder route must resolve its scene and refuse a mismatched pass with 403 `scene_pass_not_allowed`. Pinned in Task 5.
2. **An unpublished space reached by a visitor** (feed or marker lookup without sign-in): 404, the same as an unknown space, so drafts don't leak. Pinned in Task 4.
3. **A revoked or ended headset** whose 15-minute pass hasn't expired yet: the next request is 401 `device_revoked`. Pinned in Task 5.
4. **An adjustment whose instance was deleted, or belongs to another scene**: deleting cascades; writing one for an instance outside the space's scene is 400 `instance_not_in_scene`. Pinned in Task 6.
5. **Two builders holding one item** (a Decentraland editor drafting it while a headset sends a draft): the headset gets 409 `held` with the holder's name, and the Decentraland draft isn't disturbed. Pinned in Task 7.

---

### Task 1: Branch setup and the ring codec in TypeScript

**Files:**
- Create: `packages/vlm-shared/src/ring-marker/codec.ts`
- Modify: `packages/vlm-shared/src/index.ts` (add `export * from './ring-marker/codec.js'`)
- Test: `apps/server/test/ring-codec.test.ts` (reads `apps/ring-marker/vectors/codec.json`)

**Interfaces:**
- Produces:
  - `RING_CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'`
  - `encodeRing(markerId: number, version?: number): boolean[]` — 72 cells, same order as `ringmarker/codec.py` `encode`.
  - `ringCodeOf(markerId: number): string` — 7 characters.
  - `parseRingCode(code: string): number | null` — case-insensitive, `I`/`L` read as `1`, `O` as `0`, hyphens and spaces ignored; null unless exactly 7 characters whose value is below 2^32.
  - `randomRingId(): number` — uniform 32-bit, never 0. Server-only use (it calls `crypto.getRandomValues`, available in Node 20 and browsers).

- [ ] **Step 1: Create the worktree and bring in the spike and the specs**

```bash
cd /Users/unknower/-VLM/vlm-v2
git worktree add .worktrees/ar-spaces -b feature/ar-spaces main
cd .worktrees/ar-spaces
git merge --no-ff --no-edit feature/ar-spaces-design
git merge --no-ff --no-edit spike/ar-spaces
pnpm install
```

Expected: both merges succeed without conflicts (the design branch adds only `docs/`, the spike adds only `apps/ar-spike`, `apps/quest-spike` and `apps/ring-marker`).

- [ ] **Step 2: Write the failing test**

```ts
// apps/server/test/ring-codec.test.ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { encodeRing, parseRingCode, randomRingId, ringCodeOf } from 'vlm-shared'

const vectors = JSON.parse(readFileSync(new URL('../../ring-marker/vectors/codec.json', import.meta.url), 'utf8'))

describe('ring codec', () => {
  it('encodes every vector exactly as the Python reference', () => {
    for (const v of vectors.encode) expect(encodeRing(v.id, v.version ?? 0)).toEqual(v.cells)
  })
  it('writes the test markers codes', () => {
    expect(ringCodeOf(0x2e3d4c5b)).toHaveLength(7)
    expect(parseRingCode(ringCodeOf(0x2e3d4c5b))).toBe(0x2e3d4c5b)
  })
  it('reads codes forgivingly and rejects bad ones', () => {
    const c = ringCodeOf(0x1d2c3b4a)
    expect(parseRingCode(c.toLowerCase())).toBe(0x1d2c3b4a)
    expect(parseRingCode(c.slice(0, 3) + '-' + c.slice(3))).toBe(0x1d2c3b4a)
    expect(parseRingCode(c.replace(/1/g, 'I').replace(/0/g, 'O'))).toBe(0x1d2c3b4a)
    expect(parseRingCode('ZZZZZZZ')).toBeNull() // 35 bits, above 2^32
    expect(parseRingCode('ABC')).toBeNull()
    expect(parseRingCode('ABCDEFU')).toBeNull() // U isn't in the alphabet
  })
  it('makes non-zero 32-bit ids', () => {
    for (let i = 0; i < 100; i++) {
      const id = randomRingId()
      expect(id).toBeGreaterThan(0)
      expect(id).toBeLessThan(2 ** 32)
    }
  })
})
```

Before writing it, open `apps/ring-marker/vectors/codec.json` and match its real key names (the survey saw top-level `encode` and `decode`); adjust `v.id`, `v.version` and `v.cells` to them.

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm --filter vlm-server exec vitest run test/ring-codec.test.ts`
Expected: FAIL, `encodeRing` is not exported.

- [ ] **Step 4: Port `encode` and `code_of` from `apps/ring-marker/ringmarker/codec.py`**

Port GF(64) arithmetic (polynomial x^6+x+1), the systematic RS(12,6) encoder with generator roots α^0..α^5, the staggered symbol cells (`OFFSET = (0, 2, 4)`), and the XOR mask from SHA-256 of `"VLM ring marker v0"`. Compute the mask with a small synchronous SHA-256 or precompute it as a constant from the Python (`python3 -c` it once and paste the 72 booleans with a comment saying how it was made). Prefer the constant: `vlm-shared` runs in the browser too, where SHA-256 is async. The decoder isn't ported; only the Quest app decodes.

- [ ] **Step 5: Run the test to see it pass, then build the package**

Run: `pnpm --filter vlm-server exec vitest run test/ring-codec.test.ts && pnpm --filter vlm-shared build`
Expected: PASS; build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/vlm-shared/src/ring-marker/codec.ts packages/vlm-shared/src/index.ts apps/server/test/ring-codec.test.ts
git commit -m "feat(shared): ring marker codec in TypeScript, checked against the Python vectors"
```

---

### Task 2: Ring marker layout and SVG

**Files:**
- Create: `packages/vlm-shared/src/ring-marker/layout.ts`
- Create: `apps/ring-marker/vectors/layout.json` (made by a script step below)
- Modify: `packages/vlm-shared/src/index.ts`
- Test: `apps/server/test/ring-layout.test.ts`

**Interfaces:**
- Consumes: `encodeRing` (Task 1).
- Produces:
  - `type RingShape = { kind: 'sector'; r0: number; r1: number; a0: number; a1: number } | { kind: 'disc'; r: number } | { kind: 'rect'; x: number; y: number; w: number; h: number }` — millimetres, origin at the circle's centre, y up, angles in degrees clockwise from the top. Match `layout.py`'s `Sector`, `Disc`, `Rect` fields; rename only if they differ, and note it in a comment.
  - `ringShapes(markerId: number, diameterMm: number, version?: number): RingShape[]` — finder ring with its 16° top gap, the arcs, the centre dot and the corner marks.
  - `ringPlaqueSizeMm(diameterMm: number): number` — the square plaque's side (about 150 at 140).
  - `RING_MAX_DIAMETER_MM = 256`, `RING_DEFAULT_DIAMETER_MM = 140`.
  - `ringMarkerSvg(markerId: number, diameterMm: number, opts?: { dark?: string; light?: string }): string` — a standalone SVG with `width`/`height` in `mm` and a `viewBox` in millimetres, light plaque, dark shapes.

- [ ] **Step 1: Dump the Python layout as vectors**

```bash
cd apps/ring-marker
python3 - <<'EOF' > vectors/layout.json
import json, dataclasses
from ringmarker.layout import marker_shapes
from ringmarker.codec import TEST_MARKERS  # adjust the import if TEST_MARKERS lives elsewhere
out = []
for m in TEST_MARKERS:
    shapes = [dict(kind=type(s).__name__.lower(), **dataclasses.asdict(s)) for s in marker_shapes(m.id, m.diameter_mm, 0)]
    out.append(dict(id=m.id, diameter=m.diameter_mm, shapes=shapes))
print(json.dumps(out, indent=1))
EOF
```

Expected: a JSON file with three markers. Fix attribute names to whatever `layout.py` really uses.

- [ ] **Step 2: Write the failing test**

```ts
// apps/server/test/ring-layout.test.ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RING_MAX_DIAMETER_MM, ringMarkerSvg, ringShapes } from 'vlm-shared'

const vectors = JSON.parse(readFileSync(new URL('../../ring-marker/vectors/layout.json', import.meta.url), 'utf8'))

describe('ring layout', () => {
  it('matches the Python layout to 1 µm', () => {
    for (const m of vectors) {
      const shapes = ringShapes(m.id, m.diameter)
      expect(shapes.length).toBe(m.shapes.length)
      shapes.forEach((s, i) => {
        for (const [k, v] of Object.entries(m.shapes[i])) if (typeof v === 'number') expect((s as any)[k]).toBeCloseTo(v, 3)
      })
    }
  })
  it('refuses sizes above the bed limit', () => {
    expect(() => ringShapes(1, RING_MAX_DIAMETER_MM + 1)).toThrow()
  })
  it('draws an SVG sized in millimetres', () => {
    const svg = ringMarkerSvg(0x2e3d4c5b, 140)
    expect(svg).toMatch(/^<svg[^>]+width="[\d.]+mm"/)
    expect(svg).toContain('viewBox=')
  })
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm --filter vlm-server exec vitest run test/ring-layout.test.ts`
Expected: FAIL, `ringShapes` not exported.

- [ ] **Step 4: Port `marker_shapes` and `corner_grids` from `layout.py`; write `ringMarkerSvg`**

The corner marks derive from SHA-256 of the ID as 4 big-endian bytes. As with the mask in Task 1, avoid async hashing: include a tiny synchronous SHA-256 in `layout.ts` (about 60 lines, standard FIPS 180-4) since every marker's corners differ and can't be precomputed. Sectors become SVG `path`s with two arcs.

- [ ] **Step 5: Run the test to see it pass**

Run: `pnpm --filter vlm-server exec vitest run test/ring-layout.test.ts && pnpm --filter vlm-shared build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/vlm-shared/src/ring-marker/layout.ts packages/vlm-shared/src/index.ts apps/ring-marker/vectors/layout.json apps/server/test/ring-layout.test.ts
git commit -m "feat(shared): ring marker layout and SVG, matching the Python generator"
```

---

### Task 3: Spaces, floors and markers — tables and setup routes

**Files:**
- Modify: `apps/server/src/db/schema.ts` (new tables after `hyperfyPairings`)
- Create: `apps/server/src/ar/access.ts`, `apps/server/src/ar/spaces.ts`
- Create: `packages/vlm-shared/src/ar.ts` (the view types below), exported from `index.ts`
- Create: `apps/server/src/routes/ar-spaces.ts`; register in `apps/server/src/app.ts` next to `hyperfyPairingRoutes`
- Test: `apps/server/test/ar-spaces-routes.test.ts`

**Interfaces:**
- Produces tables (drizzle names → SQL names), all ids `uuid().primaryKey().defaultRandom()`, timestamps with time zone:
  - `arSpaces` → `ar_spaces`: `sceneId` (fk `scenes`, cascade), `name` text not null, `place` text (address or description), `lat` / `lng` doublePrecision nullable, `published` boolean default false, `createdAt`, `updatedAt`. Index on `sceneId`.
  - `arFloors` → `ar_floors`: `spaceId` (fk cascade), `name` text not null, `heightM` real not null default 0, `sortOrder` integer not null default 0.
  - `arMarkers` → `ar_markers`: `floorId` (fk cascade), `ringId` bigint `{ mode: 'number' }` unique not null, `code` text unique not null, `diameterMm` real not null default 140, `whereText` text (where the ring is, shown to visitors before they arrive), `poseX` / `poseY` / `poseZ` / `headingDeg` real nullable, `poseRecordedAt` timestamp nullable, `createdAt`.
- `apps/server/src/ar/access.ts`:
  - `mayBuild(access: SceneAccess): boolean` — true for levels `admin`, `owner`, `cohost`, `editor`.
  - `spaceScene(spaceId: string): Promise<string | null>`, `floorScene(floorId)`, `markerScene(markerId)` — return the scene id, null when not found or the id isn't a uuid.
  - SceneFrom resolvers: `fromSpace`, `fromFloor`, `fromMarker` (read param `id`), for `config.scenePass.sceneFrom`.
- `packages/vlm-shared/src/ar.ts`: `type ArMarkerView = { id: string; ringId: number; code: string; diameterMm: number; whereText: string | null; pose: { x: number; y: number; z: number; headingDeg: number } | null }`, `type ArFloorView = { id: string; name: string; heightM: number; sortOrder: number; markers: ArMarkerView[] }`, `type ArSpaceView = { id: string; sceneId: string; name: string; place: string | null; lat: number | null; lng: number | null; published: boolean; floors: ArFloorView[] }`.
- `apps/server/src/ar/spaces.ts` functions: `listSpaces(sceneId)`, `getSpace(id): Promise<ArSpaceView | null>`, `createSpace(sceneId, {name, place?})` (also creates floor "Ground floor" at 0 m), `updateSpace(id, patch)`, `deleteSpace(id)`, `addFloor(spaceId, {name, heightM})`, `updateFloor`, `deleteFloor`, `addMarker(floorId, {diameterMm?, whereText?})` (picks `randomRingId()` and retries on a unique clash, sets `code = ringCodeOf(ringId)`), `updateMarker(id, {diameterMm?, whereText?})`, `deleteMarker`. Every write calls `publishSceneTouched(sceneId)` so feeds wake.
- Routes (all `preHandler: [authenticate]`, then `getSceneAccess(actorFromClaims(request.user), sceneId)` and `mayBuild`, else 403 `no_access`). They declare `config.scenePass = { sceneFrom: <resolver> }` without `ar: true`: setup is a dashboard job, not a headset one.
  - `GET /api/scenes/:sceneId/ar/spaces` → `ArSpaceView[]` (this read-only route also takes an AR pass: `ar: true`, added in Task 5, so the headset HUD can name the scene's other places)
  - `POST /api/scenes/:sceneId/ar/spaces` `{name, place?}` → `ArSpaceView` (201)
  - `PUT /api/ar/spaces/:id` `{name?, place?, lat?, lng?, published?}` → `ArSpaceView`
  - `DELETE /api/ar/spaces/:id` → 204
  - `POST /api/ar/spaces/:id/floors` `{name, heightM}` → floor; `PUT /api/ar/floors/:id`; `DELETE /api/ar/floors/:id` (409 `last_floor` if it's the only floor)
  - `POST /api/ar/floors/:id/markers` `{diameterMm?, whereText?}` → `ArMarkerView` (400 `bad_diameter` outside 60–256 mm); `PUT /api/ar/markers/:id`; `DELETE /api/ar/markers/:id`

- [ ] **Step 1: Write the failing tests**

Use `resetDb`, `createUser`, `tokenFor`, `createScene`, `testApp` from `test/helpers`. Cases:
- `owner creates a space with a ground floor` — POST returns 201 and `floors[0]` is `{ name: 'Ground floor', heightM: 0 }`.
- `adds a 140 mm marker with a 7-character code` — `code` matches `/^[0-9A-HJKMNP-TV-Z]{7}$/` and `parseRingCode(code) === ringId`.
- `editor may set up, viewer may not` — a `sceneCollaborators` editor gets 201; a viewer gets 403 `no_access`.
- `booking host may not` — a booking grant with role `host` on a venue for the scene gets 403.
- `rejects a 300 mm marker` — 400 `bad_diameter`.
- `won't delete the last floor` — 409 `last_floor`.
- `a scene pass is refused on setup routes` — a Hyperfy pass for the scene gets 403.
- `deleting a space removes its floors and markers` — counts drop to 0.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter vlm-server exec vitest run test/ar-spaces-routes.test.ts`
Expected: FAIL, 404 on the new routes.

- [ ] **Step 3: Add the tables, `access.ts`, `spaces.ts` and the routes**

Copy the route module shape from `routes/scene-roles.ts`. Global setup runs `drizzle-kit push`, so no migration file is needed.

- [ ] **Step 4: Run them to see them pass, plus the scene-pass guard test**

Run: `pnpm --filter vlm-server exec vitest run test/ar-spaces-routes.test.ts && pnpm --filter vlm-server test -- scene-pass`
Expected: PASS (the guard test walks `app.registeredRoutes`, so it checks the new routes declare `scenePass` on purpose).

- [ ] **Step 5: Commit**

```bash
git add packages/vlm-shared/src apps/server/src/db/schema.ts apps/server/src/ar apps/server/src/routes/ar-spaces.ts apps/server/src/app.ts apps/server/test/ar-spaces-routes.test.ts
git commit -m "feat(server): AR spaces, floors and ring markers with setup routes"
```

---

### Task 4: Marker lookup and the published-space feed

**Files:**
- Create: `apps/server/src/ar/snapshot.ts`
- Create: `apps/server/src/routes/ar-feed.ts`; register in `app.ts`
- Modify: `packages/vlm-shared/src/ar.ts` (feed types and constants)
- Test: `apps/server/test/ar-feed.test.ts`

**Interfaces:**
- Consumes: `getSpace`, `ArSpaceView` (Task 3); `sceneSnapshot` (`hyperfy/snapshot.ts`), `onSceneTouched` (`realtime/bus.ts`), `TokenBucketLimiter`.
- Produces in `vlm-shared/src/ar.ts`:
  - `AR_FEED = { version: 1, holdMs: 25_000 }`
  - `type ArSpaceWire = Omit<ArSpaceView, 'sceneId'>`
  - `type ArFeedResponse = { v: 1; version: string; space: ArSpaceWire; scene: SerializedScene | null }`
  - `type ArMarkerLookup = { spaceId: string; floorId: string; markerId: string; spaceName: string; whereText: string | null }`
- `arSpaceSnapshot(spaceId: string): Promise<{ version: string; space: ArSpaceWire; scene: SerializedScene | null; sceneId: string } | null>` — `version` is SHA-256 of `{space, scene}` JSON (scene with adjustments applied, Task 6 adds that).
- Routes:
  - `GET /api/ar/markers/by-code/:code` → `ArMarkerLookup`. Public. 404 `not_found` for an unknown code or an unpublished space, unless the caller is signed in and `mayBuild` on its scene. `config.scenePass = { sceneFrom: markerSceneByCode, ar: true }` (the `ar` flag comes in Task 5; add it then).
  - `GET /api/ar/spaces/:id/feed?since=` → `ArFeedResponse`, long-poll exactly like `GET /api/hyperfy/feed` (`routes/hyperfy-feed.ts`: subscribe before the first read, hold `AR_FEED.holdMs`, answer when the version changes). Public for a published space; a draft space needs a signed-in builder (account token or AR pass), else 404. Its own per-IP limiter, `{ capacity: 120, refillPerSec: 2 }`, with test hooks `setArFeedLimiter` and `setArFeedHoldMs`. `logLevel: 'warn'`.

- [ ] **Step 1: Write the failing tests**

- `looks up a published marker by code, any case` — returns `spaceId`, `floorId`, `spaceName`.
- `hides an unpublished space from visitors` — lookup and feed both 404 without auth; the owner's token gets 200 for both.
- `the feed returns the space and the scene` — `space.floors[0].markers[0].code` present; `scene.images` present after `createElement(... 'image')`.
- `the feed holds until the scene changes` — with `setArFeedHoldMs(2000)`, a poll with the current `since` resolves after an instance update with a new version, well before 2 s.
- `the feed wakes on a space edit` — updating a marker's pose (direct DB update plus `publishSceneTouched`) changes the version.
- `rate-limits per IP` — with a 2-token limiter, the third call is 429 `rate_limited`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter vlm-server exec vitest run test/ar-feed.test.ts`
Expected: FAIL, 404.

- [ ] **Step 3: Implement `vlm-shared/src/ar.ts`, `ar/snapshot.ts` and `routes/ar-feed.ts`**

Factor the long-poll loop out of `hyperfy-feed.ts` into `apps/server/src/http/long-poll.ts` as `longPoll(request, reply, sceneId, since, holdMs, read: () => Promise<{ version: string; body: unknown } | null>)` and use it from both routes; the existing Hyperfy feed tests must still pass.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter vlm-server exec vitest run test/ar-feed.test.ts test/hyperfy-feed`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/vlm-shared/src/ar.ts apps/server/src/ar/snapshot.ts apps/server/src/http/long-poll.ts apps/server/src/routes/ar-feed.ts apps/server/src/routes/hyperfy-feed.ts apps/server/src/app.ts apps/server/test/ar-feed.test.ts
git commit -m "feat(server): published AR space feed and marker lookup by code"
```

---

### Task 5: Headset pairing and the AR pass

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`arDevices`)
- Create: `apps/server/src/ar/devices.ts`, `apps/server/src/routes/ar-devices.ts`; register in `app.ts`
- Modify: `apps/server/src/auth/scene-from.ts` (add `ar?: true` beside `hyperfy?: true`), `apps/server/src/auth/tokens.ts` (claims `deviceId`), `apps/server/src/auth/scene-pass.ts` (`issueArPass`), `apps/server/src/middleware/auth.ts` (the `via === 'ar'` checks), `apps/server/src/ws/VLMSceneRoom.ts` (treat a revoked AR pass like a revoked Hyperfy pass), `apps/server/src/app.ts` (`redactPairingCode` covers `/api/ar/pair/<code>`)
- Modify: `packages/vlm-shared/src/ar.ts` (`AR_PAIRING`, wire types)
- Modify routes to opt in with `ar: true`: in `routes/scenes.ts` `GET /api/scenes/:id`, `POST /api/presets/:presetId/elements`, `PUT /api/elements/:id`, `DELETE /api/elements/:id`, `POST /api/elements/:id/instances`, `PUT /api/instances/:id`; in `routes/scene-library.ts` `GET` and `POST /api/scenes/:sceneId/library`; `GET /api/ar/markers/by-code/:code` and `GET /api/ar/spaces/:id/feed` (Task 4); `GET /api/scenes/:sceneId/ar/spaces` (Task 3).
- Test: `apps/server/test/ar-devices.test.ts`

**Interfaces:**
- `arDevices` → `ar_devices`: `userId` (fk users, cascade, null until approved), `codeHash` text unique (nulled on claim), `secretHash` text not null (SHA-256 of the headset's secret, sent at start), `deviceName` text, `kind` text nullable (`personal` | `shared`, set on approval), `status` text not null default `pending` (`pending|approved|refused|claimed|revoked`), `codeExpiresAt`, `expiresAt` nullable, `lastUsedAt` nullable, `createdAt`. Index on `userId`.
- `AR_PAIRING = { codeTtlMs: 10 * 60_000, personalIdleTtlMs: 90 * 86_400_000, sharedSessionTtlMs: 12 * 3_600_000 }`. Codes reuse `HYPERFY_PAIRING`'s alphabet and length and `normalizePairingCode`.
- `ar/devices.ts`: `startDevicePairing(secretHash: string, deviceName: string | null): Promise<{ code: string; codeExpiresAt: Date }>`; `devicePairingForApproval(code)`; `approveDevicePairing(code, actor, kind: 'personal' | 'shared')`; `claimDevicePairing(code, secret)` → `{ deviceId, kind, expiresAt }` (sets `expiresAt` to now + idle TTL or session TTL); `mintArPass(app, deviceId, secret, spaceId)` → `{ pass, passExpiresAt, sceneId }` or an error code (`device_revoked`, `no_access`, `not_found`); personal devices slide `expiresAt` forward on each mint; `endDeviceSession(deviceId, secret)` (shared: status `revoked`; personal: no change) and it ends that device's AR drafts (Task 7 hooks in); `listDevices(userId)`; `revokeDevice(id, userId)`; `deviceLive(id): Promise<boolean>` with a 10 s cache cleared on revoke/end, as `pairingLive` does.
- `issueArPass(app, user, wallet, { deviceId, sceneId })` → `{ pass, passExpiresAt }`: claims `kind: 'scene'`, `sceneId`, `via: 'ar'`, `deviceId`, expiry `config.jwtAccessExpiry`.
- Middleware: `via === 'ar'` → 401 `device_revoked` unless `deviceLive(deviceId)`; 403 `ar_pass_not_allowed` on a route whose `scenePass` lacks `ar: true`. The existing scene-pass scene check then applies.
- Routes:
  - `POST /api/ar/pair` `{ secretHash, deviceName? }` → `{ code, approveUrl: <webAppUrl>/pair/headset/<code>, codeExpiresAt }`, 10/min per IP.
  - `GET /api/ar/pair/:code` (account only) → `{ deviceName, codeExpiresAt }`; 404 when expired or used.
  - `POST /api/ar/pair/:code/approve` `{ kind: 'personal' | 'shared' }` (account only), 30/min.
  - `POST /api/ar/pair/:code/claim` `{ secret }` → `{ status: 'pending' }` or `{ status: 'approved', deviceId, kind, expiresAt }` or `{ status: 'refused' }`; 120/min.
  - `POST /api/ar/devices/:id/pass` `{ secret, spaceId }` → `{ pass, passExpiresAt, sceneId }`; 403 `no_access` when the approving user can't build on that space's scene.
  - `POST /api/ar/devices/:id/end` `{ secret }` → 204.
  - `POST /api/ar/devices/:id/spaces` `{ secret }` → `Array<{ spaceId, spaceName, sceneId, sceneName }>`: every space on scenes the approving user can build on, for the headset's "pick a space" list when no ring is in view.
  - `GET /api/ar/devices` (account) → `Array<{ id, deviceName, kind, status, lastUsedAt, expiresAt }>`; `DELETE /api/ar/devices/:id` (account, own devices) → 204.

- [ ] **Step 1: Write the failing tests**

- `pairs a personal headset end to end` — start → approve as owner with `kind:'personal'` → claim returns `deviceId` → mint pass for the owner's space → `GET /api/scenes/:id` with the pass is 200.
- `a shared headset's session ends` — approve `shared`, claim, mint, `POST /end` → the same pass gets 401 `device_revoked`, and mint gets `device_revoked`.
- `revoking from the website kills the pass at once` — `DELETE /api/ar/devices/:id`, then the pass gets 401 `device_revoked`.
- `a pass for space A's scene can't touch space B's scene` — pass minted for A; `PUT /api/instances/<instance in B>` is 403 `scene_pass_not_allowed`.
- `an AR pass is refused on routes that don't opt in` — e.g. `GET /api/scenes/:id/roles` gives 403 `ar_pass_not_allowed`.
- `can't mint for a scene the approver can't build on` — owner of scene A approves; minting for a space on scene B (owned by someone else) is 403 `no_access`. A booking host approving is allowed to pair, but minting is 403 `no_access`.
- `wrong secret is refused` — claim and mint with another secret: 401 `bad_secret`.
- `codes expire after 10 minutes` — with a fake clock (`vi.setSystemTime`), approve after 10 min is 404.
- `lists the spaces the approver can build on` — owner of scene A and editor on scene B, a space on each, plus a space on scene C they can't touch → `POST /devices/:id/spaces` returns A's and B's only.
- `codes are kept out of logs` — `redactPairingCode('/api/ar/pair/ABC234/approve')` hides the code.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter vlm-server exec vitest run test/ar-devices.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement, following `hyperfy/pairing.ts` and `routes/hyperfy-pairing.ts` closely**

Reuse its `sha256`/`sameHash` helpers by moving them to `apps/server/src/auth/hash.ts` and importing them from both modules.

- [ ] **Step 4: Run them to see them pass, plus the whole server suite**

Run: `pnpm --filter vlm-server test`
Expected: PASS, including the Hyperfy pairing and scene-pass guard tests.

- [ ] **Step 5: Commit**

```bash
git add -A apps/server packages/vlm-shared
git commit -m "feat(server): headset pairing (personal or shared) and the AR scene pass"
```

---

### Task 6: Alignment saves and "Just this place" adjustments

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`arAdjustments`)
- Create: `apps/server/src/ar/adjustments.ts`, `apps/server/src/routes/ar-builder.ts`; register in `app.ts`
- Modify: `apps/server/src/ar/snapshot.ts` (apply adjustments)
- Test: `apps/server/test/ar-builder.test.ts`, `apps/server/test/ar-adjustments.test.ts`

**Interfaces:**
- `arAdjustments` → `ar_adjustments`: `spaceId` (fk cascade), `instanceId` (fk `scene_element_instances`, cascade), `dPosition` jsonb `{x,y,z}` metres, `dRotation` jsonb `{x,y,z}` degrees, `scaleFactor` jsonb `{x,y,z}` multipliers, `updatedAt`. Unique `(spaceId, instanceId)`.
- `applyAdjustments(scene: SerializedScene, adj: ReadonlyMap<string, Adjustment>): SerializedScene` (pure, in `ar/adjustments.ts`): for each instance whose `sk` is in `adj`, position += dPosition, rotation += dRotation (each Euler component, degrees), scale *= scaleFactor component-wise; returns a new object, input untouched. `type Adjustment = { dPosition: Vec3; dRotation: Vec3; scaleFactor: Vec3 }` exported from `vlm-shared/src/ar.ts`.
- `applyAdjustments` also sets `arAdjusted: true` on each adjusted instance, so the headset HUD can mark them.
- Routes (all `authenticate`, `mayBuild`, `scenePass: { sceneFrom: fromSpace | fromMarker, ar: true }`):
  - `PUT /api/ar/markers/:id/pose` `{ x, y, z, headingDeg, heightAboveFloorM }` → `{ marker: ArMarkerView, warnings: Array<'floor_height_off'> }`. Floor check: `|(y − heightAboveFloorM) − floor.heightM| > 0.5` warns. Heading stored normalised to [0, 360).
  - `PUT /api/ar/spaces/:id/adjustments/:instanceId` `Adjustment` → 200; 400 `instance_not_in_scene` if the instance isn't in the scene's active preset.
  - `DELETE /api/ar/spaces/:id/adjustments/:instanceId` → 204 (Reset to shared).
  - Each publishes `publishSceneTouched(sceneId)`.

- [ ] **Step 1: Write the failing tests**

`ar-adjustments.test.ts` (pure):
- `adds offsets and multiplies scale` — instance at (1,2,3), rotation (0,90,0), scale (2,2,2); adjustment dPosition (0.5,0,0), dRotation (0,10,0), scaleFactor (0.5,1,1) → (1.5,2,3), (0,100,0), (1,2,2).
- `leaves other instances and the input alone`.

`ar-builder.test.ts`:
- `saves an alignment and the feed carries it` — PUT pose, then the feed's marker `pose` equals it.
- `warns when the floor is off by more than 0.5 m` — floor at 0 m, pose y 2.2 with heightAboveFloorM 1.5 → `['floor_height_off']`; y 1.9 → `[]`.
- `heading is normalised` — 370 → 10, −90 → 270.
- `an adjustment shows only in this space's feed` — two spaces on one scene; adjust in A; A's feed instance is moved and flagged `arAdjusted`, B's and `GET /api/hyperfy/feed`'s snapshot (via `sceneSnapshot`) aren't.
- `refuses an instance from another scene` — 400 `instance_not_in_scene`.
- `deleting the instance drops the adjustment` — cascade.
- `an AR pass may save; a viewer may not` — AR pass 200, viewer 403.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter vlm-server exec vitest run test/ar-adjustments.test.ts test/ar-builder.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them to see them pass**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/server packages/vlm-shared
git commit -m "feat(server): save ring alignments and per-place adjustments; feed applies them"
```

---

### Task 7: AR draft relay

Rationale (ruling, recorded here so reviewers don't re-litigate): Quest has no maintained Colyseus 0.15 client, so the headset sends drafts over REST and the server relays them into the scene room, which keeps the Decentraland relay unchanged for everyone else. The room's holders move into a process-wide registry the AR routes can read synchronously. That works in `VLM_MODE=single`, which production runs (check `railway.toml`/env in Step 1 and stop with a ledger note if it doesn't); in other modes the AR draft routes answer 503 `drafts_unavailable` and the headset just saves without a live preview for others.

**Files:**
- Create: `apps/server/src/ws/draft-holds.ts`
- Modify: `apps/server/src/ws/VLMSceneRoom.ts` (use the registry instead of its private `draftHolders`; register/unregister itself in a `roomsByScene` map; expose `relayArDraft(msg)` and `relayArDraftEnd(sk, saved)`)
- Create: `apps/server/src/routes/ar-drafts.ts`; register in `app.ts`
- Modify: `apps/server/src/ar/devices.ts` (`endDeviceSession` ends the device's drafts)
- Test: `apps/server/test/ar-drafts.test.ts`

**Interfaces:**
- `draft-holds.ts`: `holderOf(sceneId, sk): DraftHolder | undefined`, `hold(sceneId, sk, holder: DraftHolder): boolean` (false when someone else holds it), `release(sceneId, sk, holderKey)`, `releaseAll(holderKey): Array<{ sceneId; sk }>`, `type DraftHolder = { key: string; name: string; expiresAt?: number }`. Room holders use key `room:<sessionId>`; headsets use `ar:<deviceId>`. `sweepExpired(now): Array<{ sceneId; sk }>` runs every 30 s from the room module.
- AR holds expire 10 minutes (Global Constraints) after the device's last draft for that item; expiry relays `transform_draft_end { sk, saved: false }`.
- Routes (AR pass only — an account token gets 403 `ar_pass_required`; `scenePass: { sceneFrom: boundSceneWithInstance, ar: true }` where the resolver checks the instance `sk` belongs to the pass's scene):
  - `POST /api/ar/drafts` `{ element, sk, position, rotation, scale }` → 204, or 409 `{ error: 'held', holderName }`; 20 per second per device as in the room.
  - `POST /api/ar/drafts/end` `{ sk, saved }` → 204.
- Relayed messages are the room's existing `transform_draft` (with `holderName` = the approving user's display name + " (headset)") and `transform_draft_end`, so the Decentraland HUD needs no change.

- [ ] **Step 1: Check production's mode**

Run: `grep -rn "VLM_MODE" apps/server/railway.toml railway.toml Dockerfile apps/server/entrypoint.sh 2>/dev/null`
Expected: no override (default `single`) or `single`. If production is scalable, record a ledger ruling and keep the 503 path as the only one.

- [ ] **Step 2: Write the failing tests**

Using `startGameServer` and `joinScene` from `test/helpers/game-server.ts`:
- `a headset draft reaches a Decentraland editor` — an editor client joined to the room receives `transform_draft` with the headset's position and a `holderName` ending in "(headset)".
- `a viewer doesn't receive it`.
- `a held item is refused` — the editor sends `transform_draft` for sk first; the headset gets 409 `held` with the editor's name; the editor's hold stands.
- `the headset's hold blocks the editor` — the editor gets `transform_held`.
- `ending the draft relays transform_draft_end`.
- `the hold lapses after 10 minutes` — fake timers: after 10 min plus a sweep, editors get `transform_draft_end { saved: false }`.
- `ending a shared session ends its drafts` — `POST /api/ar/devices/:id/end` relays `transform_draft_end` for each held sk.
- `an editor leaving the room still reverts its own drafts` — the existing `onLeave` behaviour still passes (run the room's existing draft tests).

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter vlm-server exec vitest run test/ar-drafts.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

- [ ] **Step 5: Run the room's and the new tests**

Run: `pnpm --filter vlm-server test -- draft`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A apps/server
git commit -m "feat(server): relay headset drafts to editors through the scene room"
```

---

### Task 8: AR analytics

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`analyticsSceneKindEnum` gains `'ar'`)
- Create: `apps/server/src/ar/analytics.ts`
- Modify: `apps/server/src/routes/ar-feed.ts` (new route)
- Test: `apps/server/test/ar-analytics.test.ts`

**Interfaces:**
- `POST /api/ar/spaces/:id/analytics` — public for a published space, body is the Hyperfy batch shape checked by `checkHyperfyAnalyticsBatch` (`{ v: 1, events: [{ type: 'enter'|'leave'|'pos', playerId, t, x?, y?, z? }] }`), plus `platform: 'ar-quest'` (reject other values with 400 `bad_platform`; `ar-ios` and `ar-visionos` are added by the Apple plan). Per-IP limiter `{ capacity: 60, refillPerSec: 1 }`. 404 for an unpublished or unknown space.
- `recordArBatch(space: { id; sceneId; name }, platform: string, batch)` — like `recordHyperfyBatch`: an `analytics_scenes` row with `kind: 'ar'`, `locationKey 'ar:<spaceId>'`, `realm 'ar'`; sessions with `platform` set to the batch's platform; visitors unverified.

- [ ] **Step 1: Write the failing tests**

- `records an enter and a leave as an ar-quest session` — the scene's analytics overview (existing query used by the dashboard) shows one visit with platform `ar-quest`.
- `refuses an unpublished space` — 404.
- `refuses other platforms` — `platform: 'hyperfy'` → 400 `bad_platform`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter vlm-server exec vitest run test/ar-analytics.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement, sharing code with `hyperfy/analytics.ts` rather than copying it**

- [ ] **Step 4: Run them to see them pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/server
git commit -m "feat(server): AR space analytics as platform ar-quest"
```

---

### Task 9: Print files

**Files:**
- Create: `apps/server/src/ar/printfiles.ts` (mesh building, STL, 3MF, PDF)
- Modify: `apps/server/src/routes/ar-spaces.ts` (download route)
- Test: `apps/server/test/ar-printfiles.test.ts`

**Interfaces:**
- Consumes: `ringShapes`, `ringPlaqueSizeMm`, `ringMarkerSvg`, `ringCodeOf` (Tasks 1–2).
- `type Mounting = 'none' | 'tape' | 'magnets' | 'screws' | 'keyhole'`. Defaults `'none'`.
  - `tape`: a 1 mm recess in the back, inset 8 mm from each edge.
  - `magnets`: four 10.4 × 2.2 mm pockets (for 10 × 2 mm discs) in the back, 12 mm in from each corner.
  - `screws`: two countersunk holes (3.5 mm shaft, 7 mm head) on the vertical centre line, 10 mm from top and bottom edges, outside the ring.
  - `keyhole`: one keyhole slot (8 mm head, 4 mm slot, 10 mm long) centred 15 mm below the top edge, with the plaque thickened to 6 mm behind it in a 30 mm square.
- `buildMarkerMeshes(markerId, diameterMm, mounting): { base: Mesh; raised: Mesh }` — the base is the square plaque 4.0 mm thick minus the mounting cuts; the raised part is every `RingShape` extruded 0.6 mm from z = 4.0. Arcs are polygonised at no more than 1° per segment.
- `stl(mesh): Buffer` (binary), `threeMf(base, raised): Buffer` (zip with two objects, two filaments), `paperPdf(markerId, diameterMm): Buffer` (US Letter, vector paths from `ringShapes`, the code, `vlm.gg/s/<code>`, a 100 mm check bar, and "Print at 100% (actual size)"; hand-written PDF objects, no library).
- `GET /api/ar/markers/:id/files?format=stl-base|stl-raised|3mf|pdf|svg&mounting=...` → file download with `Content-Disposition: attachment; filename="vlm-ring-<code>-<diameter>mm.<ext>"`. Same access as the setup routes.
- Ruling: the 3D printed text strip from the AR spaces design is left out of this plan (raised lettering needs a font outliner); the paper PDF prints the code and URL instead. Noted for the owner.

- [ ] **Step 1: Write the failing tests**

- `STL triangle counts are sane and the file size matches` — binary STL length = 84 + 50 × triangles; base has > 12 triangles; raised has > 300.
- `the base is 4 mm thick and the raised parts end at 4.6 mm` — min/max z of the parsed STL vertices.
- `the plaque is the plaque size wide` — x extent equals `ringPlaqueSizeMm(140)` within 0.01.
- `tape mounting cuts a 1 mm recess` — the base has vertices at z = 1.0.
- `3MF is a zip with a model file naming two objects` — unzip (Node `zlib` inflate on the entries, or check for `3D/3dmodel.model` and two `<object` tags).
- `the PDF says to print at 100% and carries the code` — starts with `%PDF-`, contains the code and `100%`.
- `the download route names the file` — `Content-Disposition` includes `vlm-ring-<code>-140mm.stl`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter vlm-server exec vitest run test/ar-printfiles.test.ts`

- [ ] **Step 3: Implement, porting `printfiles.py`'s `Mesh`, `build_meshes`, `write_stl`, `write_3mf`**

For the zip, use Node's `zlib.deflateRawSync` with a hand-written zip container (local headers, central directory, CRC-32) in `apps/server/src/ar/zip.ts`, unless a zip library is already a server dependency (check `apps/server/package.json` first and use it if so).

- [ ] **Step 4: Run them to see them pass, then open one STL in a slicer by eye if available**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/server
git commit -m "feat(server): ring marker print files (STL, 3MF, paper PDF) with mounting options"
```

---

### Task 10: Dashboard — AR spaces tab

**Files:**
- Create: `apps/web/src/lib/ar.ts` (pure helpers), `apps/web/src/lib/ar.test.ts`
- Create: `apps/web/src/app/(dashboard)/scenes/[sceneId]/ArSpaces.tsx`
- Modify: `apps/web/src/app/(dashboard)/scenes/[sceneId]/client.tsx` (tab `'ar'` labelled "AR spaces", added to `TabKey`, `TABS`, and the non-element special cases at the count/filter code), `apps/web/src/lib/api.ts` (methods below)

**Interfaces:**
- API methods: `getArSpaces(sceneId)`, `createArSpace(sceneId, body)`, `updateArSpace(id, patch)`, `deleteArSpace(id)`, `addArFloor(spaceId, body)`, `updateArFloor(id, patch)`, `deleteArFloor(id)`, `addArMarker(floorId, body)`, `updateArMarker(id, patch)`, `deleteArMarker(id)`, `arMarkerFileUrl(id, format, mounting)` (a URL builder; downloads go through `fetch` with the token and a blob, since a plain link can't send the header).
- `lib/ar.ts`: `alignmentStatus(m: ArMarkerView): 'not_aligned' | 'aligned'`, `spaceReadiness(s: ArSpaceView): { ok: boolean; missing: Array<'marker' | 'alignment'> }` (publishing is allowed with missing items but the UI says what's missing), `shareUrl(code: string): string` → `https://vlm.gg/s/<code>`, `friendlyArError(code: string): string` for `no_access`, `bad_diameter`, `last_floor`, `not_found`.
- UI (copy `SceneRoles.tsx`'s card and error pattern):
  - A list of the scene's spaces, **Add AR space** (name, place).
  - Per space: name and place fields, **Published** switch with the readiness note, floors (name, height in metres, add/remove), and per floor its markers.
  - Per marker: the live SVG preview from `ringMarkerSvg` (rendered with `dangerouslySetInnerHTML` from our own generator only), the code, size (60–256 mm, default 140), "Where to find it" text, alignment status ("Not aligned yet: align it with the Quest app"), share link, mounting choice, and downloads: **Paper (PDF)**, **3MF (two colours)**, **STL base**, **STL raised**. Printing note: "Print at 100%. Change filament at 4.0 mm. Matte filament works best."
  - A disabled **Order a printed marker** button with "Coming later".

- [ ] **Step 1: Write the failing tests for `lib/ar.ts`**

- `alignmentStatus` for a marker with and without a pose.
- `spaceReadiness` with no markers → `missing: ['marker']`; with an unaligned marker → `['alignment']`; aligned → `ok: true`.
- `shareUrl('2E3D4C5')` → `https://vlm.gg/s/2E3D4C5`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter web exec vitest run src/lib/ar.test.ts` (use the web package's real name from `apps/web/package.json`)

- [ ] **Step 3: Implement `lib/ar.ts`, the API methods and `ArSpaces.tsx`; wire the tab**

- [ ] **Step 4: Run tests, typecheck and build**

Run: `pnpm --filter web exec vitest run && pnpm --filter web typecheck && pnpm --filter web build`
Expected: PASS, static export builds.

- [ ] **Step 5: Check it in a browser**

Start the server and web locally against `vlm_test`-style local data (never `vlm`), sign in as a scene owner, add a space and a marker, see the preview, download each file. Use the `run` skill if it helps.

- [ ] **Step 6: Commit**

```bash
git add -A apps/web
git commit -m "feat(web): AR spaces tab with floors, ring markers, preview and print downloads"
```

---

### Task 11: Headset pairing pages and paired headsets

**Files:**
- Create: `apps/web/src/app/pair/headset/[code]/page.tsx`, `client.tsx`
- Create: `apps/web/src/app/(dashboard)/settings/PairedHeadsets.tsx`; mount in `settings/page.tsx` beside `LinkedHyperfySessions`
- Modify: `apps/web/src/lib/pairing.ts` (`headsetPairingCodeFromPath`), `apps/web/src/lib/pairing.test.ts`, `apps/web/src/lib/api.ts` (`getHeadsetPairingInfo`, `approveHeadsetPairing(code, kind)`, `getHeadsets`, `revokeHeadset`)
- Modify: `apps/server/src/app.ts` (`/pair/headset/:code` and the trailing-slash form → `sendFile('pair/headset/_/index.html')`)
- Test: `apps/web/src/lib/pairing.test.ts`, `apps/server/test/ar-pages.test.ts` (route serving; Task 12 adds to it)

**Interfaces:**
- The approval page mirrors `/pair/[code]`'s phases. Its choice: two large buttons, **This is my headset** ("Stays signed in. Builder opens in one tap.") and **Shared headset** ("Signs out when it's taken off. Each session needs a new code."). Neither is preselected.
- `PairedHeadsets` lists `getHeadsets()` with name, kind, last used, and **Revoke**.

- [ ] **Step 1: Write the failing tests**

- `headsetPairingCodeFromPath('/pair/headset/ABC-234/')` → `ABC234`.
- Server: `GET /pair/headset/ABC234` serves `pair/headset/_/index.html` from a temp `config.dashboardDir` (copy the `/u/:code` test in `companion-upload.test.ts`).

- [ ] **Step 2: Run them to see them fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run web and server tests, web build**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web apps/server
git commit -m "feat(web): approve a headset as personal or shared; list and revoke paired headsets"
```

---

### Task 12: The `vlm.gg/s/<code>` page and Android app links

**Files:**
- Create: `apps/web/src/app/s/[code]/page.tsx`, `client.tsx`
- Modify: `apps/server/src/app.ts` (`/s/:code` and `/s/:code/` → `s/_/index.html`; add `/s/` to the log scrub), new route `GET /.well-known/assetlinks.json`
- Modify: `apps/server/src/config.ts` (`androidAppPackage` default `gg.vlm.spaces`, `androidCertSha256` from `ANDROID_CERT_SHA256`, comma-separated, default empty)
- Test: `apps/server/test/ar-pages.test.ts`, `apps/web/src/lib/ar.test.ts` (code from path)

**Interfaces:**
- `lib/ar.ts`: `spaceCodeFromPath(path: string): string | null` — reads the last path segment, normalises with `parseRingCode`/`ringCodeOf`, null if invalid.
- The page fetches `GET /api/ar/markers/by-code/:code` with plain `fetch` (no auth) and shows: the space name, its "Where to find the ring" text, "Look at the ring when you get there", and **Open in the VLM app on Quest** (an `https://vlm.gg/s/<code>` link, which the Quest app's verified link catches) plus a short note that iPhone and Vision Pro apps are coming. Unknown or unpublished: "This space isn't open yet."
- `assetlinks.json`: `[{ "relation": ["delegate_permission/common.handle_all_urls"], "target": { "namespace": "android_app", "package_name": <androidAppPackage>, "sha256_cert_fingerprints": <androidCertSha256 list> } }]`, `Content-Type: application/json`. An empty fingerprint list serves `[]`, so nothing claims links before the app is signed.

- [ ] **Step 1: Write the failing tests**

- `spaceCodeFromPath('/s/2e3d-4c5/')` → the normalised code; `'/s/bad/'` → null.
- Server: `/s/ABCDEFG` serves `s/_/index.html`; `/.well-known/assetlinks.json` with `ANDROID_CERT_SHA256` set returns the package and fingerprints; unset returns `[]`.

- [ ] **Step 2: Run them to see them fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run all tests and build both apps**

Run: `pnpm test && pnpm --filter web build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web apps/server
git commit -m "feat: vlm.gg/s/<code> space page and Android app links"
```

---

## After this plan

Deployment waits for the owner: `railway up /Users/unknower/-VLM/vlm-v2/.worktrees/ar-spaces --path-as-root -s vlm-server --ci`, once they say so. `ANDROID_CERT_SHA256` is set after plan 3 creates the release key.
