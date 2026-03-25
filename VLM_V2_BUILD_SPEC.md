# VLM v2 — Complete Rebuild Specification

This document is a comprehensive blueprint for an AI agent or engineering team to rebuild Virtual Land Manager from the ground up. It describes what VLM is, what it does, how the v1 architecture works, what the v2 architecture should look like, and the exact steps to build it.

Read this document in full before writing any code.

---

## Table of Contents

1. [What Is VLM](#1-what-is-vlm)
2. [V1 Architecture Summary](#2-v1-architecture-summary)
3. [V2 Architecture Overview](#3-v2-architecture-overview)
4. [Monorepo Structure](#4-monorepo-structure)
5. [Phase 1: Shared Types & Platform Contract](#5-phase-1-shared-types--platform-contract)
6. [Phase 2: Core SDK (Platform-Agnostic)](#6-phase-2-core-sdk-platform-agnostic)
7. [Phase 3: Backend API](#7-phase-3-backend-api)
8. [Phase 4: Web Dashboard, In-World HUD & Command Center](#8-phase-4-web-dashboard)
   - [8.5 In-World Management HUD](#85-in-world-management-hud)
   - [8.6 Multi-World Event Orchestration](#86-multi-world-event-orchestration)
9. [Phase 5: Media Server & Streaming](#9-phase-5-media-server--streaming)
10. [Phase 6: Decentraland Adapter](#10-phase-6-decentraland-adapter)
11. [Phase 7: Additional Platform Adapters](#11-phase-7-additional-platform-adapters)
12. [Phase 8: Documentation Site](#12-phase-8-documentation-site)
13. [Billing & Subscription System](#13-billing--subscription-system)
14. [Data Migration from V1](#14-data-migration-from-v1)
15. [Platform Integration Hooks (HTTP Push)](#15-platform-integration-hooks-http-push)
16. [Self-Hosting & One-Click Deploy](#16-self-hosting--one-click-deploy)
17. [Appendix A: Complete V1 Message Protocol](#appendix-a-complete-v1-message-protocol)
17. [Appendix B: Complete V1 Data Model](#appendix-b-complete-v1-data-model)
18. [Appendix C: Complete V1 Enum Reference](#appendix-c-complete-v1-enum-reference)
19. [Appendix D: V1 API Route Reference](#appendix-d-v1-api-route-reference)

---

## 1. What Is VLM

Virtual Land Manager is both a platform and a job title. It enables a single person — the Virtual Land Manager — to orchestrate a brand's entire metaverse presence across multiple platforms simultaneously. One operator can deploy worlds, manage live events, place and arrange 3D assets, control video streams, and monitor analytics across Decentraland, Hyperfy, and any future platform — all from one unified interface.

The core product provides:

- **A web dashboard** where creators configure scene elements (video screens, images, 3D models, sounds, widgets) with position, rotation, scale, and behavior.
- **An in-world HUD** that surfaces the same management capabilities directly inside the metaverse — browse assets, place objects, adjust layouts, trigger deployments, and manage events without leaving the world.
- **A multi-world command center** that lets one person manage a simultaneous cross-platform activation — an event running in Decentraland and Hyperfy at the same time, controlled from a single screen.
- **A real-time sync layer** (Colyseus WebSocket) that pushes dashboard and HUD changes to live scenes instantly.
- **An in-world SDK** that scene developers install into their metaverse project. The SDK connects to VLM's servers, receives scene configuration, and renders elements using the platform's native APIs.
- **Analytics** tracking visitor sessions, movement paths, and custom actions — aggregated across all platforms for a unified view.
- **Events and Giveaways** for time-bounded experiences with NFT distribution, coordinated across multiple worlds simultaneously.
- **A credit/balance system** for giveaway operations.

In v1, VLM only supported Decentraland. V2 should support any metaverse platform that has an entity/component system and can run JavaScript/TypeScript.

### The Virtual Land Manager Role

The platform is designed around the idea that a brand or organization hires (or designates) one person to manage their metaverse presence — the Virtual Land Manager. This person needs to:

- Set up a multi-platform presence quickly (deploy worlds across Decentraland + Hyperfy in minutes)
- Run simultaneous events across platforms without switching between separate tools
- Make real-time adjustments during live events (swap a video stream, move a screen, toggle a giveaway) from either the web dashboard or from within any of the connected worlds
- See what's happening across all worlds at a glance (visitor counts, stream status, event state)
- Not be a developer — the HUD and dashboard should be usable by someone with event management skills, not coding skills

### V2 Additions

- **Paid HLS video streaming** — users can provision streaming servers, push RTMP, and get HLS playlist URLs for their scenes.
- **Media hosting** — users can upload, store, and serve images and videos with CDN delivery.
- **Multi-platform support** — a platform adapter interface that lets VLM work in Decentraland, Hyperfy, Three.js-based worlds, and any future platform.
- **Subscription billing** via Stripe for streaming and storage.
- **Email/OAuth authentication** alongside Web3 wallet auth.
- **One-click scene deployment** — deploy Decentraland scenes/worlds and provision Hyperfy worlds directly from the web dashboard or in-world HUD, with no CLI required.
- **3D asset library** — a curated catalog of pre-built GLB models (buildings, furniture, decorations, etc.) that users can browse, select, and place into scenes from the dashboard or in-world HUD.
- **In-world management HUD** — a spatial UI overlay inside each platform that lets the Virtual Land Manager browse assets, place objects, adjust layouts, manage events, and trigger deployments without leaving the world. Paid features surface contextually.
- **Multi-world command center** — a dashboard view (and cross-world HUD mode) that shows all active worlds for an event, with per-world status, visitor counts, stream health, and the ability to push changes to all worlds at once.

---

## 2. V1 Architecture Summary

Understanding v1 is critical context. Do not skip this section.

### Projects

| Project | Tech | Purpose |
|---------|------|---------|
| `vlm-api` | Node.js, TypeScript, Express, Colyseus, DynamoDB, Redis, S3 | Backend API + WebSocket server |
| `vlm-ui` | Vue 2, Vuetify 2, Vuex 3, Colyseus.js, Web3.js | Management dashboard |
| `vlm-dcl` | TypeScript, Colyseus.js, Decentraland SDK 7 | In-world SDK for Decentraland scenes |
| `vlm-docs` | Docsify | Documentation site |

### How Real-Time Scene Management Works

This is the core product loop — understand it thoroughly:

1. Creator opens the web dashboard and navigates to a scene.
2. Dashboard joins a Colyseus room (`vlm_scene`) filtered by `sceneId`.
3. Creator adds/edits/removes a scene element (e.g., moves a video screen).
4. Dashboard sends a `scene_preset_update` message to the Colyseus room with `{ action: 'update', element: 'video', instance: true, property: 'transform', ... }`.
5. The API server (which hosts the Colyseus room) persists the change to DynamoDB and broadcasts the message to all other clients in the room.
6. The in-world SDK (also connected to the same Colyseus room) receives the message.
7. The SDK's `VLMSceneManager` routes the message to the appropriate element manager (`VLMVideoManager.updateInstance()`).
8. The manager calls the platform adapter's services to update the entity in the 3D world.

The user sees their change reflected in the live metaverse scene within milliseconds, without redeploying anything.

### V1 SDK Architecture (vlm-dcl)

The existing vlm-dcl is already structured as a platform adapter for Decentraland. It is NOT a fork of Decentraland's SDK — it uses the SDK's APIs to implement VLM's scene management.

**Layer structure:**
```
VLM class (public API)
  → Managers (VLMVideoManager, VLMImageManager, etc.)
    → Components (VLMVideo.Config, VLMVideo.Instance, etc.)
      → Services (VideoService, MaterialService, TransformService, etc.)
        → Decentraland SDK APIs (@dcl/sdk/ecs, @dcl/sdk/math, etc.)
```

**The Services layer** is where all Decentraland-specific code lives. Each service wraps a specific Decentraland capability:
- `VideoService` → wraps `ecs.VideoPlayer`, `ecs.Material.Texture.Video()`
- `MaterialService` → wraps `ecs.Material.setBasicMaterial()`, `ecs.Material.setPbrMaterial()`
- `TransformService` → wraps `ecs.Transform.createOrReplace()`
- `MeshService` → wraps `ecs.MeshRenderer`, `ecs.GltfContainer`
- `AudioService` → wraps `ecs.AudioSource`
- `ColliderService` → wraps `ecs.PhysicsCollider`
- `ClickEventService` → wraps `ecs.pointerEventsSystem`, RestrictedActions

**The key insight for v2:** The Managers and Components layers are platform-agnostic logic. The Services layer is the platform adapter. V2 formalizes the boundary between them with a shared interface.

### V1 Decentraland-Specific Coupling Points

These are the imports/APIs that tie vlm-dcl to Decentraland specifically:
- `@dcl/sdk/ecs` — Entity, VideoPlayer, Material, Transform, MeshRenderer, AudioSource, etc.
- `@dcl/sdk/math` — Vector3, Quaternion, Color3, Color4
- `~system/UserIdentity` — getUserData() for wallet/display name
- `~system/SignedFetch` — signedFetch() for authenticated API calls
- `~system/RestrictedActions` — movePlayerTo(), openExternalUrl(), requestTeleport()
- `~system/EnvironmentApi` — getSceneInformation(), isPreviewMode(), getPlatform()
- `@dcl/sdk/src/players` — onEnterScene(), onLeaveScene()

---

## 3. V2 Architecture Overview

### Design Principles

1. **Platform-agnostic core.** All scene management logic, networking, and state management lives in shared packages. Platform-specific code is isolated in adapter packages.
2. **Adding a new platform = implementing one interface.** No changes to the core, API, or dashboard required.
3. **One person, many worlds.** Every feature is designed for a single Virtual Land Manager to operate across multiple platforms simultaneously. Events, deployments, and analytics are multi-world by default, not per-world with manual aggregation.
4. **In-world first, dashboard second.** The in-world HUD is the primary management interface — the web dashboard is for setup, planning, and analytics. During a live event, the VLM operator should never need to leave the world.
5. **Type safety end-to-end.** Shared types between API, dashboard, and SDK. No hand-maintained fetch wrappers — use tRPC or similar.
6. **Simple infrastructure.** PostgreSQL instead of 8 DynamoDB tables. The data is relational.
7. **Paid features surface in context.** Billing is integrated into the in-world HUD so users discover premium features at the moment of need, not on a separate pricing page.

### System Diagram

```
┌─────────────────────────────────────────────────────┐
│              The Virtual Land Manager                │
│         (one person managing everything)             │
│                                                      │
│  ┌──────────┐   ┌──────────────┐   ┌─────────────┐ │
│  │ Web3     │   │ Email/OAuth  │   │ API Key     │ │
│  │ Wallet   │   │ (Google,     │   │ (Server-to- │ │
│  │          │   │  Discord)    │   │  Server)    │ │
│  └────┬─────┘   └──────┬───────┘   └──────┬──────┘ │
└───────┼────────────────┼──────────────────┼─────────┘
        │                │                  │
        ▼                ▼                  ▼
┌────────────────────────────────────────────────────┐
│                  Web Dashboard                      │
│              (Next.js App Router)                    │
│                                                     │
│  Command Center │ Scene Editor │ Asset Library      │
│  Deploy │ Events │ Streaming │ Analytics │ Billing  │
└───────────────────┬──────────────────┬──────────────┘
                    │ tRPC / REST      │ Colyseus WSS
                    ▼                  ▼
┌────────────────────────────────────────────────────┐
│                   VLM API Server                    │
│               (Fastify + Colyseus)                  │
│                                                     │
│  Auth │ Scenes │ Events │ Giveaways │ Analytics    │
│  Users│ Media  │ Billing│ Streaming │ Deploy       │
└──┬──────────┬──────────┬──────────┬────────────────┘
   │          │          │          │
   ▼          ▼          ▼          ▼
┌──────┐ ┌───────┐ ┌────────┐ ┌──────────────┐
│Postgr│ │ Redis │ │   S3   │ │ Media Server │
│  es  │ │       │ │ + CDN  │ │ (HLS/RTMP)   │
└──────┘ └───────┘ └────────┘ └──────────────┘

                    ▲ Colyseus WSS
                    │
┌────────────────────────────────────────────────────┐
│         In-World SDKs + Management HUD              │
│                                                     │
│  ┌────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │ vlm-core   │  │ vlm-core    │  │ vlm-core    │ │
│  │ vlm-hud    │  │ vlm-hud     │  │ vlm-hud     │ │
│  │     +      │  │     +       │  │     +       │ │
│  │ vlm-adapter│  │ vlm-adapter │  │ vlm-adapter │ │
│  │   -dcl     │  │  -hyperfy   │  │  -threejs   │ │
│  └────────────┘  └─────────────┘  └─────────────┘ │
│       │                │                │          │
│  Decentraland     Hyperfy          Three.js       │
│  SDK 7 APIs       APIs             APIs           │
└────────────────────────────────────────────────────┘

The VLM operator can manage all connected worlds from either:
  • The web dashboard's Command Center (all worlds at a glance)
  • The in-world HUD in any connected world (spatial UI, contextual)
  • Both simultaneously — changes sync instantly across all interfaces
```

---

## 4. Monorepo Structure

Use **Turborepo** with **pnpm** workspaces.

```
vlm/
├── apps/
│   ├── api/                        # Fastify + Colyseus backend
│   │   ├── src/
│   │   │   ├── server.ts           # Entry point
│   │   │   ├── routes/             # Fastify route modules
│   │   │   ├── ws/                 # Colyseus rooms
│   │   │   ├── services/           # Business logic
│   │   │   ├── db/                 # Drizzle ORM schema + queries
│   │   │   ├── middleware/         # Auth, rate limiting, etc.
│   │   │   └── integrations/       # Stripe, Alchemy, Discord, etc.
│   │   ├── drizzle/                # Migration files
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   ├── web/                        # Next.js dashboard
│   │   ├── src/
│   │   │   ├── app/                # App Router pages
│   │   │   ├── components/         # React components
│   │   │   ├── hooks/              # Custom hooks (state, API, WS)
│   │   │   ├── lib/                # Utilities, auth, Colyseus client
│   │   │   └── styles/             # Tailwind CSS
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   ├── media-server/               # HLS streaming + transcoding
│   │   ├── src/
│   │   │   ├── server.ts           # Entry point
│   │   │   ├── ingest/             # RTMP ingest
│   │   │   ├── transcode/          # FFmpeg HLS transcoding
│   │   │   ├── storage/            # S3 segment upload
│   │   │   └── routes/             # Stream management API
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── docs/                       # Documentation site
│       ├── (Docusaurus or Starlight or similar)
│       └── package.json
│
├── packages/
│   ├── vlm-shared/                 # Types, enums, constants, interfaces
│   │   ├── src/
│   │   │   ├── types/              # All shared TypeScript types
│   │   │   ├── enums/              # All enums (element types, roles, etc.)
│   │   │   ├── platform.ts         # VLMPlatformAdapter interface
│   │   │   └── protocol.ts         # WebSocket message type definitions
│   │   └── package.json
│   │
│   ├── vlm-core/                   # Platform-agnostic scene management
│   │   ├── src/
│   │   │   ├── VLM.ts              # Main VLM class
│   │   │   ├── managers/           # Element managers (Video, Image, etc.)
│   │   │   ├── storage/            # VLM.storage implementation
│   │   │   ├── events/             # Internal event bus
│   │   │   └── state/              # Scene state management
│   │   └── package.json
│   │
│   ├── vlm-hud/                    # In-world management HUD (platform-agnostic logic)
│   │   ├── src/
│   │   │   ├── HUDManager.ts       # Main HUD controller
│   │   │   ├── panels/             # Panel logic (AssetBrowser, SceneLayout, EventControl, etc.)
│   │   │   ├── CommandCenterBridge.ts  # Cross-world state aggregation for in-world mini command center
│   │   │   ├── BillingPrompts.ts   # In-world upgrade/purchase flow logic
│   │   │   └── types.ts            # HUDRenderer interface, panel types, etc.
│   │   └── package.json
│   │
│   ├── vlm-client/                 # Shared networking (HTTP + WebSocket)
│   │   ├── src/
│   │   │   ├── http.ts             # API client (tRPC or typed fetch)
│   │   │   ├── colyseus.ts         # Colyseus room management
│   │   │   └── auth.ts             # Token management
│   │   └── package.json
│   │
│   ├── vlm-adapter-dcl/            # Decentraland SDK 7 adapter
│   │   ├── src/
│   │   │   ├── DclAdapter.ts       # Implements VLMPlatformAdapter
│   │   │   ├── DclHUDRenderer.ts   # HUD rendering via DCL UI Toolkit
│   │   │   ├── services/           # DCL-specific service wrappers
│   │   │   ├── auth/               # DCL signed fetch auth
│   │   │   └── index.ts            # createVLM() entry point
│   │   └── package.json
│   │
│   ├── vlm-adapter-hyperfy/        # Hyperfy adapter (example)
│   │   └── ...
│   │
│   └── vlm-adapter-threejs/        # Generic Three.js adapter
│       └── ...
│
├── docker-compose.yml              # Local dev stack (Postgres, Redis, MinIO)
├── turbo.json
├── pnpm-workspace.yaml
├── .env.example
└── README.md
```

### Turborepo Configuration

```json
// turbo.json
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "test": {
      "dependsOn": ["build"]
    }
  }
}
```

### Local Development

```yaml
# docker-compose.yml (local dev services only)
services:
  postgres:
    image: postgres:16-alpine
    ports: ["5432:5432"]
    environment:
      POSTGRES_DB: vlm
      POSTGRES_USER: vlm
      POSTGRES_PASSWORD: vlm_dev
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  minio:
    image: minio/minio
    ports: ["9000:9000", "9001:9001"]
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: vlm_dev
      MINIO_ROOT_PASSWORD: vlm_dev_secret

volumes:
  pgdata:
```

Run the full stack:
```bash
docker-compose up -d          # Start Postgres, Redis, MinIO
pnpm install                  # Install all dependencies
pnpm turbo dev                # Start all apps in parallel
```

---

## 5. Phase 1: Shared Types & Platform Contract

**Package:** `packages/vlm-shared`

This is the foundation. Everything else imports from here. Build this first and get it right.

### 5.1 Platform Adapter Interface

This is the most important type in the entire system. It defines the contract that every metaverse platform adapter must implement.

```typescript
// packages/vlm-shared/src/platform.ts

export interface VLMPlatformAdapter {
  // --- Identity & Auth ---
  /** Get the current user's platform-specific identity */
  getPlatformUser(): Promise<PlatformUser>
  /** Get a signed authentication proof (e.g., wallet signature, platform token) */
  getAuthProof(): Promise<AuthProof>

  // --- Scene Metadata ---
  /** Get scene metadata from the platform (ID, location, realm, etc.) */
  getSceneInfo(): Promise<SceneInfo>
  /** Get platform environment details (preview mode, platform name, etc.) */
  getEnvironment(): Promise<PlatformEnvironment>

  // --- Entity Lifecycle ---
  createEntity(): EntityHandle
  destroyEntity(handle: EntityHandle): void
  entityExists(handle: EntityHandle): boolean

  // --- Transform ---
  setTransform(entity: EntityHandle, transform: TransformData): void

  // --- Rendering ---
  setPlaneRenderer(entity: EntityHandle): void
  setGltfModel(entity: EntityHandle, src: string): void
  setMaterial(entity: EntityHandle, material: MaterialData): void
  setVideoMaterial(entity: EntityHandle, video: VideoMaterialData): void

  // --- Video ---
  createVideoPlayer(entity: EntityHandle, options: VideoPlayerOptions): void
  updateVideoSource(entity: EntityHandle, src: string): void
  setVideoVolume(entity: EntityHandle, volume: number): void
  getVideoState(entity: EntityHandle): VideoState

  // --- Audio ---
  setAudioSource(entity: EntityHandle, options: AudioOptions): void
  playAudio(entity: EntityHandle): void
  stopAudio(entity: EntityHandle): void

  // --- Physics ---
  setCollider(entity: EntityHandle, options: ColliderOptions): void
  removeCollider(entity: EntityHandle): void

  // --- Input ---
  onPointerDown(entity: EntityHandle, options: PointerOptions, cb: PointerCallback): void
  removePointerEvents(entity: EntityHandle): void

  // --- Player Actions ---
  openUrl(url: string): void
  teleportPlayer(destination: string): void
  movePlayer(position: Vec3, cameraTarget?: Vec3): void
  triggerEmote(emoteId: string): void

  // --- Frame Loop ---
  registerSystem(update: (dt: number) => void): void
  unregisterSystem(update: (dt: number) => void): void

  // --- Capabilities ---
  readonly capabilities: PlatformCapabilities
}

export interface PlatformCapabilities {
  video: boolean
  spatialAudio: boolean
  gltfModels: boolean
  customEmotes: boolean
  playerTeleport: boolean
  externalUrls: boolean
  nftDisplay: boolean
  colliders: boolean
  spatialUI: boolean          // Can render in-world HUD panels (2D UI in 3D space)
  screenSpaceUI: boolean      // Can render screen-space HUD overlay
  maxEntities?: number
  platformName: string        // 'decentraland' | 'hyperfy' | 'threejs' | etc.
  platformVersion?: string
}

export type EntityHandle = number | string  // Platform-specific entity ID

export interface PlatformUser {
  id: string                  // Platform-specific user ID
  displayName?: string
  walletAddress?: string      // If blockchain-based platform
  isGuest: boolean
  avatarUrl?: string
}

export interface AuthProof {
  type: 'signed-fetch' | 'wallet-signature' | 'platform-token' | 'api-key'
  payload: Record<string, unknown>
}

export interface SceneInfo {
  sceneId: string             // VLM scene ID (from scene config)
  platformSceneId?: string    // Platform's own scene identifier
  location?: string           // Platform-specific location string
  metadata?: Record<string, unknown>
}
```

### 5.2 Scene Element Types

Port from v1 but clean up the naming. These are the types that flow between the API, dashboard, and SDK.

```typescript
// packages/vlm-shared/src/types/elements.ts

export interface SceneElement {
  id: string                  // UUID
  sceneId: string
  presetId: string
  type: ElementType
  name?: string
  enabled: boolean
  customId?: string
  customRendering: boolean
  clickEvent?: ClickEvent
  properties: Record<string, unknown>  // Type-specific props
  createdAt: string           // ISO 8601
  updatedAt: string
}

export interface SceneElementInstance {
  id: string                  // UUID
  elementId: string           // FK to SceneElement
  enabled: boolean
  customId?: string
  customRendering: boolean
  position: Vec3
  rotation: Vec3              // Euler angles
  scale: Vec3
  clickEvent?: ClickEvent     // Instance-level override
  parent?: string             // Parent element instance ID
  withCollisions: boolean
  properties: Record<string, unknown>
  createdAt: string
  updatedAt: string
}
```

### 5.3 All Enums

Port all v1 enums with consistent naming:

```typescript
// packages/vlm-shared/src/enums/index.ts

export enum ElementType {
  VIDEO = 'video',
  IMAGE = 'image',
  MODEL = 'model',
  SOUND = 'sound',
  NFT = 'nft',
  WIDGET = 'widget',
  CLAIM_POINT = 'claim_point',
}

export enum ClickEventType {
  NONE = 0,
  EXTERNAL = 1,
  SOUND = 2,
  STREAM = 3,
  MOVE = 4,
  TELEPORT = 5,
}

export enum WidgetControlType {
  NONE = 0,
  TOGGLE = 1,
  TEXT = 2,
  SELECTOR = 3,
  DATETIME = 4,
  TRIGGER = 5,
  SLIDER = 6,
}

export enum VideoSourceType {
  NONE = 0,
  IMAGE = 1,
  PLAYLIST = 2,
  LIVE = 3,
}

export enum SoundSourceType {
  CLIP = 0,
  LOOP = 1,
  PLAYLIST = 2,
  STREAM = 3,
}

export enum SceneSettingType {
  LOCALIZATION = 0,
  MODERATION = 1,
  INTEROPERABILITY = 2,
  ACCESS = 3,
}

export enum UserRole {
  BASIC = 0,
  EARLY_ACCESS = 1,
  ADVANCED = 2,
  SCENE_ADMIN = 3,
  ORG_ADMIN = 4,
  VLM_CONTRACTOR = 5,
  VLM_EMPLOYEE = 6,
  VLM_ADMIN = 7,
  GOD_MODE = 10,
}

export enum AnalyticsSessionRole {
  VISITOR = 0,
  SCENE_ADMIN = 1,
  ORG_ADMIN = 2,
  VLM_CONTRACTOR = 3,
  VLM_EMPLOYEE = 4,
  VLM_ADMIN = 5,
}

export enum AnalyticsSegmentType {
  LOADING = 'loading',
  IDLE = 'idle',
  STATIONARY_DISENGAGED = 'stationary_disengaged',
  STATIONARY_ENGAGED = 'stationary_engaged',
  RUNNING_DISENGAGED = 'running_disengaged',
  WALKING_DISENGAGED = 'walking_disengaged',
  RUNNING_ENGAGED = 'running_engaged',
  WALKING_ENGAGED = 'walking_engaged',
}

export enum ClaimPointType {
  MARKETPLACE_IMAGE = 0,
  CUSTOM_IMAGE = 1,
  MODEL = 2,
  MANNEQUIN = 3,
}

export enum MannequinType {
  MALE = 0,
  FEMALE = 1,
  MATCH_PLAYER = 2,
}
```

### 5.4 WebSocket Message Protocol

Define all message types as a typed protocol:

```typescript
// packages/vlm-shared/src/protocol.ts

/** Client → Server messages */
export type ClientMessage =
  | { type: 'session_start'; data: SessionStartData }
  | { type: 'session_action'; data: SessionActionData }
  | { type: 'session_end'; data: {} }
  | { type: 'scene_preset_update'; data: ScenePresetUpdateData }
  | { type: 'scene_setting_update'; data: SceneSettingUpdateData }
  | { type: 'scene_change_preset'; data: { presetId: string } }
  | { type: 'scene_add_preset'; data: { name: string } }
  | { type: 'scene_clone_preset'; data: { presetId: string; name: string } }
  | { type: 'scene_delete_preset'; data: { presetId: string } }
  | { type: 'scene_video_update'; data: VideoUpdateData }
  | { type: 'scene_sound_locator'; data: { enabled: boolean } }
  | { type: 'giveaway_claim'; data: GiveawayClaimData }
  | { type: 'user_message'; data: UserMessageData }
  | { type: 'get_user_state'; data: { key: string } }
  | { type: 'set_user_state'; data: { key: string; value: unknown } }
  | { type: 'send_player_position'; data: PlayerPositionData }
  | { type: 'path_start'; data: PathStartData }
  | { type: 'path_segments_add'; data: PathSegmentData }
  | { type: 'path_end'; data: {} }

/** Server → Client messages */
export type ServerMessage =
  | { type: 'session_started'; data: SessionStartedData }
  | { type: 'scene_preset_update'; data: ScenePresetUpdateData }
  | { type: 'scene_change_preset'; data: SceneChangePresetData }
  | { type: 'scene_video_status'; data: VideoStatusData }
  | { type: 'scene_sound_locator'; data: SoundLocatorData }
  | { type: 'scene_moderator_message'; data: ModeratorMessageData }
  | { type: 'scene_moderator_crash'; data: {} }
  | { type: 'giveaway_claim_response'; data: GiveawayClaimResponseData }
  | { type: 'user_message'; data: UserMessageData }
  | { type: 'get_user_state'; data: { key: string; value: unknown } }
  | { type: 'set_user_state'; data: { key: string; success: boolean } }
  | { type: 'send_active_users'; data: { activeUsers: ActiveUser[] } }
  | { type: 'request_player_position'; data: {} }
  | { type: 'host_joined'; data: HostData }
  | { type: 'host_left'; data: HostData }
  | { type: 'add_session_action'; data: SessionActionBroadcast }
  | { type: 'command_center_status'; data: CommandCenterStatusData }
  | { type: 'cross_world_update'; data: CrossWorldUpdateData }
  | { type: 'hud_state_update'; data: HUDStateUpdateData }

export interface ScenePresetUpdateData {
  action: 'init' | 'create' | 'update' | 'updateAll' | 'delete'
  element?: ElementType
  instance?: boolean          // true = operating on instance, false = config
  property?: string           // which property changed
  id?: string                 // element or instance ID
  scenePreset?: ScenePreset   // full preset data (for 'init' action)
  sceneSettings?: SceneSetting[]
  elementData?: SceneElement
  instanceData?: SceneElementInstance
}
```

### 5.5 Math Types

Shared vector/transform types that don't depend on any platform's math library:

```typescript
// packages/vlm-shared/src/types/math.ts

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface TransformData {
  position: Vec3
  rotation: Vec3    // Euler angles in degrees
  scale: Vec3
}

export interface ClickEvent {
  type: ClickEventType
  showFeedback: boolean
  hoverText?: string
  externalLink?: string
  sound?: string
  moveTo?: { position: Vec3; cameraTarget?: Vec3 }
  teleportTo?: string
}
```

---

## 6. Phase 2: Core SDK (Platform-Agnostic)

**Package:** `packages/vlm-core`

This package contains all scene management logic that is NOT platform-specific. It depends only on `vlm-shared` and `vlm-client`. It receives a `VLMPlatformAdapter` at initialization time and calls it for all platform operations.

### 6.1 VLM Class

The main entry point, similar to v1's `VLM` class in `vlm-dcl/src/app.ts`:

```typescript
// packages/vlm-core/src/VLM.ts

import { VLMPlatformAdapter, VLMStorage } from 'vlm-shared'
import { VLMClient } from 'vlm-client'

export class VLM {
  private adapter: VLMPlatformAdapter
  private client: VLMClient
  public storage: VLMStorage

  constructor(adapter: VLMPlatformAdapter) {
    this.adapter = adapter
    this.storage = createEmptyStorage()
  }

  async init(config: VLMInitConfig): Promise<VLMStorage> {
    // 1. Get platform user and scene info from adapter
    // 2. Authenticate with VLM API via vlm-client
    // 3. Join Colyseus room for this scene
    // 4. Register message handlers
    // 5. Receive initial scene state ('session_started' + 'scene_preset_update' with action 'init')
    // 6. Route initial elements to managers
    // 7. Return populated storage
  }

  // Public API (matches v1)
  sendMessage(id: string, data?: unknown): void { ... }
  onMessage(id: string, callback: (data: unknown) => void): void { ... }
  setState(id: string, value: unknown): void { ... }
  getState(id: string): unknown { ... }
  recordAction(id: string, metadata?: Record<string, unknown>): void { ... }
}
```

### 6.2 Element Managers

One manager per element type. Each manager:
- Maintains a registry of configs and instances
- Handles create/update/delete operations from WebSocket messages
- Calls the platform adapter for rendering operations
- Exposes entries in VLM.storage for developer access

```
packages/vlm-core/src/managers/
├── VideoManager.ts
├── ImageManager.ts
├── MeshManager.ts
├── SoundManager.ts
├── WidgetManager.ts
├── ClaimPointManager.ts
├── HUDManager.ts           # In-world management HUD (see Phase 4b)
├── CommandCenterManager.ts # Cross-world state aggregation
└── index.ts
```

Each manager follows the same pattern. Example:

```typescript
// packages/vlm-core/src/managers/VideoManager.ts

export class VideoManager {
  private adapter: VLMPlatformAdapter
  private configs: Map<string, VideoConfig>
  private instances: Map<string, VideoInstance>

  constructor(adapter: VLMPlatformAdapter) {
    if (!adapter.capabilities.video) return  // Skip if platform doesn't support video
    this.adapter = adapter
  }

  init(configs: VideoConfigData[]): void {
    // Initialize all video elements from scene preset data
    for (const config of configs) {
      this.create(config)
      for (const instance of config.instances) {
        this.createInstance(config, instance)
      }
    }
  }

  create(data: VideoConfigData): VideoConfig { ... }
  createInstance(config: VideoConfig, data: VideoInstanceData): VideoInstance { ... }
  update(id: string, property: string, value: unknown): void { ... }
  updateInstance(id: string, property: string, value: unknown): void { ... }
  delete(id: string): void { ... }
  deleteInstance(id: string): void { ... }
}
```

### 6.3 Scene Manager (Message Router)

Routes incoming WebSocket messages to the appropriate element manager. This is the equivalent of v1's `VLMSceneManager` and `VLMSystemListeners`:

```typescript
// packages/vlm-core/src/SceneManager.ts

export class SceneManager {
  private managers: Record<ElementType, ElementManager>

  handlePresetUpdate(message: ScenePresetUpdateData): void {
    switch (message.action) {
      case 'init':
        this.initScenePreset(message.scenePreset)
        break
      case 'create':
        this.managers[message.element].create(message.elementData)
        break
      case 'update':
        if (message.instance) {
          this.managers[message.element].updateInstance(message.id, message.property, ...)
        } else {
          this.managers[message.element].update(message.id, message.property, ...)
        }
        break
      case 'delete':
        if (message.instance) {
          this.managers[message.element].deleteInstance(message.id)
        } else {
          this.managers[message.element].delete(message.id)
        }
        break
    }
  }
}
```

### 6.4 VLM.storage

The developer-facing read API. Mirrors v1 structure:

```typescript
export interface VLMStorage {
  videos: { configs: Record<string, VideoConfig>; instances: Record<string, VideoInstance> }
  images: { configs: Record<string, ImageConfig>; instances: Record<string, ImageInstance> }
  models: { configs: Record<string, MeshConfig>; instances: Record<string, MeshInstance> }
  sounds: { configs: Record<string, SoundConfig>; instances: Record<string, SoundInstance> }
  widgets: { configs: Record<string, WidgetConfig> }
  claimPoints: { configs: Record<string, ClaimPointConfig>; instances: Record<string, ClaimPointInstance> }
}
```

Configs and instances should expose the same methods as v1 (see the SPEC.md files and Appendix B) so that existing Decentraland scene code continues to work.

---

## 7. Phase 3: Backend API

**App:** `apps/api`

### 7.1 Tech Stack

| Component | V1 | V2 | Why |
|-----------|----|----|-----|
| HTTP Framework | Express | **Fastify** | 2-3x faster, built-in schema validation, better TypeScript support |
| WebSocket | Colyseus | **Colyseus** (keep) | Excellent room-based multiplayer, battle-tested in v1 |
| Database | DynamoDB (8 tables) | **PostgreSQL + Drizzle ORM** | Data is relational; joins, transactions, and indexes are needed |
| Cache | Redis + DAX | **Redis** (keep, drop DAX) | Postgres eliminates the need for DAX; Redis for presence + caching |
| Storage | S3 | **S3 + CloudFront CDN** | Add CDN for media delivery |
| Auth | JWT + Web3 only | **JWT + Web3 + OAuth + API keys** | Broader audience |
| API Style | REST (hand-written) | **tRPC** (or OpenAPI with typed client gen) | End-to-end type safety with vlm-shared types |

### 7.2 Database Schema (PostgreSQL + Drizzle)

```sql
-- Auth & Identity
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT,
  email TEXT UNIQUE,
  avatar_url TEXT,
  role INTEGER NOT NULL DEFAULT 0,  -- UserRole enum
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE user_auth_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,  -- 'wallet' | 'email' | 'google' | 'discord' | 'apple'
  identifier TEXT NOT NULL,  -- wallet address, email, OAuth ID
  credential_hash TEXT,  -- bcrypt hash for email/password
  metadata JSONB,
  UNIQUE(type, identifier)
);

CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,  -- hashed API key
  prefix TEXT NOT NULL,  -- first 8 chars for identification
  scopes TEXT[] DEFAULT '{}',
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Organizations
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE org_memberships (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  role INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, org_id)
);

-- Scenes
CREATE TABLE scenes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id),
  org_id UUID REFERENCES organizations(id),
  name TEXT NOT NULL,
  description TEXT,
  thumbnail_url TEXT,
  active_preset_id UUID,  -- FK added after presets table
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE scene_collaborators (
  scene_id UUID REFERENCES scenes(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scene_id, user_id)
);

CREATE TABLE scene_presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id UUID REFERENCES scenes(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Signature Arrangement',
  locale TEXT DEFAULT 'en-US',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE scenes ADD FOREIGN KEY (active_preset_id) REFERENCES scene_presets(id);

CREATE TABLE scene_elements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  preset_id UUID REFERENCES scene_presets(id) ON DELETE CASCADE,
  type TEXT NOT NULL,  -- ElementType enum value
  name TEXT,
  enabled BOOLEAN DEFAULT true,
  custom_id TEXT,
  custom_rendering BOOLEAN DEFAULT false,
  click_event JSONB,  -- ClickEvent object
  properties JSONB NOT NULL DEFAULT '{}',  -- Type-specific properties
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE scene_element_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  element_id UUID REFERENCES scene_elements(id) ON DELETE CASCADE,
  enabled BOOLEAN DEFAULT true,
  custom_id TEXT,
  custom_rendering BOOLEAN DEFAULT false,
  position JSONB NOT NULL DEFAULT '{"x":0,"y":0,"z":0}',
  rotation JSONB NOT NULL DEFAULT '{"x":0,"y":0,"z":0}',
  scale JSONB NOT NULL DEFAULT '{"x":1,"y":1,"z":1}',
  click_event JSONB,  -- Instance-level override
  parent_instance_id UUID REFERENCES scene_element_instances(id),
  with_collisions BOOLEAN DEFAULT false,
  properties JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE scene_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id UUID REFERENCES scenes(id) ON DELETE CASCADE,
  type INTEGER NOT NULL,  -- SceneSettingType enum
  value JSONB NOT NULL DEFAULT '{}',
  UNIQUE(scene_id, type)
);

CREATE TABLE scene_state (
  scene_id UUID REFERENCES scenes(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value JSONB,
  PRIMARY KEY (scene_id, user_id, key)
);

-- Events
CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id),
  org_id UUID REFERENCES organizations(id),
  name TEXT NOT NULL,
  description TEXT,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  timezone TEXT DEFAULT 'UTC',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE event_scene_links (
  event_id UUID REFERENCES events(id) ON DELETE CASCADE,
  scene_id UUID REFERENCES scenes(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, scene_id)
);

CREATE TABLE event_giveaway_links (
  event_id UUID REFERENCES events(id) ON DELETE CASCADE,
  giveaway_id UUID REFERENCES giveaways(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, giveaway_id)
);

-- Giveaways
CREATE TABLE giveaways (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id),
  name TEXT NOT NULL,
  enabled BOOLEAN DEFAULT true,
  claim_limit_per_user INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE giveaway_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  giveaway_id UUID REFERENCES giveaways(id) ON DELETE CASCADE,
  contract_address TEXT,
  token_id TEXT,
  name TEXT,
  image_url TEXT,
  metadata JSONB
);

CREATE TABLE giveaway_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  giveaway_id UUID REFERENCES giveaways(id),
  user_id UUID REFERENCES users(id),
  item_id UUID REFERENCES giveaway_items(id),
  status TEXT NOT NULL DEFAULT 'pending',
  claimed_at TIMESTAMPTZ DEFAULT now()
);

-- Credits & Billing
CREATE TABLE credit_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  org_id UUID REFERENCES organizations(id),
  balance INTEGER NOT NULL DEFAULT 0,
  CHECK (user_id IS NOT NULL OR org_id IS NOT NULL)
);

CREATE TABLE credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  balance_id UUID REFERENCES credit_balances(id),
  amount INTEGER NOT NULL,  -- positive = credit, negative = debit
  type TEXT NOT NULL,  -- 'purchase', 'promo', 'allocation', 'deallocation', 'transfer'
  description TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  org_id UUID REFERENCES organizations(id),
  stripe_subscription_id TEXT UNIQUE,
  stripe_customer_id TEXT,
  tier TEXT NOT NULL DEFAULT 'free',  -- 'free', 'creator', 'pro', 'studio'
  status TEXT NOT NULL DEFAULT 'active',
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Media & Streaming
CREATE TABLE media_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id),
  org_id UUID REFERENCES organizations(id),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  s3_key TEXT NOT NULL,
  cdn_url TEXT,
  folder TEXT DEFAULT '/',
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 3D Asset Library
CREATE TABLE asset_library_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,  -- 'building', 'furniture', 'decoration', 'nature', 'structure', 'lighting', etc.
  tags TEXT[] DEFAULT '{}',
  s3_key TEXT NOT NULL,
  cdn_url TEXT,
  thumbnail_url TEXT,
  file_size_bytes BIGINT NOT NULL,
  triangle_count INTEGER NOT NULL,
  texture_count INTEGER NOT NULL,
  material_count INTEGER NOT NULL,
  dimensions JSONB,  -- { width, height, depth } in meters
  license TEXT DEFAULT 'vlm-standard',  -- license type for the asset
  author TEXT,
  is_public BOOLEAN DEFAULT true,  -- available to all users vs. uploaded by a specific user
  uploaded_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_asset_library_category ON asset_library_items(category);
CREATE INDEX idx_asset_library_tags ON asset_library_items USING GIN(tags);

-- Scene Deployments
CREATE TABLE scene_deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id UUID REFERENCES scenes(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,  -- 'decentraland', 'hyperfy'
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'building', 'deploying', 'deployed', 'failed'
  deployment_type TEXT NOT NULL,  -- 'parcel', 'world' (DCL), 'instance' (Hyperfy)
  target JSONB NOT NULL,  -- DCL: { parcels: ["0,0"], contentServer: "..." } / Hyperfy: { instanceUrl: "...", region: "..." }
  asset_bundle JSONB,  -- { totalSizeBytes, triangleCount, assetIds: [...] } — budget tracking
  deployed_by UUID REFERENCES users(id),
  error_message TEXT,
  catalyst_entity_id TEXT,  -- Decentraland: entity ID on the Catalyst network
  infrastructure_id TEXT,  -- Hyperfy: Docker container ID, Fly machine ID, etc.
  deployed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_scene_deployments_scene ON scene_deployments(scene_id);

-- Wallet keys stored for automated Decentraland deployments (encrypted at rest)
CREATE TABLE deployment_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(id),
  platform TEXT NOT NULL DEFAULT 'decentraland',
  wallet_address TEXT NOT NULL,
  encrypted_private_key TEXT,  -- AES-256-GCM encrypted; NULL if user signs client-side
  label TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, wallet_address)
);

-- Platform Integration Hooks (for platforms without WebSocket, e.g., Second Life)
CREATE TABLE platform_callbacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  element_id TEXT,               -- null for controller/scene-level callbacks
  element_type TEXT,             -- 'video', 'image', 'controller', etc.
  platform TEXT NOT NULL,        -- 'secondlife', etc.
  callback_url TEXT NOT NULL,
  region TEXT,                   -- platform-specific location (e.g., SL region name)
  metadata JSONB,               -- platform-specific metadata (position, etc.)
  failure_count INTEGER DEFAULT 0,
  last_registered TIMESTAMPTZ DEFAULT now(),
  UNIQUE(scene_id, element_id, element_type, platform)
);

CREATE INDEX idx_platform_callbacks_scene ON platform_callbacks(scene_id);

-- Cleanup: DELETE FROM platform_callbacks WHERE last_registered < now() - interval '5 minutes';

CREATE TABLE streaming_servers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id),
  org_id UUID REFERENCES organizations(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'shared',  -- 'shared' | 'dedicated'
  status TEXT NOT NULL DEFAULT 'provisioning',
  rtmp_url TEXT,
  stream_key TEXT,
  hls_playlist_url TEXT,
  region TEXT DEFAULT 'us-east-1',
  infrastructure_id TEXT,  -- ECS task ARN, Fly machine ID, etc.
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE streaming_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID REFERENCES streaming_servers(id),
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  peak_bitrate INTEGER,
  peak_viewers INTEGER,
  recorded BOOLEAN DEFAULT false,
  vod_s3_key TEXT
);

-- Analytics
CREATE TABLE analytics_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id UUID REFERENCES scenes(id),
  user_id UUID,
  wallet_address TEXT,
  display_name TEXT,
  role INTEGER DEFAULT 0,
  platform TEXT,  -- 'decentraland', 'hyperfy', etc.
  device JSONB,
  location JSONB,
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ
);

CREATE INDEX idx_analytics_sessions_scene ON analytics_sessions(scene_id);
CREATE INDEX idx_analytics_sessions_time ON analytics_sessions(started_at);

CREATE TABLE analytics_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES analytics_sessions(id) ON DELETE CASCADE,
  scene_id UUID REFERENCES scenes(id),
  name TEXT NOT NULL,
  metadata JSONB,
  path_point JSONB,  -- [x, y, z, timestamp, rx, ry, pov, cx, cy, crx, cry]
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_analytics_actions_scene ON analytics_actions(scene_id);

CREATE TABLE analytics_paths (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES analytics_sessions(id) ON DELETE CASCADE,
  scene_id UUID,
  segments JSONB NOT NULL DEFAULT '[]',
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ
);
```

### 7.3 Colyseus Room

Keep the same `vlm_scene` room pattern. The room is the hub of real-time communication. See Appendix A for the complete message protocol that must be implemented.

Key changes from v1:
- Use typed message handlers based on `vlm-shared` protocol types
- Replace DynamoDB calls with Drizzle/PostgreSQL queries
- Add `platform` field to session tracking (analytics per platform)

### 7.4 Authentication

Support multiple auth methods, all producing the same JWT:

```typescript
// Auth flows, all return { accessToken, refreshToken }

// 1. Web3 wallet signature (v1 flow, keep it)
POST /auth/web3          // Get challenge nonce
POST /auth/web3/verify   // Submit signed nonce

// 2. Platform-specific signed fetch (Decentraland, etc.)
POST /auth/platform      // Submit platform auth proof

// 3. Email/password
POST /auth/register      // Create account with email
POST /auth/login         // Login with email/password

// 4. OAuth
GET  /auth/oauth/:provider  // Redirect to OAuth provider
GET  /auth/oauth/:provider/callback

// 5. API key (for server-to-server)
// Sent as Authorization: Bearer vlm_key_xxxxx header

// Token refresh (same as v1)
POST /auth/refresh
```

### 7.5 API Routes

Organize by domain. Preserve v1 functionality, add new media/streaming/billing routes:

```
/auth/*              Authentication (see above)
/users/*             User profile, notifications
/organizations/*     Org CRUD, memberships
/scenes/*            Scene CRUD, collaboration, presets
/events/*            Event CRUD, scene/giveaway linking
/giveaways/*         Giveaway CRUD, items, claims
/analytics/*         Session data, aggregates, CSV export
/media/*             Upload, list, delete media assets (NEW)
/assets/*            Browse, search, upload 3D asset library items (NEW)
/deploy/*            Build, deploy, and manage scene deployments (NEW)
/command-center/*    Cross-world status, event orchestration, broadcast actions (NEW)
/streaming/*         Provision, manage, monitor streams (NEW)
/billing/*           Subscription management, usage, invoices (NEW)
/hook/*              Platform integration hooks — HTTP push for non-WebSocket platforms (NEW)
/admin/*             Admin panel endpoints
/health              Health check
```

See Appendix D for the complete v1 route reference. All v1 routes should have v2 equivalents.

---

## 8. Phase 4: Web Dashboard & In-World Management

### 8.0 Design Philosophy: Build on the Web, Manage in the World

The V2 web dashboard is NOT a daily-use management tool. It is a **build-and-deploy workbench** that users visit at the beginning of a project and rarely return to. All day-to-day scene management — video switching, preset changes, element repositioning, event control, analytics — happens from **inside the virtual world** via the in-world HUD.

**What you do on the web dashboard (once):**
- Create an account, set up your organization
- Upload media (images, videos) and 3D assets (GLBs) to your library — or browse the open-source asset catalog
- Arrange a base scene layout (drag-and-drop assets onto a 2D map or 3D preview)
- Configure billing, streaming servers, and custom domains
- Deploy to a platform (Decentraland parcel/world, Hyperfy instance)

**What you do in-world (every day):**
- Open the VLM HUD (hotkey, click, or chat command)
- Browse your media library and asset catalog from inside the world
- Place, move, rotate, scale any element with 3D gizmos
- Switch video screens between live stream, playlist, and static image
- Toggle presets, manage events, run giveaways
- Monitor analytics (who's here, visitor count, engagement)
- Manage multiple worlds simultaneously via the mini command center
- Invite collaborators

**Why this matters:** Metaverse creators should not alt-tab to a browser to manage their world. The world IS the product. If they're running a live event across three platforms, they need to control everything from wherever they are — including from inside one of those worlds. The web dashboard exists because you need a file picker to upload assets, and you need Stripe Checkout for billing. Those are browser-native capabilities. Everything else happens in-world.

**What about users without a VR headset or Decentraland client?** The web dashboard retains all management capabilities as a fallback. It's not deprecated — it's just no longer the primary interface. Users who prefer a traditional web UI can still use it for everything. The in-world HUD is the *preferred* path, not the *only* path.

**App:** `apps/web`

### 8.1 Tech Stack

| Component | V1 | V2 | Why |
|-----------|----|----|-----|
| Framework | Vue 2 (EOL) | **Next.js 14+ (App Router)** | SSR for landing pages, React ecosystem, active support |
| UI Library | Vuetify 2 | **Tailwind CSS + shadcn/ui** | Smaller bundles, more customizable, better DX |
| State | Vuex 3 (18 modules) | **Zustand** or **Jotai** + React Query | Simpler than Vuex, co-locates state with components |
| API Client | Hand-written fetch classes | **tRPC client** (matches API) | Type-safe, auto-generated from server |
| WebSocket | Colyseus.js | **Colyseus.js** (keep) | Same room protocol |
| Charts | ApexCharts + Chart.js + D3 + Carbon | **Recharts** (one library) | Consolidate; Recharts covers all chart types needed |
| Video | Video.js + HLS.js | **Video.js + HLS.js** (keep) | Battle-tested for HLS playback |
| Web3 | web3.js + ethers | **wagmi + viem** | Modern, lighter, better React hooks |
| i18n | Custom JSON + generate script | **next-intl** | Built for Next.js, type-safe |

### 8.2 Page Structure

```
app/
├── (marketing)/              # Public pages (SSR)
│   ├── page.tsx              # Landing page
│   ├── pricing/page.tsx      # Pricing tiers
│   └── status/page.tsx       # System status
│
├── (auth)/                   # Auth pages
│   ├── login/page.tsx        # Wallet + email + OAuth login
│   ├── register/page.tsx     # Registration
│   └── layout.tsx            # Auth layout (centered card)
│
├── (dashboard)/              # Authenticated pages
│   ├── layout.tsx            # Dashboard layout (sidebar + header)
│   ├── command-center/       # Multi-world command center (NEW)
│   │   ├── page.tsx          # All active worlds at a glance
│   │   └── [eventId]/page.tsx  # Event-scoped command center
│   ├── scenes/
│   │   ├── page.tsx          # Scene list (cards grid)
│   │   └── [sceneId]/
│   │       ├── page.tsx      # Scene editor (redirects to first tab)
│   │       ├── analytics/page.tsx
│   │       ├── videos/page.tsx
│   │       ├── images/page.tsx
│   │       ├── models/page.tsx
│   │       ├── sounds/page.tsx
│   │       ├── giveaways/page.tsx
│   │       ├── widgets/page.tsx
│   │       ├── moderation/page.tsx
│   │       ├── presets/page.tsx
│   │       └── settings/page.tsx
│   ├── events/
│   │   ├── page.tsx          # Event list
│   │   └── [eventId]/page.tsx
│   ├── giveaways/
│   │   ├── page.tsx          # Giveaway list
│   │   └── [giveawayId]/page.tsx
│   ├── media/page.tsx        # Media library (NEW)
│   ├── assets/               # 3D asset library (NEW)
│   │   ├── page.tsx          # Browse/search asset catalog
│   │   └── upload/page.tsx   # Upload custom GLB assets
│   ├── deploy/               # Scene deployment (NEW)
│   │   ├── page.tsx          # Deployment history + new deployment
│   │   └── [deployId]/page.tsx  # Deployment status/details
│   ├── streaming/            # (NEW)
│   │   ├── page.tsx          # Stream list + provisioning
│   │   └── [streamId]/page.tsx  # Stream dashboard (status, key, VODs)
│   ├── billing/page.tsx      # Subscription + usage (NEW)
│   ├── profile/page.tsx
│   ├── organization/page.tsx
│   └── admin/page.tsx        # VLM admin only
│
├── (companion)/              # Minimal pages for in-world companion flows
│   └── u/[code]/page.tsx    # Quick upload page (QR code / short link target)
│
└── api/                      # Next.js API routes (OAuth callbacks, webhooks)
```

### 8.3 Key Features to Implement

All v1 features must be preserved. See the SPEC.md files in vlm-ui and vlm-api for complete feature lists. New features:

**Media Library (`/media`)**
- Drag-and-drop image and video upload
- Folder organization
- Preview with thumbnails
- Usage quota display (based on subscription tier)
- Select media from library when configuring scene elements (instead of entering URLs)

**3D Asset Library (`/assets`)**
- Browse a curated catalog of pre-built GLB models organized by category (buildings, furniture, decorations, nature, structures, lighting, etc.)
- Search and filter by name, category, tags, triangle count, and file size
- 3D preview of each asset with orbit controls
- Per-asset metadata display: triangle count, texture count, material count, file size, physical dimensions
- Upload custom GLB assets to a personal library
- When adding assets to a scene, display a **live budget meter** showing cumulative file size, triangle count, texture count, and material count against the target platform's limits (see Platform Constraints below)
- Assets selected for a scene are tracked in `scene_deployments.asset_bundle` for deployment bundling

**Scene Deployment (`/deploy`)**
- One-click deployment of scenes to Decentraland (parcels or Worlds) and Hyperfy directly from the dashboard
- Platform-specific deployment configuration:
  - **Decentraland parcels:** select target parcel coordinates, verify wallet ownership/operator rights
  - **Decentraland Worlds:** select target World name (DCL NAME or ENS domain)
  - **Hyperfy:** provision a new world instance (select region, configure environment variables)
- Two wallet signing modes for Decentraland:
  - **Client-side signing:** user connects browser wallet and signs the deployment payload (more secure, no key storage)
  - **Server-side signing:** user stores an encrypted deployment wallet key for fully automated deployments (stored AES-256-GCM encrypted in `deployment_wallets` table)
- Deployment pipeline status tracking: pending → building → deploying → deployed (or failed)
- Deployment history with rollback capability (redeploy a previous bundle)
- Pre-deploy validation: check asset bundle against platform limits before attempting deployment

**Command Center (`/command-center`)** (NEW)

The command center is the heart of the "one person manages everything" workflow. It provides a unified view of all active worlds and events, designed for live event operation.

- **Multi-world overview:** Grid/list of all connected worlds (across all platforms) showing:
  - Platform icon (Decentraland, Hyperfy, etc.)
  - World name and deployment status
  - Live visitor count (updated in real-time via Colyseus)
  - Stream status (live/offline, bitrate, viewer count per world)
  - Event state (active event name, time remaining, giveaway status)
  - Quick-action buttons: toggle giveaway, swap video stream, switch preset
- **Event-scoped view (`/command-center/[eventId]`):** Filters to only worlds linked to a specific event. Shows:
  - Aggregate visitor count across all worlds
  - Per-world breakdown
  - Synchronized actions: push a preset change, video swap, or giveaway toggle to ALL linked worlds simultaneously with one click
  - Event timeline: what's scheduled, what's live, what's completed
- **Cross-world broadcast:** Send a scene update (swap video, enable giveaway, change preset, show/hide elements) to multiple worlds at once. The API fans out the Colyseus message to all rooms linked to the event.
- **Alert feed:** Real-time notifications from all worlds — new visitors, giveaway claims, stream drops, moderation flags — in one scrollable feed.

**Streaming Dashboard (`/streaming`)**
- Provision new streaming server (select type: shared or dedicated)
- Display RTMP ingest URL + stream key
- Live status indicator (online/offline, bitrate, viewers)
- Start/stop recording
- List recorded VODs with playback
- Copy HLS playlist URL for use in scene video elements

**Billing (`/billing`)**
- Current subscription tier and status
- Usage breakdown (storage used, stream minutes, deployments, etc.)
- Upgrade/downgrade tier (Stripe Checkout or embedded pricing table)
- Invoice history (Stripe Customer Portal)

### 8.4 Real-Time Scene Editing

The dashboard joins the same Colyseus `vlm_scene` room as the in-world SDK. Preserve this architecture exactly — it's what makes VLM special. When a creator drags a video screen to a new position in the dashboard, the message flows through Colyseus and the SDK moves the screen in the live world immediately.

The dashboard connects as a "host" client type. The SDK connects as an "analytics" client type. Both receive the same scene update broadcasts.

### 8.5 In-World Management HUD

**Package:** `packages/vlm-hud`

The in-world HUD is a spatial/screen-space UI that lets the Virtual Land Manager perform most dashboard operations from inside any connected world. It is the primary management interface during live events — the operator should not need to alt-tab to a browser.

The HUD is platform-agnostic at the logic layer (part of `vlm-core`/`vlm-hud`) with platform-specific rendering via the adapter's UI capabilities.

#### HUD Architecture

```
┌─────────────────────────────────────────────────┐
│                   vlm-hud                        │
│           (platform-agnostic logic)              │
│                                                  │
│  ┌──────────┐ ┌───────────┐ ┌────────────────┐ │
│  │ HUD State│ │ Panel     │ │ Command Center │ │
│  │ Manager  │ │ Registry  │ │ Bridge         │ │
│  └──────────┘ └───────────┘ └────────────────┘ │
│       │              │               │           │
│       ▼              ▼               ▼           │
│  ┌─────────────────────────────────────────┐    │
│  │         HUD Renderer Interface          │    │
│  │  renderPanel() / showNotification() /   │    │
│  │  renderBudgetMeter() / renderGrid()     │    │
│  └─────────────────────────────────────────┘    │
└──────────────────────┬──────────────────────────┘
                       │ Implemented per platform
          ┌────────────┼─────────────┐
          ▼            ▼             ▼
   DCL UI Toolkit   Hyperfy UI   Three.js HTML
   (screen-space)   (app panels)  (CSS2D/CSS3D)
```

#### HUD Panels

The HUD is organized as a set of toggleable panels that the VLM operator opens via a persistent toolbar (small floating button or hotkey):

**1. Asset Browser Panel**
- Browse the 3D asset library by category/search (fetched from VLM API)
- Thumbnail grid of available GLB models with metadata (triangle count, file size)
- Tap an asset to place it in the scene at the operator's current position
- For Decentraland: adding a new asset that isn't in the deployed bundle triggers a "Publish Changes" prompt (redeploy required)
- For Hyperfy: asset is uploaded and placed immediately (no redeploy needed)
- Live budget meter showing current usage vs. platform limits
- Paid tier assets are visually marked — tapping one prompts an in-world upgrade flow

**2. Scene Layout Panel**
- List of all elements/instances in the current scene
- Select any element to show transform gizmo (move/rotate/scale)
- Toggle element visibility (show/hide)
- Duplicate or delete elements
- Changes sync instantly via Colyseus — same as editing from the dashboard

**3. Event Control Panel**
- Shows current event status (if an event is active)
- Per-world visitor counts for all worlds linked to the event
- Quick actions:
  - Toggle giveaway on/off across all worlds
  - Swap video stream URL across all worlds
  - Switch scene preset across all worlds
  - Send a moderation action (ban/mute/teleport)
- These "across all worlds" actions use the cross-world broadcast system (see Command Center)

**4. Stream Control Panel**
- Current stream status (live/offline, bitrate, viewer count)
- Quick-switch between video sources (live stream, VOD, image fallback)
- If no active stream subscription: contextual upsell ("Go live? Start a stream rental")

**5. World Status Panel (Mini Command Center)**
- Compact view of all connected worlds in the current event
- Per-world: platform, visitor count, stream status, deployment status
- Tap a world to send a quick action to just that world
- Aggregate stats across all worlds

**6. Notification Feed**
- Real-time toast notifications: visitor enters/leaves, giveaway claimed, stream goes live/offline, deployment completes
- Filterable by world and event

#### HUD Rendering Interface

Each platform adapter implements `HUDRenderer` alongside `VLMPlatformAdapter`:

```typescript
// packages/vlm-shared/src/types/hud.ts

export interface HUDRenderer {
  /** Show/hide a named panel */
  showPanel(panel: HUDPanelType, state: HUDPanelState): void
  hidePanel(panel: HUDPanelType): void

  /** Render a grid of asset thumbnails (for asset browser) */
  renderAssetGrid(assets: AssetThumbnail[]): void

  /** Show a transform gizmo on an entity */
  showTransformGizmo(entity: EntityHandle, mode: 'move' | 'rotate' | 'scale'): void
  hideTransformGizmo(): void

  /** Show a notification toast */
  showNotification(notification: HUDNotification): void

  /** Render the budget meter (file size, triangles, etc.) */
  renderBudgetMeter(usage: BudgetUsage, limits: BudgetLimits): void

  /** Show an upgrade/purchase prompt */
  showUpgradePrompt(feature: string, tier: string): void

  /** Render the mini command center (world status grid) */
  renderWorldStatusGrid(worlds: WorldStatus[]): void

  /** Platform-specific: can this platform render this panel type? */
  supportsPanel(panel: HUDPanelType): boolean
}

export enum HUDPanelType {
  ASSET_BROWSER = 'asset_browser',
  SCENE_LAYOUT = 'scene_layout',
  EVENT_CONTROL = 'event_control',
  STREAM_CONTROL = 'stream_control',
  WORLD_STATUS = 'world_status',
  NOTIFICATIONS = 'notifications',
  UPGRADE = 'upgrade',
}

export interface WorldStatus {
  sceneId: string
  sceneName: string
  platform: string
  visitorCount: number
  streamStatus: 'live' | 'offline' | 'error'
  deploymentStatus: 'deployed' | 'deploying' | 'failed'
  eventId?: string
}
```

#### In-World Asset Upload (Companion Flow)

No metaverse platform provides a native file picker from inside the world. To support "never leave the world" asset management, the HUD uses a **companion upload flow**:

1. Operator opens the Asset Browser panel in the HUD
2. Taps "Upload New" button
3. The HUD generates a short-lived upload URL and displays it as:
   - A **QR code** (scan with phone)
   - A **short link** (e.g., `vlm.gg/u/abc123`) that can be typed into any browser
   - Copied to clipboard (on platforms that support it)
4. On their phone or any browser, the user opens the link → lands on a minimal upload page
5. They select files (GLBs, images, videos) and upload
6. Files are immediately processed (thumbnails generated, triangle counts computed) and added to their media library
7. The in-world HUD's Asset Browser **auto-refreshes** (the upload page sends a Colyseus message to the operator's room notifying of new assets)
8. The newly uploaded assets appear in the browser within seconds
9. The operator places them in the scene without ever leaving the world

For Hyperfy specifically, since assets can be uploaded to running instances without redeploy, the placement is instant. For Decentraland, newly added GLBs require a redeploy — the HUD shows a "Publish Changes" button that triggers the deployment pipeline.

#### HUD Access Control

The HUD is only visible to authenticated VLM operators (scene admins, org admins). Regular scene visitors never see it. The SDK checks the user's role on session start and initializes the HUD only for authorized users.

```typescript
// In vlm-core init flow:
const user = await adapter.getPlatformUser()
const session = await client.startSession(user, sceneInfo)

if (session.role >= UserRole.SCENE_ADMIN && adapter.capabilities.screenSpaceUI) {
  this.hud = new HUDManager(adapter.getHUDRenderer(), client)
  this.hud.init()
}
```

#### In-World Billing UX

The HUD is the primary monetization surface. Paid features are discovered in context:

- **Asset library:** Premium assets are visible but marked with a tier badge. Tapping one shows an upgrade prompt: "This asset is available on the Creator plan. Upgrade to unlock." The prompt links to a Stripe Checkout session (opened in an external browser or in-platform browser where supported).
- **Deployment:** Free tier users can configure scenes but see "Upgrade to deploy" when they try to publish. This keeps the full editing experience accessible for exploration.
- **Streaming:** The stream control panel shows rental options when no active subscription covers streaming.
- **Event management:** Cross-world broadcast (the killer feature for brands) is gated to Pro/Studio tiers. Free/Creator users can manage one world at a time.

### 8.6 Multi-World Event Orchestration

This is the architectural backbone for the "one person manages a simultaneous cross-platform activation" use case.

#### How It Works

Events in VLM already link to multiple scenes (`event_scene_links`). V2 extends this so that each scene can be deployed to a different platform, and the event becomes the orchestration unit:

```
Event: "Brand X Summer Launch"
├── Scene: "Main Stage" → deployed to Decentraland World
├── Scene: "Showcase Hall" → deployed to Hyperfy world
├── Scene: "VIP Lounge" → deployed to second Hyperfy world
└── Linked Giveaway: "Summer NFT Drop" → active in all three
```

The Virtual Land Manager sees all three worlds in the Command Center. They can:
- Push a video stream URL to all three worlds at once (or selectively)
- Toggle the giveaway across all worlds simultaneously
- Switch all worlds to a "starting soon" preset, then flip to the "live" preset when the event begins
- See aggregate analytics: "247 total visitors — 89 in DCL, 102 in Hyperfy Main, 56 in Hyperfy VIP"

#### Cross-World Broadcast Protocol

When the operator triggers a cross-world action (from the dashboard Command Center or from the in-world HUD's Event Control Panel):

1. Client sends a `cross_world_update` message to the API:
   ```typescript
   {
     type: 'cross_world_update',
     data: {
       eventId: 'uuid',
       targetScenes: 'all' | string[],  // all event scenes, or specific ones
       action: ScenePresetUpdateData,    // the same update payload used for single-scene edits
     }
   }
   ```
2. The API looks up all `event_scene_links` for the event.
3. For each linked scene, the API sends the `scene_preset_update` message to that scene's Colyseus room.
4. Each connected SDK receives the update and applies it — same as a regular dashboard edit.
5. The API also pushes to HTTP callbacks for non-WebSocket platforms (Second Life, etc.).

This reuses the existing message protocol entirely — cross-world broadcast is just "send the same message to N rooms instead of 1."

#### Command Center WebSocket Room

The Command Center uses a separate Colyseus room (`vlm_command_center`) filtered by `eventId` (or `userId` for a global view). This room aggregates status from all connected scene rooms:

```typescript
// Colyseus room: vlm_command_center
// Joined by: dashboard Command Center page, in-world HUD world status panel

// Server broadcasts to this room every few seconds:
{
  type: 'command_center_status',
  data: {
    eventId: 'uuid',
    worlds: [
      {
        sceneId: 'uuid',
        sceneName: 'Main Stage',
        platform: 'decentraland',
        visitorCount: 89,
        streamStatus: 'live',
        deploymentStatus: 'deployed',
        activePreset: 'Live Show',
        giveawayActive: true,
      },
      // ... more worlds
    ],
    aggregate: {
      totalVisitors: 247,
      totalGiveawayClaims: 42,
      activeStreams: 2,
    }
  }
}
```

---

## 9. Phase 5: Media Server & Streaming

**App:** `apps/media-server`

This is the new paid feature. A separate service that handles RTMP ingest and HLS transcoding.

### 9.1 Architecture

```
RTMP stream from OBS/Streamlabs/etc.
        │
        ▼
┌─────────────────────┐
│   RTMP Ingest       │  ← Node-Media-Server or nginx-rtmp module
│   (port 1935)       │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│   FFmpeg Transcode   │  ← Spawned as child process per stream
│                      │
│   Input: RTMP        │
│   Output: HLS        │
│   - 360p  (800kbps)  │
│   - 720p  (2.5Mbps)  │
│   - 1080p (5Mbps)    │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│   S3 Segment Upload  │  ← .ts segments + .m3u8 playlists
│   + CDN Invalidation │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│   CloudFront CDN     │  ← Viewers fetch HLS from edge
│   https://cdn.vlm.gg │
│   /streams/{id}/     │
│   playlist.m3u8      │
└──────────────────────┘
```

### 9.2 Provisioning Flow

**Shared streaming (default):**
1. User requests a stream via the API (`POST /streaming/provision`)
2. API creates a `streaming_servers` row with `type: 'shared'`
3. API generates a unique stream key
4. Returns RTMP URL (`rtmp://ingest.vlm.gg/live`) + stream key
5. When the user starts streaming, the shared media server picks it up by stream key
6. Transcodes and uploads segments to S3 under `streams/{server_id}/`
7. HLS URL: `https://cdn.vlm.gg/streams/{server_id}/playlist.m3u8`

**Dedicated streaming (higher tier):**
1. User requests a dedicated stream (`POST /streaming/provision` with `type: 'dedicated'`)
2. API provisions a new container (ECS Fargate task, Fly.io machine, etc.)
3. The container runs its own RTMP ingest + FFmpeg
4. Returns a unique RTMP endpoint for that container
5. Higher cost, guaranteed resources, no contention

### 9.3 Recording & VOD

When recording is enabled:
1. FFmpeg writes full-quality segments to a separate S3 path (`vods/{server_id}/{session_id}/`)
2. After stream ends, a background job concatenates segments into a single MP4
3. VOD is accessible via the media library

### 9.4 Integration with VLM Scenes

The HLS playlist URL from a streaming server is just a URL. Creators paste it into a video element's `liveSrc` field in the scene editor. The SDK plays it via the platform's video player. No special integration needed — HLS is universally supported.

The media server also notifies the VLM API of stream status changes (online/offline) via internal webhook or Redis pub/sub. The API broadcasts these as `scene_video_status` messages to relevant Colyseus rooms, so in-world scenes can show/hide fallback images automatically.

---

## 10. Phase 6: Decentraland Adapter

**Package:** `packages/vlm-adapter-dcl`

This is a port of the existing `vlm-dcl` project, restructured to implement `VLMPlatformAdapter`.

### 10.1 Adapter Implementation

```typescript
// packages/vlm-adapter-dcl/src/DclAdapter.ts

import { engine, Entity, Transform, Material, VideoPlayer, AudioSource,
         MeshRenderer, GltfContainer, Schemas } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { getUserData } from '~system/UserIdentity'
import { signedFetch } from '~system/SignedFetch'
import { getSceneInformation, isPreviewMode } from '~system/EnvironmentApi'
import { movePlayerTo, openExternalUrl, requestTeleport } from '~system/RestrictedActions'

import type { VLMPlatformAdapter, EntityHandle, TransformData, ... } from 'vlm-shared'

export class DclPlatformAdapter implements VLMPlatformAdapter {
  readonly capabilities = {
    video: true,
    spatialAudio: true,
    gltfModels: true,
    customEmotes: true,
    playerTeleport: true,
    externalUrls: true,
    nftDisplay: true,
    colliders: true,
    platformName: 'decentraland',
  }

  async getPlatformUser(): Promise<PlatformUser> {
    const data = await getUserData({})
    return {
      id: data.data?.userId ?? '',
      displayName: data.data?.displayName,
      walletAddress: data.data?.publicKey,
      isGuest: !data.data?.hasConnectedWeb3,
    }
  }

  async getAuthProof(): Promise<AuthProof> {
    // Use Decentraland's signedFetch for platform-verified auth
    return { type: 'signed-fetch', payload: { signedFetch } }
  }

  async getSceneInfo(): Promise<SceneInfo> {
    const info = await getSceneInformation({})
    const metadata = JSON.parse(info.metadataJson)
    return {
      sceneId: metadata.vlm?.sceneId,
      platformSceneId: info.urn,
      location: metadata.scene?.base,
    }
  }

  createEntity(): EntityHandle {
    return engine.addEntity()
  }

  destroyEntity(handle: EntityHandle): void {
    engine.removeEntity(handle as Entity)
  }

  setTransform(entity: EntityHandle, t: TransformData): void {
    Transform.createOrReplace(entity as Entity, {
      position: Vector3.create(t.position.x, t.position.y, t.position.z),
      rotation: Quaternion.fromEulerDegrees(t.rotation.x, t.rotation.y, t.rotation.z),
      scale: Vector3.create(t.scale.x, t.scale.y, t.scale.z),
    })
  }

  // ... implement all other VLMPlatformAdapter methods
  // Port logic from vlm-dcl/src/services/*.service.ts
}
```

### 10.2 Entry Point

```typescript
// packages/vlm-adapter-dcl/src/index.ts

import { VLM } from 'vlm-core'
import { DclPlatformAdapter } from './DclAdapter'

export async function createVLM(config?: Partial<VLMInitConfig>): Promise<VLM> {
  const adapter = new DclPlatformAdapter()
  const vlm = new VLM(adapter)
  await vlm.init(config)
  return vlm
}

// Also re-export QuickCreator helpers for convenience
export { QuickCreator } from './QuickCreator'
```

### 10.3 Usage in a Decentraland Scene

```typescript
import { createVLM } from 'vlm-adapter-dcl'

const vlm = await createVLM()

// Everything works the same as v1
vlm.storage.videos.configs['my-screen'].updateVolume(0.5)
vlm.sendMessage('game-start', { round: 1 })
vlm.onMessage('game-start', (data) => { ... })
vlm.recordAction('checkpoint-reached', { checkpoint: 3 })
vlm.setState('score', 42)
const score = vlm.getState('score')
```

### 10.4 Scene Deployment Service

The Decentraland adapter includes a server-side deployment service that builds and deploys scenes to the Catalyst content network directly from the VLM API, enabling one-click deployment from the web dashboard.

#### Deployment Architecture

```
Web Dashboard                VLM API                     Decentraland Catalyst
┌──────────┐    POST        ┌──────────────┐   POST     ┌─────────────────────┐
│ "Deploy" │───/deploy───→  │ Build scene  │──/content/──│ peer.decentraland   │
│  button  │   request      │ bundle from  │  entities   │ .org/content        │
└──────────┘                │ selected     │             └─────────────────────┘
     │                      │ assets +     │
     │ (optional)           │ scene code   │   OR for Worlds:
     ▼                      │ template     │             ┌─────────────────────┐
  Wallet sign               └──────────────┘──/content/──│ worlds-content-     │
  (client-side)                    │          entities   │ server.decentraland │
                                   │                     │ .org                │
                                   ▼                     └─────────────────────┘
                            Sign with wallet
                            (client-side or
                             stored key)
```

#### Key Dependencies

- **`dcl-catalyst-client`** npm package — provides `DeploymentBuilder.buildEntity()` and `CatalystClient.deployEntity()` for programmatic deployment without the CLI.
- **`@dcl/crypto`** — `Authenticator.createSimpleAuthChain()` to build the auth chain from a wallet signature.

#### Deployment Flow

```typescript
import { CatalystClient, DeploymentBuilder } from 'dcl-catalyst-client'
import { EntityType } from '@dcl/schemas'
import { Authenticator } from '@dcl/crypto'

// 1. Assemble scene files: compiled JS bundle + selected GLB assets + scene.json
const contentFiles: Map<string, Buffer> = assembleSceneBundle(sceneConfig, selectedAssets)

// 2. Build the entity
const { entityId, files } = await DeploymentBuilder.buildEntity({
  type: EntityType.SCENE,
  pointers: ['0,0'],        // parcel coordinates from deployment config
  files: contentFiles,
  metadata: sceneMetadata,   // scene.json with parcels, spawn points, etc.
})

// 3. Sign with wallet (client-side via browser wallet, or server-side with stored key)
const authChain = Authenticator.createSimpleAuthChain(
  entityId,
  walletAddress,
  signature,
)

// 4. Deploy to Catalyst
const client = new CatalystClient({
  url: isWorld
    ? 'https://worlds-content-server.decentraland.org'
    : 'https://peer.decentraland.org',
})
await client.deployEntity({ entityId, files, authChain })
```

#### Authentication

- The deploying wallet must **own or be an operator of** the target LAND/Estate parcels.
- For Worlds, the wallet must own the DCL NAME or ENS domain.
- The `entityId` (a hash of the entity content) is signed with the wallet's private key, and the Catalyst server verifies on-chain deploy rights.
- For automated server-side deployments, the `DCL_PRIVATE_KEY` is stored encrypted in `deployment_wallets` and decrypted at deploy time.

#### Platform Constraints (Decentraland Scene Limits)

These limits are critical for the asset library budget meter and pre-deploy validation. All formulas use **n** = number of parcels.

**File Size Limits:**

| Deployment Type | Storage Budget |
|---|---|
| LAND parcels | 15 MB per parcel, 300 MB max total |
| Worlds (DCL NAME) | 100 MB base + 100 MB per LAND parcel owned + 100 MB per 2,000 MANA held |
| Worlds (ENS domain) | Fixed 36 MB (cannot be expanded) |
| Any single file | 50 MB max |

**Per-Parcel Complexity Limits:**

| Resource | Formula | 1 parcel | 4 parcels | 16 parcels |
|---|---|---|---|---|
| Triangles | n × 10,000 | 10,000 | 40,000 | 160,000 |
| Entities | n × 200 | 200 | 800 | 3,200 |
| Bodies (meshes) | n × 300 | 300 | 1,200 | 4,800 |
| Materials | log2(n+1) × 20 | 20 | ~46 | ~68 |
| Textures | log2(n+1) × 10 | 10 | ~23 | ~34 |
| Height | log2(n+1) × 20 m | 20 m | ~46 m | ~69 m |

**Important:** Only currently rendered entities count toward limits. The VLM SDK can dynamically show/hide entities, so the budget applies to the worst-case simultaneous render, not the total asset count.

**Runtime constraints:**
- GLB models **cannot** be loaded from external URLs at runtime. The `GltfContainer` component only accepts paths relative to the deployed scene bundle.
- Models can be dynamically swapped, created, destroyed, moved, and shown/hidden at runtime — but only among assets already in the deployed bundle.
- Scene code can fetch layout data from VLM's API (via `fetch()`) to drive dynamic entity placement.

#### Implications for the Asset Library

Because external GLB loading is not supported, the deployment model for Decentraland is **build-then-deploy**:

1. User browses the asset library in the dashboard and selects items for their scene.
2. User arranges assets (position, rotation, scale) via the dashboard scene editor.
3. The dashboard shows a live budget meter comparing selected assets against the target's limits.
4. User clicks "Deploy" — VLM assembles a scene bundle containing only the selected GLBs plus a VLM scene template (compiled JS that connects to VLM's API and renders entities based on server-driven configuration).
5. The bundle is deployed to the Catalyst network.
6. **Post-deployment, layout changes (move/rotate/scale/show/hide) happen in real-time** via the existing VLM Colyseus sync — no redeploy needed.
7. **Adding or removing GLB assets requires a new deployment** — but this is a one-click "Publish Changes" from the dashboard, not a manual CLI workflow.

### 10.5 Migration from v1 vlm-dcl

The public API (`VLM.init()`, `VLM.storage`, `VLM.sendMessage`, etc.) should remain identical so existing Decentraland scenes can upgrade with minimal code changes. The main difference is the import path changes from `import VLM from 'vlm-dcl'` to `import { createVLM } from 'vlm-adapter-dcl'`.

Provide a migration guide and consider exporting a compatibility wrapper:

```typescript
// packages/vlm-adapter-dcl/src/compat.ts
// For backwards compatibility with v1 import style
import { createVLM } from './index'

const VLM = {
  init: async (config) => { return createVLM(config) },
  // ... proxy other static methods
}
export default VLM
```

---

## 11. Phase 7: Additional Platform Adapters

Each adapter is a thin package that implements `VLMPlatformAdapter` using the target platform's APIs.

### 11.1 Hyperfy Adapter (`vlm-adapter-hyperfy`)

Hyperfy uses a Three.js-based world with its own component system. The adapter wraps Hyperfy's world API:

```typescript
export class HyperfyPlatformAdapter implements VLMPlatformAdapter {
  private world: HyperfyWorld

  constructor(world: HyperfyWorld) {
    this.world = world
  }

  readonly capabilities = {
    video: true,
    spatialAudio: true,
    gltfModels: true,
    customEmotes: false,  // Hyperfy may not support custom emotes
    playerTeleport: true,
    externalUrls: true,
    nftDisplay: false,
    colliders: true,
    platformName: 'hyperfy',
  }

  createEntity(): EntityHandle {
    return this.world.createEntity()
  }

  setTransform(entity: EntityHandle, t: TransformData): void {
    this.world.setPosition(entity, t.position)
    this.world.setRotation(entity, t.rotation)
    this.world.setScale(entity, t.scale)
  }

  // ... etc
}
```

### 11.2 Hyperfy World Provisioning & Deployment

Unlike Decentraland (which has a centralized content network), Hyperfy v2 uses a **self-hosted, one-server-per-world model**. Each world is a standalone Node.js process backed by SQLite. There is no centralized "create world" API — VLM must manage the infrastructure directly.

#### Provisioning Architecture

```
Web Dashboard              VLM API                    Infrastructure Provider
┌──────────┐   POST       ┌─────────────────┐        ┌──────────────────────┐
│ "Create  │──/deploy──→  │ Provision new   │──API──→│ Fly.io / Docker /    │
│  World"  │  request     │ Hyperfy instance │        │ DigitalOcean / etc.  │
└──────────┘              └────────┬────────┘        └──────────┬───────────┘
                                   │                            │
                                   ▼                            ▼
                          Store instance URL           New container running
                          + credentials in             Hyperfy at
                          scene_deployments            https://world.fly.dev
```

#### Provisioning Flow

1. User clicks "Create World" in the dashboard and selects a region.
2. VLM API provisions a new Hyperfy instance via the infrastructure provider's API (e.g., Fly.io `fly deploy`, Docker API, etc.):
   - Clones the Hyperfy repo template (or uses a pre-built Docker image).
   - Generates `JWT_SECRET`, `ADMIN_CODE`, and other env vars.
   - Configures `PUBLIC_WS_URL`, `PUBLIC_API_URL`, `PUBLIC_ASSETS_URL` to point to the new instance.
   - Starts the container.
3. VLM stores the instance URL, admin credentials, and infrastructure ID in `scene_deployments`.
4. The VLM Hyperfy adapter connects to the running world via WebSocket (`ws://<host>/ws`).

#### Asset Management in Hyperfy

Hyperfy is **more flexible than Decentraland** for runtime asset management:

- GLB files can be dragged into a world or uploaded as `.hyp` packages (a binary format containing JSON header + asset data).
- Apps can programmatically create nodes via `app.create(nodeName)` and place them with `world.add(node)`.
- The headless `agent.mjs` client can connect to a running world via WebSocket and manipulate objects programmatically.
- **No strict file size or triangle budgets** like Decentraland — limits are practical (server memory, client rendering performance) rather than enforced by the platform.

**Deployment model for Hyperfy is deploy-then-customize:**

1. VLM provisions and deploys a base Hyperfy world.
2. Users browse the asset library and add items at any time — VLM uploads GLBs to the running world via the Hyperfy upload mechanism (`npm run upload` or direct API).
3. Layout changes happen in real-time via VLM's Colyseus sync, same as Decentraland.
4. Adding new assets does **not** require a redeploy or restart — they are uploaded to the running instance.

**Current limitation:** Hyperfy has no external REST API for world manipulation from outside. Object placement must happen from within an app script or via the headless `agent.mjs` WebSocket client. The VLM Hyperfy adapter should use the agent API as a bridge between the dashboard and the running world. Note: Hyperfy v2 is in alpha and APIs may change.

### 11.3 Generic Three.js Adapter (`vlm-adapter-threejs`)

A catch-all for any world built on Three.js:

```typescript
export class ThreeJSPlatformAdapter implements VLMPlatformAdapter {
  private scene: THREE.Scene
  private entities: Map<string, THREE.Object3D>

  constructor(scene: THREE.Scene) {
    this.scene = scene
  }

  createEntity(): EntityHandle {
    const id = crypto.randomUUID()
    const obj = new THREE.Object3D()
    this.entities.set(id, obj)
    this.scene.add(obj)
    return id
  }

  setTransform(entity: EntityHandle, t: TransformData): void {
    const obj = this.entities.get(entity as string)
    obj.position.set(t.position.x, t.position.y, t.position.z)
    obj.rotation.set(
      t.rotation.x * Math.PI / 180,
      t.rotation.y * Math.PI / 180,
      t.rotation.z * Math.PI / 180
    )
    obj.scale.set(t.scale.x, t.scale.y, t.scale.z)
  }

  // ... etc
}
```

### 11.4 Guidelines for New Adapters

When implementing a new adapter:

1. Implement all methods in `VLMPlatformAdapter`
2. Set `capabilities` accurately — vlm-core will skip unsupported features gracefully
3. Auth: implement `getAuthProof()` to return whatever proof the platform provides. If the platform has no built-in auth (e.g., a generic Three.js app), use `type: 'api-key'` and have the developer pass their VLM API key
4. For `getSceneInfo()`, read the VLM scene ID from wherever the platform stores configuration (e.g., `scene.json` for Decentraland, a config object for Three.js apps)
5. Export a `createVLM(platformSpecificArgs)` function as the entry point
6. Publish as `vlm-adapter-{platform}` on npm

### 11.5 Second Life Adapter (`vlm-sl`)

Second Life is fundamentally different from all other platforms. There is no npm package, no JavaScript runtime, no WebSocket. The integration is **LSL scripts** dropped into prims, communicating with the VLM API over HTTP.

**Key differences from WebSocket-based adapters:**

| Aspect | Decentraland / Hyperfy | Second Life |
|--------|----------------------|-------------|
| Language | TypeScript/JavaScript | LSL (C-like, event-driven) |
| Networking | Colyseus WebSocket | HTTP only (llHTTPRequest out, llRequestURL in) |
| Real-time updates | WebSocket push (instant) | HTTP push to callback URL (~1-3s latency) |
| Video playback | SDK video player component | Media-on-a-Prim (MOAP) via Chromium |
| Integration format | npm package | LSL script dropped into a prim |
| Distribution | npm registry | Second Life Marketplace or direct copy |
| Entity creation | SDK API | Manual prim placement in SL editor |

**Architecture:**

```
VLM Dashboard → VLM API → POST to callback URL → SL Script → llSetPrimMediaParams → Viewer Chromium → HLS/Video/Image
                    ↑                                    │
                    └────── llHTTPRequest (poll) ─────────┘
```

The SL integration does NOT use the Colyseus room. Instead, it uses a **callback registration + HTTP push** pattern:

1. Each VLM LSL script requests a temporary public URL from SL via `llRequestURL()`
2. The script registers this URL with the VLM API (`POST /hook/sl/register`)
3. The VLM API stores the callback in `platform_callbacks` table
4. When scene data changes (preset update, video status change, etc.), the API POSTs the update to all registered callbacks for that scene
5. The LSL script receives the POST, parses the JSON, and calls `llSetPrimMediaParams()` to update the display
6. A periodic heartbeat (every 30s) re-registers the callback and polls for missed updates

**Scripts (in `/vlm-sl/scripts/`):**

- **VLM_VideoScreen.lsl** — The main script. Handles live HLS streams, video playlists, and image fallback. Switches automatically when stream status changes. Configuration via prim description (`sceneId|screenId`).
- **VLM_ImageDisplay.lsl** — Simpler version for static images with remote URL updates.
- **VLM_SceneController.lsl** — Optional master controller that holds one API connection and relays updates to child scripts via `llRegionSay` on channel `-4849564`, reducing HTTP load for multi-screen scenes.

**LSL Constraints to be aware of:**

| Constraint | Limit | Impact |
|-----------|-------|--------|
| Request body | 2 KB | Registration payload must be compact |
| Response body | 16 KB | API responses must strip unnecessary fields |
| HTTP timeout | ~25 seconds | Pushes must be fast; stale callbacks removed |
| Memory per script | 64 KB (Mono) | No large data structures in the script |
| Callback URL lifetime | Until sim restart | Scripts re-register on heartbeat timer |
| No WebSocket | — | Must use HTTP push + polling instead of Colyseus |
| No JSON parser | — | Scripts use manual string parsing (jsonGetString/jsonGetInteger helpers) |

**MOAP (Media-on-a-Prim) capabilities:**
- Natively plays HLS `.m3u8` URLs (the viewer's embedded Chromium renders them)
- Plays MP4 video files directly
- Displays images (PNG, JPG) as web pages
- Supports per-face media (each face of a prim can have a different URL)
- No synchronized playback across viewers — each viewer loads independently

---

## 15. Platform Integration Hooks (HTTP Push)

This section describes the HTTP push system that enables platforms without WebSocket support (like Second Life) to receive real-time scene updates from the VLM API.

### 15.1 Overview

The Colyseus WebSocket room is the primary real-time channel for platforms that support it (Decentraland, Hyperfy). For platforms that cannot maintain a WebSocket connection, the VLM API provides an HTTP push system where platform scripts register a callback URL and the API POSTs updates to it.

This is a **server-side addition to the VLM API** — it hooks into the existing scene update flow.

### 15.2 New API Routes

#### POST /hook/register

Register or re-register a platform callback URL. Called by in-world scripts on startup and periodically (every 30s) as a heartbeat.

**Request body:**
```json
{
  "sceneId": "uuid",
  "elementId": "screen-custom-id",
  "elementType": "video",
  "callbackUrl": "https://simhost-...:12043/cap/uuid",
  "platform": "secondlife",
  "mode": "element",
  "region": "My Region Name",
  "metadata": { "position": "<128, 25, 128>" }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `sceneId` | Yes | VLM scene UUID |
| `elementId` | No | Custom ID or SK of the specific element. Null for controller/scene-level callbacks. |
| `elementType` | No | `video`, `image`, `controller`. Null for scene-level. |
| `callbackUrl` | Yes | The URL the API should POST updates to. |
| `platform` | Yes | Platform identifier (`secondlife`, etc.) |
| `mode` | No | `element` (default) or `controller` (receives all scene updates) |
| `region` | No | Platform-specific location for debugging |
| `metadata` | No | Additional platform-specific data |

**Response (200 OK):**
Return the current config for the registered element so the script can initialize immediately without a separate poll.

For video elements:
```json
{
  "liveSrc": "https://stream.example.com/live.m3u8",
  "isLive": false,
  "enableLiveStream": true,
  "offImageSrc": "https://example.com/offline.png",
  "offType": 1,
  "playlist": ["https://example.com/v1.mp4"],
  "volume": 80
}
```

For image elements:
```json
{
  "textureSrc": "https://example.com/banner.png",
  "enabled": true
}
```

For controller mode:
```json
{
  "videos": [{ ...compact video config }],
  "images": [{ ...compact image config }]
}
```

**Server-side behavior:**
1. Upsert into `platform_callbacks` (match on `scene_id + element_id + element_type + platform`)
2. Update `last_registered` timestamp and reset `failure_count` to 0
3. Query current scene config and return it

#### GET /hook/config

Poll current config for a single element. Fallback for when push is missed.

**Query parameters:**
- `sceneId` (required)
- `elementId` (required)
- `elementType` (required) — `video` | `image`

**Response:** Same format as the registration response, matching the element type.

#### GET /hook/scene

Poll full scene config (all elements). Used by controller scripts.

**Query parameters:**
- `sceneId` (required)

**Response:**
```json
{
  "videos": [
    {
      "sk": "uuid",
      "customId": "main-screen",
      "liveSrc": "https://...",
      "isLive": false,
      "offImageSrc": "https://...",
      "offType": 1,
      "playlist": ["url1", "url2"],
      "volume": 80
    }
  ],
  "images": [
    {
      "sk": "uuid",
      "customId": "banner-1",
      "textureSrc": "https://...",
      "enabled": true
    }
  ]
}
```

**Important:** Responses must be under 16 KB (Second Life's `HTTP_BODY_MAXLENGTH`). Strip instance arrays (SL scripts manage their own prim positioning), strip timestamps, strip fields irrelevant to rendering.

### 15.3 Push Dispatch System

When scene data changes, the API must notify all registered callbacks for that scene. This hooks into the existing Colyseus room broadcast logic.

#### Where to hook in

In the Colyseus `vlm_scene` room message handlers, after persisting changes and broadcasting to WebSocket clients, also dispatch to HTTP callbacks:

```typescript
// In the Colyseus room handler, after broadcasting to WS clients:
import { dispatchPlatformCallbacks } from '../integrations/platform-hooks'

// After: room.broadcast('scene_video_status', { sk, status, url })
// Also:
await dispatchPlatformCallbacks(sceneId, {
  action: 'video_status',
  sk,
  isLive: status,
  url,
})

// After: room.broadcast('scene_preset_update', message)
// Also:
await dispatchPlatformCallbacks(sceneId, {
  action: 'config_update',
  elementId: message.elementData?.sk || message.id,
  ...compactElementConfig(message),
})

// After: room.broadcast('scene_change_preset', message)
// Also:
await dispatchPlatformCallbacks(sceneId, {
  action: 'preset_change',
  presetId: message.presetId,
})
```

#### Push message formats

```typescript
// Video status change (stream up/down)
{ action: 'video_status', sk: 'uuid', isLive: boolean, url: string }

// Element config update (property changed from dashboard)
{ action: 'config_update', elementId: 'uuid', ...elementConfig }

// Preset switched
{ action: 'preset_change', presetId: 'uuid' }

// Playlist advance (server-driven)
{ action: 'playlist_next' }

// Keepalive ping
{ action: 'ping' }
```

#### Implementation

```typescript
// apps/api/src/integrations/platform-hooks.ts

import { db } from '../db'
import { platformCallbacks } from '../db/schema'
import { eq, and, lt } from 'drizzle-orm'

export async function dispatchPlatformCallbacks(
  sceneId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Get all callbacks registered for this scene
  const callbacks = await db
    .select()
    .from(platformCallbacks)
    .where(eq(platformCallbacks.sceneId, sceneId))

  if (callbacks.length === 0) return

  const body = JSON.stringify(payload)

  // Fire-and-forget with short timeout — don't block the Colyseus handler
  const results = await Promise.allSettled(
    callbacks.map(async (cb) => {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)

        const res = await fetch(cb.callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        })

        clearTimeout(timeout)

        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        // Reset failure count on success
        if (cb.failureCount > 0) {
          await db
            .update(platformCallbacks)
            .set({ failureCount: 0 })
            .where(eq(platformCallbacks.id, cb.id))
        }
      } catch (e) {
        // Increment failure count
        const newCount = (cb.failureCount || 0) + 1
        if (newCount >= 3) {
          // Remove stale callback after 3 consecutive failures
          await db
            .delete(platformCallbacks)
            .where(eq(platformCallbacks.id, cb.id))
        } else {
          await db
            .update(platformCallbacks)
            .set({ failureCount: newCount })
            .where(eq(platformCallbacks.id, cb.id))
        }
      }
    }),
  )
}

// Cron job: clean up callbacks that haven't re-registered in 5 minutes
export async function cleanupStaleCallbacks(): Promise<void> {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000)
  await db
    .delete(platformCallbacks)
    .where(lt(platformCallbacks.lastRegistered, cutoff))
}
```

### 15.4 Keepalive Ping

Run a periodic job (every 60 seconds) that sends `{ "action": "ping" }` to all registered callbacks. This serves two purposes:
1. Verifies the callback is still reachable (removes stale ones)
2. Keeps the SL simulator from closing idle HTTP connections

### 15.5 Future Platform Hooks

This system is designed to be platform-agnostic. Any future platform that cannot use WebSocket can register a callback URL via the same `/hook/register` endpoint. The `platform` field distinguishes between platforms, and the push dispatch sends to all callbacks regardless of platform.

Potential future uses:
- **Discord bots** listening for scene events
- **IoT devices** displaying VLM content on physical screens
- **CI/CD pipelines** triggered by scene changes
- **Custom dashboards** with lightweight polling

---

## 12. Phase 8: Documentation Site

**App:** `apps/docs`

Replace Docsify with **Starlight** (Astro-based) or **Docusaurus** for better developer experience, search, versioning, and component embedding.

### Content Structure

```
docs/
├── getting-started/
│   ├── what-is-vlm.md
│   ├── quickstart.md
│   └── concepts.md          # Scenes, presets, elements, instances
│
├── dashboard/
│   ├── scenes.md
│   ├── scene-editor.md
│   ├── events.md
│   ├── giveaways.md
│   ├── analytics.md
│   ├── media-library.md     # NEW
│   ├── asset-library.md     # NEW — browsing, uploading, and managing 3D assets
│   ├── scene-deployment.md  # NEW — deploying to Decentraland and Hyperfy from the dashboard
│   ├── in-world-hud.md      # NEW — using the in-world management HUD
│   ├── command-center.md    # NEW — multi-world event orchestration
│   ├── streaming.md          # NEW
│   └── billing.md            # NEW
│
├── sdk/
│   ├── overview.md           # Platform adapter concept
│   ├── api-reference.md      # VLM class, storage, messaging, state
│   ├── decentraland/
│   │   ├── install.md
│   │   ├── migration-from-v1.md
│   │   └── examples.md
│   ├── hyperfy/
│   │   ├── install.md
│   │   └── examples.md
│   ├── threejs/
│   │   ├── install.md
│   │   └── examples.md
│   └── building-an-adapter.md  # Guide for new platform support
│
├── custom-features/
│   ├── widgets.md
│   ├── custom-rendering.md
│   ├── custom-analytics.md
│   ├── multiplayer-events.md
│   └── scene-state.md
│
├── api/
│   ├── authentication.md
│   ├── rest-reference.md     # Auto-generated from tRPC/OpenAPI
│   └── websocket-protocol.md
│
└── self-hosting/
    ├── overview.md
    ├── docker-compose.md
    ├── aws-deployment.md
    └── environment-variables.md
```

---

## 13. Billing & Subscription System

### 13.1 Subscription Tiers

| Feature | Free | Creator ($15/mo) | Pro ($49/mo) | Studio ($149/mo) |
|---------|------|-------------------|--------------|-------------------|
| Scenes | 3 | 20 | 100 | Unlimited |
| In-World HUD | View-only | Full editing | Full editing | Full editing |
| Command Center | No | 1 world at a time | Multi-world | Multi-world + cross-world broadcast |
| Cross-World Broadcast | No | No | No | Yes — push changes to all event worlds at once |
| Media Storage | 500 MB | 10 GB | 50 GB | 500 GB |
| Deployments | Manual only | 10/month | 50/month | Unlimited |
| 3D Asset Library | Public catalog | Public + 50 custom uploads | Public + 500 custom | Unlimited custom |
| Hyperfy Worlds | No | 1 instance | 5 instances | Unlimited |
| Streaming | No | Shared (1000 min) | Shared (5000 min) | Dedicated (unlimited) |
| Stream Rentals | No | A-la-carte | A-la-carte | Included |
| Recording/VOD | No | No | Yes | Yes |
| Analytics Retention | 7 days | 30 days | 90 days | 1 year |
| Cross-Platform Analytics | No | No | Per-world only | Aggregate across all worlds |
| API Keys | No | 1 | 5 | Unlimited |
| Custom Domain | No | No | Yes | Yes |
| Priority Support | No | No | No | Yes |
| Giveaway Credits | 100 | 1,000 | 5,000 | 25,000 |

**Monetization philosophy:** The free tier gives full access to scene management and a view-only in-world HUD, so users can explore VLM's capabilities without paying. The in-world HUD becomes the primary conversion surface — premium assets, deployment, streaming, and multi-world event management are discoverable in context. The Studio tier unlocks the full "Virtual Land Manager" experience: one person operating a multi-platform brand activation from a single interface.

### 13.2 Stripe Integration

```typescript
// apps/api/src/integrations/stripe.ts

// Subscription lifecycle
POST /billing/checkout        // Create Stripe Checkout session for upgrade
POST /billing/portal          // Create Stripe Customer Portal session
POST /billing/webhook         // Stripe webhook handler

// Webhook events to handle:
// - checkout.session.completed → activate subscription
// - customer.subscription.updated → update tier
// - customer.subscription.deleted → downgrade to free
// - invoice.payment_failed → notify user, grace period
// - invoice.paid → record payment
```

### 13.3 Usage Tracking

Track usage in real-time against subscription limits:

```typescript
// Before allowing media upload:
const usage = await getStorageUsage(userId)
const limit = getStorageLimit(subscription.tier)
if (usage + fileSize > limit) throw new QuotaExceededError()

// Before allowing stream start:
const minutes = await getStreamMinutesUsed(userId, currentBillingPeriod)
const limit = getStreamMinuteLimit(subscription.tier)
if (minutes >= limit) throw new QuotaExceededError()
```

---

## 14. Data Migration from V1

If migrating existing VLM v1 data to v2:

### 14.1 DynamoDB → PostgreSQL Migration

Write a one-time migration script that:

1. Scans each DynamoDB table
2. Maps the PK/SK pattern to relational rows (see Appendix B for the full PK/SK mapping)
3. Inserts into PostgreSQL with proper foreign keys
4. Handles the element arrays in presets (v1 stores element IDs as arrays on the preset; v2 uses FK on the element pointing to the preset)

Key mappings:
```
vlm_main: pk='vlm:scene' → scenes table
vlm_main: pk='vlm:scene:preset' → scene_presets table
vlm_main: pk='vlm:scene:video' → scene_elements table (type='video')
vlm_main: pk='vlm:scene:video:instance' → scene_element_instances table
vlm_main: pk='vlm:user:account' → users table
vlm_main: pk='vlm:user:wallet' → user_auth_methods table (type='wallet')
vlm_main: pk='vlm:event' → events table
vlm_main: pk='vlm:event:giveaway' → giveaways table
... (see Appendix B for complete list)
```

### 14.2 S3 Media

S3 media can stay in place. Update the `media_assets` table to point to existing S3 keys. Optionally add CloudFront distribution in front.

### 14.3 User Auth

V1 users authenticated exclusively by wallet. During migration:
1. Create a `users` row for each unique wallet
2. Create a `user_auth_methods` row with `type: 'wallet'` and `identifier: walletAddress`
3. Users can later add email/OAuth auth methods to the same account

---

## 16. Deployment Modes & Self-Hosting

One codebase, one Docker image, three deployment modes. The mode is set by a single environment variable and determines sensible defaults for everything else.

```bash
VLM_MODE=single    # Self-hosted, one server, one person's scenes
VLM_MODE=scalable  # Self-hosted, multiple servers, organization-scale
VLM_MODE=cloud     # The hosted vlm.gg SaaS (multi-tenant, billing enabled)
```

### 16.1 Mode Comparison

| Capability | `single` | `scalable` | `cloud` |
|-----------|----------|------------|---------|
| **Target user** | Solo creator, small team | Studio, organization, agency | vlm.gg (we run this) |
| **Setup time** | 5 minutes | 30 minutes | N/A (we manage it) |
| **Server topology** | One container | Multiple containers + LB | Auto-scaling cluster |
| **Colyseus presence** | In-memory | Redis (required) | Redis cluster |
| **Database** | Supabase free / local Postgres | Managed Postgres | Managed Postgres + read replicas |
| **Storage** | Supabase Storage / local | S3 / R2 / Supabase | S3 + CloudFront CDN |
| **Redis** | Not needed | Required (`REDIS_URL`) | Required (ElastiCache cluster) |
| **Billing / Stripe** | Disabled (all features free) | Optional | Required (feature gating) |
| **Scene limit** | Unlimited (practical limit ~10-20) | Unlimited | Tiered by subscription |
| **HLS streaming** | Optional (embedded FFmpeg) | Optional (embedded or separate) | Separate media server |
| **Auth providers** | Email/password only | Email + OAuth + wallet | Email + OAuth + wallet + Apple |
| **Multi-tenant** | No (single org) | No (single org, multiple users) | Yes (many orgs, isolated data) |
| **CDN** | None (served from storage) | Optional | Required |
| **Monitoring** | Console logs | Optional (Prometheus metrics) | Full observability stack |
| **Deploy targets** | Railway / Render / Fly / VPS | Docker Compose / Kubernetes | ECS / Kubernetes |

### 16.2 How Modes Work in Code

The `VLM_MODE` env var sets defaults. Every default can be overridden by setting the specific env var. The mode is just a shorthand.

```typescript
// apps/server/src/config.ts

type VLMMode = 'single' | 'scalable' | 'cloud'

const mode: VLMMode = (process.env.VLM_MODE as VLMMode) || 'single'

export const config = {
  mode,

  // Colyseus presence
  useRedisPresence: env('REDIS_URL')
    ? true
    : mode !== 'single',  // scalable and cloud require Redis

  // Billing
  billingEnabled: env('STRIPE_SECRET_KEY')
    ? true
    : mode === 'cloud',  // only cloud enables billing by default

  // All features unlocked when billing is disabled
  allFeaturesUnlocked: !env('STRIPE_SECRET_KEY') && mode !== 'cloud',

  // Multi-tenant isolation
  multiTenant: env('MULTI_TENANT')
    ? env('MULTI_TENANT') === 'true'
    : mode === 'cloud',

  // Storage
  storageProvider: env('STORAGE_PROVIDER')
    || (mode === 'cloud' ? 's3' : 'supabase'),

  // CDN
  cdnUrl: env('CDN_URL') || null,

  // Streaming
  streamingEnabled: env('ENABLE_STREAMING') === 'true'
    || mode === 'cloud',

  // Metrics endpoint (/metrics for Prometheus)
  metricsEnabled: env('ENABLE_METRICS') === 'true'
    || mode !== 'single',

  // First signup becomes admin (single/scalable only)
  autoPromoteFirstUser: mode !== 'cloud',

  // Concurrent scene room limit per server (prevents memory exhaustion)
  maxRoomsPerServer: parseInt(env('MAX_ROOMS') || (mode === 'single' ? '50' : '500')),
}
```

### 16.3 Mode: `single` — Self-Hosted, One Server

**Audience:** Individual creator, small team, hackathon project, or anyone evaluating VLM.

**Architecture:**

```
┌──────────────────────────────────┐
│     Single VLM Container         │
│                                  │
│  Fastify API + Colyseus WS      │
│  + Next.js static dashboard     │
│  + (optional) FFmpeg worker     │
│                                  │
│  Colyseus: in-memory presence   │
│  (no Redis needed)              │
└────────────┬─────────────────────┘
             │
   ┌─────────┴──────────┐
   │                     │
   ▼                     ▼
┌──────────┐     ┌──────────────┐
│ Supabase │     │ (nothing     │
│ Postgres │     │  else needed)│
│+ Storage │     └──────────────┘
└──────────┘
```

**Setup (5 minutes):**

1. Create a Supabase project at supabase.com (free tier)
2. Click "Deploy on Railway" in the VLM repo README
3. Paste four env vars: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`
4. Railway auto-generates `JWT_SECRET` and `PUBLIC_URL`
5. Open your VLM instance, sign up, you're the admin

Or with Docker on a VPS:

```bash
git clone https://github.com/virtuallandmanager/vlm.git && cd vlm
cp .env.example .env
# Edit .env: set DATABASE_URL and SUPABASE_* vars (or use local Postgres)
docker compose -f docker-compose.single.yml up -d
```

**What you get:**
- Full VLM dashboard and in-world HUD
- All scene element types (video, image, model, sound, widget)
- Real-time Colyseus sync between dashboard and in-world
- Media upload and storage
- All platform adapters (Decentraland, Hyperfy, Second Life)
- No billing — every feature works
- No scene limits (practical limit: whatever one server can handle)

**What you don't get:**
- Horizontal scaling (one server = one point of failure)
- If the server restarts, active Colyseus rooms are dropped (clients auto-reconnect)
- No CDN — media served directly from storage
- No built-in monitoring (just console logs)

**docker-compose.single.yml:**

```yaml
services:
  vlm:
    image: ghcr.io/virtuallandmanager/vlm:latest
    ports:
      - "3010:3010"
    environment:
      VLM_MODE: single
      DATABASE_URL: ${DATABASE_URL}
      SUPABASE_URL: ${SUPABASE_URL}
      SUPABASE_ANON_KEY: ${SUPABASE_ANON_KEY}
      SUPABASE_SERVICE_KEY: ${SUPABASE_SERVICE_KEY}
      JWT_SECRET: ${JWT_SECRET}
      PUBLIC_URL: ${PUBLIC_URL:-http://localhost:3010}
    restart: unless-stopped
```

Or fully self-contained (no Supabase, local Postgres + filesystem storage):

```yaml
# docker-compose.single-local.yml
services:
  vlm:
    image: ghcr.io/virtuallandmanager/vlm:latest
    ports:
      - "3010:3010"
    environment:
      VLM_MODE: single
      DATABASE_URL: postgresql://vlm:vlm@postgres:5432/vlm
      STORAGE_PROVIDER: local
      LOCAL_STORAGE_PATH: /data/uploads
      JWT_SECRET: ${JWT_SECRET:-change-me}
      PUBLIC_URL: ${PUBLIC_URL:-http://localhost:3010}
    volumes:
      - uploads:/data/uploads
    depends_on:
      - postgres

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: vlm
      POSTGRES_USER: vlm
      POSTGRES_PASSWORD: vlm
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
  uploads:
```

### 16.4 Mode: `scalable` — Self-Hosted, Multiple Servers

**Audience:** Studio running VLM for dozens of scenes, agency managing multiple clients, organization with high availability requirements.

**Architecture:**

```
                    ┌───────────┐
                    │ Load      │
                    │ Balancer  │
                    │ (Nginx/   │
                    │  Traefik) │
                    └─────┬─────┘
                          │
            ┌─────────────┼─────────────┐
            │             │             │
            ▼             ▼             ▼
    ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
    │  VLM Server  │ │  VLM Server  │ │  VLM Server  │
    │  Instance 1  │ │  Instance 2  │ │  Instance 3  │
    │              │ │              │ │              │
    │ Fastify +    │ │ Fastify +    │ │ Fastify +    │
    │ Colyseus +   │ │ Colyseus +   │ │ Colyseus +   │
    │ Dashboard    │ │ Dashboard    │ │ Dashboard    │
    └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
           │                │                │
     ┌─────┴────────────────┴────────────────┴─────┐
     │                                              │
     ▼                    ▼                         ▼
┌──────────┐      ┌──────────┐              ┌──────────┐
│ Postgres │      │  Redis   │              │ S3 / R2  │
│ (managed)│      │ (required│              │ Storage  │
└──────────┘      │  for     │              └──────────┘
                  │  presence)│
                  └──────────┘
```

**Why Redis is required:** With multiple VLM servers, Colyseus rooms need to be discoverable across servers. If a dashboard connects to Server 1 and the in-world SDK connects to Server 2, they need to end up in the same room. Redis provides the shared presence layer that makes this work. Without it, rooms are only visible to the server that created them.

**Setup (30 minutes):**

1. Provision managed Postgres (Supabase Pro, Neon, RDS, or self-hosted)
2. Provision Redis (Upstash, ElastiCache, or self-hosted)
3. Provision object storage (S3, R2, or Supabase Storage)
4. Deploy VLM containers behind a load balancer

```yaml
# docker-compose.scalable.yml
services:
  vlm-1:
    image: ghcr.io/virtuallandmanager/vlm:latest
    environment:
      VLM_MODE: scalable
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: ${REDIS_URL}
      STORAGE_PROVIDER: s3
      S3_BUCKET: ${S3_BUCKET}
      S3_REGION: ${S3_REGION}
      S3_ACCESS_KEY: ${S3_ACCESS_KEY}
      S3_SECRET_KEY: ${S3_SECRET_KEY}
      JWT_SECRET: ${JWT_SECRET}
      PUBLIC_URL: ${PUBLIC_URL}
    restart: unless-stopped

  vlm-2:
    image: ghcr.io/virtuallandmanager/vlm:latest
    environment: *vlm-env  # Same env vars as vlm-1

  vlm-3:
    image: ghcr.io/virtuallandmanager/vlm:latest
    environment: *vlm-env

  nginx:
    image: nginx:alpine
    ports:
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
    depends_on:
      - vlm-1
      - vlm-2
      - vlm-3

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data

volumes:
  redis-data:
```

**Load balancer WebSocket routing:** Colyseus requires sticky sessions — a WebSocket connection must stay on the same server for its lifetime. Configure the load balancer for session affinity:

```nginx
# nginx.conf — key sections
upstream vlm_servers {
    ip_hash;  # Sticky sessions by client IP
    server vlm-1:3010;
    server vlm-2:3010;
    server vlm-3:3010;
}

server {
    listen 443 ssl;

    location / {
        proxy_pass http://vlm_servers;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

**What you get beyond `single`:**
- High availability — if one server goes down, others handle traffic
- More concurrent Colyseus rooms (distributed across servers)
- Shared Redis presence — rooms work across servers
- Better suited for >50 concurrent scenes
- Optional Prometheus metrics endpoint (`/metrics`) for monitoring

### 16.5 Mode: `cloud` — The Hosted SaaS (vlm.gg)

**Audience:** This is what we run. Multi-tenant, billing-gated, auto-scaling.

**Architecture:**

```
                    ┌────────────┐
                    │ CloudFront │
                    │ CDN        │
                    └──────┬─────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
     ┌────────┴──┐  ┌─────┴─────┐  ┌──┴──────────┐
     │ Next.js   │  │ ALB/NLB   │  │ Media Server │
     │ Dashboard │  │           │  │ (ECS/Fly)    │
     │ (Vercel)  │  │           │  └──────┬───────┘
     └───────────┘  └─────┬─────┘         │
                          │               │
            ┌─────────────┼─────────┐     │
            ▼             ▼         ▼     │
    ┌──────────────┐ ┌──────────┐ ┌──┐   │
    │ VLM API      │ │ VLM API  │ │..│   │
    │ (ECS Fargate)│ │ (ECS)    │ │  │   │
    │ Auto-scaling │ │          │ │  │   │
    └──────┬───────┘ └────┬─────┘ └──┘   │
           │              │               │
     ┌─────┴──────────────┴───────────────┘
     │              │              │
     ▼              ▼              ▼
┌──────────┐  ┌──────────┐  ┌──────────┐
│ RDS      │  │ElastiCache│  │   S3     │
│ Postgres │  │ Redis     │  │ + CDN    │
│ + replica│  │ cluster   │  └──────────┘
└──────────┘  └──────────┘
```

**Key differences from `scalable`:**

1. **Dashboard runs separately.** In cloud mode, the Next.js dashboard deploys to Vercel (or its own container) — not embedded in the API. This allows independent scaling and CDN edge caching for the dashboard.

2. **Multi-tenant data isolation.** Cloud mode enables `multiTenant: true`, which adds `org_id` scoping to database queries. One VLM Cloud instance serves many organizations, each seeing only their own data.

3. **Stripe billing required.** Features are gated by subscription tier. The `allFeaturesUnlocked` flag is false. Premium assets, streaming, deployment, and cross-world broadcast require paid plans.

4. **Media server is separate.** HLS transcoding runs as its own service (auto-scaling ECS tasks or Fly machines) instead of an embedded FFmpeg worker. This prevents transcoding workload from affecting API responsiveness.

5. **Auto-scaling.** ECS/Kubernetes scales the API containers based on CPU/memory and WebSocket connection count. Redis cluster mode distributes Colyseus presence across multiple Redis nodes.

6. **CDN for everything.** Media assets served via CloudFront. Dashboard served via Vercel Edge. API behind ALB with TLS termination.

**Environment:**

```bash
VLM_MODE=cloud
DATABASE_URL=postgresql://...rds.amazonaws.com:5432/vlm
REDIS_URL=rediss://...cache.amazonaws.com:6379
STORAGE_PROVIDER=s3
S3_BUCKET=vlm-media-prod
S3_REGION=us-east-1
CDN_URL=https://cdn.vlm.gg
JWT_SECRET=...
PUBLIC_URL=https://api.vlm.gg
DASHBOARD_URL=https://vlm.gg
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
ALCHEMY_API_KEY=...
ENABLE_STREAMING=true
MEDIA_SERVER_URL=https://media.vlm.gg
MULTI_TENANT=true
ENABLE_METRICS=true
```

### 16.6 Colyseus Presence by Mode

This is the critical scaling piece. Colyseus uses a "presence" layer to track which rooms exist on which server.

```typescript
// apps/server/src/colyseus/presence.ts

import { Server } from 'colyseus'
import { RedisPresence } from '@colyseus/redis-presence'
import { WebSocketTransport } from '@colyseus/ws-transport'
import { config } from '../config'

export function createColyseusServer(httpServer: any): Server {
  const options: any = {
    transport: new WebSocketTransport({ server: httpServer }),
  }

  if (config.useRedisPresence && process.env.REDIS_URL) {
    // Scalable/Cloud: Redis presence — rooms discoverable across servers
    options.presence = new RedisPresence(process.env.REDIS_URL)
    options.driver = new RedisDriver(process.env.REDIS_URL)
    console.log('Colyseus: using Redis presence (multi-server)')
  } else {
    // Single: in-memory presence — rooms only on this server
    console.log('Colyseus: using in-memory presence (single server)')
  }

  const server = new Server(options)

  server.define('vlm_scene', VLMSceneRoom).filterBy(['sceneId'])
  server.define('vlm_command_center', VLMCommandCenterRoom).filterBy(['eventId'])

  return server
}
```

**What happens when a room is on Server A but a client connects to Server B:**

- `single` mode: This can't happen — there's only one server. Client always joins the room on the same (only) server.
- `scalable`/`cloud` mode: Colyseus Redis presence knows which server owns which room. The load balancer routes the initial HTTP upgrade to any server. That server checks Redis, discovers the room is on Server A, and either:
  - Proxies the client to Server A (Colyseus handles this via the Redis driver)
  - Or creates the room locally if it doesn't exist yet (first client for a given sceneId creates the room on whichever server they hit)

This is why sticky sessions are recommended but not strictly required — Colyseus Redis presence handles cross-server room discovery.

### 16.7 Storage Abstraction

Same interface, different backends per mode:

```typescript
// apps/server/src/storage/index.ts

export interface StorageProvider {
  upload(key: string, data: Buffer, contentType: string): Promise<string>
  download(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
  getPublicUrl(key: string): string
  list(prefix: string): Promise<string[]>
}

export function createStorage(): StorageProvider {
  const provider = process.env.STORAGE_PROVIDER || config.storageProvider

  switch (provider) {
    case 'supabase':
      return new SupabaseStorage(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
    case 's3':
      return new S3Storage({ bucket: process.env.S3_BUCKET!, region: process.env.S3_REGION! })
    case 'r2':
      return new R2Storage({ bucket: process.env.R2_BUCKET!, endpoint: process.env.R2_ENDPOINT! })
    case 'local':
      return new LocalStorage(process.env.LOCAL_STORAGE_PATH || './uploads')
    default:
      return new LocalStorage('./uploads')
  }
}
```

`single` defaults to `supabase` (zero config if Supabase is already set up for Postgres).
`scalable` defaults to `s3` (shared across servers — local filesystem doesn't work with multiple servers).
`cloud` defaults to `s3` with `CDN_URL` prepended to public URLs.

### 16.8 Feature Gating by Mode

```typescript
// apps/server/src/middleware/feature-gate.ts

import { config } from '../config'

export function requireFeature(feature: string) {
  return async (request, reply) => {
    // All features unlocked in single/scalable mode (unless Stripe is configured)
    if (config.allFeaturesUnlocked) return

    // Cloud mode: check subscription tier
    const user = request.user
    const subscription = await getSubscription(user.id)
    const allowed = checkFeatureAccess(feature, subscription.tier)

    if (!allowed) {
      reply.status(403).send({
        error: 'upgrade_required',
        feature,
        currentTier: subscription.tier,
        requiredTier: getRequiredTier(feature),
      })
    }
  }
}

// Usage in routes:
app.post('/api/streaming/provision',
  { preHandler: [authenticate, requireFeature('streaming')] },
  streamingController.provision
)
```

Self-hosters never see upgrade prompts. They get streaming, deployment, cross-world broadcast, unlimited scenes — everything. The `requireFeature` middleware is a no-op when `allFeaturesUnlocked` is true.

### 16.9 Database Auto-Migration

On first boot, the server automatically applies all pending migrations:

```typescript
// apps/server/src/db/migrate.ts

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

export async function runMigrations() {
  const sql = postgres(process.env.DATABASE_URL!)
  const db = drizzle(sql)
  await migrate(db, { migrationsFolder: './drizzle' })
  await sql.end()
  console.log('Database migrations complete')
}
```

Called at server startup before the HTTP server binds:

```typescript
// apps/server/src/index.ts
await runMigrations()
// ... then start Fastify + Colyseus
```

No manual migration step for any mode. The server bootstraps itself.

### 16.10 One-Click Deploy Templates

#### Railway (for `single` mode)

**`railway.toml`:**
```toml
[build]
builder = "dockerfile"

[deploy]
startCommand = "node dist/index.js"
healthcheckPath = "/api/health"
```

README button:
```markdown
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/vlm)
```

The Railway template includes:
- VLM container (from Dockerfile)
- Prompts for `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`
- Auto-generates `JWT_SECRET`
- Sets `VLM_MODE=single`
- Sets `PUBLIC_URL` from Railway's assigned domain

#### Render (for `single` mode)

**`render.yaml`:**
```yaml
services:
  - type: web
    name: vlm
    runtime: docker
    plan: starter
    healthCheckPath: /api/health
    envVars:
      - key: VLM_MODE
        value: single
      - key: JWT_SECRET
        generateValue: true
      - key: DATABASE_URL
        sync: false
      - key: SUPABASE_URL
        sync: false
      - key: SUPABASE_ANON_KEY
        sync: false
      - key: SUPABASE_SERVICE_KEY
        sync: false
```

#### Docker Compose (for `scalable` mode)

See the `docker-compose.scalable.yml` in Section 16.4 above. Also provide a `docker-compose.single-local.yml` for people who want everything in one compose file with no external services.

### 16.11 Dockerfile

One Dockerfile for all modes. The image is the same — only env vars change behavior.

```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/ packages/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm turbo build

# Export Next.js dashboard as static files
RUN cd apps/web && npx next export -o ../server/dashboard

# Stage 2: Runtime
FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache ffmpeg  # For optional HLS streaming

COPY --from=builder /app/apps/server/dist ./dist
COPY --from=builder /app/apps/server/dashboard ./dashboard
COPY --from=builder /app/apps/server/drizzle ./drizzle
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/server/package.json ./

EXPOSE 3010
CMD ["node", "dist/index.js"]
```

### 16.12 Environment Variables (Complete Reference)

```bash
# =============================================================================
# REQUIRED (all modes)
# =============================================================================
VLM_MODE=single                     # single | scalable | cloud
DATABASE_URL=                       # PostgreSQL connection string
JWT_SECRET=                         # Random 64-char string for JWT signing
PUBLIC_URL=                         # Public URL of this instance

# =============================================================================
# REQUIRED for Supabase storage (single mode default)
# =============================================================================
SUPABASE_URL=                       # https://xxx.supabase.co
SUPABASE_ANON_KEY=                  # Public anon key
SUPABASE_SERVICE_KEY=               # Service role key

# =============================================================================
# REQUIRED for scalable/cloud modes
# =============================================================================
REDIS_URL=                          # Redis connection string (redis:// or rediss://)

# =============================================================================
# STORAGE (override defaults per mode)
# =============================================================================
STORAGE_PROVIDER=                   # supabase (default), s3, r2, local
# S3_BUCKET=                        # Required for s3 provider
# S3_REGION=                        # Required for s3 provider
# S3_ACCESS_KEY=                    # Required for s3 provider
# S3_SECRET_KEY=                    # Required for s3 provider
# R2_BUCKET=                        # Required for r2 provider
# R2_ENDPOINT=                      # Required for r2 provider
# R2_ACCESS_KEY=                    # Required for r2 provider
# R2_SECRET_KEY=                    # Required for r2 provider
# LOCAL_STORAGE_PATH=./uploads      # For local provider
# CDN_URL=                          # Prepend to all public media URLs

# =============================================================================
# OPTIONAL (all modes)
# =============================================================================
PORT=3010
# GOOGLE_CLIENT_ID=                 # Enable Google OAuth
# GOOGLE_CLIENT_SECRET=
# DISCORD_CLIENT_ID=                # Enable Discord OAuth
# DISCORD_CLIENT_SECRET=
# ALCHEMY_API_KEY=                  # Enable Web3 wallet auth + blockchain
# ENABLE_STREAMING=false            # Enable HLS streaming (requires FFmpeg)
# ENABLE_METRICS=false              # Enable /metrics endpoint for Prometheus

# =============================================================================
# CLOUD MODE ONLY
# =============================================================================
# STRIPE_SECRET_KEY=                # Enable billing + feature gating
# STRIPE_WEBHOOK_SECRET=
# DASHBOARD_URL=                    # Separate dashboard URL (if not embedded)
# MEDIA_SERVER_URL=                 # Separate media server URL
# MULTI_TENANT=true                 # Enable org-scoped data isolation
# MAX_ROOMS=500                     # Colyseus room limit per server

# =============================================================================
# ADMIN
# =============================================================================
# ADMIN_EMAIL=                      # Auto-promote this email to admin
# (If unset, first signup becomes admin in single/scalable modes)
```

### 16.13 The 5-Minute, 30-Minute, and Full Setup Guides

**`single` mode (5 minutes):**
1. Create Supabase project → copy 4 credentials
2. Click "Deploy on Railway" → paste credentials
3. Open URL → sign up → you're the admin → create a scene

**`scalable` mode (30 minutes):**
1. Provision managed Postgres (Supabase Pro, Neon, or RDS)
2. Provision Redis (Upstash Pro or ElastiCache)
3. Provision S3 bucket (or R2)
4. Clone repo → `docker compose -f docker-compose.scalable.yml up -d`
5. Configure load balancer with sticky sessions
6. Point DNS at load balancer

**`cloud` mode (we run this):**
- Terraform/Pulumi IaC for full AWS stack
- ECS auto-scaling, RDS, ElastiCache, S3 + CloudFront
- Vercel for dashboard
- Stripe Connect for billing
- GitHub Actions CI/CD
- Datadog/Grafana for observability

### 16.2 Consolidated Architecture

```
┌──────────────────────────────────────────────┐
│           Single VLM Container               │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ Fastify   │  │ Colyseus │  │ Next.js   │ │
│  │ REST API  │  │ WS rooms │  │ static    │ │
│  │ /api/*    │  │ /ws/*    │  │ export    │ │
│  │ /hook/*   │  │          │  │ /*        │ │
│  └─────┬─────┘  └─────┬────┘  └─────┬─────┘ │
│        │               │             │       │
│        └───────┬───────┘             │       │
│                │                     │       │
│         Fastify server              Served   │
│         (single port)             as static  │
│                                   files by   │
│                                   Fastify    │
│                                              │
│  Optional:                                   │
│  ┌──────────────────────┐                   │
│  │ FFmpeg worker         │                   │
│  │ (HLS transcoding)    │                   │
│  │ Enabled by env var   │                   │
│  └──────────────────────┘                   │
└──────────────────┬───────────────────────────┘
                   │
     ┌─────────────┼──────────────┐
     │             │              │
     ▼             ▼              ▼
┌─────────┐  ┌──────────┐  ┌──────────┐
│Supabase │  │ Upstash  │  │ (none)   │
│Postgres │  │ Redis    │  │          │
│+ Storage│  │ optional │  │          │
└─────────┘  └──────────┘  └──────────┘
```

### 16.3 Server Entry Point

The consolidated server runs everything in one process:

```typescript
// apps/server/src/index.ts

import Fastify from 'fastify'
import { Server } from 'colyseus'
import { WebSocketTransport } from '@colyseus/ws-transport'
import fastifyStatic from '@fastify/static'
import path from 'path'

const app = Fastify()

// --- Serve the Next.js static export ---
app.register(fastifyStatic, {
  root: path.join(__dirname, '../dashboard'),  // Next.js `out/` directory
  prefix: '/',
  wildcard: true,  // SPA fallback
})

// --- Register API routes ---
app.register(import('./routes/auth'))
app.register(import('./routes/scenes'))
app.register(import('./routes/media'))
app.register(import('./routes/hooks'))
app.register(import('./routes/streaming'))
// ... all other route modules

// --- Health check ---
app.get('/api/health', async () => ({ status: 'ok' }))

// --- Start Colyseus on the same HTTP server ---
const colyseusServer = new Server({
  transport: new WebSocketTransport({ server: app.server }),
})
colyseusServer.define('vlm_scene', VLMSceneRoom)
colyseusServer.define('vlm_command_center', VLMCommandCenterRoom)

// --- Optional: start FFmpeg streaming worker ---
if (process.env.ENABLE_STREAMING === 'true') {
  import('./workers/streaming').then(m => m.startStreamingWorker())
}

const port = parseInt(process.env.PORT || '3010')
await app.listen({ port, host: '0.0.0.0' })
console.log(`VLM running on port ${port}`)
```

### 16.4 Environment Variables (Complete List)

The entire VLM instance is configured via environment variables. No config files, no secrets in code.

```bash
# =============================================================================
# REQUIRED — Set these to get VLM running
# =============================================================================

# Supabase (one account gives you Postgres + Storage)
DATABASE_URL=postgresql://postgres:password@db.xxx.supabase.co:5432/postgres
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...                  # Public anon key
SUPABASE_SERVICE_KEY=eyJ...               # Service role key (for storage)

# JWT secret (generate a random 64-char string)
JWT_SECRET=your-random-secret-here

# Public URL where this instance is accessible
PUBLIC_URL=https://your-vlm.railway.app

# =============================================================================
# OPTIONAL — Sensible defaults if not set
# =============================================================================

# Port (default: 3010, Railway/Render set this automatically)
PORT=3010

# Redis (omit for single-server in-memory mode)
# REDIS_URL=redis://default:password@xxx.upstash.io:6379

# Storage provider (default: supabase, also supports: s3, r2, local)
STORAGE_PROVIDER=supabase
# For S3: AWS_ACCESS_KEY, AWS_SECRET_KEY, AWS_REGION, S3_BUCKET
# For R2: R2_ACCESS_KEY, R2_SECRET_KEY, R2_ENDPOINT, R2_BUCKET
# For local: LOCAL_STORAGE_PATH=./uploads

# Auth providers (omit to disable)
# GOOGLE_CLIENT_ID=...
# GOOGLE_CLIENT_SECRET=...
# DISCORD_CLIENT_ID=...
# DISCORD_CLIENT_SECRET=...

# Stripe (omit to disable billing — all features unlocked)
# STRIPE_SECRET_KEY=...
# STRIPE_WEBHOOK_SECRET=...

# Alchemy (omit to disable blockchain features)
# ALCHEMY_API_KEY=...

# HLS Streaming (requires FFmpeg installed in container)
# ENABLE_STREAMING=true

# Admin (first user to sign up becomes admin, or set explicitly)
# ADMIN_EMAIL=you@example.com
```

**Key design decision:** When `STRIPE_SECRET_KEY` is not set, all features are unlocked with no billing. Self-hosters get everything for free. This is the open-source value proposition — you can run your own VLM with no feature gates. The hosted version (vlm.gg) sets Stripe keys and gates premium features behind subscriptions.

### 16.5 Database Migrations

Drizzle ORM handles migrations. On first boot, the server auto-runs pending migrations:

```typescript
// apps/server/src/db/migrate.ts
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const sql = postgres(process.env.DATABASE_URL!)
const db = drizzle(sql)

await migrate(db, { migrationsFolder: './drizzle' })
console.log('Database migrations complete')
```

This runs automatically on server start. No manual migration step.

### 16.6 Storage Abstraction

To support Supabase Storage, S3, Cloudflare R2, and local filesystem interchangeably:

```typescript
// apps/server/src/storage/index.ts

export interface StorageProvider {
  upload(key: string, data: Buffer, contentType: string): Promise<string>  // returns public URL
  download(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
  getPublicUrl(key: string): string
  listObjects(prefix: string): Promise<string[]>
}

export function createStorageProvider(): StorageProvider {
  switch (process.env.STORAGE_PROVIDER || 'supabase') {
    case 'supabase':
      return new SupabaseStorageProvider()
    case 's3':
      return new S3StorageProvider()
    case 'r2':
      return new R2StorageProvider()
    case 'local':
      return new LocalStorageProvider()
    default:
      return new SupabaseStorageProvider()
  }
}
```

Supabase Storage is S3-compatible, so the S3 provider works with minor URL differences. But a dedicated Supabase provider uses the Supabase JS client for simpler setup (no AWS credentials needed).

### 16.7 One-Click Deploy Templates

#### Railway (Recommended)

Create a `railway.toml` in the repo root:

```toml
[build]
builder = "dockerfile"
dockerfilePath = "Dockerfile"

[deploy]
startCommand = "node dist/index.js"
healthcheckPath = "/api/health"
healthcheckTimeout = 30
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3
```

Add a "Deploy on Railway" button to the README:

```markdown
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/vlm)
```

The Railway template pre-configures:
- The VLM container from the Dockerfile
- A Supabase plugin (or instructions to connect external Supabase)
- An Upstash Redis plugin (optional)
- Environment variable prompts for `JWT_SECRET`, `PUBLIC_URL`

#### Render

Create a `render.yaml`:

```yaml
services:
  - type: web
    name: vlm
    runtime: docker
    plan: starter
    healthCheckPath: /api/health
    envVars:
      - key: DATABASE_URL
        sync: false
      - key: SUPABASE_URL
        sync: false
      - key: SUPABASE_ANON_KEY
        sync: false
      - key: SUPABASE_SERVICE_KEY
        sync: false
      - key: JWT_SECRET
        generateValue: true
      - key: PUBLIC_URL
        fromService:
          type: web
          name: vlm
          property: host
```

#### Fly.io

Create a `fly.toml`:

```toml
app = "vlm"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 3010
  force_https = true

  [http_service.concurrency]
    type = "connections"
    hard_limit = 1000
    soft_limit = 500

[[services]]
  protocol = "tcp"
  internal_port = 3010
  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]
```

#### Docker Compose (Self-Managed VPS)

For users who want to run everything on a single VPS with no managed services:

```yaml
# docker-compose.self-hosted.yml
services:
  vlm:
    build: .
    ports:
      - "3010:3010"
    environment:
      DATABASE_URL: postgresql://vlm:vlm@postgres:5432/vlm
      STORAGE_PROVIDER: local
      LOCAL_STORAGE_PATH: /data/uploads
      REDIS_URL: redis://redis:6379
      JWT_SECRET: ${JWT_SECRET:-change-me-to-a-random-string}
      PUBLIC_URL: ${PUBLIC_URL:-http://localhost:3010}
    volumes:
      - vlm-uploads:/data/uploads
    depends_on:
      - postgres
      - redis

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: vlm
      POSTGRES_USER: vlm
      POSTGRES_PASSWORD: vlm
    volumes:
      - vlm-pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine

volumes:
  vlm-pgdata:
  vlm-uploads:
```

This is the "I have a $5/mo VPS" option. No Supabase, no Upstash — just Postgres and Redis in Docker alongside VLM. Media files stored locally.

### 16.8 Dockerfile

```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install dependencies
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/vlm-shared/package.json packages/vlm-shared/
# ... other packages
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY . .
RUN pnpm turbo build

# Build Next.js dashboard as static export
RUN cd apps/web && pnpm next build && pnpm next export -o ../server/dashboard

# Stage 2: Runtime
FROM node:20-alpine AS runtime
WORKDIR /app

# Install FFmpeg (optional, for streaming)
RUN apk add --no-cache ffmpeg

# Copy built artifacts
COPY --from=builder /app/apps/server/dist ./dist
COPY --from=builder /app/apps/server/dashboard ./dashboard
COPY --from=builder /app/apps/server/drizzle ./drizzle
COPY --from=builder /app/apps/server/node_modules ./node_modules
COPY --from=builder /app/apps/server/package.json ./

EXPOSE 3010
CMD ["node", "dist/index.js"]
```

### 16.9 The 5-Minute Setup (User Guide)

This is what the README should walk the user through:

**Step 1: Create a Supabase project (2 minutes)**
1. Go to supabase.com, sign up, create a new project
2. Copy: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` from Settings → API

**Step 2: Deploy to Railway (1 minute)**
1. Click the "Deploy on Railway" button in the repo README
2. Paste your Supabase credentials when prompted
3. Railway assigns a public URL automatically

**Step 3: Open your VLM instance (30 seconds)**
1. Visit `https://your-vlm.railway.app`
2. Sign up (first user becomes admin)
3. Create a scene, add elements, deploy to a metaverse platform

**That's it.** Three steps. No CLI, no Docker knowledge, no AWS account.

For the Docker Compose option (self-managed VPS):

```bash
git clone https://github.com/virtuallandmanager/vlm.git
cd vlm
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
echo "PUBLIC_URL=http://your-server-ip:3010" >> .env
docker compose -f docker-compose.self-hosted.yml up -d
```

Four commands. Open `http://your-server-ip:3010` in a browser.

### 16.10 Monorepo Structure Update

The consolidated architecture changes the monorepo slightly:

```
vlm/
├── apps/
│   ├── server/                     # Consolidated: API + Colyseus + static dashboard
│   │   ├── src/
│   │   │   ├── index.ts            # Entry point (Fastify + Colyseus + static files)
│   │   │   ├── routes/             # Fastify route modules
│   │   │   ├── ws/                 # Colyseus rooms
│   │   │   ├── services/           # Business logic
│   │   │   ├── db/                 # Drizzle ORM schema + queries + auto-migration
│   │   │   ├── storage/            # Storage abstraction (Supabase/S3/R2/local)
│   │   │   ├── middleware/
│   │   │   ├── integrations/       # Stripe, Alchemy, platform hooks
│   │   │   └── workers/            # Optional: streaming FFmpeg worker
│   │   ├── drizzle/                # Migration files
│   │   ├── dashboard/              # Next.js static export (populated at build time)
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   ├── web/                        # Next.js dashboard (builds to static export)
│   │   └── ...                     # Same as before, but `next export` output goes to server/dashboard/
│   │
│   └── docs/                       # Documentation site
│
├── packages/
│   ├── vlm-shared/
│   ├── vlm-core/
│   ├── vlm-client/
│   ├── vlm-adapter-dcl/
│   ├── vlm-adapter-hyperfy/
│   └── vlm-adapter-threejs/
│
├── docker-compose.self-hosted.yml  # Full local stack (Postgres + Redis + VLM)
├── docker-compose.dev.yml          # Dev stack (just Postgres + Redis, apps run locally)
├── railway.toml                    # Railway one-click deploy
├── render.yaml                     # Render deploy config
├── fly.toml                        # Fly.io deploy config
├── Dockerfile                      # Production image
├── turbo.json
├── pnpm-workspace.yaml
├── .env.example
└── README.md
```

The key change: `apps/api` is renamed to `apps/server` and absorbs the static dashboard output. `apps/web` still exists as a separate development workspace but its build output is copied into `apps/server/dashboard/` during the Docker build.

### 16.11 Feature Flags via Environment

Self-hosters control which features are active entirely through environment variables:

| Feature | Env Var | Default | Behavior when unset |
|---------|---------|---------|-------------------|
| Billing | `STRIPE_SECRET_KEY` | unset | All features unlocked, no paywalls |
| Blockchain | `ALCHEMY_API_KEY` | unset | Wallet auth disabled, email/OAuth only |
| HLS Streaming | `ENABLE_STREAMING` | `false` | Stream management UI hidden |
| Google OAuth | `GOOGLE_CLIENT_ID` | unset | Google login button hidden |
| Discord OAuth | `DISCORD_CLIENT_ID` | unset | Discord login button hidden |
| Redis | `REDIS_URL` | unset | In-memory Colyseus presence (single-server only) |
| CDN | `CDN_URL` | unset | Media served directly from storage provider |

No `.env` file is required. If only `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `JWT_SECRET`, and `PUBLIC_URL` are set, you get a fully functional VLM instance with:
- Email/password auth
- Scene management (all element types)
- Real-time Colyseus sync
- Media upload and storage via Supabase
- Platform hooks for Second Life
- All adapter integrations working
- No billing gates

---

## Appendix A: Complete V1 Message Protocol

### Client → Server Messages

| Message Type | Data | Purpose |
|-------------|------|---------|
| `session_start` | `{ sessionToken, sceneId, ... }` | Initialize analytics session |
| `session_action` | `{ action, metadata, pathPoint, sessionToken }` | Record user action |
| `session_end` | `{}` | End analytics session |
| `scene_preset_update` | `{ action, element, instance, property, id, elementData, instanceData }` | Create/update/delete scene element |
| `scene_setting_update` | `{ settingType, value }` | Update scene setting |
| `scene_change_preset` | `{ sceneData, id: presetId }` | Switch active preset |
| `scene_add_preset_request` | `{ name }` | Create new preset |
| `scene_clone_preset_request` | `{ presetId }` | Clone existing preset |
| `scene_delete_preset_request` | `{ presetId }` | Delete preset |
| `scene_video_update` | `{ sk, status, url }` | Update video stream status |
| `scene_sound_locator` | `{ enabled }` | Toggle sound visualizers |
| `scene_create` | `{ sceneData }` | Create new scene |
| `scene_load_request` | `{ sceneId }` | Request scene data |
| `scene_delete` | `{ sceneId }` | Delete scene |
| `scene_update_property` | `{ property, value }` | Update scene property |
| `scene_moderator_message` | `{ message, style }` | Broadcast moderator message |
| `scene_moderator_crash` | `{ userId }` | Crash/disable user |
| `giveaway_claim` | `{ giveawayId, claimPointId }` | Claim giveaway item |
| `user_message` | `{ messageId, data }` | Custom inter-user messaging |
| `get_user_state` | `{ key }` | Get persistent state |
| `set_user_state` | `{ key, value }` | Set persistent state |
| `get_player_state` | `{ key }` | Get player state |
| `set_player_state` | `{ key, value }` | Set player state |
| `send_player_position` | `{ positionData }` | Respond to position request |
| `request_player_position` | `{}` | Request player positions |
| `path_start` | `{ pathData }` | Begin movement path tracking |
| `path_segments_add` | `{ segments }` | Add path segments |
| `path_end` | `{}` | End path tracking |
| `send_active_users` | `{}` | Request active user list |
| `set_admin_access` | `{ sceneId, adminAccess }` | Set admin access level |
| `send_access_invite` | `{ userId }` | Invite user to scene |
| `accept_access_invite` | `{ inviteId }` | Accept invite |
| `reject_access_invite` | `{ inviteId }` | Reject invite |
| `revoke_access` | `{ userId }` | Revoke user access |

### Server → Client Messages

| Message Type | Data | Purpose |
|-------------|------|---------|
| `session_started` | `{ session, user }` | Session initialized |
| `scene_preset_update` | `{ action, scenePreset, sceneSettings }` | Scene data (init or update) |
| `scene_change_preset` | `{ user, scene, preset }` | Preset switched |
| `scene_video_status` | `{ sk, status, url }` | Video stream status change |
| `scene_sound_locator` | `{ enabled }` | Sound locator toggle |
| `scene_moderator_message` | `{ message, style }` | Moderator message broadcast |
| `scene_moderator_crash` | `{}` | Crash command |
| `giveaway_claim_response` | `{ responseType, reason, giveawayId, sk }` | Claim result |
| `user_message` | `{ messageId, data }` | Custom message broadcast |
| `get_user_state` | `{ key, value }` | State value response |
| `set_user_state` | `{ key, success }` | State set confirmation |
| `send_active_users` | `{ activeUsers }` | Active user list |
| `request_player_position` | `{}` | Position request broadcast |
| `send_player_position` | `{ positionData }` | Player position data |
| `host_joined` | `{ displayName, connectedWallet }` | Host connected |
| `host_left` | `{ displayName, connectedWallet }` | Host disconnected |
| `add_session_action` | `{ action, metadata, pathPoint, displayName, timestamp }` | Action broadcast to hosts |
| `set_admin_access` | `{ sceneId, adminAccess }` | Admin access updated |

---

## Appendix B: Complete V1 Data Model

### DynamoDB PK/SK Patterns (vlm_main table)

All records use `pk` (partition key) and `sk` (sort key). The `pk` value identifies the entity type.

| Entity | PK Value | SK Value | Key Fields |
|--------|----------|----------|------------|
| Scene | `vlm:scene` | UUID | name, owner, orgId, scenePreset (active preset ID), presets[] |
| Scene Preset | `vlm:scene:preset` | UUID | name, videos[], images[], nfts[], sounds[], widgets[], claimPoints[], models[], locale |
| Scene Setting | `vlm:scene:setting` | UUID | type (SceneSettingType), value |
| Video Config | `vlm:scene:video` | UUID | liveSrc, isLive, enableLiveStream, playlist[], offImageSrc, offType, emission, volume, instances[] |
| Video Instance | `vlm:scene:video:instance` | UUID | position, rotation, scale, clickEvent, parent, customId, withCollisions, enabled |
| Image Config | `vlm:scene:image` | UUID | textureSrc, emission, transparency, clickEvent, instances[] |
| Image Instance | `vlm:scene:image:instance` | UUID | position, rotation, scale, clickEvent, parent, customId, withCollisions, enabled |
| NFT Config | `vlm:scene:nft` | UUID | contractAddress, tokenId, instances[] |
| NFT Instance | `vlm:scene:nft:instance` | UUID | position, rotation, scale, clickEvent, enabled |
| Sound Config | `vlm:scene:sound` | UUID | audioSrc, sourceType, volume, instances[] |
| Sound Instance | `vlm:scene:sound:instance` | UUID | position, rotation, scale, enabled |
| Model Config | `vlm:scene:model` | UUID | modelSrc, withCollisions, instances[] |
| Model Instance | `vlm:scene:model:instance` | UUID | position, rotation, scale, clickEvent, enabled |
| Widget Config | `vlm:scene:widget` | UUID | type (WidgetControlType), value, order |
| ClaimPoint Config | `vlm:scene:claimpoint` | UUID | giveawayId, type, properties, instances[] |
| ClaimPoint Instance | `vlm:scene:claimpoint:instance` | UUID | position, rotation, scale, enabled |
| User Account | `vlm:user:account` | UUID | displayName, email, role, registeredAt |
| User Wallet | `vlm:user:wallet` | Address | userId (links to account) |
| User Role | `vlm:user:role` | Role ID | userId, role |
| User Scene Link | `vlm:user:scene:link` | Link ID | userId, sceneId |
| User Session | `vlm:user:session` | UUID | userId, token, expiresAt |
| Organization | `vlm:organization:account` | UUID | name |
| Org User | `vlm:organization:user` | User ID | orgId, role |
| Org Balance | `vlm:organization:account:balance` | Balance ID | orgId, balance |
| Event | `vlm:event` | UUID | name, description, startTime, endTime, timezone |
| Event Scene Link | `vlm:event:scene:link` | Link ID | eventId, sceneId |
| Event Giveaway Link | `vlm:event:giveaway:link` | Link ID | eventId, giveawayId |
| Giveaway | `vlm:event:giveaway` | UUID | name, enabled, claimLimit, items[] |
| Giveaway Item | `vlm:event:giveaway:item` | UUID | giveawayId, contractAddress, tokenId |
| Giveaway Claim | `vlm:event:giveaway:claim` | UUID | giveawayId, userId, itemId, status |
| Transaction | `vlm:transaction` | UUID | type, amount, fromId, toId |
| Allocation | `vlm:allocation` | UUID | giveawayId, amount |
| History | `vlm:history` | UUID | entityId, action, before, after |
| Media Channel | `vlm:media:channel` | UUID | name, url |

### DynamoDB Analytics Table (vlm_analytics)

| Entity | PK Value | SK Value | Key Fields |
|--------|----------|----------|------------|
| Analytics Session | `vlm:analytics:session` | UUID | sceneId (GSI), userId, wallet, displayName, role, device, location, startTime, endTime |
| Analytics Action | `vlm:analytics:session:action` | UUID | sceneId (GSI), sessionId, name, metadata, pathPoint, timestamp |
| Analytics Aggregate | `vlm:analytics:aggregate` | `{date}:{scale}` | sceneId, count, scale (MINUTE/HOUR/DAY/WEEK/MONTH/YEAR) |
| Analytics Path | `vlm:analytics:path` | UUID | sessionId, sceneId, segments[], startTime, endTime |
| Analytics Path Segment | `vlm:analytics:path:segment` | UUID | pathId, segmentType, points[] |

### Analytics Path Point Format

Each path point is a tuple:
```
[x, y, z, timestamp_offset, rotation_x, rotation_y, pov_mode, camera_x, camera_y, camera_rotation_x, camera_rotation_y]
```

- Indices 0-2: Player position (x, y, z)
- Index 3: Timestamp offset from session start (seconds)
- Indices 4-5: Player rotation (x, y)
- Index 6: POV mode (-1, 0, 1, or 2)
- Indices 7-10: Camera position and rotation

---

## Appendix C: Complete V1 Enum Reference

```typescript
// Element Types
enum ElementType { VIDEO, IMAGE, NFT, MODEL, SOUND, WIDGET, CLAIM_POINT }

// Click Events
enum ClickEventType { NONE=0, EXTERNAL=1, SOUND=2, STREAM=3, MOVE=4, TELEPORT=5 }

// Widget Controls
enum WidgetControlType { NONE=0, TOGGLE=1, TEXT=2, SELECTOR=3, DATETIME=4, TRIGGER=5, SLIDER=6 }

// Video Sources
enum VideoSourceType { NONE=0, IMAGE=1, PLAYLIST=2, LIVE=3 }

// Sound Sources
enum SoundSourceType { CLIP=0, LOOP=1, PLAYLIST=2, STREAM=3 }

// Scene Settings
enum SceneSettingType { LOCALIZATION=0, MODERATION=1, INTEROPERABILITY=2, ACCESS=3 }

// User Roles
enum UserRole { BASIC=0, EARLY_ACCESS=1, ADVANCED=2, SCENE_ADMIN=3, ORG_ADMIN=4, VLM_CONTRACTOR=5, VLM_EMPLOYEE=6, VLM_ADMIN=7, GOD_MODE=10 }

// Analytics Session Roles
enum AnalyticsSessionRole { VISITOR=0, SCENE_ADMIN=1, ORG_ADMIN=2, VLM_CONTRACTOR=3, VLM_EMPLOYEE=4, VLM_ADMIN=5 }

// Analytics Segment Types
enum AnalyticsSegmentType { LOADING, IDLE, STATIONARY_DISENGAGED, STATIONARY_ENGAGED, RUNNING_DISENGAGED, WALKING_DISENGAGED, RUNNING_ENGAGED, WALKING_ENGAGED }

// Claim Point Types
enum ClaimPointType { MARKETPLACE_IMAGE=0, CUSTOM_IMAGE=1, MODEL=2, MANNEQUIN=3 }

// Mannequin Types
enum MannequinType { MALE=0, FEMALE=1, MATCH_PLAYER=2 }

// Analytics Aggregation Scales
enum AggregationScale { MINUTE, HOUR, DAY, WEEK, MONTH, YEAR }
```

---

## Appendix D: V1 API Route Reference

All routes from the v1 vlm-api. V2 should have equivalents for all of these plus the new media/streaming/billing routes.

### Authentication
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/auth/web3` | None | Get signature challenge token |
| POST | `/auth/login` | None | Submit signed token, receive JWT |
| GET | `/auth/refresh` | Refresh token | Get new access token |
| POST | `/auth/decentraland` | DCL signed fetch | Decentraland world auth |

### Users
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/user/vlm/update` | JWT | Update user profile |
| GET | `/user/notifications` | JWT | Get pending invites |
| POST | `/user/setup` | JWT | Initial user setup |

### Scenes
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/scene/cards` | JWT | List user's scenes |
| POST | `/scene/create` | JWT | Create scene |
| GET | `/scene/delete/:sceneId` | JWT | Delete scene |
| GET | `/scene/leave/:sceneId` | JWT | Leave shared scene |
| POST | `/scene/invite/user` | JWT | Invite collaborator |
| GET | `/scene/demo` | None | Get demo scene |
| GET | `/scene/:sceneId` | JWT | Get scene details |

### Events
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/event/all` | JWT | List user's events |
| POST | `/event/create` | JWT | Create event |
| POST | `/event/update` | JWT | Update event |
| GET | `/event/:eventId` | JWT | Get event details |
| POST | `/event/link/scene` | JWT | Link scene to event |
| POST | `/event/link/scenes` | JWT | Link multiple scenes |
| POST | `/event/link/giveaway` | JWT | Link giveaway to event |
| POST | `/event/link/giveaways` | JWT | Link multiple giveaways |
| POST | `/event/unlink/scene` | JWT | Unlink scene |
| POST | `/event/unlink/giveaway` | JWT | Unlink giveaway |

### Giveaways
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/giveaway/all` | JWT | List user's giveaways |
| POST | `/giveaway/create` | JWT | Create giveaway |
| POST | `/giveaway/update` | JWT | Update giveaway |
| POST | `/giveaway/item/add` | JWT | Add items to giveaway |

### Analytics
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/analytics/recent/:sceneId` | JWT | Recent metrics |
| GET | `/analytics/historical/:sceneId` | JWT | Historical metrics |
| GET | `/analytics/event-data/:eventId` | JWT | Export event CSV |
| GET | `/analytics/scene-sessions/:sceneId` | JWT | Export session CSV |

### Media
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/media/user/image` | JWT | Upload image |
| POST | `/media/user/avatar` | JWT | Upload avatar |
| GET | `/media/image/:sk/:file` | None | Get image |
| GET | `/media/avatar/:id` | None | Get avatar |
| GET | `/media/avatar/default.png` | None | Get default avatar |
| GET | `/media/demo-image/:id` | None | Get demo image |
| GET | `/media/demo-video/:id` | None | Get demo video |
| GET | `/media/guides/:id` | None | Get guide image |
| GET | `/media/channel/all` | JWT | List channels |
| POST | `/media/channel/add` | JWT | Add channel |

### Streams
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/stream/cards` | JWT | List user's streams |
| POST | `/stream/create` | JWT | Create stream |
| GET | `/stream/delete/:sceneId` | JWT | Delete stream |

### Balances
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/balance/user/all` | JWT | Get user balances |
| GET | `/balance/organization/all` | JWT | Get org balances |
| POST | `/balance/add` | JWT | Add credits |
| POST | `/balance/deduct` | JWT | Deduct credits |
| POST | `/balance/allocate` | JWT | Allocate to giveaway |
| POST | `/balance/deallocate` | JWT | Deallocate from giveaway |
| POST | `/balance/transfer` | JWT | Transfer credits |

### Promotions
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/promotion/claim` | JWT | Claim promo credits |

### Transactions
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/transaction/mine` | Alchemy webhook | Mined tx notification |
| POST | `/transaction/drop` | Alchemy webhook | Dropped tx notification |
| POST | `/transaction/transfer` | JWT | Transfer transaction |

### Collections (Decentraland NFTs)
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/collection/user` | JWT | Get user's DCL collections |
| GET | `/collection/:contractAddress` | JWT | Get collection details |
| GET | `/collection/:contractAddress/items` | JWT | Get collection items |

### Admin
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/admin/panel` | Admin | Get admin panel data |
| POST | `/admin/loginAs` | Admin | Impersonate user |
| GET | `/admin/server/restrictions` | Admin | Get server restrictions |
| GET | `/admin/logs` | Admin | Get admin logs |
| GET | `/admin/users` | Admin | List all users |
| GET | `/admin/events` | Admin | List all events |
| POST | `/admin/update` | Admin | Update organization |
| GET | `/admin/migrate/:pk` | Admin | Data migration |

### Logging
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/log/error` | JWT | Log client error |
| POST | `/log/warning` | JWT | Log client warning |
| POST | `/log/info` | JWT | Log client info |
| POST | `/log/wat` | JWT | Log WAT (Web Activity Tracking) |

### Session
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/session/end` | JWT | End analytics session |

### Health
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/_health` | None | Health check |
| GET | `/_status` | Admin (basic auth) | Colyseus monitor |
