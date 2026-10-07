# VLM Shared Streaming (one region, fixed DNS) — Design

**Date:** 2026-10-06 · **Status:** design approved in conversation 2026-10-06 ("looks good mang"); spec awaiting review
**Branch:** feature/shared-streaming (from feature/media-hosting c800b75 — uses its upsert/serializer changes)

## 1. Goal

A creator provisions a stream on the dashboard, pastes `rtmp://ingest.vlm.gg/live` + their stream key into OBS, and pastes the playback URL into a video screen's live URL. When they go live, every screen using that URL in the scene's active preset switches to the stream for everyone in-world without a reload — including visitors who arrive mid-stream — and switches back when they stop. Only provisioned keys can publish.

Decided in conversation: shared ingest first (dedicated per-stream machines are a later spec); one Fly.io region; `vlm.gg` is on Cloudflare; names `ingest.vlm.gg` and `live.vlm.gg`.

## 2. Findings that shape the design

- `apps/streaming` (Node-Media-Server + FFmpeg → HLS, live/offline webhook) works locally but has no Dockerfile / Fly config, and its `start` script runs `node dist/index.ts` (not a built file).
- The media server accepts **any** stream key (`prePublish` never checks).
- The webhook reports `hlsUrl: http://localhost:8000/...` and the API **overwrites** `streaming_servers.hls_playlist_url` with it.
- The webhook only calls HTTP platform callbacks; it **never notifies the scene room**, so DCL screens never switch to live (the comment says it does).
- `GET /api/streaming/:id` and `GET /api/streaming/:id/sessions` have **no owner check** — any signed-in user can read anyone's stream key. The webhook secret (`STREAMING_WEBHOOK_KEY`) is optional.
- Room `init` carries no live status, so a visitor joining mid-stream sees the offline screen.
- With one region, Fly's anycast IP plus two static DNS records is enough: no per-stream routing is needed. (Multi-region playback routing via `fly-replay` is future work and won't change these URLs.)

## 3. Decisions

### Infrastructure
- **Fly app `vlm-streaming`**, one always-on machine in one region (`iad`), a Fly volume mounted at `/data` (HLS output `/data/streams`). Dedicated IPv4. Services: TCP 1935 (RTMP, raw TCP) and HTTP 8000 behind Fly's TLS on 443 (`live.vlm.gg` certificate via `fly certs add live.vlm.gg`).
- Image: `apps/streaming/Dockerfile` — Node 20 slim + `ffmpeg` from apt; builds the TypeScript; `CMD node dist/index.js`. `apps/streaming/fly.toml` committed. `package.json` `start` → `node dist/index.js`.
- **Cloudflare DNS (manual, once, DNS-only / grey cloud):** `ingest.vlm.gg` A → the dedicated IPv4; `live.vlm.gg` A → the same IPv4 (plus AAAA → the app's IPv6). Steps go in a runbook `apps/streaming/DEPLOY.md`. No code edits DNS.
- **API env (Railway):** `RTMP_INGEST_URL=rtmp://ingest.vlm.gg/live`, `HLS_BASE_URL=https://live.vlm.gg/streams`, `STREAMING_WEBHOOK_KEY=<secret>`. **Media server env (Fly secrets):** `VLM_API_URL=https://api.vlm.gg`, `VLM_WEBHOOK_KEY=<same secret>`, `OUTPUT_DIR=/data/streams`.
- Deploying (Fly app creation, DNS records, env) is done by the user from the runbook; implementation does not deploy.

### Stream keys
- **`POST /api/streaming/authorize`** (`X-Webhook-Key` required) `{ streamKey }` → `200 { ok: true }` for a key that exists in `streaming_servers`; `403 { error: 'unknown_key' }` otherwise; `401` for a missing/wrong secret.
- Media server `prePublish`: calls authorize (5 s timeout). Node-Media-Server 2.7 emits `prePublish` synchronously, so the check is async: FFmpeg and the `live` webhook start **only after** authorize returns `200 ok`; anything else (403, 401, timeout, network error) → `nms.getSession(id).reject()`, no FFmpeg, no webhook. **Fail closed.** (A rejected publisher may push a few seconds of data into NMS before the drop; nothing is transcoded or served.)

- **Playback id (added after the final review, 2026-10-06):** the playback URL is shown to every visitor, so it carries a separate random `playback_id`, never the stream key: `https://live.vlm.gg/streams/<playbackId>/playlist.m3u8`. Authorize returns `{ ok: true, playbackId }` and the media server writes HLS under it; streams provisioned without one get one on their next authorize. The media server's public HTTP (`/health`) reports only a count; `/status` (which listed keys) is removed. A publish is reported `live` only once its playlist exists (up to 20 s, else it is stopped and rejected).

### Webhook (`POST /api/streaming/webhook`)
- Secret **required** whenever `STREAMING_WEBHOOK_KEY` is set, and in cloud mode a missing env is a 503 `webhook_not_configured` (never open). Self-hosted with no key keeps today's open behaviour (local dev).
- Never writes `hls_playlist_url` from the webhook body (the provisioned URL is the truth). The `hlsUrl` field is ignored.
- Live/offline update the row and sessions as today, then publish a presence-bus event `{ type: 'stream_status', playlistUrl, live }` on a **global** topic `streams` (the stream may be used by any scene, not only `server.sceneId`). HTTP platform callbacks for `server.sceneId` stay as today.

### Scene rooms
- Every `VLMSceneRoom` subscribes to the `streams` topic. On `stream_status`, it loads its scene's active preset videos, and for each element whose `liveSrc` equals `playlistUrl` broadcasts `scene_video_status { elementId, status: 'live' | 'offline', url: playlistUrl }` (the shape `SceneManager.handleVideoStatus` already consumes).
- **Live status on join/edit:** when the room serializes videos (init, preset change, upsert), each video whose `liveSrc` matches a `streaming_servers` row with `status = 'live'` gets `isLive: true` (one query per serialization for the set of live playlist URLs). The client then starts live, and `VideoManager.upsert` already keeps in-memory live state when media fields are unchanged.
- URL matching is exact string equality after trimming whitespace.

### Ownership
- `GET /api/streaming/:id` and `GET /api/streaming/:id/sessions`: owner or admin only, else 404 (don't reveal existence). List was already scoped to the owner.

### Stuck-live recovery
- `GET /api/streaming/live-keys` (`X-Webhook-Key` required) → `{ streamKeys: [...] }` of rows with `status = 'live'`.
- On startup, the media server fetches it and sends `offline` webhooks for every key not actively publishing on it (one region, one machine: that's all of them at boot). Failure is logged and retried every 30 s up to 5 times.

### HLS housekeeping
- On `donePublish`, the stream's output directory is removed after 60 s (unless the key publishes again within that window).
- HLS paths are resolved and confined to `OUTPUT_DIR` (reject `..`); files are streamed, not `readFileSync`.

### Dashboard
- Streaming page: label the HLS copy row "Playback URL — paste into a video screen's Live URL"; show OBS instructions as Server = `rtmp://ingest.vlm.gg/live`, Stream Key = key (the API already returns both). No new linking UI.

## 4. Out of scope
Dedicated per-stream machines and DNS-per-stream; multiple regions / `fly-replay` playback routing; RTMPS; recording/VOD; ABR (stays off); automated DNS changes; deploying.

## 5. Testing
- **Server (vitest, real Postgres):** authorize (known → 200, unknown/deleted → 403, missing/wrong secret → 401); webhook requires the secret when set and in cloud mode with no env → 503; webhook live/offline updates row + session and never overwrites `hls_playlist_url`; a joined room client receives `scene_video_status` for matching active-preset videos only (non-matching URL, non-active preset → nothing), via `test/helpers/game-server.ts`; `init` during a live stream carries `isLive: true` for the matching video only; owner checks on get/sessions (stranger → 404, admin → 200); `live-keys` lists only live rows and needs the secret.
- **Media server (`node --test`, logic extracted into a testable module with injected fetch/FFmpeg):** publish rejected on 403 / 401 / timeout / network error and accepted on 200; startup offline sweep sends offline for listed keys; HLS path traversal rejected; cleanup timer cancelled by a re-publish.
- **Manual (after the user deploys):** OBS → `rtmp://ingest.vlm.gg/live` with a provisioned key → the test scene's screen with that playback URL switches live; a second client joining mid-stream sees live; stop → both go back offline; an unprovisioned key is refused.
