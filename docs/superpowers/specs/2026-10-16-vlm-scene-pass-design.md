# VLM Scene Pass (scene-bound in-world sessions) — Design

**Date:** 2026-10-16 · **Status:** approved in conversation 2026-10-16, section by section

## 1. Goal

A Decentraland scene can only ever act as a visiting player inside itself. A stranger's scene gets nothing useful; the player's own scenes keep working as now (HUD, roles, media, Stats).

## 2. Findings

- `POST /api/auth/platform` (`apps/server/src/routes/auth.ts`) verifies a Decentraland signed fetch and returns a 15 min access token and a 7 day refresh token carrying the player's **full** account (`id`, `role`, `orgId`, `wallet`, `verified`). Any scene can call it through `signedFetch`, with or without VLM installed.
- `POST /api/auth/handoff` (D1) turns any verified wallet token into a single-use code that the scene code receives and can exchange for a full website session.
- `VLMSceneRoom.onAuth` accepts any valid access token for any scene's room.
- Signed scene requests carry explorer-set metadata that scene code can't forge (ADR-289): `sceneId` (entity hash), `parcel` (base `x,y`), `realm { hostname, protocol, serverName }`, `signer: "decentraland-kernel-scene"`, `isGuest`, `hashPayload` (SHA-256 of the body).
- We verify with the old `decentraland-crypto-middleware`, which lowercases the whole signed payload, so metadata key casing is outside the signature (Decentraland RCA 2026-08-11 and 2026-08-25, critical). Fixed in `@dcl/crypto-middleware` ≥ 6.3.0 (verbatim metadata, `requireSigner`, declared keys refused when folded; 6.2.0+ still accepts old explorers' payloads).
- Location setups (`location_setups`, one active per analytics location) already require proof of control of the land or World (`analytics/claims.ts` `controls`). Scenes that only declare a `sceneId` in code have no such proof.
- Media: `media_assets.owner_id` (no scene link), quota enforced in `routes/media.ts` per owner's tier; models from phone uploads land in `asset_library_items` (`uploaded_by`).
- Production (2026-10-16): 2 scenes (1 with an active setup), 8 users, 0 scene roles, 0 bookings, 2 media files.

## 3. Decisions

### 3.1 In-world sign-in and binding

- **Verification:** `POST /api/auth/platform` verifies with `@dcl/crypto-middleware` ≥ 6.3.0 and requires: signer is the canonical `decentraland-kernel-scene`; `sceneId`, `parcel`, `realm.serverName` present with canonical key spelling; when the request has a body, `hashPayload` equals SHA-256 of the raw body. Any failure → **guest** token (as unverified requests get now). `isGuest: true` → guest.
- **Location:** Genesis City (realm not a World) → the analytics location whose parcels contain the signed `parcel`. World (`realm.serverName` ends in `.eth`) → the location for that world name. Preview realms keep today's preview rules (`ALLOW_UNVERIFIED_PLATFORM_AUTH`, local servers only).
- **Official realms only:** `serverName`, `parcel` and the scene code are controlled by whoever runs the realm, so outside local preview a pass binds only when `realm.hostname` (lowercased, compared exactly — no ports, paths or suffix matching) is an official Decentraland realm of the right kind; anything else → visitor pass with no location. Genesis City: `realm-provider.decentraland.org`, `realm-provider-ea.decentraland.org`, `peer.decentraland.org`, the host of `DCL_CATALYST_URL`, and the DAO catalyst list (`{catalyst}/lambdas/contracts/servers`, cached 1 h; on failure the Decentraland-run catalysts `peer-ec1/ec2/ap1/eu1.decentraland.org`, retried after 1 min). Worlds: `worlds-content-server.decentraland.org` (and the host of `DCL_WORLDS_URL`), either bare or as `{host}/world/{serverName}` (what the explorer sends for a World); a path naming another World, or a Genesis City host with a `.eth` name (or the reverse), → visitor.
- **Deployment match:** when the setup recorded a deployment entity, the signed `sceneId` must equal it after the redeploy check (`releaseIfRedeployed`); when it recorded none, the redeploy check runs first (it records the live deployment when the team deployed it and releases the setup when an outsider did), then the same match applies (unknown deployer, nothing live or directory down → visitor). Otherwise → visitor pass at the location. Live-deployment lookups are cached 30 s per location. (Comms-less foreign realms report `realm-provider.decentraland.org`, so the entity is the only check on them.)
- **Scene:** the location's active `location_setups` row → `vlmSceneId`. The body's `sceneId` is a hint only: if it disagrees with the setup, the setup wins; with no setup, the pass has no scene and the HUD offers "Set up here" (existing flow).
- **Scene pass token:** access token claims `{ id, wallet, verified: true, kind: 'scene', sceneId: string | null, locationId: string | null, role, orgId: null }`, 15 min. No refresh token (`refreshToken: null`; no client used one): a pass taken by a hostile realm stops working 15 min after the player leaves. The HUD re-signs (signed request only; a failure or guest answer keeps the current pass) every 10 min and on a 401, and sends the new pass to the room (`auth_renew`). A hand-off code minted from a pass stores the pass's expiry, and the exchanged pass keeps it (an expired one → `410`). `POST /api/auth/refresh` refuses verified scene refresh tokens; unverified local-preview passes keep a 7 d refresh token. A pass with `sceneId: null` is a **visitor pass**: room join as visitor and analytics only.
- **Website tokens:** every token minted by website sign-in (email, Google, wallet) and refresh carries `kind: 'account'`. Tokens without `kind` are refused (`401`) on HTTP and in rooms — one forced sign-in for existing website sessions; the HUD re-signs automatically.
- **Rooms:** `VLMSceneRoom.onAuth` treats a scene pass whose `sceneId` isn't the room's scene, or a visitor pass, as an anonymous visitor (content only). A bound pass's connection acts as an anonymous visitor once the pass expires, until `auth_renew { sessionToken }` hands it a fresh pass for the same user and scene. `VLMCommandCenterRoom` treats every scene pass as anonymous. Existing per-role message guards stay.

### 3.2 What a scene pass can reach

- **Default deny:** routes declare `config: { scenePass: { sceneFrom } }`, where `sceneFrom(request)` returns the scene id the request acts on (path param, or a lookup from element / instance / preset / stream id to its scene). A global `preHandler` refuses a `kind: 'scene'` token with `403 { error: 'scene_pass_not_allowed' }` on any route without the declaration, or when `sceneFrom` ≠ the pass's `sceneId`.
- **Allowed** (role checks unchanged): the bound scene (read, settings), its presets / elements / instances, its roles and transfer-host (host-only as now), its analytics read routes, its scene library (§3.3), upload codes (`POST /api/upload-tokens` for that scene), `POST /api/auth/handoff`, `POST /api/auth/refresh`. `GET /api/scenes` with a pass returns only the bound scene.
- **Refused:** other scenes, account / API keys, billing, organisations, personal media library, deploys, admin, everything else.
- **Website hand-off:** `POST /api/auth/handoff` with a scene pass mints a code that exchanges for a **scene pass** (same `sceneId/locationId`), never a full session; with an account token it stays as D1. The code row stores `kind`, `scene_id`, `location_id`. On the website a scene pass may open only `next` paths belonging to its scene (`/analytics/?scene=<id>` or `?location=<locationId>` today); any other page, or a `403 scene_pass_not_allowed`, shows sign-in with `next`. A banner reads "Signed in from *Scene* — sign in for full access". Only a real sign-in replaces a scene pass with a full session.

### 3.3 Scene library

- **Table** `scene_library` (`id`, `scene_id` → scenes, `media_asset_id` → media_assets null, `asset_item_id` → asset_library_items null, exactly one of the two set, `added_by` → users, `booking_id` → bookings null, `created_at`; unique per scene + item).
- **Upload with a scene pass** (editor and above): stored in the **scene owner's** account (`owner_id` = `scenes.owner_id`), counted against the owner's quota with the existing check, linked to the scene with `added_by`. During an active booking where the uploader is the booking's host: stored in the **uploader's** account, linked with `booking_id`. Owner over quota → `413 { error: 'storage_limit_reached', message: "The scene owner's storage is full" }`.
- **List:** `GET /api/scenes/:sceneId/library` → items linked to the scene, excluding booking items whose booking isn't active, plus nothing from personal libraries.
- **Add from own library** (account token, item owner, editor+ on the scene): `POST /api/scenes/:sceneId/library { mediaAssetId | assetItemId }`.
- **Remove link:** `DELETE /api/scenes/:sceneId/library/:id` — host and co-host any item, editor own `added_by` items. Unlinking never deletes the file; deleting the file stays owner-only on the account library.
- **Backfill:** a one-time migration links every media asset and model referenced by a scene's elements/instances to that scene (`added_by` = owner).
- The HUD's media and model pickers read the scene library instead of `/api/media`.

## 4. Error handling

- Signed request missing fields, misspelled, unsigned by a scene, or failing the body hash → guest token (no distinguishing error).
- Setup lookup / directory down → visitor pass; HUD shows "VLM unreachable — retrying" and asks again.
- Scene pass on a refused route → `403 scene_pass_not_allowed`; website shows the sign-in banner.
- Old or kind-less tokens → `401`; website sign-in with `next`; HUD gets a new pass.
- Expired pass mid-edit → silent refresh; failed refresh → new signed request.

## 5. Testing

- **Server (vitest, real Postgres):**
  - Signature: valid scene request → pass bound to its location; respelled `Signer` / `SceneId` / `Parcel` refused; missing field refused; body/hash mismatch refused; wallet-signed (non-scene) refused; `isGuest` → guest.
  - Binding: GC parcel in a set-up location → that scene; World name → that scene; no setup → visitor pass; body `sceneId` that disagrees with the setup is ignored.
  - Default deny: a test walks **every registered route** and fails if a route without `scenePass` config accepts a scene pass; a pass for scene A refused on scene B for each allowed route; `GET /api/scenes` returns only the bound scene.
  - Rooms: pass for A can't join B; visitor pass joins as visitor; kind-less token refused.
  - Refresh keeps the pass bound; account refresh keeps `kind: 'account'`.
  - Hand-off: scene pass → code → scene pass, never account; `next` outside the scene → sign-in.
  - Library: editor upload lands in owner's account and quota; renter upload in renter's, hidden after the booking; pass can't list a personal library; unlink keeps the file; backfill links placed media.
- **Web (vitest):** scene-pass `next` allow-list; banner shown for scene passes.
- **Manual in-world:** own scene: HUD and Stats work; another parcel with no setup → visitor pass; a copy of the test scene on another parcel with a forged `sceneId` → no access to the real scene.

## 6. Out of scope

The smart wearable's own sessions (its spec designs them), analytics D2, any change to billing routes.
