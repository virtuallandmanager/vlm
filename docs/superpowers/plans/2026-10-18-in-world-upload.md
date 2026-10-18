# In-world Media Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an editor in a Decentraland scene upload images and GLBs from the HUD, on this computer or by scanning a QR code with a phone. Each upload shows up live in the HUD Media Library with a status badge.

**Architecture:** Builds on the existing companion upload codes and the `/u/[code]` page:
- Uploads become two steps (`start`, then data) so a `media_assets` row with a status exists while bytes are in flight.
- Library changes are published on the realtime bus and relayed to editors in the scene room. `vlm-core` exposes them as `onLibraryChanged`.
- The DCL HUD gets an Upload sub-view (opens the link and shows a server-rendered QR PNG) plus per-row badges.

**Tech Stack:** Fastify + drizzle (Postgres), Colyseus, Next.js static export, Decentraland SDK7 react-ecs, vitest. Adds the `qrcode` npm package to `apps/server`.

**Spec:** `docs/superpowers/specs/2026-10-18-in-world-upload-design.md`

## Global Constraints

- **Who:** only scene editors mint in-world codes (`scene.edit`). No renters. The HUD Upload button shows only where `canEdit()` passes.
- **No sign-in in the QR:** the QR and link carry only a companion upload code, never an auth hand-off code.
- **Kinds:** in-world codes are restricted to `kinds: ['image','model']`. The page picker and the server both enforce it.
- **Limits unchanged:** `classifyUpload` (images ≤ 10 MB, GLB ≤ 50 MB). Quota is checked with `assertStorageQuota` on the destination account.
- **Destination:** `uploadDestination(minter, sceneId)`. An editor's upload goes into the scene owner's account. Null means 403.
- **Stored statuses:** `media_assets.status` is `'uploading' | 'processing' | 'ready' | 'failed'`, default `'ready'`.
- **HUD statuses:** `'uploading' | 'processing' | 'available' | 'needs_sync' | 'failed'`. `needs_sync` applies only to **placed** GLBs that aren't deployed with the scene; an unplaced GLB is `available`.
- **Badge copy:** `✓ Available` (green), `⟳ Needs sync` (amber), `✕ Failed` (red), `• Uploading` / `• Processing` (muted). If the DCL font lacks a glyph, use `•` and keep the word.
- **Abandoned uploads:** a row still `uploading` 15 minutes after `start` becomes `failed` with error `Upload didn't finish`.
- **Code TTL and size:** in-world codes are 30 minutes and 10 uploads (the existing `createUploadToken` defaults).
- **Link base:** the upload URL is `${config.webAppUrl}/u/${code}`.
- **Typings:** the DCL adapter stays on SDK 7.22 typings. `uiBackground.texture` / `filterMode` exist there.
- **Off-limits:** billing routes. Breaking API changes are fine (no users), so there are no compatibility shims.
- **Tool versions:**
  - Server, core and web tests use Node 20 (`~/.nvm/versions/node/v20.20.2/bin` on PATH).
  - The server tests need the local Postgres that `apps/server/vitest.config.ts` points at.

## Review Focus

1. **The phone opens `https://<web>/u/abc123` in the production static build.** Expect the upload page with that code, not a blank page. Today the exported page reads `useParams()` as `'_'` and bails. Pinned by Task 4's `codeFromPath` tests and the `/u/:code` server route test in Task 3.
2. **The same file is retried after a failed `start`** (over quota or too big). Expect no orphan `uploading` row and no upload spent from the code. Pinned in Task 3.
3. **The minter is an admin, or a cohost/editor tied only to their wallet.** Their upload must land and link, not be refused. Today the route rebuilds them as `{role:'user'}` with no wallet. Pinned in Task 3.
4. **A second editor is in the room, or the uploader isn't in the room at all.** Every editor gets `scene_library_changed`; viewers get nothing. Pinned in Task 2.
5. **Dismissing a Failed row.** The link and the failed `media_assets` row are both gone, and a non-failed asset is never deleted by unlink. Pinned in Task 3.

---

### Task 1: Media status columns and library listing

**Files:**
- Modify: `apps/server/src/db/schema.ts`. Change `mediaAssets` (around line 594) and `uploadTokens` (around line 860).
- Modify: `apps/server/entrypoint.sh`. Add idempotent fallback SQL next to the `scene_library` block.
- Modify: `apps/server/src/library/scene-library.ts`. Change `LibraryItem` and `listSceneLibrary`; add `getSceneLibraryItem` and `expireStaleUploads`.
- Modify: `apps/server/src/analytics/jobs.ts`. Register a daily job.
- Test: `apps/server/test/scene-library-status.test.ts` (new).

**Interfaces:**
- **Produces, schema:**
  - `mediaAssets` gets:
    - `status` (`text('status').notNull().default('ready')`)
    - `error` (`text('error')`)
  - `storageKey` and `sizeBytes` become nullable.
  - `uploadTokens` gets:
    - `kinds` (`text('kinds').array()`, nullable = any)
    - `minterWallet` (`text('minter_wallet')`)
    - `minterVerified` (`boolean('minter_verified').notNull().default(false)`)
- **Produces, library:**
  - `LibraryItem` gains `status: 'uploading' | 'processing' | 'ready' | 'failed'` and `error: string | null`. Model-catalog items are always `'ready'`.
  - `export const STALE_UPLOAD_MS = 15 * 60_000`
  - `export async function expireStaleUploads(now?: Date): Promise<number>` sets `status='failed', error="Upload didn't finish"` on `uploading` rows whose `created_at < now - STALE_UPLOAD_MS`. It returns the count.
  - `export async function getSceneLibraryItem(sceneId: string, linkId: string): Promise<LibraryItem | null>`. It uses the same mapping as `listSceneLibrary`, so factor the row-to-item mapping into one function.
  - `listSceneLibrary` calls `expireStaleUploads()` first.

- [ ] **Step 1: Write the failing tests** in `scene-library-status.test.ts`. Use `resetDb`, `createUser` and `createScene` from `test/helpers`, and insert rows directly with `db`.
  - `it('lists a media item with its status and error')`: insert `media_assets {status:'processing', storageKey:null, sizeBytes:null, publicUrl:null}` and link it. `listSceneLibrary(scene.id)[0]` should have `status: 'processing'`, `error: null`, `url: ''`, `sizeBytes: 0`.
  - `it('marks uploads stuck in uploading for 15 minutes as failed')`: insert a row `{status:'uploading', createdAt: new Date(Date.now() - 16*60_000)}` and another at `Date.now() - 60_000`. After `listSceneLibrary`, the first has `{status:'failed', error:"Upload didn't finish"}` and the second is still `'uploading'`.
  - `it('defaults existing-style inserts to ready')`: an insert with no status reads back `'ready'`.
  - `it('getSceneLibraryItem returns one item or null')`: the linked id returns an item with the same shape as the list entry; a random uuid returns `null`.
- [ ] **Step 2: Run the tests.** `cd apps/server && pnpm vitest run test/scene-library-status.test.ts`. Expected: FAIL (no `status` column).
- [ ] **Step 3: Implement** the schema changes, the `LibraryItem` mapping, `expireStaleUploads` and `getSceneLibraryItem`.
  - `url` maps `publicUrl ?? ''` and `sizeBytes` maps `sizeBytes ?? 0`.
  - Register the daily job with `registerDailyJob('stale-upload-expire', (now) => expireStaleUploads(now))` in `jobs.ts`.
  - In `entrypoint.sh`, add the fallback block, logging `[vlm-server] media status columns ensured`:
    - `ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ready'`
    - `ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS error TEXT`
    - `ALTER TABLE media_assets ALTER COLUMN storage_key DROP NOT NULL`
    - `ALTER TABLE media_assets ALTER COLUMN size_bytes DROP NOT NULL`
    - `ALTER TABLE upload_tokens ADD COLUMN IF NOT EXISTS kinds TEXT[]`
    - `ALTER TABLE upload_tokens ADD COLUMN IF NOT EXISTS minter_wallet TEXT`
    - `ALTER TABLE upload_tokens ADD COLUMN IF NOT EXISTS minter_verified BOOLEAN NOT NULL DEFAULT false`
  - Fix any TypeScript fallout from the now-nullable `storageKey` and `sizeBytes`. That includes the quota sum in `media/quota.ts`, which must treat null as 0, and the media delete route.
- [ ] **Step 4: Run** `pnpm vitest run test/scene-library-status.test.ts test/scene-library.test.ts test/media-upload.test.ts` and then `pnpm typecheck` (or `pnpm exec tsc --noEmit`) in `apps/server`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): media upload status columns and library status`.

### Task 2: Live library changes over the scene room

**Files:**
- Modify: `apps/server/src/realtime/bus.ts`
- Modify: `apps/server/src/ws/VLMSceneRoom.ts`. Change `onVenueEvent` and add an editors-only send.
- Modify: `apps/server/src/library/scene-library.ts`. `linkToScene` publishes after inserting.
- Modify: `apps/server/src/routes/scene-library.ts`. The unlink route publishes.
- Modify: `packages/vlm-shared/src/protocol.ts`. Add the server→client message.
- Test: `apps/server/test/library-live-room.test.ts` (new). Model it on `transform-draft-room.test.ts`, which shows how to join editor and viewer clients.

**Interfaces:**
- **Consumes:** `getSceneLibraryItem` (Task 1).
- **Produces, bus:**
  - New `VenueEvent` member: `{ type: 'library_changed'; sceneId: string; linkId: string; removed: boolean }`
  - `export async function publishLibraryChanged(sceneId: string, linkId: string, removed = false): Promise<void>`. It never throws; copy `publishElementChanged`'s try/catch.
- **Produces, protocol:** `{ type: 'scene_library_changed'; data: { action: 'upsert'; item: SceneLibraryItemData } | { action: 'remove'; id: string } }`.
  - `SceneLibraryItemData` is exported from `vlm-shared` and has the same fields as the server's `LibraryItem`.
- **Produces, room:** on `library_changed` it sends `scene_library_changed` to every client with `scene.edit`, with no sender exclusion.
  - Upsert re-reads the item with `getSceneLibraryItem` and sends nothing if it's null.
  - Generalize `relayToEditors` so `except` is optional.

- [ ] **Step 1: Write the failing tests.**
  - `it('relays a library upsert to every editor and not to viewers')`: join an editor and a viewer, then `await publishLibraryChanged(scene.id, linkId)` after inserting and linking a media row. The editor receives `{action:'upsert', item:{id: linkId, status:'ready'}}`; the viewer receives nothing within 300 ms.
  - `it('relays a removal')`: `publishLibraryChanged(scene.id, linkId, true)` gives `{action:'remove', id: linkId}`.
  - `it('linkToScene publishes')`: calling `linkToScene` for a new media item delivers an upsert to a joined editor.
- [ ] **Step 2: Run** `pnpm vitest run test/library-live-room.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Call `publishLibraryChanged` in two places:
  - in `linkToScene`, only when a new row was inserted
  - in the unlink route after a successful delete, with `removed = true`
- [ ] **Step 4: Run** the new test file, then `test/scene-library.test.ts`, `test/scene-room.test.ts` and `test/transform-draft-room.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): relay scene library changes to editors`.

### Task 3: Two-step companion upload, QR PNG and dismiss

**Files:**
- Modify: `apps/server/src/routes/companion-upload.ts`
- Modify: `apps/server/src/media/store.ts`. Split it into a reserve step and a fill step.
- Modify: `apps/server/src/routes/scene-library.ts`. Unlink deletes a failed asset.
- Modify: `apps/server/src/app.ts`. Add a `/u/:code` static route.
- Modify: `apps/server/package.json`. Add `"qrcode": "^1.5.4"` and `"@types/qrcode"` as a dev dependency.
- Modify: `apps/server/test/scene-library-upload.test.ts`. Its companion test uses the old single POST; rewrite it for the new flow.
- Test: `apps/server/test/companion-upload.test.ts` (new).

**Interfaces:**
- **Consumes:**
  - Task 1's columns
  - `publishLibraryChanged` (Task 2)
  - `uploadDestination`, `linkToScene`, `classifyUpload`, `assertStorageQuota`
- **Produces, store.ts:**
  - `reserveMedia(ownerId, {filename, contentType, sizeBytes}, opts?)` returns a `mediaAssets` row:
    - it runs `classifyUpload` and `assertStorageQuota` and throws `StoreMediaError` on refusal
    - it inserts `{status:'uploading', storageKey:null, publicUrl:null, sizeBytes}` with the classified content type
  - `fillMedia(assetId, data: Buffer)` returns a `mediaAssets` row:
    - it sets `processing`, re-runs `classifyUpload(filename, contentType, data.length)`, uploads, and sets `{status:'ready', storageKey, publicUrl, sizeBytes: data.length}`
    - on any error it sets `{status:'failed', error: <message>}`, then rethrows
  - `storeMedia` keeps its signature for the dashboard routes; implement it as `reserveMedia` followed by `fillMedia`.
- **Produces, routes:**
  - `POST /api/upload-tokens`:
    - The body also takes `kinds?: ('image'|'model'|'video')[]`.
    - It stores `kinds`, plus `minterWallet = request.user.wallet ?? null` and `minterVerified = request.user.verified === true`.
    - The response `uploadUrl` is `${config.webAppUrl}/u/${code}`, and the response adds `qrUrl: ${config.publicUrl}/api/upload/${code}/qr.png`.
  - `GET /api/upload/:code`: the response adds `kinds: string[] | null`.
  - `POST /api/upload/:code/start` with `{filename, contentType, sizeBytes}`:
    - returns 201 `{assetId, remainingUploads}`, or the store error, or 403 `{error:'forbidden'}` when the destination is null
    - checks the code's `kinds` against the classified type: `image/*` is image, `model/gltf-binary` is model, `video/*` is video; a mismatch returns 415 `{error:'unsupported_type'}`
    - the asset is linked with `linkToScene(sceneId, {mediaAssetId}, token.userId, dest.bookingId)`
    - the upload count is incremented only on success
  - `POST /api/upload/:code/:assetId` with `{fileData}` (base64):
    - returns 201 `{asset}` (status `ready`)
    - returns 404 unless the asset was reserved through this code, so the token needs a way to know its reservations. My call: compare `media_assets.metadata.uploadCode === code`, written by `start`.
    - returns 409 when the asset isn't `uploading`
    - after both `ready` and `failed` it calls `publishLibraryChanged(sceneId, linkId)`
  - `GET /api/upload/:code/qr.png`:
    - `image/png` from `QRCode.toBuffer(uploadUrl, {margin: 2, width: 512, errorCorrectionLevel: 'M'})`
    - `Cache-Control: public, max-age=<seconds until expiry>`
    - 404 for an unknown or expired code
  - The old `POST /api/upload/:code` single-call route is removed.
- **Minter identity:** at `start`, build the Actor as `{userId: token.userId, role: <users.role read now>, wallet: token.minterWallet, verified: token.minterVerified}`. A token without `sceneId` stores into `token.userId`'s own account and isn't linked.
- **Unlink** (`DELETE /api/scenes/:sceneId/library/:id`): after its existing checks, if the linked `media_assets` row has `status` of `'failed'` or `'uploading'`, delete that asset row. The cascade removes the link. Otherwise only the link is removed (as today).
- **`app.ts`:** inside the dashboard block, before the not-found handler, register `GET /u/:code` (and the trailing-slash form). It sends `u/_/index.html` from the dashboard root.

- [ ] **Step 1: Write the failing tests** in `companion-upload.test.ts`.
  - **Setup:** an owner and an editor. Give the editor a `sceneRoles` editor row with a wallet, as `scene-library-upload.test.ts` does. Use `PNG` base64 from that file.
  - `it('mints an in-world code with kinds, a web link and a QR url')`: as the editor, `POST /api/upload-tokens {sceneId, kinds:['image','model']}`. Expect 201, `uploadUrl === `${config.webAppUrl}/u/${code}``, `qrUrl` ends with `/api/upload/${code}/qr.png`. `GET /api/upload/:code` returns `kinds: ['image','model']`.
  - `it("start then data stores an editor's upload in the owner's account, linked, ready")`: `start` returns 201. The library item is `status:'uploading'`. After the data post the asset is `status:'ready'`, its `ownerId === owner.id`, and the link's `addedBy === editor.id`.
  - `it('a refused start leaves no row and spends no upload')`: `start` with `sizeBytes: 11 * 1024 * 1024`, `image/png`. Expect 413, no new `media_assets` rows, and `remainingUploads` unchanged on `GET`.
  - `it('refuses a type outside the code kinds')`: a code with `kinds:['image']`, then `start` with `m.glb`/`model/gltf-binary`. Expect 415.
  - `it('a wallet-only editor and an admin minter both land')`: an editor whose access comes only from a wallet `sceneRoles` row, and a `createUser({role:'admin'})` minter. Both `start` with 201.
  - `it('a minter who lost access is refused at start')`: delete the editor's `sceneRoles` row after minting. `start` returns 403.
  - `it('data for an asset from another code is 404 and a second data post is 409')`
  - `it('bytes that fail classification mark the asset failed with an error')`: `start` as `image/png` with `sizeBytes: 10`, then post 11 MB of zero bytes. Expect a 413 response, and the asset reads `status:'failed'` with a non-null `error`.
  - `it('serves a QR png for a live code and 404 otherwise')`: the content type is `image/png` and the body starts with the PNG signature `89 50 4e 47`. An expired code returns 404.
  - `it('unlinking a failed upload deletes the asset; unlinking a ready one keeps it')`
  - `it('serves the upload page for /u/:code when the dashboard is present')`: set `config.dashboardDir` to a temp dir containing `u/_/index.html` with the text `UPLOAD`. `GET /u/abc234` returns 200 with a body that contains `UPLOAD`. Follow how `app.ts` reads `config.dashboardDir` at build time.
- [ ] **Step 2: Run** `pnpm vitest run test/companion-upload.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the store split, the routes, the unlink change and the `/u/:code` route. Then rewrite the companion test in `scene-library-upload.test.ts` for start-then-data. A stranger's code is now refused at `start` with 403.
- [ ] **Step 4: Run** the whole server suite, `pnpm vitest run` in `apps/server`, plus the typecheck. Expected: PASS. Before this work the server suite had 497 tests.
- [ ] **Step 5: Commit** `feat(server): two-step companion uploads with status, QR png and dismiss`.

### Task 4: The upload page

**Files:**
- Create: `apps/web/src/lib/companion.ts`
- Test: `apps/web/src/lib/companion.test.ts`
- Modify: `apps/web/src/app/u/[code]/client.tsx`

**Interfaces:**
- **Consumes:** Task 3's `GET` (with `kinds`), `start` and data routes.
- **Produces:**
  - `codeFromPath(pathname: string, paramCode: string | undefined): string | null`. It returns `paramCode` unless that is empty or `'_'`. Otherwise it parses `/u/<code>` from `pathname`, with or without a trailing slash, and returns null if there's no match. Codes match `^[a-z0-9]{6}$`.
  - `acceptFor(kinds: string[] | null): string`. For `['image','model']` it returns `'.png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif,.glb'`. For null it returns today's full list, including `.mp4,.webm`.
  - `uploadErrorMessage(status: number, body: {error?: string}): string`:
    - 413 → `'That file is too big (images up to 10 MB, models up to 50 MB)'`
    - 415 → `"That file type isn't supported here (HEIC photos: choose JPEG or PNG)"`
    - 410 → `'This upload link has used all its uploads'`
    - 404 → `'This upload link has expired — make a new one in-world'`
    - 403 → `"You can't upload to this scene anymore"`
    - 402 or a body error containing `quota` → `'Storage is full for this scene's owner'`
    - anything else → `body.error ?? 'Upload failed'`

- [ ] **Step 1: Write the failing tests** in `companion.test.ts`:
  - `codeFromPath('/u/abc234/', '_') === 'abc234'`
  - `codeFromPath('/u/abc234', undefined) === 'abc234'`
  - `codeFromPath('/x', '_') === null`
  - `codeFromPath('/u/abc234', 'zzz999') === 'zzz999'`
  - `acceptFor(['image','model'])` doesn't contain `mp4`; `acceptFor(null)` does.
  - Each `uploadErrorMessage` mapping above.
- [ ] **Step 2: Run** `cd apps/web && pnpm vitest run src/lib/companion.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers. Then change `client.tsx`:
  - Get the code from `codeFromPath(window.location.pathname, params.code)`, inside the effect.
  - Set the picker's `accept` with `acceptFor(tokenInfo.kinds)`.
  - Upload each file in two steps. First `start` with `{filename, contentType: file.type || (name ends .glb ? 'model/gltf-binary' : 'application/octet-stream'), sizeBytes: file.size}`. Then post the data with `XMLHttpRequest`, so `upload.onprogress` can drive a per-file progress bar.
  - Show each file in the list with its state (`Uploading 42%`, `Processing…`, `Done`, or the `uploadErrorMessage`).
  - An error on one file doesn't stop the others.
  - Change the footer copy to `Uploads appear in the Media Library in your HUD.`
- [ ] **Step 4: Run** `pnpm vitest run` and `pnpm exec tsc --noEmit` in `apps/web`. Expected: PASS (39 tests plus the new ones).
- [ ] **Step 5: Commit** `feat(web): upload page reads its code in static builds, two-step uploads with progress`.

### Task 5: Client and core library API

**Files:**
- Modify: `packages/vlm-client/src/http.ts`
- Modify: `packages/vlm-core/src/VLM.ts`
- Modify: `packages/vlm-core/src/managers/MeshManager.ts`
- Create: `packages/vlm-core/src/media-status.ts`, exported from the core index
- Test: `packages/vlm-core/test/media-status.test.ts`
- Test: `packages/vlm-core/test/models.test.ts`. Extend it.

**Interfaces:**
- **Consumes:** the `scene_library_changed` protocol type (Task 2) and Task 3's token response.
- **Produces, `vlm-client`:**
  - `SceneLibraryItem` gains `status` and `error`, and is aliased to vlm-shared's `SceneLibraryItemData`.
  - `createUploadToken(sceneId, opts?: {maxUploads?, expiresInMinutes?, kinds?})` returns `Promise<{ token: UploadToken }>`, where `UploadToken = { code: string; uploadUrl: string; qrUrl: string; expiresAt: string; maxUploads: number }`.
  - `removeFromSceneLibrary(sceneId: string, id: string): Promise<void>` sends `DELETE /api/scenes/:sceneId/library/:id`.
- **Produces, `vlm-core`:**
  - `VLM.onLibraryChanged(listener: (change: LibraryChange) => void): () => void`, fed by the `scene_library_changed` room message. `LibraryChange = { action: 'upsert'; item: SceneLibraryItem } | { action: 'remove'; id: string }`.
  - `VLM.missingModelSrcs(): string[]`, the `modelSrc` of each sk in `storage.models.missing`, taken from MeshManager's config map. Expose it through a MeshManager method `missingSrcs(): string[]`.
  - `media-status.ts`:
    - `export type HUDMediaStatus = 'uploading' | 'processing' | 'available' | 'needs_sync' | 'failed'`
    - `export function hudStatus(item: SceneLibraryItem, isModel: boolean, missingSrcs: ReadonlySet<string>): HUDMediaStatus`. It maps `ready` to `needs_sync` only when `isModel && missingSrcs.has(item.url)`, and otherwise to `available`. The other statuses pass straight through.
    - `export function applyLibraryChange(items: SceneLibraryItem[], change: LibraryChange): SceneLibraryItem[]`. An upsert replaces the item in place, or prepends it if it's new. A remove filters it out.

- [ ] **Step 1: Write the failing tests.**
  - `hudStatus` for each stored status, including:
    - a ready model with its url in `missingSrcs` gives `'needs_sync'`
    - a ready model with its url absent gives `'available'`
    - a ready image whose url happens to be in the set gives `'available'`
  - `applyLibraryChange`:
    - an upsert of a new item goes first
    - an upsert of an existing id replaces it at the same index
    - a remove of an unknown id leaves the list unchanged
  - In `models.test.ts`: after init with a model whose src the fake adapter can't resolve, `vlm.missingModelSrcs()` equals `[thatSrc]`; it is `[]` once that model is removed.
- [ ] **Step 2: Run** `cd packages/vlm-core && pnpm vitest run test/media-status.test.ts test/models.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Register the `scene_library_changed` handler next to the others in `registerMessageHandlers`, emitting `library_changed` on the event bus.
- [ ] **Step 4: Run** `pnpm vitest run` in vlm-core (225 tests plus the new ones) and the repo typecheck (`pnpm -r typecheck` or `pnpm turbo typecheck`, as the repo's root `package.json` names it). Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): live library changes, missing model srcs and HUD media status`.

### Task 6: HUD Upload view and status badges (DCL adapter)

**Files:**
- Modify: `packages/vlm-adapter-dcl/src/DclHUDRenderer.tsx`. Change `HUDMediaItem`, `state`, `AssetBrowserPanel` (around lines 776-833), and add new setters.
- Modify: `packages/vlm-adapter-dcl/src/index.ts`. Change `refreshMedia`, the action handler and the subscriptions.

**Interfaces:**
- **Consumes:** `hudStatus`, `applyLibraryChange`, `vlm.onLibraryChanged`, `vlm.missingModelSrcs`, `vlm.onModelsMissing`, `createUploadToken(sceneId, {kinds:['image','model']})`, `removeFromSceneLibrary` (Task 5).
- **Produces:**
  - Data types:
    - `HUDMediaItem = { id: string; name: string; kind: 'image' | 'model'; status: HUDMediaStatus; error?: string }`
    - New renderer state: `upload: { open: boolean; loading: boolean; error: string | null; token: UploadToken | null }`
  - Renderer setters:
    - `setUploadView(v: Partial<typeof state.upload>): void`
  - Scene actions, all editor-only:
    - `media_upload_open`: mints a token and opens the sub-view
    - `media_upload_new`: mints a fresh token
    - `media_upload_computer`: `adapter.openUrl(token.uploadUrl)`
    - `media_upload_back`: closes the sub-view and forgets the token
    - `media_dismiss {assetId}`: `removeFromSceneLibrary`

- [ ] **Step 1: Adapter wiring in `index.ts`.**
  - `refreshMedia` builds rows from one shared mapper: `mediaKind` + `hudStatus(item, kind === 'model', new Set(vlm.missingModelSrcs()))`.
  - `mediaKind` must accept non-ready items with an empty url. Classify by `contentType`/name when `status !== 'ready'`.
  - Subscribe once, for editors only:
    - `vlm.onLibraryChanged` → `media = applyLibraryChange(media, change)`, then push the rows.
    - `vlm.onModelsMissing` → re-push the rows, so Needs sync appears after Place and clears after a redeploy.
  - Panel close (`media_upload_back`) and a failed mint go through `setUploadView`. A mint failure shows `Couldn't make an upload link — try again`.
  - `place()` refuses items that aren't `available` or `needs_sync`, with the message `That file isn't ready yet`.
- [ ] **Step 2: Renderer.**
  - The header gets an `Upload` button, visible when `canEdit()`. The empty state replaces `Upload them on the dashboard's Media page` with the same `Upload` button.
  - Each row gets a badge `Label` after the name, using the constraint copy and colors: `C.success`, `C.warning`, `C.danger`, `C.textMuted`.
  - `Place` shows for `available` and `needs_sync`. `Dismiss` shows for `failed`, and the `error` appears as a 9 px second line. Nothing shows while uploading or processing.
  - The Upload sub-view replaces the list while `state.upload.open` is true:
    - title `Upload media`
    - button `Open on this computer`
    - a 168×168 `UiEntity` with `uiBackground={{ texture: { src: token.qrUrl, filterMode: 'point' }, textureMode: 'stretch' }}`
    - `Scan to upload from your phone`
    - `token.uploadUrl` in 10 px
    - `Code: <code>`
    - `Link expires <HH:MM local> · 10 uploads`
    - `New link` and `Back` buttons
    - while loading it shows `Making a link…`
- [ ] **Step 3: Build and typecheck** the adapter (`pnpm --filter vlm-adapter-dcl build` or its typecheck script) and the smart item (`pnpm --filter vlm-dcl test`, 20 tests). Expected: PASS.
- [ ] **Step 4: Smoke-test in the local scene.**
  - Run the hud-test worktree's local server, web and scene against this branch, the same way that setup does: server on 3010, web on 3000, scene on 8001 under Node 22.
  - Then check:
    - Upload opens the sub-view.
    - The QR texture renders. If it doesn't, record it; the text link still works.
    - `Open on this computer` shows DCL's open-link prompt.
    - Uploading a PNG from the browser shows `• Uploading` → `• Processing` → `✓ Available` in the HUD without reopening.
    - Placing a GLB flips its badge to `⟳ Needs sync`.
  - Note whether `✓ ⟳ ✕` render. If not, switch the glyph to `•`.
- [ ] **Step 5: Commit** `feat(dcl): HUD upload link, QR and live media status badges`.

### Task 7: Docs and owner checklist

**Files:**
- Modify: `apps/docs/.../dashboard/in-world-hud.md` (find it with `ls apps/docs` and search for `in-world-hud.md`). Add a section "Uploading from in-world".
- Create: `docs/superpowers/spikes/2026-10-18-in-world-upload-checklist.md`

- [ ] **Step 1: Write the docs section.** Cover:
  - the Upload button, the computer link and the phone QR
  - who can use it (editors)
  - what each badge means
  - that models need `npx vlm-dcl sync` and a redeploy after placing
  - that links last 30 minutes and allow 10 uploads
- [ ] **Step 2: Write the owner's in-world checklist** of about 15 items. It mirrors Task 6's smoke test, plus:
  - phone scan on iOS and Android
  - an iPhone photo, checking whether it was converted to JPEG
  - too-big file → Failed → Dismiss
  - an expired link
  - a second editor sees uploads live
  - a viewer sees no Upload button
- [ ] **Step 3: Commit** `docs: in-world upload guide and checklist`.
