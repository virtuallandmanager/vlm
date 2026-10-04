# VLM Venues: Rentable Music Venues on VLM v2

**Date:** 2026-10-04
**Status:** Design approved in conversation; awaiting written-spec review
**Vision source:** `~/-VLM/VirtualVenues/VLMVirtualVenues.pptx` (Virtual Venues deck, Jan 2024) and the concept art in that folder

## 1. Goal

Let people rent time-boxed, full control of a Decentraland music venue run on VLM v2. During their booking, a renter and the crew they choose control the venue from an in-world HUD (and a matching dashboard page): light shows, video screens and stream URLs, timed video playlists, presets, and moderation. When the booking ends, access ends and the venue reverts automatically.

This spec covers the whole system so the pieces fit, but only **Sub-projects 0 and 1** are specified to implementation depth. Each later sub-project gets its own spec → plan → build cycle, refining the outline here.

### Decisions already made

| Topic | Decision |
|---|---|
| Who owns venues | Phased: VLM-operated venue network first, third-party owner marketplace later |
| Payments | Card (Stripe one-time Checkout) **and** crypto (MANA/USDC on Polygon) |
| Venue model | Both permanent venues (own scene/World) and pop-up venues on host plots |
| Crew permissions | Role presets with per-person scope tweaks |
| Lighting depth | Designed looks (cues) + live faders per fixture group; looks schedulable |
| Architecture | A rentals module inside vlm-v2 (not a separate service) |
| Platform | Decentraland first, wallet auth; other adapters later |

### Venue concepts from the deck

.vagabond (nomadic hacktivist club), Caldera Lounge (volcano lounge, expandable stage), Neon Arbor (electric treehouse, two floors), Aurora Gardens (Red Rocks-style amphitheater with a reactive aurora), plus Crystal Echo and Syvilia (concept art only). Existing DCL scene projects: `VirtualVenues/{AuroraGardens,dotvagabond,unfound-outpost,CasaRoustan}`. These become the first venue network once ported to VLM v2 elements.

### Workflows (from the deck, kept)

- **Organizer:** create booking → pick venue + slot → add performers/crew → confirmation → setup link (stream URL with preview, images into poster/banner slots on a venue mockup) → reminder 1h before → venue goes live at start → swap stream/images and run lights live.
- **Performer:** booking notice → reminder 24h before → reminder 1h before with control link → live light/effect control during the set.

## 2. Current state of VLM v2 (relevant findings)

From review of `~/-VLM/vlm-v2` at `ba1fa15`:

- Hierarchy Scene → Preset → Element → Instance; element types `image, video, nft, sound, widget, custom, model` (`apps/server/src/db/schema.ts:19`).
- Roles: global `users.role` (`admin|creator|viewer`), per-org `org_members.role`, per-scene `scene_collaborators.role` (`owner|editor|viewer`). Collaborators are added by email only (`routes/scenes.ts:484`). No time-limited or scoped scene access exists.
- Every element/instance write route checks only `scene.ownerId === user.id || role === 'admin'` (`routes/scenes.ts:177-404`); `editor` grants nothing.
- DCL HUD renderer exists (`packages/vlm-adapter-dcl/src/DclHUDRenderer.tsx`) but `setHUDActionHandler` is never called, and the HUD is shown to every visitor (`packages/vlm-core/src/VLM.ts:277-304`).
- Video elements support `liveSrc`, `playlist[]`, `playlistIndex`; playlists have no timing. No lighting exists. Event `startTime`/`endTime` are stored but nothing acts on them.
- Cross-world broadcasts and stream live/offline webhooks reach only HTTP platform callbacks, not Colyseus scene rooms.
- Billing is Stripe subscriptions only (`integrations/stripe.ts`); no one-time payments or crypto.
- **Security defects that block rentals:**
  1. `VLMSceneRoom` never verifies `sessionToken` (no `onAuth`); any client can send `scene_preset_update`, which is persisted (`apps/server/src/ws/VLMSceneRoom.ts:54-65`).
  2. `POST /api/auth/platform` falls back to the body-supplied wallet/id when DCL signed-fetch verification fails (`routes/auth.ts:213-222`), so anyone can claim any wallet.
  3. Platform auth auto-creates every new wallet user as `admin` when `autoPromoteFirstUser` is on; it lacks the first-user check that registration has (`routes/auth.ts:245` vs `:56-60`).
- No automated tests exist in the repo.

## 3. Sub-project map

| # | Sub-project | Depends on | Spec depth here |
|---|---|---|---|
| 0 | v2 hardening | none | **Full** |
| 1 | Access grants (wallet-based, time-boxed, scoped, enforced) | 0 | **Full** |
| 2 | Venue Control HUD + "My Booking" dashboard page | 1 | Outline |
| 3 | Lighting element type + venue look packs | 1 | Outline |
| 4 | Run-of-show scheduler + booking lifecycle jobs | 1, 3 | Outline |
| 5 | Venue catalog, booking, payments, notifications | 1, 4 | Outline |
| 6 | Pop-up venues on host plots | 1–5 | Outline |
| 7 | Third-party venue marketplace | 1–5 | Outline |

Sub-projects 2 and 3 can proceed in parallel once 1 lands. Until 5 exists, bookings are created by VLM admins through an admin API, which is enough to run real events on the first venues.

---

## 4. Sub-project 0: v2 hardening

### 4.1 Colyseus room authentication

- Add `onAuth(client, options)` to `VLMSceneRoom` (and `VLMCommandCenterRoom`). It verifies `options.sessionToken` with the same JWT secret Fastify uses and resolves the user. Missing or invalid token → join as an **anonymous visitor** (allowed: visitors still need to receive scene updates), with `client.auth = { userId: null }`.
- Every **mutating** message handler requires authorization via the shared permission function (§5.4) before applying or persisting anything. Mutating handlers: `scene_preset_update`, `scene_change_preset`, `scene_setting_update`, `scene_video_update` (the control path, not status reports), `scene_moderator_message`, `scene_moderator_crash`, `path_segments_add`, plus all new venue messages. Unauthorized → send `error { code: 'forbidden', messageType }` to the client only; do not broadcast or persist.
- Read/telemetry handlers (`session_*`, `user_message`, `get/set_user_state`, `request/send_player_position`) stay open to visitors; `set_user_state` must write only the sender's own `userId`.

### 4.2 Platform auth: no unverified wallets

- `POST /api/auth/platform`: if signed-fetch verification fails or is absent, never use the body's wallet as a `wallet` auth identifier.
  - If `config.allowUnverifiedPlatformAuth` (new; default `false`, set `true` only in local dev/preview) is on, issue a token flagged `verified: false`, tied to a `preview:` identifier.
  - Otherwise issue a **guest token** (`role: 'viewer'`, no persisted wallet auth method).
- Unverified/guest tokens never pass a permission check that requires a grant, ownership or admin.
- JWT payload gains `wallet` (lowercased, verified only) and `verified: boolean`.

### 4.3 No auto-admin for platform users

- Platform-auth user creation uses the same rule as registration: admin only if no users exist yet; otherwise `creator`.

### 4.4 Collaborator role enforcement

- Write routes in `routes/scenes.ts` replace their inline owner/admin checks with the shared permission function (§5.4). Mapping: scene owner/global admin → everything; `scene_collaborators.role = 'editor'` → all scene scopes except deleting the scene or managing collaborators; `viewer` → read only.
- `GET /api/scenes` returns scenes the user owns **or** collaborates on (with a `relationship` field).

### 4.5 Test harness

- Add Vitest to `apps/server` with a Postgres test database (docker-compose dev service). Shared helpers: create user (email or verified wallet), create scene with preset and element, sign a JWT, create a Colyseus test client.
- Tests for 0: forged-wallet platform auth gets no wallet identity; second platform user is not admin; unauthenticated room client cannot mutate (no broadcast, no DB write); editor collaborator can update an element; viewer cannot.

---

## 5. Sub-project 1: Access grants

### 5.1 Tables (Drizzle, `apps/server/src/db/schema.ts`)

```ts
venueKindEnum = pgEnum('venue_kind', ['permanent', 'popup'])
bookingStatusEnum = pgEnum('booking_status',
  ['pending', 'confirmed', 'live', 'ended', 'canceled'])
venueScopeEnum = pgEnum('venue_scope', [
  'screens', 'playlist', 'lights.cue', 'lights.faders', 'schedule',
  'presets', 'audio', 'moderation', 'crew',
])
venueRoleEnum = pgEnum('venue_role',
  ['host', 'cohost', 'vj', 'lighting', 'performer', 'door'])

venues {
  id uuid pk
  sceneId uuid → scenes.id (unique)          // one venue per scene in v1
  orgId uuid → organizations.id              // the venue owner
  name text, slug text unique, description text
  kind venue_kind default 'permanent'
  defaultPresetId uuid → scene_presets.id    // what the venue reverts to
  timezone text default 'UTC'
  rules jsonb  // { minHours, maxHours, setupLeadMinutes (default 60),
               //   graceMinutes (default 15), bufferMinutes (default 30) }
  rentableElementIds uuid[]                  // elements renters may change
  isListed boolean default false
  createdAt, updatedAt
}

bookings {
  id uuid pk
  venueId uuid → venues.id
  renterUserId uuid → users.id
  title text
  startsAt timestamptz, endsAt timestamptz
  status booking_status default 'pending'
  bookingPresetId uuid → scene_presets.id    // cloned from venue default
  holdExpiresAt timestamptz                  // for 'pending' (sub-project 5)
  paymentRef jsonb                           // filled by sub-project 5
  blockedRange tstzrange not null            // [startsAt − buffer, endsAt + buffer)
  createdAt, updatedAt
  EXCLUDE USING gist (venue_id WITH =, blocked_range WITH &&)
    WHERE (status IN ('pending','confirmed','live'))
}

access_grants {
  id uuid pk
  bookingId uuid → bookings.id (cascade)
  sceneId uuid → scenes.id                   // denormalized for fast lookup
  walletAddress text not null                // lowercased
  userId uuid → users.id null                // set when wallet first signs in
  role venue_role
  scopes venue_scope[]                       // effective scopes (role defaults ± tweaks)
  validFrom timestamptz, validUntil timestamptz
  grantedByUserId uuid → users.id
  revokedAt timestamptz null
  createdAt
  UNIQUE (bookingId, walletAddress)
  INDEX (sceneId, walletAddress)
}
```

The overlap constraint needs the `btree_gist` extension; the entrypoint SQL fallback must create it. `blockedRange` is set by the server whenever `startsAt`/`endsAt` are written, using the venue's `bufferMinutes` (a Postgres generated column can't read another table). Drizzle has no native exclusion-constraint or `tstzrange` support, so both go in a raw SQL migration.

### 5.2 Roles → default scopes

| Role | Default scopes |
|---|---|
| host | all scopes |
| cohost | all scopes (cannot revoke or downgrade the host grant) |
| vj | screens, playlist, schedule |
| lighting | lights.cue, lights.faders, schedule |
| performer | lights.cue |
| door | moderation |

Defined once in `vlm-shared` (`VENUE_ROLE_SCOPES`). A grant stores its effective `scopes`; changing role resets scopes to that role's defaults, then the renter can toggle individual scopes.

### 5.3 Time windows

For a booking with `startsAt`/`endsAt` and venue rules:

- **Setup window:** from confirmation until `startsAt − setupLeadMinutes`. Grants allow edits to the **booking preset only**; the live scene is untouched. HUD/dashboard show a preview.
- **Live window:** `startsAt − setupLeadMinutes` to `endsAt + graceMinutes`. Changes apply to the live scene immediately.
- Host grant: `validFrom` = confirmation time, `validUntil` = end of live window. Crew grants are clamped to lie within the host grant. Attempts to exceed are rejected with `400`.
- `access_revoked` is sent and the venue reverts at `validUntil` (enforced by sub-project 4's job loop; until it exists, by an in-process timer set when the booking goes live, re-armed on server boot from the DB).

### 5.4 The permission function

`apps/server/src/auth/permissions.ts`:

```ts
type SceneScope = VenueScope | 'scene.edit' | 'scene.admin'
can(actor: Actor, sceneId: string, scope: SceneScope, at = new Date()):
  Promise<{ ok: boolean; target: 'live' | 'bookingPreset' | null; bookingId?: string }>
```

Resolution order:
1. Global admin or scene owner, or an org owner/admin of the venue's org → `ok`, `target: 'live'`.
2. `scene_collaborators` editor → `ok` for `scene.edit` and all venue scopes except `crew`; viewer → no writes.
3. Active access grant: `revokedAt is null`, `validFrom <= at < validUntil`, matching `userId` **or** verified `wallet`, `scopes` contains `scope` → `ok`, `target` determined by §5.3 window.
4. Otherwise `ok: false`.

Grant-scoped actors may only modify elements whose ids are in `venues.rentableElementIds` (or the booking-preset clones of them). Everything else is owner/editor only.

Results are cached per room per user for 10 seconds; the cache is invalidated on any grant insert/update/revoke for that scene (in-process event bus; Redis pub/sub in scalable mode).

When a verified wallet signs in, any grants with that `walletAddress` and null `userId` are linked to the user.

### 5.5 Booking presets

On confirmation, the server clones the venue's `defaultPresetId` (elements and instances) into a new preset named `booking:<bookingId>` and stores it as `bookingPresetId`. In the setup window, venue-scope writes target that preset. At live start, the scene's active preset switches to it (existing `scene_change_preset` path); at live end, it switches back to `defaultPresetId`. The booking preset is kept 30 days after the booking ends for "rebook with same setup," then deleted.

### 5.6 API (sub-project 1)

All under `/api/venues`, JSON, JWT auth:

- `POST /` (admin or org owner): make a scene a venue. `PATCH /:id`, `GET /:id`, `GET /` (listed venues).
- `POST /:id/bookings` (admin only until sub-project 5): create a confirmed booking for a renter (by userId or verified wallet). Creates the host grant and booking preset.
- `GET /bookings/mine`: bookings where the user has the host grant or any active grant.
- `GET /bookings/:id/grants`, `POST /bookings/:id/grants` `{ walletAddress, role, scopes? }`, `PATCH /grants/:id`, `DELETE /grants/:id` (sets `revokedAt`). All require `crew` scope; cohosts cannot touch the host grant.
- `POST /bookings/:id/cancel` (admin): status `canceled`, revoke all grants, revert if live.

Room messages added: `venue_access` (server → client on join and on change: the client's current scopes, window, and booking id, or none), `access_revoked` (server → client).

### 5.7 Tests (sub-project 1)

- Grant lifecycle: create, scope tweak, revoke; crew grant clamped to host window.
- `can()` truth table: owner, admin, editor, viewer, active grant with and without scope, expired, revoked, not-yet-valid, wallet-only grant linked on sign-in, unverified token with a matching wallet string (must fail).
- Setup-window writes land in the booking preset and do not change the live scene; live-window writes broadcast.
- Overlapping bookings rejected by the exclusion constraint, including the buffer.
- Expiry: at `validUntil`, client receives `access_revoked`, a later mutation is rejected, the scene reverts to the default preset.
- Rentable-element restriction: grant holder cannot modify a non-rentable element.

---

## 6. Sub-project 2: Venue Control HUD (outline)

- Shown only when the room's `venue_access` says the user has at least one scope; closes on `access_revoked`. Wires `setHUDActionHandler` in the DCL adapter.
- Tabs, each gated by scope: **Stage** (status, countdown, look/preset quick list), **Screens** (per rentable screen: source, stream URL entry with preview and health dot, "send to my phone" companion link reusing `companion-upload`), **Lights** (look grid, faders if `lights.faders`), **Run of Show** (timeline of schedule items), **Crew** (add by wallet or nearby avatar, role, scope toggles, revoke), **Door** (mute/kick/ban via moderator messages).
- Web dashboard **My Booking** page with the same controls, for setup-heavy work (poster uploads, playlist building).
- Concurrency: last write wins; all changes broadcast; scheduled changes are labeled as such in the HUD.

## 7. Sub-project 3: Lighting (outline)

- New element type `light` in `vlm-shared`: fixture group with `color`, `intensity`, `speed`, `pattern` (`static | pulse | chase | strobe | breathe`). DCL adapter renders with emissive materials and SDK light sources within DCL's active-light limits.
- **Looks:** named snapshot of all light-group states (optionally with a preset), stored per venue; each venue ships a signature look pack. `lights.faders` holders can save looks into the booking preset.
- Sync: a look is broadcast once with a start timestamp; clients run pattern animation locally against the shared clock, so patterns stay aligned without per-frame traffic.

## 8. Sub-project 4: Run-of-show scheduler (outline)

- `schedule_items { bookingId, fireAt, action (set_look | play_playlist | set_stream | switch_preset | set_image), targetElementId, params jsonb, status, createdBy }`.
- Server job loop: every 5s, claim due items with `SELECT … FOR UPDATE SKIP LOCKED` (multi-server safe), apply through the same path as a live edit, broadcast. Fires whether or not anyone is present.
- The same loop runs booking lifecycle (go live, end and revert, reminders), replacing sub-project 1's in-process timer.
- Also fixes: event `startTime`/`endTime` drive preset switches; stream webhooks and cross-world broadcasts fan out to Colyseus scene rooms.

## 9. Sub-project 5: Catalog, booking, payments, notifications (outline)

- Public catalog page per listed venue with concept art, capacity notes, hourly rate, and an availability calendar.
- Booking: choose slot → `pending` with a 15-minute hold (`holdExpiresAt`) → pay → `confirmed` (creates host grant and booking preset). The exclusion constraint already prevents double booking.
- Card: Stripe Checkout `mode: 'payment'`, confirmed by webhook.
- Crypto: a small `VenuePayments` contract on Polygon accepting MANA/USDC with a `bookingId` in the emitted event. The server watches events and confirms after N blocks. Crypto price is locked at checkout from the venue's USD rate.
- Notifications follow the deck timeline (confirmed, setup link, 24h, 1h) by email (collected at booking, optional for crew) with an `.ics` attachment, plus an in-world banner when a grant holder enters their venue.
- Cancellation and refund policy per venue; refunds processed manually at first.

## 10. Sub-projects 6–7 (outline)

- **Pop-ups:** a host-plot scene contains every venue design that fits its parcel footprint, each as a set of presets; a booking selects a design, and the booking preset is cloned from that design's default.
- **Marketplace:** third-party owners list venues (owner approval queue); Stripe Connect payouts; contract fee split for crypto; owner-defined rules and pricing.

## 11. Out of scope for this spec

Non-DCL adapters for venue control, ticketing/paid entry for guests, audio mixing, avatar-based performer motion capture, and automated refunds.

## 12. Open questions for later sub-projects

- Exact DCL light-source limits per scene and their effect on look design (sub-project 3).
- Which email provider `services/email.ts` uses in production, and whether Discord notifications are wanted (sub-project 5).
- Hourly pricing per venue (sub-project 5).
