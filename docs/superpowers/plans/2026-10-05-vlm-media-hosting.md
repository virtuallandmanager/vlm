# VLM Media Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hosts upload images and GLBs to VLM and place them in their Decentraland scene; images appear live, GLBs after one `npx vlm-dcl sync` + redeploy, then everything is edited live.

**Architecture:** Uploads go to the Media library (R2 via `cdn.vlm.gg`) with a type/size allowlist. Every REST element/instance write publishes an `element_changed` bus event; scene rooms load the element and broadcast a full `upsert`/`delete`, which `SceneManager` applies by replacing the element. The DCL adapter maps model URLs to deployed files under `models/vlm/` and reports undeployed ones; a dependency-free `vlm-dcl sync` CLI downloads a location's models into the scene folder. HUD and dashboard get place/upload/picker UI.

**Tech Stack:** Fastify 5, Drizzle + Postgres, Colyseus 0.15, vitest, DCL SDK7 react-ecs, Next.js 15, Node ≥ 18 (`node:test` for the CLI).

**Spec:** `docs/superpowers/specs/2026-10-05-vlm-media-hosting-design.md`

## Global Constraints

- Node 20 for dev (`export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH`); the CLI must run on Node ≥ 18 with no dependencies.
- Server tests: `cd apps/server && npx vitest run <file>`; full `pnpm --filter vlm-server test`. Core: `pnpm --filter vlm-core exec vitest run`. Test helper `createScene(owner, name?)` returns `{ scene, preset }`.
- Allowed uploads: `image/png`, `image/jpeg`, `image/webp`, `image/gif` ≤ 10 MB; GLB ≤ 50 MB (`model/gltf-binary`, or `application/octet-stream` + `.glb` filename → stored as `model/gltf-binary`). Otherwise `415 { error: 'unsupported_type' }` / `413 { error: 'too_large' }`.
- Live update messages: `scene_preset_update` `{ action: 'upsert', element: 'image'|'model'|'video'|'sound', elementData }` and `{ action: 'delete', element, id }`.
- Model file path in a scene: `models/vlm/<last URL path segment>` (e.g. `https://cdn.vlm.gg/u1/ab12.glb` → `models/vlm/ab12.glb`).
- Sync manifest: `models/vlm/.vlm-sync.json`. Size limits: Genesis City 15 MB × parcels; Worlds 100 MB.
- No new dependencies. Don't change billing routes. Wallets lowercased.
- Commit after each task; end every commit message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. A relayed toggle (`{ id, enabled }` with no properties) must leave `textureSrc`/`modelSrc` intact in the DB — Task 1.
2. An edit to a non-active preset must not reach players in the room — Task 2.
3. A model whose file isn't deployed must not create a broken entity in-world, and the HUD must say why — Task 4.
4. `sync` must never delete files it didn't create — Task 5.
5. A viewer (or a visitor with no role) must not be able to place or delete elements through the new HUD actions (server-enforced) — Task 6.

---

### Task 1: Upload allowlist + safe property merge

**Files:** Modify `apps/server/src/routes/media.ts`, `apps/server/src/ws/VLMSceneRoom.ts` (`persistPresetUpdate`); Test `apps/server/test/media-upload.test.ts`, extend the existing room test (`test/scene-room.test.ts`) or add `test/preset-persist.test.ts`.

**Interfaces:** Produces `export function classifyUpload(filename: string, contentType: string, size: number): { ok: true; contentType: string } | { ok: false; status: 413 | 415; error: 'too_large' | 'unsupported_type' }` in `apps/server/src/storage/upload-policy.ts`.

- [ ] **Step 1: Failing tests.** `media-upload.test.ts`: PNG 1 KB → 201 and `asset.contentType === 'image/png'`; GLB sent as `application/octet-stream` with `duck.glb` → 201 stored as `model/gltf-binary`; `text/html` → 415 `unsupported_type`; an 11 MB PNG → 413 `too_large`; a 51 MB GLB → 413 (build buffers with `Buffer.alloc`, base64 them). Unit-test `classifyUpload` directly for the boundaries (exactly 10 MB image ok, 10 MB + 1 → too_large; `.GLB` uppercase ok).
  Room persist test: create an image element with `properties: { textureSrc: 'https://x/a.png' }`, send `scene_preset_update` `{ action: 'update', element: 'image', elementData: { sk: <id>, enabled: false } }` from a host client, assert the DB row has `enabled = false` and `properties.textureSrc === 'https://x/a.png'`; send `{ action: 'update', element: 'image', elementData: { sk: <id>, textureSrc: 'https://x/b.png' } }` → `properties = { textureSrc: 'https://x/b.png' }` (other keys kept).
- [ ] **Step 2: Run, verify they fail.**
- [ ] **Step 3: Implement.** `upload-policy.ts`:
```ts
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MB = 1024 * 1024
export const IMAGE_MAX_BYTES = 10 * MB
export const MODEL_MAX_BYTES = 50 * MB

export function classifyUpload(filename: string, contentType: string, size: number):
  | { ok: true; contentType: string }
  | { ok: false; status: 413 | 415; error: 'too_large' | 'unsupported_type' } {
  const type = (contentType || '').toLowerCase()
  const isGlb = /\.glb$/i.test(filename) && (type === 'model/gltf-binary' || type === 'application/octet-stream' || type === '')
  if (IMAGE_TYPES.has(type)) return size > IMAGE_MAX_BYTES ? { ok: false, status: 413, error: 'too_large' } : { ok: true, contentType: type }
  if (isGlb) return size > MODEL_MAX_BYTES ? { ok: false, status: 413, error: 'too_large' } : { ok: true, contentType: 'model/gltf-binary' }
  return { ok: false, status: 415, error: 'unsupported_type' }
}
```
In `media.ts` call it right after decoding the buffer (before the quota check); use the returned `contentType` for storage + DB; sanitize the stored extension to `glb|png|jpg|jpeg|webp|gif` from the classified type. In `persistPresetUpdate`'s element-update and instance-update branches: compute `const extracted = this.extractProperties(data)`; only if it has keys, load the current row and set `properties = { ...(row.properties ?? {}), ...extracted }`. Also make `extractProperties` unwrap a nested `properties` object (`{ ...data.properties, ...rest }`) so old dashboard relays don't nest.
- [ ] **Step 4: Run tests; full server suite.**
- [ ] **Step 5: Commit** `fix(server): media upload type/size allowlist; live edits merge element properties`.

---

### Task 2: Server-broadcast live updates after REST writes

**Files:** Modify `apps/server/src/realtime/bus.ts`, `apps/server/src/routes/scenes.ts` (element create/update/delete and instance create/update/delete handlers — lines ~290–480), `apps/server/src/ws/VLMSceneRoom.ts` (`onVenueEvent`); Test `apps/server/test/live-updates.test.ts` (use `test/helpers/game-server.ts` `startGameServer` / `joinScene`).

**Interfaces:**
- Bus event added to `VenueEvent`: `{ type: 'element_changed'; sceneId: string; presetId: string; elementId: string; elementType: string; deleted: boolean }` and `export async function publishElementChanged(e: Omit<Extract<VenueEvent, { type: 'element_changed' }>, 'type'>)`.
- Room broadcasts `scene_preset_update` `{ action: 'upsert', element, elementData }` (from `serializeSingleElement(elementWithInstances)`) or `{ action: 'delete', element, id }`, only when `presetId === scene.activePresetId`. Must not touch `accessGeneration`/access cache.

- [ ] **Step 1: Failing test.** Start the game server; create host, scene (active preset), join the room as the host; via REST: create an image element → the client receives `{ action: 'upsert', element: 'image', elementData: { sk, textureSrc, instances: [] } }`; add an instance → `upsert` whose `elementData.instances` has 1 with the posted position; update the instance position → `upsert` with the new position; delete the instance → `upsert` with 0 instances; delete the element → `{ action: 'delete', element: 'image', id }`. Second preset (not active): creating an element there → no message within 300 ms.
- [ ] **Step 2: Run, verify it fails.**
- [ ] **Step 3: Implement.** In each REST handler, after the DB write succeeds, `await publishElementChanged({ sceneId, presetId, elementId, elementType, deleted })` (look up the element's preset → scene id; for instance routes use the instance's element). In the room's `onVenueEvent`, handle `element_changed` before the access-cache branch: if deleted → broadcast delete; else load the element `with: { instances: true }`, verify `element.presetId` is the scene's active preset (load scene), broadcast upsert. Swallow and log errors (never crash the room).
- [ ] **Step 4: Run test; full server suite.**
- [ ] **Step 5: Commit** `feat(server): broadcast full element upserts to scene rooms after REST edits`.

---

### Task 3: `GET /api/setup/models` (public model list for a location)

**Files:** Modify `apps/server/src/routes/setup.ts`; Test `apps/server/test/setup-models.test.ts`.

**Interfaces:** `GET /api/setup/models?location=<gc:x,y|world:name>` → `200 { sceneId, models: [{ elementId, name, url, file, sizeBytes }] }` where `file = 'models/vlm/' + basename(url)` and `sizeBytes` comes from the matching `media_assets.publicUrl` row (null if unknown). `404 { error: 'not_set_up' }` when the location has no active setup. `400` for a bad location string. Rate-limit per IP with the existing limiter.
Also export `localModelFile(url: string): string | null` from `packages/vlm-shared/src/models.ts` (index export): returns `models/vlm/<basename>` for http(s) URLs ending in `.glb` (query string stripped), else `null`. Server uses it.

- [ ] **Step 1: Failing tests.** Active setup with an active preset holding: model element `modelSrc: 'https://cdn.vlm.gg/u/aa.glb'` (with a matching media_assets row of 1234 bytes), model element with `modelSrc: 'models/local.glb'` (not listed), image element (not listed) → exactly one model `{ file: 'models/vlm/aa.glb', sizeBytes: 1234 }`. Ended setup → 404. Unknown location → 404. `location=nope` → 400. Unit tests for `localModelFile` (query string, uppercase `.GLB`, non-glb → null, relative → null) in `packages/vlm-core/test/models.test.ts`.
- [ ] **Step 2–4:** fail → implement → pass; full server + core suites.
- [ ] **Step 5: Commit** `feat(server): public model list for a set-up location`.

---

### Task 4: Live upserts in core; deployed-model mapping in the DCL adapter

**Files:** Modify `packages/vlm-core/src/SceneManager.ts`, `packages/vlm-core/src/managers/MeshManager.ts` (if needed for the hook), `packages/vlm-adapter-dcl/src/DclAdapter.ts`; Test `packages/vlm-core/test/scene-manager-upsert.test.ts`.

**Interfaces:**
- `SceneManager.handlePresetUpdate` handles `action: 'upsert'`: `managers[element].delete(elementData.sk)` (no-op if absent) then `managers[element].create(elementData)`.
- `VLMPlatformAdapter` optional hook `resolveModelSrc?(src: string): string | null` (vlm-shared types). MeshManager calls it (when present) before creating the GltfContainer; `null` → skip the entity and record the element in `storage.models.missing` (a `Set<string>` of element sks, or an array — pick one and type it) and emit an event `'models_missing'` on the core EventBus with the count.
- DCL adapter: at init, load `getSceneInformation().content` (array of `{ file }`) into a Set (lowercased); `resolveModelSrc(src)`: if `localModelFile(src)` is non-null → return it when the Set contains it, else `null`; non-URL src → return as-is.
- `VLM` exposes `missingModels(): number` (read by the HUD in Task 6).

- [ ] **Step 1: Failing core tests.** With a fake adapter (follow the pattern in existing vlm-core tests): `upsert` for an existing image replaces its config/instances (old instance entity removed, new ones created); `upsert` for an unknown element creates it. Model with `resolveModelSrc` returning null → no entity created, `missingModels()` = 1 and the event fires; returning a path → GltfContainer src is that path.
- [ ] **Step 2–4:** fail → implement → pass; `pnpm --filter vlm-core exec vitest run`; build + typecheck vlm-shared, vlm-core, vlm-adapter-dcl.
- [ ] **Step 5: Commit** `feat(core,dcl): apply live element upserts; load GLBs from deployed models/vlm files`.

---

### Task 5: `npx vlm-dcl sync`

**Files:** Create `packages/vlm-smart-item-dcl/bin/vlm-dcl.mjs` (shebang `#!/usr/bin/env node`), `packages/vlm-smart-item-dcl/bin/sync.mjs` (logic, exported for tests), `packages/vlm-smart-item-dcl/test/sync.test.mjs` (`node:test`); Modify `packages/vlm-smart-item-dcl/package.json` (`"bin": { "vlm-dcl": "bin/vlm-dcl.mjs" }`, add `bin` to `files`, script `"test": "node --test test/"`).

**Interfaces:** `vlm-dcl sync [--server <url>] [--location <key>] [--dry-run]`; exported `locationFromSceneJson(json): string`, `async function sync({ cwd, server, location, dryRun, fetch, log }): Promise<{ downloaded: string[]; skipped: string[]; removed: string[]; totalBytes: number; limitBytes: number; over: boolean }>`.

- [ ] **Step 1: Failing tests** (stub `fetch` and a temp dir): `locationFromSceneJson` → `gc:-3,-2` from `scene.base`, `world:my.dcl.eth` from `worldConfiguration.name` (lowercased); sync downloads two listed models to `models/vlm/`, writes `.vlm-sync.json`; second run skips both (same size); a listed model removed from the server list is deleted only if it's in the manifest; an unrelated `models/vlm/mine.glb` not in the manifest is never deleted; `--dry-run` writes nothing; 404 `not_set_up` → throws a clear error ("This location isn't set up in VLM yet — walk into your deployed scene and press Set up VLM here"); size: GC 1 parcel with 16 MB of files → `over: true`.
- [ ] **Step 2–4:** fail → implement → pass (`cd packages/vlm-smart-item-dcl && node --test test/`). CLI prints a summary (downloaded/skipped/removed, total vs limit, and "Now deploy your scene (Creator Hub: Publish, or `npx sdk-commands deploy`)").
- [ ] **Step 5: Commit** `feat(vlm-dcl): npx vlm-dcl sync downloads a location's GLBs into models/vlm`.

---

### Task 6: HUD — place from the library, layout show/hide/delete, sync notice

**Files:** Modify `packages/vlm-adapter-dcl/src/DclHUDRenderer.tsx`, `packages/vlm-adapter-dcl/src/index.ts`, `packages/vlm-client/src/http.ts`; Test `packages/vlm-core/test/media-client.test.ts`.

**Interfaces:** New `VLMHttpClient` methods: `getMedia(): Promise<{ assets: { id, filename, contentType, publicUrl, sizeBytes }[] }>` (`GET /api/media`), `getScene(sceneId)` (exists — reuse to read `activePresetId`), `createElement(presetId, { type, name, properties })` and `createInstance(elementId, { position, rotation, scale })`, `updateElement(elementId, patch)`, `deleteElement(elementId)` — match the existing REST routes in `apps/server/src/routes/scenes.ts` (read their bodies). Renderer methods `setMedia(list)`, `setMissingModels(n)`; scene actions `media_refresh`, `media_place { assetId }`, `layout_toggle { elementId, enabled }`, `layout_delete { elementId }`.

- [ ] **Step 1: Failing client tests** for the new methods' URLs/bodies (stub fetch, same style as `setup-client.test.ts`).
- [ ] **Step 2–3: Implement.**
  - The Assets panel (existing `AssetBrowserPanel` UI in the renderer) shows the host's media: images and GLBs (badge "GLB"), with a **Place** button.
  - `media_place`: read the player's position/rotation (`Transform.get(engine.PlayerEntity)`), compute 2 m forward on the XZ plane, convert to scene-local coordinates (subtract the scene base parcel × 16 — reuse the adapter's existing base-parcel info), create the element (`image` → `{ textureSrc: url }`, scale 2×2×1, facing the player; `model` → `{ modelSrc: url }`, scale 1) and one instance via REST in the active preset. The server broadcast (Task 2) renders it.
  - Layout panel rows get show/hide and delete (confirm step) via REST.
  - When `vlm.missingModels() > 0` (and on the `models_missing` event), show a notice in the toolbar area: "N model(s) need sync + redeploy — run npx vlm-dcl sync".
  - Only host/co-host/editor see Place / show-hide / delete (renderer state `sceneRole`); the server already enforces it (403 → friendly "You don't have permission to edit this scene").
  - Wire the old `setHUDActionHandler` 'place' path to the same `media_place` handler (or remove the dead tile click).
- [ ] **Step 4: Verify:** core tests; build + typecheck adapter; smart-item bundle + typecheck; build `test-scenes/dcl-smart-item-test`.
- [ ] **Step 5: Commit** `feat(dcl): place images and GLBs from your media library in the HUD; sync notice`.

---

### Task 7: Dashboard — GLB upload and picker; stop raw relays

**Files:** Modify `apps/web/src/app/(dashboard)/scenes/[sceneId]/client.tsx` (ModelElementEditor ~545–575, MediaPicker ~384, relay calls ~1136–1365), `apps/web/src/app/(dashboard)/media/page.tsx`, `apps/web/src/lib/api.ts` (upload helper).

- [ ] **Step 1: Shared upload helper** in `api.ts`: `fileToBase64(file: File): Promise<string>` using `FileReader.readAsDataURL` (strip the `data:…;base64,` prefix); use it everywhere uploads are built (media page, image editor, new model editor). Show server errors `unsupported_type` / `too_large` as "Only PNG, JPG, WebP, GIF (≤ 10 MB) or GLB (≤ 50 MB)".
- [ ] **Step 2: ModelElementEditor:** add **Upload GLB** (`accept=".glb,model/gltf-binary"`) and a **Choose from Media** picker filtered to GLBs (extend MediaPicker's `accept` to match `model/gltf-binary` or `.glb` names); under the field: "GLBs need `npx vlm-dcl sync` + a redeploy before they appear in-world."
- [ ] **Step 3: Media page** accepts `.glb` and shows a "GLB" tile for models.
- [ ] **Step 4: Remove the Colyseus relays** after REST writes in `client.tsx` (the server broadcasts now). Keep anything that isn't an element/instance edit (video live controls etc.) untouched.
- [ ] **Step 5: Verify** `pnpm --filter vlm-web exec tsc --noEmit && pnpm --filter vlm-web build`; commit `feat(web): GLB upload and picker; rely on server-broadcast live updates`.

---

### Task 8: Release prep

- [ ] **Step 1:** `pnpm turbo test` and `cd packages/vlm-smart-item-dcl && node --test test/` — all green.
- [ ] **Step 2:** README for `vlm-dcl`: section "Images and 3D models" — upload on vlm.gg (Media) or place from the HUD; images are live; GLBs: run `npx vlm-dcl sync` in your scene folder, then deploy; after that they're edited live. Keep version `2.1.0` (unpublished).
- [ ] **Step 3: Commit** `docs(vlm-dcl): images and 3D models`.
- [ ] Controller (not implementer): merge, deploy, in-world check per spec §5, publish `vlm-dcl` 2.1.0 with the user's passkey.
