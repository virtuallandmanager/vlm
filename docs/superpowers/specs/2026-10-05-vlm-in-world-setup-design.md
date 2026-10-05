# VLM In-World Setup and Scene Roles — Design

**Date:** 2026-10-05 · **Status:** draft for review · **Replaces:** the analytics "claim" flow (analytics spec §5, Sub-project C), which never shipped a UI.

## 1. Goal

A creator installs `vlm-dcl` (code or Creator Hub script), deploys, walks into their scene and presses **Set up VLM here** in the HUD. That one press creates their VLM account (if needed), creates the VLM scene, attaches the location's analytics, and makes them the scene's **host**. No email, no dashboard visit, no claim step. The host then hands out roles to other wallet addresses.

## 2. Decisions (from the 2026-10-05 conversation)

- **Who may press Setup:** a wallet that, for every parcel of the scene, is the owner, operator, update operator, an update manager or approved-for-all — or that deployed the scene currently live there. For a World: the World's owner, or a wallet on the World's deployment permission list. (Visitors never see the button.)
- **First press wins:** whoever presses Setup becomes host. Land control grants nothing beyond the right to press Setup on a location that isn't set up.
- **Host is final:** nobody can take the host role away — not co-hosts, not the land owner. The host can hand it to another wallet voluntarily.
- **The owner's escape hatch is a redeploy:** if the land owner wants a different host, they deploy their own scene. A new deployment by someone who is not the host or a co-host ends the current setup (§5), and the location can be set up again.
- **No account required:** in-world identity is the wallet (Decentraland signed fetch). Signing in on vlm.gg with the same wallet later shows the same scene.

## 3. Roles

Assigned per scene, to a **wallet address** (works before that person has ever used VLM; it attaches to their account the first time they sign in with that wallet).

| Role | Can do |
|---|---|
| **Host** (exactly one) | Everything: content, presets, streams, analytics, roles, scene settings, delete analytics data, transfer host |
| **Co-host** | Everything the host can, except: remove or change the host, transfer host, delete analytics data, delete the scene |
| **Editor** | Content and presets (the existing editor scope set), view analytics; no role management |
| **Viewer** | View analytics; no changes |

- Co-hosts can add/remove editors, viewers and other co-hosts.
- Venue booking roles (`vj`, `lighting`, `door`, … from the venues spec) are unchanged and stay time-boxed per booking.
- Host = `scenes.ownerId`. Transfer sets the new owner and makes the previous host a co-host.

## 4. Data model

New table `scene_roles`:

| Column | Notes |
|---|---|
| `id` uuid pk | |
| `scene_id` → scenes, cascade | |
| `wallet_address` text, lowercased, not null | the assignee |
| `user_id` → users, nullable | filled when the wallet signs in (like `linkWalletGrants`) |
| `role` enum `scene_role` (`cohost`, `editor`, `viewer`) | host is not a row |
| `granted_by_user_id`, `created_at`, `revoked_at` | revoke = soft delete |
| unique (`scene_id`, `wallet_address`) where not revoked | |

New table `location_setups` (one active row per location; history kept):

| Column | Notes |
|---|---|
| `id` uuid pk | |
| `analytics_scene_id` → analytics_scenes | the location |
| `vlm_scene_id` → scenes | created by Setup |
| `host_user_id` → users | at setup time (informational; live host is `scenes.ownerId`) |
| `deployment_entity_id` text | catalyst/worlds entity id live when Setup was pressed |
| `started_at`, `ended_at` (null = active), `end_reason` (`redeployed`, `deleted`) | |

The claim routes, `claimScene` and the claim re-verify job are removed. The `analytics_scenes.claim*` columns stay in the schema but nothing reads or writes them (no production data uses them; dropping columns isn't worth the migration risk). `POST /api/analytics/claims/check-signed` stays for `vlm-dcl` 2.0.0 clients.

`getSceneAccess` gains one step after the collaborator check: an active `scene_roles` row matching the actor's user id or verified wallet → `cohost` = full access minus `scene.host` actions; `editor` = existing editor scopes + `analytics.view`; `viewer` = `analytics.view`. New scopes: `analytics.view`, `analytics.delete`, `roles.manage`, `scene.host` (host-only: transfer, delete scene/data).

## 5. Setup and release

**`POST /api/scenes/setup-here`** (Decentraland signed fetch, like `check-signed`; also accepts a verified wallet session):
1. Verify the signed fetch → wallet. Resolve the location from the signed metadata/realm (same resolution as ingest). Reject preview realms except for the dev server.
2. Check eligibility (§2) with the existing `controls()` plus the World deployment-permission lookup.
3. If the location has an active setup: if the current live deployment (entity id) differs from `deployment_entity_id` **and** its deployer is not the host or an active co-host → end that setup (`ended_at = now`, `end_reason = 'redeployed'`) and continue; otherwise → `409 already_set_up` with the host's short wallet for the HUD to show.
4. Resolve or create the wallet's user (`resolveVerifiedWalletUser`), create the VLM scene (owner = that user, name from scene.json title), insert the `location_setups` row, set `analytics_scenes.vlm_scene_id`.
5. Return `{ sceneId }`; the SDK connects to it exactly as if `sceneId` had been configured.

Redeploys by the host or a co-host keep the setup (they are updating their own scene). The redeploy check also runs lazily whenever the HUD asks for its state, so a released location shows **Set up VLM here** again to the next eligible person.

**Analytics visibility across tenures:** a host sees analytics recorded from their `started_at` to `ended_at`. Data from an earlier tenure stays with that tenure's scene (visible to its host and roles, under the same rules) and is never shown to the next host.

## 6. In-world HUD

- **Not set up, eligible wallet:** a single card — "Set up VLM here" + one line explaining what it does. One press → spinner → connected HUD.
- **Not set up, not eligible / visitor:** no VLM UI at all (as today).
- **Set up, has a role:** the normal HUD (toolbar), plus a **Roles** panel for host/co-hosts:
  - list of wallets with roles (short address, role, remove);
  - **Add**: pick from people currently in the scene (display name + short address, from the players list) or paste an address; choose Co-host / Editor / Viewer;
  - host only: **Transfer host** to a listed co-host (confirm step).
- **Set up, no role:** no VLM UI.

## 7. Dashboard (vlm.gg)

- Scene settings gets the same **Roles** list (add by address, change role, remove; transfer for the host).
- Scenes list shows scenes where the user is host or has a role.
- No claim UI. The Analytics page itself is Sub-project D (separate spec).

## 8. Error handling

- Decentraland directory unavailable during Setup → `503`, HUD shows "Decentraland's servers aren't answering — try again in a minute" and retries on the next press (no partial setup).
- Two eligible people press at once → the unique active-setup constraint makes one win; the other gets `409 already_set_up`.
- Scene limit reached for a Cloud-mode free tier → setup still succeeds (setup is free; limits apply to paid features), so the press never fails for billing reasons.
- Wallet not verifiable (guest, unsigned client) → button hidden; endpoint `401`.

## 9. Testing

Server (vitest, real Postgres, `FakeDclDirectory`):
- eligibility: owner / operator / update manager / approved-for-all / deployer-of-live-scene / World owner / World deployer allowed; visitor and partial-parcel controller rejected;
- first press wins; concurrent presses → one setup;
- redeploy by host or co-host keeps the setup; redeploy by anyone else releases it and a new eligible press succeeds;
- role rules: co-host cannot remove/change the host, transfer, or delete data; co-host can manage editors/viewers/co-hosts; wallet-addressed role attaches on first wallet sign-in;
- analytics tenure: a new host never sees the previous tenure's sessions;
- `getSceneAccess` matrix for host / co-host / editor / viewer / none.

In-world: the `dcl-smart-item-test` scene against the local server (preview realm allowed in dev), then one real deployment against production.

## 10. Out of scope

Analytics charts/reports (Sub-project D), billing changes, venue booking roles, merging two existing VLM accounts.
