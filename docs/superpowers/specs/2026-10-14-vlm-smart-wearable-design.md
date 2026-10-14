# VLM Smart Wearable (remote scene control) — Design

**Date:** 2026-10-14 · **Status:** approved in conversation 2026-10-14, section by section

## 1. Goal

A seamless hand-off between the in-scene VLM HUD and a VLM smart wearable. Inside one of your scenes, the scene's HUD controls it as today. Step outside, and the wearable picks up the same HUD for that scene and lets you control any of your scenes from anywhere in Decentraland. The wearable always shows a **My Scenes** panel with live visitors and stats for each scene.

For hosts, co-hosts and editors (role-limited); viewers get stats only.

## 2. Findings that shape the design

- Smart wearables are SDK7-only portable experiences that run while worn, anywhere; other players don't see their effects. Created with the CLI (`npx @dcl/sdk-commands init --project smart-wearable`), packed with `npm run pack`, uploaded in the Builder's Collections tab, tested on Sepolia with "See in world". Both body shapes required.
- **3 MB limit**, uncompressed, for everything (code, models, images). The current dev build of a scene with VLM is 9.8 MB unminified; the minified size is unknown.
- `fetch`/`signedFetch` need `USE_FETCH`, WebSockets need `USE_WEBSOCKET` in `scene.json` `requiredPermissions` (these only apply to portable experiences and smart wearables).
- The message bus is sandboxed per scene/portable experience: the wearable can't talk to the scene directly. Coordination goes through the VLM server.
- Any scene can set `portableExperiences` to `disabled` or `hideUi`; the wearable shows nothing there.
- Positions in a portable experience are global (relative to Genesis Plaza 0,0).
- Docs don't confirm that React-ECS UI and `signedFetch` behave in a wearable as in a scene → spike (§6).
- Existing code: `packages/vlm-hud` (platform-neutral HUD logic and panels), `packages/vlm-adapter-dcl` (`DclHUDRenderer.tsx`, the Decentraland renderer), `VLMSceneRoom` (host clients, `clientMeta`), the signed-fetch verification used by `/api/scenes/setup-here` and ingest.

## 3. What you see

| Where you are | Scene HUD | Wearable |
|---|---|---|
| In one of your VLM scenes, scene HUD connected for you | Full editing, as today | **My Scenes** panel only |
| Outside your scenes, in a World, or in one of your scenes whose HUD is off or an old `vlm-dcl` | — | **My Scenes** panel + full HUD for the picked scene |

- **My Scenes panel:** one row per scene where your wallet has a role: visitors now, today's visitors and peak, stream live or not, active preset. Clicking a row (when the wearable HUD is allowed) opens that scene's HUD. **Go** teleports there (Decentraland asks you to confirm). Refreshes about every 10 s.
- **Wearable HUD:** the same panels as the scene HUD (shared code), joined to that one scene's room as host. Placing and moving are by numbers: position, rotation, scale fields with nudge buttons; no "place in front of me".
- **Hand-off:** walking out of a scene opens the wearable HUD on that scene and on the panel you had open (the server remembers your last panel per wallet). Walking back in closes it once the scene HUD is connected for you.
- Roles: host and co-host get everything their role allows in the scene HUD; editors get content editing; viewers get the stats row only.

## 4. Server

New `apps/server/src/routes/remote.ts`:

- **`POST /api/remote/session`** — Decentraland signed fetch → wallet → short-lived token (same token kind HUD clients use). Uses the existing signed-fetch verification but does **not** resolve or require a location. Rejects invalid or expired signatures (`401`). Rate-limited per IP.
- **`GET /api/remote/overview`** (token) → `{ scenes: [{ sceneId, name, role, parcels: string[] | null, world: string | null, visitorsNow, todayVisitors, todayPeak, streamLive, activePreset: { id, name } | null, hudActive, lastPanel }] }`.
  - Scenes: where the wallet's user is host (`scenes.ownerId`) or has an active `scene_roles` row.
  - `parcels`/`world` from the scene's active `location_setups` → analytics location.
  - `visitorsNow`: the room's `visitors` metadata (0 when no room is open).
  - `todayVisitors`/`todayPeak`: existing analytics tables (UTC day), respecting the host's tenure rules from the in-world setup spec.
  - `streamLive`: any stream on the scene currently live.
  - `hudActive`: the wallet is in the room's `hudWallets` metadata.
  - Viewers: same row; the wearable treats them as stats-only.
- **`PUT /api/remote/last-panel`** (token) `{ sceneId, panel }` — remembers the last open panel per user per scene in a new table `remote_panel_prefs` (`user_id`, `scene_id`, `panel`, `updated_at`; primary key `user_id, scene_id`).
- **Room change (`VLMSceneRoom`):** `JoinOptions.source?: 'scene' | 'wearable'` (default `'scene'`). Stored in `clientMeta`. On every join and leave the room calls `setMetadata({ sceneId, visitors, hudWallets })`: `visitors` = clients whose source isn't `'wearable'`; `hudWallets` = lowercased wallets of `source: 'scene'` host clients. The overview reads both through `matchMaker.query`.
- **Security fix bundled in:** `GET /api/command-center/:eventId/status` requires event ownership (or admin), matching the broadcast route.

## 5. Client

- **Shared HUD:** `DclHUDRenderer` and its panels become importable without the rest of the scene adapter, so the wearable bundles only the HUD. They gain a `mode: 'scene' | 'remote'`; remote mode replaces player-relative placement with numeric fields and nudges. Scene mode is unchanged.
- **Wearable** `apps/vlm-wearable` (SDK7 CLI smart-wearable project, both body shapes):
  - `scene.json` `requiredPermissions: ["USE_FETCH", "USE_WEBSOCKET"]`.
  - On start: `POST /api/remote/session`, then the overview poll.
  - Once a second: player parcel vs. your scenes' parcels → the §3 table.
  - Hand-off rule: keep the wearable HUD open until `hudActive` is true for the scene you're standing in (never a gap with no HUD).
  - **Go**: SDK7 teleport to the scene's base parcel (Worlds: change realm), player confirms.
  - Production minified build; a check fails the build if the packed zip's contents exceed 3 MB.
  - If the full HUD doesn't fit, fallback: the wearable bundles the Colyseus client and message types plus the HUD panels, without the `vlm-core` content renderer (the wearable never renders scene content).

## 6. Spike (gate before everything else)

A bare smart wearable with: a React-ECS UI panel, a `signedFetch` to the local server, a Colyseus room join, and a measured minified size. Tested in preview and on Sepolia via "See in world". If UI, signed fetch, WebSocket or size fails, stop and revisit this design before server work.

## 7. Error handling

- Scene blocks portable experiences: nothing to show there; the panel returns on leaving.
- Expired token or dropped connection: new token and rejoin silently. Server unreachable: "VLM unreachable — retrying", last stats kept and marked stale.
- Role removed mid-edit: the room's access re-check drops the wearable to stats only, no error.
- Hand-off lag: the wearable HUD stays until `hudActive` is true.
- No scenes: "No VLM scenes yet — set one up from its in-world HUD", with a link to vlm.gg.
- Teleport declined: nothing happens.

## 8. Testing

- **Server (vitest, real Postgres):** session accepts valid signed fetch, rejects invalid/expired, ignores location; overview lists only scenes with a role, viewer rows stats-only; `visitorsNow` excludes wearable clients; `hudActive` flips on scene-HUD join and leave; wearable room access per role equals the scene HUD's; last-panel round trip; command-center status ownership.
- **Wearable logic (vitest):** parcel matching (Genesis City; Worlds never match); the §3 show/hide table; hand-off waits for `hudActive`.
- **Shared HUD:** remote-mode numeric edits produce the same messages as scene-mode edits.
- **Size:** packed-size check under 3 MB.
- **In-world (manual):** spike on Sepolia; then stand in the test scene, walk out (HUD hands off on the same panel), move the duck by numbers from outside, walk back in (wearable HUD closes after the scene HUD connects), teleport from another parcel.

## 9. Out of scope

Announcements and moderation (v2: REST for `scene_moderator_message`, a decision on kicking), in-world drag gizmos, showing scene content from afar, publishing the collection (the user's Builder + Curation Committee step after testing).
