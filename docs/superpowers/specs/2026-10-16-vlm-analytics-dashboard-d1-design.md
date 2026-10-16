# VLM Analytics Dashboard (D1) — Design

**Date:** 2026-10-16 · **Status:** user approved the D1/D2 split and said "go ahead with your plan with best judgement" (2026-10-16). Implements the first part of Sub-project D in `2026-10-04-vlm-analytics-design.md` §7.

## 1. Goal

Hosts and anyone with an analytics role see their scene's analytics on vlm.gg, and get there in one press from the in-world HUD.

## 2. Findings

- Collection, rollups and a read API already exist and enforce access and host tenures: `GET /api/analytics/locations`, and per location `…/:id/summary`, `…/timeseries`, `…/live`, `…/heatmap`, `…/sessions`, `PATCH …/:id` (`walletVisibility`). Ids are **analytics location** ids (`analytics_scenes.id`), not VLM scene ids.
- The website's Analytics page (`apps/web/src/app/(dashboard)/analytics/page.tsx`) calls the legacy `/api/analytics/scenes/:id/recent|sessions` endpoints and computes stats in the browser. It shows nothing for v2 data.
- Rollups: hourly (`analytics_rollup_hourly`: sessions, unique/new/returning visitors, peak concurrency, dwell average, interactions/emotes/countries/platforms/camera modes as count maps) and daily heatmap cells (`analytics_heatmap_daily`, 1 m cells, `cell_x`/`cell_z` = `floor(x)`/`floor(z)` of scene positions). Rollups lag up to an hour.
- Wallets are stored on sessions only when the location's `walletVisibility` was on (writer), so `sessions` returns a wallet only in that case.
- `apps/web` is Next 15 + React 19 + Tailwind, no chart library, no tests. Sign-in always lands on `/scenes`.
- The DCL adapter already has `openExternalUrl` (Decentraland asks the player to confirm).

## 3. Decisions

- **Pages:**
  - `/analytics` — list of locations the user can read (from `GET /api/analytics/locations`): title, kind (Genesis City / World), location key, tenure dates when limited. One location → go straight to it.
  - `/analytics/[locationId]` — the dashboard. `/analytics?scene=<vlmSceneId>` resolves to the location whose `vlmSceneId` matches and redirects; if none, the list with a note.
- **Dashboard contents (one page, top to bottom):**
  1. Header: title, location key, range picker (24 h · 7 d · 30 d · custom dates; default 7 d), "Data updates hourly" note, verified-wallet share badge.
  2. Summary cards from `summary`: visitors (unique), new vs returning, sessions, peak concurrency, average time spent.
  3. Visitors over time from `timeseries`: line/area chart of unique visitors with sessions and peak concurrency as switchable series. Bucket: hour for 24 h and 7 d, day for 30 d and custom ranges over 7 days.
  4. **Here now** from `live` (polled every 15 s while the tab is visible): count plus dots on the parcel map.
  5. **Heatmap** from `heatmap` on the same parcel map: cells shaded by dwell seconds; toggle to visits.
  6. Breakdowns from `summary`: top interactions, emotes, countries, platforms (top 8 each as bar lists; rest summed as "Other").
  7. Sessions from `sessions`: started, duration, platform, country, and visitor (wallet/name only when the session has one; otherwise "Visitor" + the 8-char hash prefix), "Load more" via the cursor.
  8. Settings (hosts and co-hosts only, i.e. when the location's access allows the PATCH): wallet visibility toggle with one line explaining that it applies to new sessions.
- **Parcel map:** an SVG grid of the location's parcels (16 m each) in scene-relative metres with the base parcel at the origin, matching how positions are recorded. Needs `parcels` and `baseParcel` per location; when a location has no parcels (some Worlds), the map bounds fit the data. North up, parcel coordinates labelled.
- **Charts:** hand-written SVG components (no new dependency), following the `dataviz` skill for colour, axes, tooltips and dark mode.
- **Server changes (small):** `GET /api/analytics/locations` rows add `vlmSceneId`, `baseParcel`, `parcels`, `canManage` (true when the actor may PATCH). Nothing else in the read API changes.
- **Sign-in return:** `/?next=<path>` — after sign-in go to `next` when it is a same-origin path starting with `/` (not `//`), else `/scenes`. Dashboard pages send signed-out users there with their URL.
- **HUD:** an **Analytics** button for any role with `analytics.view` (host, co-host, editor, viewer) that opens `https://vlm.gg/analytics?scene=<sceneId>` (web base derived from the configured server: `api.vlm.gg` → `vlm.gg`; custom/self-hosted servers → the server's own origin + `/analytics?scene=`). Lives in the HUD toolbar next to the existing tabs.
- **In-world sign-in hand-off (approved 2026-10-16):** the HUD's Analytics button signs the browser in as the same wallet, no browser login.
  - `POST /api/auth/handoff` (HUD's verified-wallet bearer token from `POST /api/auth/platform`; unverified/guest → `401`) → `{ code, expiresAt }`. Code: 32 random bytes, base64url; stored hashed (SHA-256) in a new table `auth_handoff_codes` (`code_hash` pk, `user_id`, `wallet`, `expires_at` = now + 60 s, `used_at`). Rate-limited per user.
  - The HUD opens `<web>/auth/handoff?code=<code>&next=<path>` (`next` = `/analytics?scene=<sceneId>`).
  - The page immediately removes the code from the URL (`history.replaceState`), then `POST /api/auth/handoff/exchange { code }` → the same `{ accessToken, refreshToken, user }` a wallet sign-in returns, marked as a verified-wallet session. The exchange is atomic single use (`update … set used_at = now() where code_hash = $1 and used_at is null and expires_at > now() returning …`); used, expired or unknown → `410`, and the page falls back to normal sign-in with the same `next`.
  - The page sends `Referrer-Policy: no-referrer` and never exchanges on server render (only the client POST), so link previewers can't consume it. Expired rows are purged by the existing analytics jobs' sweep or on insert.
  - The session grants exactly what wallet sign-in grants — nothing more.
  - If the hand-off call fails in the HUD, it opens the plain `/analytics?scene=` link instead.
- **Old page:** the legacy-endpoint analytics page and its `api.ts` methods are removed; legacy server endpoints stay (old SDK clients).
- **Time display:** charts and tables in the browser's local time; day buckets are UTC days and labelled as such.

## 4. Error handling

- Not signed in → sign-in with `next`. No access / unknown location → "You don't have access to this scene's analytics" with a link to `/analytics`.
- No data yet → each section shows "No visits recorded yet" (summary zeros, empty chart, empty map), not errors.
- A section's request fails → that section shows "Couldn't load — retry" with a retry button; others still render.
- Live polling pauses while the tab is hidden and on errors backs off to 60 s.
- Range over 400 days (API limit) → the picker refuses it.

## 5. Testing

- Server (vitest, real Postgres): locations rows include `vlmSceneId`, `baseParcel`, `parcels`, `canManage` (host true, viewer false).
- Web (vitest added to `apps/web`, pure functions only): range → `from`/`to`/`bucket`; `next` sanitising (accepts `/analytics/x`, rejects `//evil.com`, `https://…`, empty); parcel-map geometry (parcel list → bounds, cell → SVG rect, positions → dots, World with no parcels fits data); chart scales and tick choice; breakdown top-8 + Other; session visitor label.
- Server: hand-off — verified token gets a code; unverified/guest 401; exchange returns a session for the same user; second exchange 410; expired 410; unknown 410; codes stored hashed.
- Web: hand-off page strips the code before exchanging; 410 falls back to sign-in with `next`.
- HUD: web URL derivation (`api.vlm.gg` → `vlm.gg`, localhost/custom → same origin).
- Manual: run the web app against the local server with seeded analytics data; check every section, dark mode, phone width; press the HUD button in the test scene.

## 6. Out of scope (D2)

Event/booking reports, shareable read-only report links, CSV export (pro tier), entry/exit points, dwell distribution chart, camera-mode and video-watch breakdowns, cross-scene totals.
