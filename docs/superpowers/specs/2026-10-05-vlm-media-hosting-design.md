# VLM Media Hosting (images live, GLBs via sync) — Design

**Date:** 2026-10-05 · **Status:** approved in conversation 2026-10-05 ("all looks good to me")

## 1. Goal

A scene host uploads images and GLB models to VLM and puts them in their scene. Images appear live for everyone. GLBs need one `npx vlm-dcl sync` + redeploy after they're added; after that they're placed, moved, scaled and shown/hidden live.

## 2. Findings that shape the design

- **Decentraland will not load a GLB from a URL.** Spike on 2026-10-05: a bundled GLB and a `cdn.vlm.gg` image rendered; the same GLB from `https://cdn.vlm.gg/...` did not, after a client restart. GLBs must be files in the deployed scene.
- Remote image textures (`Material.Texture.Common({ src: 'https://…' })`) render.
- Existing bugs that break images today:
  1. `VLMSceneRoom.persistPresetUpdate` overwrites an element's `properties` with whatever the relayed message carried. The dashboard relays `{ id, properties: {…} }` after its REST save, so the column becomes `{ properties: {…} }`; a toggle relays `{ id, enabled }` and wipes properties to `{}`.
  2. Dashboard relays (`add_element`, `update_instance`, `add_instance`, `delete_instance`, `delete_element`, and `update` with nested `properties`/`id`) don't match what `SceneManager.handlePresetUpdate` understands, so changes appear only after a rejoin.
  3. The HUD Asset Browser's "place" action is not wired (`setHUDActionHandler` never called).
  4. The scene editor's model element has a URL field only (no upload/picker).
  5. Uploads accept any file type; the browser builds base64 with a string `reduce` (slow on big files).

## 3. Decisions

- **One library:** images and GLBs live in the Media library (`media_assets`, `POST /api/media/upload`), stored in R2 and served from `cdn.vlm.gg`. The public "asset library" (`/api/assets`) is unchanged and not used by this flow.
- **Allowed uploads:** `image/png`, `image/jpeg`, `image/webp`, `image/gif` up to 10 MB; GLB (`model/gltf-binary`, also accepted as `application/octet-stream` with a `.glb` name, stored as `model/gltf-binary`) up to 50 MB. Anything else → `415 unsupported_type`; too big → `413 too_large`. Plan storage quotas still apply.
- **Server is the single source of live updates.** After any REST write to an element or instance (create, update, delete), the server loads the element (with instances), and if it belongs to the scene's active preset, broadcasts to the scene room:
  - `{ action: 'upsert', element: <type>, elementData: <serialized element with instances> }`, or
  - `{ action: 'delete', element: <type>, id: <elementId> }`.
  REST handlers reach rooms on any server through the existing presence bus (`realtime/bus.ts`), with a new event `{ type: 'element_changed', sceneId, elementId, presetId, elementType, deleted }`.
- **Clients replace, not patch:** `SceneManager` handles `upsert` by deleting the element (if present) and creating it from `elementData` (full replace). Existing actions stay for older clients.
- **The dashboard stops relaying raw messages** over Colyseus for element/instance edits (the server broadcasts after REST). The room's client-sent `scene_preset_update` path stays (HUD and other platforms) but `persistPresetUpdate` merges properties instead of replacing them, and never writes `properties` when the message carries none.
- **Model files:** a model element's `modelSrc` is its media URL (`https://cdn.vlm.gg/<owner>/<uuid>.glb`). In Decentraland the adapter loads `models/vlm/<uuid>.glb` (the URL's last path segment, under `models/vlm/`). At startup the adapter reads the scene's deployed file list (`getSceneInformation().content`); a model whose file isn't deployed is not rendered and is reported to the HUD.
- **`npx vlm-dcl sync`** (a `bin` in the `vlm-dcl` package, plain Node ≥ 18, no dependencies):
  1. reads `scene.json` in the current folder → location key: `world:<worldConfiguration.name>` if present, else `gc:<scene.base>`;
  2. `GET <server>/api/setup/models?location=<key>` (public) → `{ sceneId, models: [{ elementId, name, url, file, sizeBytes }] }` for the location's active setup's active preset (model elements with an http(s) `modelSrc`);
  3. downloads each to `file` (`models/vlm/<uuid>.glb`) if missing or a different size; removes files in `models/vlm/` that it created earlier (tracked in `models/vlm/.vlm-sync.json`) and that are no longer listed; never touches other files;
  4. prints what changed and the total size of the scene folder (excluding `node_modules`, `bin`, `.git`) against the limit — Genesis City: 15 MB × parcel count; Worlds: 100 MB — and warns when over;
  5. flags: `--server <url>` (default `https://api.vlm.gg`), `--location <key>` (override), `--dry-run`.
  No auth: the model list for a set-up location is public (the files are already public on the CDN).
- **HUD:**
  - **Assets panel** lists the host's Media library images and GLBs (`GET /api/media`). **Place** creates the element + one instance about 2 m in front of the player (facing them), via REST, in the scene's active preset. Images get scale 2×2; models scale 1.
  - **Layout panel**: show/hide and delete per element, via REST.
  - A notice "N model(s) need sync + redeploy — run `npx vlm-dcl sync`" when models aren't deployed.
  - Only host, co-host and editor see Assets/Layout editing (viewers don't).
- **Dashboard:** model element editor gets **Upload** and a **Media picker** filtered to GLBs, and shows "Needs `npx vlm-dcl sync` + redeploy before it appears in-world". Media page accepts and lists GLBs. Uploads read files with `FileReader.readAsDataURL` (no string concatenation).

## 4. Out of scope

One-click Publish (VLM deploys the scene) — next. In-world move/rotate gizmo. Video uploads. Model thumbnails. Multipart/direct-to-R2 uploads (base64 JSON stays; the 100 MB body limit covers 50 MB GLBs).

## 5. Testing

- Server (vitest, real Postgres): upload allowlist and size caps; `persistPresetUpdate` merge (relayed toggle keeps properties); REST element/instance writes publish `element_changed` and a joined room client receives `upsert`/`delete` with the serialized element (use `test/helpers/game-server.ts`); non-active-preset edits are not broadcast; `GET /api/setup/models` (active setup only, model elements only, file names, unknown location → 404, ended setup → 404).
- Core (vitest): `SceneManager` `upsert` replaces an element; `localModelPath(url)` mapping.
- CLI (`node --test`): location from `scene.json` (GC and World), download/skip/remove-stale with a stub server, size warning.
- In-world (manual): upload an image and a GLB on the dashboard → place both from the HUD → image appears immediately; HUD says the GLB needs sync → `npx vlm-dcl sync` in the test scene → preview reload → duck appears → move it from the dashboard → moves live.
