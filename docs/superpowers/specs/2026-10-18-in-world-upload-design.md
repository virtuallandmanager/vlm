# In-world media upload — design

Status: draft, awaiting approval (2026-10-18)

## Intent

An editor standing in their scene wants to get a file into it without leaving the world to hunt through the dashboard. The file is usually either a photo on their phone or an image or GLB model on their computer. Today they have to go to the dashboard's Media page, upload there, then come back. Even after that, the file doesn't show up in the in-world Media Library: dashboard uploads never join the scene's library.

What they want: an **Upload** button in the HUD Media Library. It opens an upload page on the computer, and the same panel shows a QR code to open that page on a phone. Whatever they upload then **waits in the HUD Media Library**, not placed automatically. Each item carries a status that updates live (Uploading → Processing → Ready, plus the model-specific state described below) until it's ready to Place with the existing Place button.

Success: the editor clicks Upload, scans the QR, picks a photo on the phone, and watches it appear in the HUD list within seconds, going from Uploading through Processing to Ready. Then they click Place. No refresh and no leaving the world.

## Goals

- Upload from the computer: one click in the HUD opens the upload page in the browser.
- Upload from the phone: a QR code in the HUD, plus a short typed fallback (the URL and its 6-character code).
- Uploaded files land in this scene's library and appear in the HUD Media Library live, newest first.
- A per-item status badge in the HUD that updates without the editor doing anything.
- Images and GLB models. These are the cases the user named.

## Non-goals

- Auto-placing uploads in the scene. Uploads wait in the library.
- Video upload from the in-world flow. The HUD library doesn't place video today. (My call; see "Calls I made".)
- Deploying or syncing GLBs from inside the world (see "Models and sync").
- Thumbnails in the HUD list. Nice later, but not needed for this.
- Changing the dashboard's Media page beyond what's needed below.
- Moving off base64 JSON uploads to presigned or direct-to-storage uploads.

## Anti-goals (failure even if it "works")

- **The QR code or link gives away more than upload rights.** Whoever scans it must not get a signed-in session. That's why this uses the existing upload codes, not the Stats sign-in hand-off.
- **The QR code is visible to other players.** It is drawn only in the editor's own screen-space HUD, never on a 3D surface.
- **A GLB looks "done" but never appears in the world**, with nothing telling the editor why.
- **An upload sits on "Uploading" forever** after the phone gave up.

## What exists today (from recon)

- **Upload codes and a phone page already exist.** `apps/server/src/routes/companion-upload.ts`:
  - `POST /api/upload-tokens` needs `scene.edit` when given a `sceneId`. It mints a 6-character code: 30 min TTL by default (1–60), 10 uploads by default (1–50).
  - `GET` and `POST /api/upload/:code` work with the code alone.
  - The page is `apps/web/src/app/u/[code]/client.tsx`. It's mobile-friendly, uploads base64 JSON one file at a time, and accepts images, GLB and video.
  - `packages/vlm-client` already has `createUploadToken`. `packages/vlm-hud`'s `AssetBrowserPanel.requestUploadToken` wraps it. The DCL adapter never calls either.
- **Bug: wrong owner account.** Companion uploads store the file in the token user's account. `POST /api/scenes/:sceneId/library/upload` goes through `uploadDestination` instead, which stores an editor's upload in the **scene owner's** account and quota (and a renter's in their own, tied to the booking).
- **Bug: wrong link base.** `uploadUrl` is built from `PUBLIC_URL`, the API origin. The page belongs to the web app, so the link should use `config.webAppUrl`.
- **No status anywhere.** `media_assets` has no status column, and an asset row only exists after the whole upload has arrived. There is no processing step for `media_assets` (sharp thumbnails exist only for `/api/assets`).
- **No live library updates.** The HUD fetches `GET /api/scenes/:sceneId/library` only when the Assets tab opens. The realtime bus (`apps/server/src/realtime/bus.ts`) has no library topic.
- **The HUD Media Library** (`AssetBrowserPanel` in `packages/vlm-adapter-dcl/src/DclHUDRenderer.tsx`, around lines 776-833) has text rows (kind label, name, Place) and shows at most 10. `HUDMediaItem` is `{id, name, kind}`.
- **Models only render once they're deployed with the scene.**
  - DCL can't load a GLB from a remote URL. The creator runs `npx vlm-dcl sync` on their computer and redeploys.
  - Core already tracks this: `vlm.missingModels()` and `onModelsMissing`. The HUD already has a `SyncNotice` ("N model(s) need sync + redeploy").
  - Placing a model today shows "run npx vlm-dcl sync and redeploy to see it".
- `DclAdapter.openUrl` wraps `openExternalUrl`. DCL shows its own "open this link?" prompt.
- SDK7 UI can draw a remote image (`uiBackground.texture.src`). The adapter doesn't do it anywhere yet. Media images already load remotely as 3D textures from the same hosts.
- No QR library is used anywhere in the repo's own code.

## Design

### The upload link

- The HUD Media Library gets an **Upload** button in the panel header, visible to editors only, like the rest of the panel.
- Pressing it calls `createUploadToken(sceneId)` and opens an **Upload sub-view** inside the panel. The sub-view shows:
  - **"Open on this computer"**: calls `adapter.openUrl(uploadUrl)`.
  - **A QR code** of the same `uploadUrl`, labelled "Scan to upload from your phone".
  - The URL and the 6-character code in text, for typing it in by hand.
  - When the link expires, and how many uploads are left.
  - **"New link"**: mints a fresh code.
  - **"Back"**: returns to the list.
- One link serves both devices.
- The token is minted in the HUD and lives in the HUD's memory. Closing the panel forgets it, and the next Upload press mints a new one. Codes are cheap and already expire on their own.
- In-world codes are scoped to images and GLB. The token gets a `kinds` restriction (see the data model), and the page's file picker and the server both enforce it.

### The QR code

- **Server-rendered PNG** at `GET /api/upload/:code/qr.png`. It encodes only that code's `uploadUrl`, never arbitrary text, and returns 404 for an unknown or expired code.
- It is generated with the `qrcode` npm package, using a quiet zone and high contrast, and sent with a `Cache-Control` header that ends at the code's expiry.
- The HUD draws it as `uiBackground={{ texture: { src, filterMode: 'point' }, textureMode: 'stretch' }}` in a square at least 160 px.
- If the texture fails or loads slowly, the typed URL and code are already on screen.

### Where uploads land

- `POST /api/upload/:code` stores the file in the account `uploadDestination(tokenUser, token.sceneId)` returns, the same rule as `/library/upload`:
  - An editor's upload goes into the scene owner's account and counts against the owner's quota.
  - A renter's goes into their own account.
- If `uploadDestination` returns null because the user lost access since minting, the upload is refused with 403.
- Every upload through an in-world code is linked to the code's scene (`linkToScene`), as it is today.

### Status

Statuses as the HUD shows them:

| Status | Meaning | Who moves it on |
|---|---|---|
| **Uploading** | The page told the server a file is coming; bytes not yet received | The page |
| **Processing** | Bytes received; the server is validating and storing them | The server |
| **Ready** | An image that can be placed | — |
| **Needs sync** | A GLB stored and placeable, but it won't render until the creator runs `npx vlm-dcl sync` and redeploys | — |
| **Failed** | Too big, wrong type, over quota, or abandoned. The reason is shown | — |

The user said "Syncing". "Needs sync" is my wording, since nothing is syncing on its own; see the questions below.

**Data model**
- Add `status` to `media_assets`: `'uploading' | 'processing' | 'ready' | 'failed'`, defaulting to `'ready'` so existing rows and dashboard uploads are unaffected.
- Add `error` (text, nullable).
- `storage_key` and `public_url` become nullable until the file is stored.
- "Needs sync" is not stored. The HUD works it out for GLBs that are `ready` in the library but aren't deployed with this scene. It uses the same `adapter.resolveModelSrc` check that drives `missingModels()`, so the badge clears once a redeploy includes the file.
- The token gets `kinds text[]`, nullable, meaning anything. In-world codes use `['image','model']`.

**Upload flow on the page**
1. `POST /api/upload/:code/start` with `{filename, contentType, sizeBytes}`.
   - The server checks the code, the type and size (`classifyUpload`) and the quota up front.
   - It inserts a `media_assets` row with `status: 'uploading'` in the destination account, links it to the scene, and spends one upload from the code.
   - It returns `{assetId}`.
   - If a check fails, it returns the error; no row and no upload spent.
2. `POST /api/upload/:code/:assetId` with the base64 body.
   - The row is set to `processing` on arrival.
   - The server re-runs `classifyUpload` on the real bytes, stores them, and fills in `storage_key`, `public_url` and `size_bytes`.
   - The row is set to `ready`, or `failed` with an `error`.
3. The current single-call `POST /api/upload/:code` is replaced by these two calls. No users yet, so no compatibility shim.

**Abandoned uploads**
- A row still `uploading` 15 minutes after `start` is marked `failed` with "Upload didn't finish".
- This is a check on read plus the existing daily cleanup job; no new timer process.
- Failed rows stay in the HUD list with their reason. They have a **Dismiss** button, which deletes the row and its library link.

The page shows its own per-file progress bar (XHR upload progress). The HUD shows status, not a percentage (my call).

### Live updates

- New realtime bus topic `library_changed {sceneId, item}`. It's published from the library and upload code whenever a scene-library item is linked, unlinked, or changes status.
- `VLMSceneRoom` relays it as `scene_library_changed` to that scene's clients **who can edit**. Viewers don't need it and shouldn't see owners' file names.
- `vlm-core` exposes `onLibraryChanged(listener)`. The DCL adapter upserts or removes the item in its cached media list and pushes it to the renderer, whether or not the panel is open. A reconnect, or the panel opening, still refetches the full list.
- The list sorts newest first, as the server already does.
- The 10-row cap stays. New uploads are at the top, so they're always visible.

### HUD changes

- `HUDMediaItem` gains:
  - `status`: `'uploading' | 'processing' | 'ready' | 'needs_sync' | 'failed'`
  - `error?: string`
- Each row gets a coloured status badge beside the kind label. Place is shown only for Ready and Needs sync; Failed shows Dismiss instead.
- Placing a Needs sync model works as it does today, with today's message.
- `mediaKind()`'s filter (images and GLB) is unchanged. Items with a non-ready status pass through it on content type.
- The empty-state text "Upload them on the dashboard's Media page" becomes an Upload button.

### Dashboard uploads

Out of scope, but noted: uploads from the dashboard Media page still don't join any scene library, so they won't appear in-world. That gap was already there and isn't made worse by this.

## Constraints

- **Who can upload:** only scene editors can mint in-world codes (`scene.edit`, as today). The HUD Upload button shows only where the panel's existing `canEdit()` passes.
- **No full session on another device:** no hand-off code goes into the QR.
- **Limits unchanged:** `classifyUpload` (images ≤ 10 MB, GLB ≤ 50 MB). Quota goes through `assertStorageQuota` on the destination account.
- **Base64 JSON body limit:** `MAX_UPLOAD_MB`, 100 by default, is unchanged.
- **Typings:** the DCL adapter's workspace typings stay on SDK 7.22, so use only UI props those typings have. `uiBackground.texture` is in 7.22.
- **Billing routes untouched.**
- **Breaking API changes are fine** (no users).

## Left to the builder

- Exact HUD layout of the Upload sub-view and the badge colours (follow the existing `C.*` palette: warning for Needs sync, danger for Failed, muted for in-progress).
- Where `library_changed` gets published. One helper is called by `linkToScene`, unlink, and the status updates.
- Migration mechanics (drizzle), and test placement following the existing server test helpers.
- How the page handles iPhone HEIC photos. iOS usually converts them to JPEG for a picker limited to `image/jpeg,image/png,…`. Check on a real phone; if HEIC still arrives, the server's 415 message should say "HEIC isn't supported, choose JPEG/PNG".

## Calls I made (for the user to check)

1. **Upload codes, not the sign-in hand-off.** The QR can only upload, never sign anyone in.
2. **One link for both devices.** It's shown in the editor's screen-space HUD only.
3. **The QR code is a server PNG** used as a UI texture, rather than built from hundreds of UI boxes.
4. **Uploads go into the scene owner's library** (and quota) when an editor uploads, matching the existing in-world upload route.
5. **In-world uploads are images and GLB only.** Video stays on the dashboard.
6. **"Needs sync"** is the label for GLBs waiting on `vlm-dcl sync` and a redeploy.
7. **No upload percentage in-world.** The page has it.
8. **Abandoned uploads fail after 15 minutes.** Failed rows can be dismissed.
9. **Renters can't upload from in-world** (editors only, as the HUD panel is today).

## Open questions for the user

1. **What should happen to a GLB after upload?** DCL can't load a model from a URL, so a GLB only shows up in-world after `npx vlm-dcl sync` on the computer plus a redeploy. Also, `vlm-dcl sync` today only downloads models that are already *placed* in the active preset (`GET /api/setup/models`), not ones merely sitting in the library. Options: (a) honest badge only — "Place, then sync + redeploy"; (b) also make `vlm-dcl sync` pull every GLB in the scene's library, so the editor can sync before placing (CLI change, republish vlm-dcl); (c) something else they had in mind by "Syncing".
