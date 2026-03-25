# VLM V2 — Implementation Plan

A phased build plan for a solo developer with AI assistance. Prioritizes reaching a testable end-to-end flow as early as possible, then expands outward.

**The core product loop that must work before anything else matters:**
Creator opens dashboard → edits a scene element → the change appears in a live metaverse scene within milliseconds via WebSocket.

**Total to MVP: ~4-6 weeks. Total to V1 feature parity: ~10-14 weeks.**

---

## Current Status: Phase 10 Complete — Advanced Features

**Last updated:** 2026-03-23

```
Phase 0: Scaffolding        ✅ DONE     Monorepo boots, all packages link
Phase 1: vlm-shared         ✅ DONE     12 enums, platform adapter interface, protocol types
Phase 2: Server + DB        ✅ DONE     Auth, scene CRUD, Colyseus room with all handlers
Phase 3: vlm-core + client  ✅ DONE     HTTP client, Colyseus manager, 4 element managers
Phase 4: DCL Adapter        ✅ DONE     DclAdapter (22 methods), platform auth route, test scene
Phase 5: Web Dashboard      ✅ DONE     Login, scene list, scene editor with Colyseus real-time sync
                           ─── MVP COMPLETE ───
Phase 6: Feature Parity    ✅ DONE     Media upload, analytics, events, giveaways, widgets, moderation
Phase 7: Hyperfy Adapter   ✅ DONE     HyperfyAdapter, EntityStore bridge, React renderer, 4 element components
Phase 8: Platform Hooks    ✅ DONE     platform_callbacks table, hook routes, push dispatch, cron cleanup
Phase 9: Deployment        ✅ DONE     VLM_MODE config matrix, Dockerfile, compose files, deploy templates
Phase 10: Advanced (High)  ✅ DONE     Asset library, scene deployment, command center (tables + API + rooms)
In-World HUD             ✅ DONE     vlm-hud package, HUDManager, 6 panel controllers, HUDRenderer interface
Hyperfy Provisioning     ✅ DONE     InfraProvider interface (Fly/Docker/Local), HyperfyProvisioner, deploy routes
HLS Streaming            ✅ DONE     vlm-streaming app (RTMP + FFmpeg + HLS), streaming tables, API routes, webhook
Stripe Billing           ✅ DONE     subscriptions table, Stripe integration, billing routes, feature-gate wired to DB
Companion Upload         ✅ DONE     upload_tokens table, token API, mobile upload page (/u/[code]), HUD integration
Documentation Site       ✅ DONE     Starlight (Astro), 29 pages: getting-started, dashboard, SDK, API, self-hosting
                           ─────────
                           Phases 0-3 completed in one session
                           Phase 7 proves multi-platform adapter architecture works
                           Phase 8 enables non-WebSocket platforms (Second Life, IoT, Discord bots)
                           Phase 9 enables one-click deploy to Railway/Render/Fly + Docker self-hosting
                           Phase 10 adds asset library, scene deployment pipeline, multi-world command center
```

### What exists at `/Users/unknower/-VLM/vlm-v2/`:

| Package | Status | Key Files |
|---------|--------|-----------|
| `vlm-shared` | ✅ Complete | 12 enums, `VLMPlatformAdapter` interface, `SceneElement`/`SceneElementInstance`, full WebSocket protocol types, math types, storage types |
| `vlm-client` | ✅ Complete | `VLMHttpClient` (all REST endpoints), `ColyseusManager` (connect, join, message handlers), `VLMAuth` (JWT decode + expiry) |
| `vlm-core` | ✅ Complete | `VLM` class (full init flow), `SceneManager` (message router), `VideoManager` (live/playlist/image switching), `ImageManager`, `MeshManager`, `SoundManager`, `EventBus` |
| `vlm-server` | ✅ Complete | Fastify 5 + Colyseus on one port, `VLM_MODE` config (single/scalable/cloud), Drizzle schema (12 tables incl. `platform_callbacks`, `asset_library_items`, `scene_deployments`, `deployment_wallets`), auto-migration, email/password auth, full scene CRUD, `VLMSceneRoom` + `VLMCommandCenterRoom`, scene preset serializer, hook routes, platform-hooks dispatch, asset library API (`/api/assets`), deployment pipeline API (`/api/deploy`), command center API (`/api/command-center`), feature-gate middleware, Dockerfile + compose files + deploy templates |
| `vlm-adapter-dcl` | ✅ Complete | `DclAdapter` implementing all 22 `VLMPlatformAdapter` methods, `createVLM()` entry point, backward-compat wrapper |
| `vlm-web` | ✅ Complete | Login/register, scene list, scene editor (tabbed: Videos/Images/Models/Sounds), Colyseus real-time sync, 24.1 kB client JS |
| `vlm-hud` | ✅ Complete | `HUDManager` (init, panel toggling, Colyseus event bridge, access control), `PanelRegistry` (modal panel state), 6 panel controllers: `AssetBrowserPanel` (search/filter, budget meter), `SceneLayoutPanel` (element list, transform gizmo, visibility toggle), `EventControlPanel` (cross-world actions), `StreamControlPanel` (live/offline switching), `WorldStatusPanel` (mini command center), `NotificationPanel` (toast feed) |
| `vlm-adapter-hyperfy` | ✅ Complete | `HyperfyAdapter` (all 27 `VLMPlatformAdapter` methods), `EntityStore` (imperative→declarative bridge), `HyperfyRenderer` (React), `VideoElement`/`ImageElement`/`ModelElement`/`SoundElement` components, `VLMApp` entry point with `useWorld`/`useFields`/`getStore` |

### Verified working (integration tested 2026-03-23):
- ✅ `pnpm turbo build` — all 7 packages compile successfully
- ✅ Docker Compose starts Postgres + Redis + MinIO
- ✅ Schema pushed to Postgres via `drizzle-kit push`
- ✅ Server starts, auto-migrates, health check returns `{"status":"ok","mode":"single"}`
- ✅ User registration with auto-promote-first-user to admin
- ✅ JWT auth (access + refresh tokens)
- ✅ Platform auth (`POST /api/auth/platform`) — auto-creates users from DCL wallet data
- ✅ Scene CRUD with full nested data (scene → presets → elements → instances)
- ✅ Colyseus WebSocket: client joins room, receives `scene_preset_update` with `action: 'init'`
- ✅ Scene serializer correctly transforms DB rows to V1-compatible wire format with `sk` IDs and flattened properties
- ✅ Full pipeline tested: platform auth → Colyseus join → scene init → video element with position/liveSrc/offType received by client
- ✅ DclAdapter compiles against `@dcl/sdk ~7.7.9` with all DCL ECS component imports resolving
- ✅ Test scene scaffold at `test-scenes/dcl-test/` with scene.json pointing to test scene ID `645c3a07-5d49-469f-88f3-1636fd55e701`

### MVP is complete. To resume development:

**Start the dev environment:**
```bash
cd /Users/unknower/-VLM/vlm-v2
docker compose -f docker-compose.dev.yml up -d     # Postgres + Redis + MinIO
cd apps/server
DATABASE_URL="postgresql://vlm:vlm_dev@localhost:5432/vlm" JWT_SECRET="test-secret" npx tsx src/index.ts
# In another terminal:
cd apps/web
NEXT_PUBLIC_API_URL=http://localhost:3010 NEXT_PUBLIC_WSS_URL=ws://localhost:3010 pnpm dev
```

**Test accounts:**
- `dashboard@vlm.gg` / `test1234` (creator role)
- `phase3@vlm.gg` / `test1234` (admin role — first user)

**Test scene IDs (in Postgres from integration tests):**
- `645c3a07-5d49-469f-88f3-1636fd55e701` — Phase 3 test scene (1 video)
- `41d2babe-3db2-4ec5-934e-baa1143f8cb2` — Dashboard test scene (1 video)

**All features from the original build spec are now implemented.**
V1 Data Migration was skipped (data already deleted).

---

## Critical Path (Phases 0-5)

```
Phase 0: Scaffolding        1-2 days    ──→ Monorepo boots, packages link           ✅
Phase 1: vlm-shared         2-3 days    ──→ All types compile                       ✅
Phase 2: Server + DB        3-5 days    ──→ API serves data, Colyseus room works    ✅
Phase 3: vlm-core + client  5-7 days    ──→ SDK manages scenes with mock adapter    ✅
Phase 4: DCL Adapter        3-5 days    ──→ ★ FIRST END-TO-END: video screen in DCL ✅
Phase 5: Web Dashboard      7-10 days   ──→ ★ FULL PRODUCT LOOP: dashboard ↔ world  ✅
                           ─────────
                           ~21-32 days to MVP
```

---

## Phase 0 — Monorepo Scaffolding

**Duration:** 1-2 days | **Depends on:** nothing | **Parallelism:** serial

### Work

- Init repo with Turborepo + pnpm workspaces
- Create empty package scaffolds: `vlm-shared`, `vlm-client`, `vlm-core`, `apps/server`, `apps/web`
- `docker-compose.dev.yml` with Postgres 16 + Redis 7 + MinIO
- Shared TSConfig, ESLint, Prettier at root
- `.env.example` with all variables from spec Section 16.12

### Done when

- `pnpm install && pnpm turbo build` succeeds across all empty packages
- `docker compose up` starts Postgres, Redis, MinIO
- Packages can import each other

---

## Phase 1 — vlm-shared: Types & Platform Contract

**Duration:** 2-3 days | **Depends on:** Phase 0 | **Parallelism:** serial (everything imports this)

### Work

| File | Contents |
|------|----------|
| `src/types/math.ts` | `Vec3`, `TransformData`, `ClickEvent` |
| `src/enums/index.ts` | All enums from spec Section 5.3 (ElementType, ClickEventType, WidgetControlType, VideoSourceType, SoundSourceType, UserRole, etc.) |
| `src/types/elements.ts` | `SceneElement`, `SceneElementInstance`, per-element-type property interfaces (VideoProperties, ImageProperties, etc.) |
| `src/types/scene.ts` | `ScenePreset`, `SceneSetting`, `VLMInitConfig`, `VLMStorage` |
| `src/platform.ts` | `VLMPlatformAdapter` interface, `PlatformCapabilities`, `PlatformUser`, `AuthProof`, `SceneInfo`, `EntityHandle` |
| `src/protocol.ts` | All `ClientMessage` / `ServerMessage` union types and data interfaces |
| `src/types/hud.ts` | `HUDRenderer` interface, `HUDPanelType` enum (stubs — flesh out later) |

### Done when

- Package compiles with zero errors
- Every type from spec Section 5 exists
- Import from `vlm-shared` resolves in `vlm-core` and `apps/server`

---

## Phase 2 — Server + Database

**Duration:** 3-5 days | **Depends on:** Phase 1 | **Parallelism:** 2A and 2B can be built in parallel

### 2A: Database (Drizzle + Postgres)

- Drizzle schema for core tables: `users`, `user_auth_methods`, `scenes`, `scene_presets`, `scene_elements`, `scene_element_instances`, `scene_settings`, `scene_state`, `scene_collaborators`
- Auto-migration runner (runs on server boot, no manual step)
- Dev seed script: test user + test scene + one video element with instance

### 2B: Fastify + Colyseus Server

- Entry point: Fastify + Colyseus on same port (spec Section 16.3 pattern)
- `VLM_MODE` config system (defaults to `single`, in-memory Colyseus presence)
- Health check at `/api/health`
- Email/password auth: `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`
- Scene CRUD routes: list, create, get, update, delete
- Element + instance CRUD routes (generic, type field distinguishes elements)
- **VLMSceneRoom** (Colyseus): join with JWT, send `scene_preset_update` init on join, handle create/update/delete messages, persist to Postgres, broadcast to room

### Done when

- Server starts, auto-migrates, health check returns 200
- Register user → login → create scene → add video element → get scene returns full data
- Two Colyseus clients join same room: one sends `scene_preset_update`, other receives broadcast
- **This proves the server half of the product loop**

---

## Phase 3 — vlm-client + vlm-core

**Duration:** 5-7 days | **Depends on:** Phase 1 (types), Phase 2 (server to test against) | **Parallelism:** client first, then core

### 3A: vlm-client

| File | Purpose |
|------|---------|
| `src/http.ts` | Typed fetch wrappers for all server routes, JWT token management |
| `src/colyseus.ts` | `joinSceneRoom()`, typed message handlers, auto-reconnect |
| `src/auth.ts` | Token storage, refresh flow, AuthProof → JWT exchange |

### 3B: vlm-core

| File | Purpose |
|------|---------|
| `src/VLM.ts` | Main entry point — accepts adapter, inits client, joins room, routes to managers |
| `src/SceneManager.ts` | Message router — `scene_preset_update` → correct element manager |
| `src/managers/VideoManager.ts` | Video configs + instances, live/playlist/image switching, volume. Port business logic from V1's `VLMVideo.logic.ts` |
| `src/managers/ImageManager.ts` | Image configs + instances. Port from V1's `VLMImage.logic.ts` |
| `src/managers/MeshManager.ts` | 3D model configs + instances |
| `src/managers/SoundManager.ts` | Audio configs + instances |
| `src/storage.ts` | `VLM.storage` — developer-facing read API keyed by customId |
| `src/events/EventBus.ts` | Internal event bus for decoupling managers |

### How to validate without an adapter

Create a `MockPlatformAdapter` that records all calls:

```typescript
class MockAdapter implements VLMPlatformAdapter {
  calls: { method: string; args: any[] }[] = []
  createEntity() { this.calls.push({ method: 'createEntity', args: [] }); return this.calls.length }
  setTransform(e, t) { this.calls.push({ method: 'setTransform', args: [e, t] }) }
  createVideoPlayer(e, o) { this.calls.push({ method: 'createVideoPlayer', args: [e, o] }) }
  // ... etc
}
```

### Done when

- Unit tests pass: `VLM.init()` with MockAdapter → adapter receives correct `createEntity`, `setTransform`, `createVideoPlayer` calls for each video instance in the scene
- Update message arrives → adapter receives `setTransform` with new position
- Video status change → adapter receives `updateVideoSource` with the correct fallback URL
- Integration test: vlm-core + vlm-client + local server → MockAdapter receives rendering calls from a real Colyseus session

---

## Phase 4 — Decentraland Adapter (First End-to-End)

**Duration:** 3-5 days | **Depends on:** Phase 3 | **Parallelism:** none (this is the integration point)

### Work

| File | Purpose |
|------|---------|
| `src/DclAdapter.ts` | Implements `VLMPlatformAdapter` — delegates to services |
| `src/services/EntityService.ts` | `engine.addEntity()` / `removeEntity()` |
| `src/services/TransformService.ts` | `Transform.createOrReplace()` |
| `src/services/VideoService.ts` | `VideoPlayer`, `Material.Texture.Video()`, `videoEventsSystem` |
| `src/services/MaterialService.ts` | `Material.setPbrMaterial()` / `setBasicMaterial()` |
| `src/services/MeshService.ts` | `MeshRenderer.setPlane()`, `GltfContainer` |
| `src/services/AudioService.ts` | `AudioSource` |
| `src/services/ColliderService.ts` | `MeshCollider` |
| `src/services/ClickEventService.ts` | `pointerEventsSystem`, `RestrictedActions` |
| `src/auth/DclAuthProof.ts` | `signedFetch` wrapper |
| `src/index.ts` | `createVLM()` entry + backward-compat wrapper |

Add `POST /auth/platform` route to server for Decentraland signed fetch verification.

### Done when — THIS IS THE MVP MILESTONE

1. Server running locally (or on Railway)
2. Scene created with a video element via REST
3. Decentraland SDK 7 preview scene imports `vlm-adapter-dcl`, calls `createVLM()`
4. **Video screen appears in the preview at the configured position**
5. Send `scene_preset_update` from another client → **screen moves in real-time**
6. Change video `isLive` status → **screen switches between live stream and fallback image**

---

## Phase 5 — Minimal Web Dashboard

**Duration:** 7-10 days | **Depends on:** Phase 2 (server), Phase 4 (to test full loop) | **Parallelism:** pages can be built in parallel

### 5A: Shell (2 days)

- Next.js 14 App Router + Tailwind + shadcn/ui
- Auth pages (login, register)
- Dashboard layout (sidebar, header)
- JWT-based auth state

### 5B: Scene Editor (5-7 days)

- Scene list page (`/scenes`) — card grid
- Scene editor (`/scenes/[sceneId]`) — tabbed interface:
  - Videos tab: list elements, add/edit/delete, configure URL/playlist/fallback
  - Images tab: same pattern
  - Models tab: same pattern
  - Sounds tab: same pattern
  - Settings tab: name, description
- **Colyseus integration**: editor joins `vlm_scene` room, sends `scene_preset_update` on every change, receives broadcasts and updates UI reactively
- Preset switcher dropdown (create/clone/delete presets)

### 5C: Static Export (1 day)

- Configure Next.js for static export (`next export`)
- Wire static output into `apps/server/dashboard/` for the consolidated container

### Done when — FULL PRODUCT LOOP

- Log in → see scenes → open editor → change video URL
- **In Decentraland preview, video source changes within milliseconds**
- Drag position slider → **screen moves in DCL**
- Open two browser tabs → changes in one reflect in the other
- Build Docker image → `VLM_MODE=single` → everything works from one container

---

## Phase 6 — V1 Feature Parity

**Duration:** 10-15 days | **Depends on:** Phase 5 | **Parallelism:** all sub-tasks are independent

Build these in whatever order your users need most. All are independent.

| Sub-phase | Days | What |
|-----------|------|------|
| **6A: Auth providers** | 3-4 | Web3 wallet, DCL signed fetch, Google OAuth, Discord OAuth, API keys |
| **6B: Analytics** | 3-5 | Session tracking, actions, paths, analytics API, dashboard analytics page |
| **6C: Events + Giveaways** | 3-5 | Event/giveaway CRUD, linking, claim points, credit system |
| **6D: Widgets** | 1-2 | WidgetManager in vlm-core, widget CRUD, widget controls |
| **6E: Moderation** | 1-2 | Moderator messages, crash command, moderation dashboard tab |
| **6F: Media Upload** | 2-3 | Storage abstraction (Supabase/S3/R2/local), upload API, media library page |

### Done when

- Every feature from V1 SPEC.md files works in V2
- A V1 Decentraland scene can switch to V2 by changing the import path

---

## Phase 7 — Hyperfy Adapter

**Duration:** 5-7 days | **Depends on:** Phase 3 (vlm-core) | **Can parallel with:** Phase 6

### Work

- `HyperfyAdapter` implementing `VLMPlatformAdapter` via the EntityStore bridge (imperative → declarative)
- `EntityStore` — observable map, adapter writes, React renderer reads
- `HyperfyRenderer` — React component iterating entities, rendering `<video>/<image>/<model>/<audio>`
- `VideoElement`, `ImageElement`, `ModelElement`, `SoundElement` components
- Entry point with `useWorld()`, `useFields()`, VLM init
- Hyperfy auth via `world.http()`

### Done when

- Same scene renders correctly in both Decentraland and Hyperfy
- Dashboard changes reflect in both worlds simultaneously
- **This proves the platform adapter architecture works**

---

## Phase 8 — Platform Hooks + Second Life

**Duration:** 3-5 days | **Depends on:** Phase 2 (server routes) | **Can parallel with:** Phase 6-7

### Work

- `POST /hook/register`, `GET /hook/config`, `GET /hook/scene` routes
- `platform_callbacks` table + CRUD
- Push dispatch system (POST to callbacks after every Colyseus broadcast)
- Stale callback cleanup cron
- Update V1 SL scripts with V2 paths/data shapes

### Done when

- Register callback → change video in dashboard → callback receives POST within seconds
- SL script (or mock) renders correct video/image based on API responses

---

## Phase 9 — Deployment Modes + Containerization

**Duration:** 3-5 days | **Depends on:** Phase 5 (dashboard), Phase 6F (storage abstraction)

### Work

- `VLM_MODE` config with full default matrix (single/scalable/cloud)
- Redis presence for scalable/cloud modes
- `requireFeature()` middleware (no-op when billing disabled)
- Production Dockerfile (two-stage, Next.js static export baked in)
- `docker-compose.single.yml`, `docker-compose.scalable.yml`, `docker-compose.self-hosted.yml`
- `railway.toml`, `render.yaml`, `fly.toml` templates
- Auto-promote first user to admin in single/scalable

### Done when

- `docker build .` produces working image
- `VLM_MODE=single` works with just DATABASE_URL + JWT_SECRET
- `VLM_MODE=scalable` works with Redis added
- Deploy to Railway via template — full operation from one click

---

## Phase 10 — Advanced Features (Post-MVP, Post-Parity)

Build these based on demand. Each is independent.

| Feature | Days | Priority | Notes |
|---------|------|----------|-------|
| **3D Asset Library** | 5-7 | High | Browse/search GLBs, budget meter, upload custom assets |
| **Scene Deployment (DCL)** | 5-7 | High | One-click deploy to DCL parcels/worlds from dashboard |
| **In-World HUD** | 7-10 | High | Asset browser, layout panel, stream control — manage from inside the world |
| **Command Center** | 5-7 | Medium | Multi-world status, cross-world broadcast, event orchestration |
| **HLS Streaming** | 7-10 | Medium | RTMP ingest, FFmpeg transcode, VOD recording |
| **Stripe Billing** | 3-5 | Medium (cloud only) | Subscriptions, usage tracking, feature gating |
| **Hyperfy Provisioning** | 5-7 | Medium | Auto-deploy Hyperfy worlds from dashboard |
| **Companion Upload** | 2-3 | Medium | QR code flow for uploading assets from phone while in-world |
| **V1 Data Migration** | 3-5 | Low (only if migrating) | DynamoDB → Postgres migration script |
| **Documentation Site** | 3-5 | Low (build last) | Starlight/Docusaurus with guides and API reference |

---

## Timeline Overview

```
Week 1-2:   Phase 0-2  (scaffolding + types + server + database)
Week 3-4:   Phase 3-4  (SDK core + DCL adapter → ★ first end-to-end)
Week 5-6:   Phase 5    (web dashboard → ★ full product loop)
                        ─── MVP COMPLETE ───
Week 7-8:   Phase 6    (V1 feature parity — auth, analytics, events, media)
Week 9-10:  Phase 7-8  (Hyperfy adapter + SL hooks — multi-platform)
Week 11-12: Phase 9    (deployment modes + containerization + one-click deploy)
Week 13+:   Phase 10   (asset library, deployment, HUD, streaming, billing)
```

---

## What to Build First Each Day

If you're ever unsure what to work on next, follow this priority:

1. **Is the critical path blocked?** Unblock it. The critical path is: types → server → SDK → adapter → dashboard.
2. **Can something be tested end-to-end?** If you just finished a component, write the test that proves it works against the real server.
3. **Is there a user-facing feature that's 80% done?** Finish it. Shipping > perfection.
4. **Are there parallel tasks?** Start the one that unblocks the most future work.

The single most important milestone is **Phase 4 completion** — a video screen appearing in a Decentraland preview, controlled by the VLM server. Everything before that is scaffolding. Everything after builds on that foundation.
