# VLM V2 — Adapter Designs

Detailed implementation designs for three platform adapters built against the V2 monorepo architecture. Each adapter implements the `VLMPlatformAdapter` interface from `vlm-shared` and is used by `vlm-core` for platform-specific rendering.

Read the V2 Build Spec (`VLM_V2_BUILD_SPEC.md`) first — especially Phase 1 (shared types + platform contract), Phase 2 (core SDK), and Phase 3 (backend API).

---

## Table of Contents

1. [Architecture Recap](#1-architecture-recap)
2. [Decentraland Adapter](#2-decentraland-adapter)
3. [Hyperfy Adapter](#3-hyperfy-adapter)
4. [Second Life Adapter](#4-second-life-adapter)
5. [Shared Patterns](#5-shared-patterns)

---

## 1. Architecture Recap

In V2, the responsibilities are split cleanly:

```
vlm-shared        — Types, enums, VLMPlatformAdapter interface, message protocol
vlm-client        — Colyseus WebSocket + HTTP API client (auth, token refresh)
vlm-core          — VLM class, SceneManager, element managers (Video, Image, etc.)
                     Calls VLMPlatformAdapter methods for rendering.
vlm-adapter-*     — Implements VLMPlatformAdapter for a specific platform.
                     Only contains platform SDK calls. Zero business logic.
```

An adapter does NOT:
- Manage scene state (vlm-core does that)
- Handle Colyseus messages (vlm-core does that)
- Authenticate with the VLM API (vlm-client does that)
- Track analytics or path data (vlm-core does that)

An adapter ONLY:
- Creates/destroys platform entities
- Sets transforms, materials, meshes, video players, audio sources, colliders
- Handles platform-specific auth proofs (signed fetch, wallet signatures)
- Reports platform capabilities
- Provides platform user identity and scene metadata

Second Life is a special case — it cannot run JavaScript, so it doesn't use `vlm-core` or `vlm-client`. Its "adapter" is standalone LSL scripts that talk to the V2 API via HTTP. See Section 4.

---

## 2. Decentraland Adapter

**Package:** `packages/vlm-adapter-dcl`

### 2.1 Package Structure

```
vlm-adapter-dcl/
├── src/
│   ├── index.ts                 # createVLM() entry point + compat wrapper
│   ├── DclAdapter.ts            # VLMPlatformAdapter implementation
│   ├── services/
│   │   ├── EntityService.ts     # engine.addEntity / removeEntity
│   │   ├── TransformService.ts  # Transform.createOrReplace
│   │   ├── VideoService.ts      # VideoPlayer, videoEventsSystem, Material.Texture.Video
│   │   ├── MaterialService.ts   # Material.setPbrMaterial / setBasicMaterial
│   │   ├── MeshService.ts       # MeshRenderer, GltfContainer, NftShape
│   │   ├── AudioService.ts      # AudioSource
│   │   ├── ColliderService.ts   # MeshCollider, ColliderLayer
│   │   ├── ClickEventService.ts # pointerEventsSystem, RestrictedActions
│   │   ├── PlayerService.ts     # PlayerEntity, CameraEntity, PlayerIdentityData
│   │   ├── InputService.ts      # inputSystem
│   │   ├── SystemService.ts     # engine.addSystem / removeSystem
│   │   └── EmoteService.ts      # AvatarEmoteCommand, triggerEmote
│   └── auth/
│       └── DclAuthProof.ts      # signedFetch wrapper
├── package.json
└── tsconfig.json
```

### 2.2 Dependencies

```json
{
  "name": "vlm-adapter-dcl",
  "version": "2.0.0",
  "peerDependencies": {
    "@dcl/sdk": "~7.7.9",
    "vlm-shared": "workspace:*",
    "vlm-core": "workspace:*",
    "vlm-client": "workspace:*"
  },
  "dependencies": {
    "colyseus.js": "^0.15.26"
  }
}
```

### 2.3 DclAdapter Implementation

```typescript
// packages/vlm-adapter-dcl/src/DclAdapter.ts

import {
  VLMPlatformAdapter,
  PlatformCapabilities,
  PlatformUser,
  AuthProof,
  SceneInfo,
  PlatformEnvironment,
  EntityHandle,
  TransformData,
  MaterialData,
  VideoMaterialData,
  VideoPlayerOptions,
  VideoState,
  AudioOptions,
  ColliderOptions,
  PointerOptions,
  PointerCallback,
} from 'vlm-shared'

import { EntityService } from './services/EntityService'
import { TransformService } from './services/TransformService'
import { VideoService } from './services/VideoService'
import { MaterialService } from './services/MaterialService'
import { MeshService } from './services/MeshService'
import { AudioService } from './services/AudioService'
import { ColliderService } from './services/ColliderService'
import { ClickEventService } from './services/ClickEventService'
import { PlayerService } from './services/PlayerService'
import { DclAuthProof } from './auth/DclAuthProof'

export class DclAdapter implements VLMPlatformAdapter {

  readonly capabilities: PlatformCapabilities = {
    video: true,
    spatialAudio: true,
    gltfModels: true,
    customEmotes: true,
    playerTeleport: true,
    externalUrls: true,
    nftDisplay: true,
    colliders: true,
    platformName: 'decentraland',
    platformVersion: '7',
  }

  // --- Identity & Auth ---

  async getPlatformUser(): Promise<PlatformUser> {
    // Use getPlayer() (SDK 7.4+) with fallback
    try {
      const { getPlayer } = await import('@dcl/sdk/players')
      const player = getPlayer()
      return {
        id: player?.userId ?? '',
        displayName: player?.name,
        walletAddress: player?.userId,
        isGuest: player?.isGuest ?? true,
      }
    } catch {
      // Fallback for older SDK
      const { getUserData } = await import('~system/UserIdentity')
      const data = await getUserData({})
      return {
        id: data.data?.userId ?? '',
        displayName: data.data?.displayName,
        walletAddress: data.data?.publicKey,
        isGuest: !data.data?.hasConnectedWeb3,
      }
    }
  }

  async getAuthProof(): Promise<AuthProof> {
    return DclAuthProof.create()
  }

  // --- Scene Metadata ---

  async getSceneInfo(): Promise<SceneInfo> {
    const { getSceneInformation } = await import('~system/Runtime')
    const info = await getSceneInformation({})
    const metadata = JSON.parse(info.metadataJson)
    return {
      sceneId: metadata.vlm?.sceneId ?? '',
      platformSceneId: info.urn,
      location: metadata.scene?.base,
      metadata: {
        parcels: metadata.scene?.parcels,
        title: metadata.display?.title,
        runtimeVersion: metadata.runtimeVersion,
      },
    }
  }

  async getEnvironment(): Promise<PlatformEnvironment> {
    const { isPreviewMode, getPlatform, getCurrentRealm } = await import('~system/EnvironmentApi')
    const [preview, platform, realm] = await Promise.all([
      isPreviewMode({}),
      getPlatform({}),
      getCurrentRealm({}),
    ])
    return {
      isPreview: preview.isPreview,
      platform: platform.platform,
      realm: realm.currentRealm,
    }
  }

  // --- Entity Lifecycle ---

  createEntity(): EntityHandle {
    return EntityService.create()
  }

  destroyEntity(handle: EntityHandle): void {
    EntityService.destroy(handle as number)
  }

  entityExists(handle: EntityHandle): boolean {
    return EntityService.exists(handle as number)
  }

  // --- Transform ---

  setTransform(entity: EntityHandle, transform: TransformData): void {
    TransformService.set(entity as number, transform)
  }

  // --- Rendering ---

  setPlaneRenderer(entity: EntityHandle): void {
    MeshService.setPlane(entity as number)
  }

  setGltfModel(entity: EntityHandle, src: string): void {
    MeshService.setGltf(entity as number, src)
  }

  setMaterial(entity: EntityHandle, material: MaterialData): void {
    MaterialService.set(entity as number, material)
  }

  setVideoMaterial(entity: EntityHandle, video: VideoMaterialData): void {
    VideoService.setVideoMaterial(entity as number, video)
  }

  // --- Video ---

  createVideoPlayer(entity: EntityHandle, options: VideoPlayerOptions): void {
    VideoService.createPlayer(entity as number, options)
  }

  updateVideoSource(entity: EntityHandle, src: string): void {
    VideoService.updateSource(entity as number, src)
  }

  setVideoVolume(entity: EntityHandle, volume: number): void {
    VideoService.setVolume(entity as number, volume)
  }

  getVideoState(entity: EntityHandle): VideoState {
    return VideoService.getState(entity as number)
  }

  // --- Audio ---

  setAudioSource(entity: EntityHandle, options: AudioOptions): void {
    AudioService.set(entity as number, options)
  }

  playAudio(entity: EntityHandle): void {
    AudioService.play(entity as number)
  }

  stopAudio(entity: EntityHandle): void {
    AudioService.stop(entity as number)
  }

  // --- Physics ---

  setCollider(entity: EntityHandle, options: ColliderOptions): void {
    ColliderService.set(entity as number, options)
  }

  removeCollider(entity: EntityHandle): void {
    ColliderService.remove(entity as number)
  }

  // --- Input ---

  onPointerDown(entity: EntityHandle, options: PointerOptions, cb: PointerCallback): void {
    ClickEventService.onPointerDown(entity as number, options, cb)
  }

  removePointerEvents(entity: EntityHandle): void {
    ClickEventService.remove(entity as number)
  }

  // --- Player Actions ---

  async openUrl(url: string): Promise<void> {
    const { openExternalUrl } = await import('~system/RestrictedActions')
    openExternalUrl({ url })
  }

  async teleportPlayer(destination: string): Promise<void> {
    const { requestTeleport } = await import('~system/UserActionModule')
    requestTeleport({ destination })
  }

  async movePlayer(position: { x: number; y: number; z: number }, cameraTarget?: { x: number; y: number; z: number }): Promise<void> {
    const { movePlayerTo } = await import('~system/RestrictedActions')
    const { Vector3 } = await import('@dcl/sdk/math')
    const opts: any = { newRelativePosition: Vector3.create(position.x, position.y, position.z) }
    if (cameraTarget) {
      opts.cameraTarget = Vector3.create(cameraTarget.x, cameraTarget.y, cameraTarget.z)
    }
    movePlayerTo(opts)
  }

  async triggerEmote(emoteId: string): Promise<void> {
    const { triggerEmote } = await import('~system/RestrictedActions')
    triggerEmote({ predefinedEmote: emoteId })
  }

  // --- Frame Loop ---

  registerSystem(update: (dt: number) => void): void {
    const { engine } = require('@dcl/sdk/ecs')
    engine.addSystem(update)
  }

  unregisterSystem(update: (dt: number) => void): void {
    const { engine } = require('@dcl/sdk/ecs')
    engine.removeSystem(update)
  }
}
```

### 2.4 Entry Point

```typescript
// packages/vlm-adapter-dcl/src/index.ts

import { VLM } from 'vlm-core'
import { VLMClient } from 'vlm-client'
import { DclAdapter } from './DclAdapter'
import type { VLMInitConfig } from 'vlm-shared'

export async function createVLM(config?: Partial<VLMInitConfig>): Promise<VLM> {
  const adapter = new DclAdapter()
  const vlm = new VLM(adapter)
  await vlm.init(config ?? { env: 'prod' })
  return vlm
}

// Backward-compatible default export for v1 migration
const VLMCompat = {
  init: async (config?: Partial<VLMInitConfig>) => {
    const vlm = await createVLM(config)
    return vlm.storage
  },
}
export default VLMCompat

export { DclAdapter }
export type { VLMInitConfig }
```

### 2.5 Auth Proof

```typescript
// packages/vlm-adapter-dcl/src/auth/DclAuthProof.ts

import type { AuthProof } from 'vlm-shared'

export class DclAuthProof {
  static async create(): Promise<AuthProof> {
    const { signedFetch } = await import('~system/SignedFetch')
    return {
      type: 'signed-fetch',
      payload: { signedFetch },
    }
  }
}
```

### 2.6 Usage in a Decentraland Scene

```typescript
// In a Decentraland SDK 7 scene:
import { createVLM } from 'vlm-adapter-dcl'

const vlm = await createVLM()

// All scene elements render automatically via vlm-core + DclAdapter

// Developer APIs:
vlm.sendMessage('game-event', { score: 100 })
vlm.onMessage('game-event', (data) => console.log(data))
vlm.setState('high-score', 9999)
const score = await vlm.getState('high-score')
vlm.recordAction('level-complete', { level: 3 })

// Direct element access:
vlm.storage.videos.configs['my-screen'].updateVolume(0.5)
```

---

## 3. Hyperfy Adapter

**Package:** `packages/vlm-adapter-hyperfy`

### 3.1 The React Problem

Hyperfy V1 uses React JSX for rendering. The `VLMPlatformAdapter` interface is imperative (`createEntity()`, `setTransform()`). These paradigms don't mix directly.

**Solution:** The Hyperfy adapter implements `VLMPlatformAdapter` with a **virtual scene graph** that translates imperative calls into React state updates. The adapter maintains a map of entities and their properties. A React component reads this map and renders the corresponding JSX.

```
vlm-core calls adapter.createEntity() / setTransform() / createVideoPlayer()
    ↓
DclAdapter: directly calls ECS APIs (imperative — works naturally)
HyperfyAdapter: updates an internal entity map, triggers React re-render
    ↓
HyperfyRenderer component reads entity map → renders <video>, <image>, <model>, etc.
```

### 3.2 Package Structure

```
vlm-adapter-hyperfy/
├── src/
│   ├── index.js                  # createVLM() entry point
│   ├── HyperfyAdapter.js         # VLMPlatformAdapter implementation
│   ├── HyperfyRenderer.js        # React component that reads the entity map
│   ├── EntityStore.js            # Observable entity map (adapter writes, renderer reads)
│   ├── elements/
│   │   ├── VideoElement.js       # <video> renderer with live/playlist/image modes
│   │   ├── ImageElement.js       # <image> renderer
│   │   ├── ModelElement.js       # <model> renderer
│   │   ├── SoundElement.js       # <audio> renderer
│   │   └── ClickHandler.js       # Click event helper
│   └── auth/
│       └── HyperfyAuthProof.js   # world.http() based auth
├── app.json
└── package.json
```

### 3.3 EntityStore — The Bridge Between Imperative and Declarative

```javascript
// packages/vlm-adapter-hyperfy/src/EntityStore.js

// A simple observable store that the adapter writes to and the React renderer reads from.
// When the adapter calls createEntity() or setTransform(), the store updates
// and notifies the renderer to re-render.

let nextEntityId = 1
const entities = new Map()
let listener = null

export class EntityStore {
  static subscribe(callback) {
    listener = callback
  }

  static notify() {
    if (listener) listener()
  }

  static createEntity() {
    const id = nextEntityId++
    entities.set(id, {
      id,
      type: null,        // 'video', 'image', 'model', 'audio', 'plane'
      transform: null,
      material: null,
      video: null,
      audio: null,
      collider: null,
      model: null,
      pointerDown: null,
      destroyed: false,
    })
    this.notify()
    return id
  }

  static destroyEntity(id) {
    const entity = entities.get(id)
    if (entity) {
      entity.destroyed = true
      this.notify()
      // Defer actual removal to allow React cleanup
      setTimeout(() => entities.delete(id), 0)
    }
  }

  static getEntity(id) {
    return entities.get(id)
  }

  static updateEntity(id, updates) {
    const entity = entities.get(id)
    if (entity) {
      Object.assign(entity, updates)
      this.notify()
    }
  }

  static getAllEntities() {
    return Array.from(entities.values()).filter(e => !e.destroyed)
  }
}
```

### 3.4 HyperfyAdapter Implementation

```javascript
// packages/vlm-adapter-hyperfy/src/HyperfyAdapter.js

import { EntityStore } from './EntityStore'

export class HyperfyAdapter {
  constructor(world) {
    this.world = world
  }

  capabilities = {
    video: true,
    spatialAudio: true,
    gltfModels: true,
    customEmotes: false,
    playerTeleport: false,
    externalUrls: true,
    nftDisplay: false,
    colliders: true,
    platformName: 'hyperfy',
    platformVersion: '1',
  }

  // --- Identity & Auth ---

  async getPlatformUser() {
    const avatar = this.world.getAvatar?.() ?? {}
    return {
      id: avatar.id || avatar.uid || '',
      displayName: avatar.name || avatar.displayName || 'Guest',
      walletAddress: avatar.wallet || null,
      isGuest: !avatar.wallet,
    }
  }

  async getAuthProof() {
    // Hyperfy uses world.http() for auth — vlm-client will pass the world instance
    return {
      type: 'platform-token',
      payload: { world: this.world },
    }
  }

  async getSceneInfo() {
    return {
      sceneId: '',  // Set by VLM.init() config
      platformSceneId: this.world.getSlug?.() || '',
      location: this.world.getSlug?.() || '',
      metadata: {
        shard: this.world.getShard?.() || '',
        sdkVersion: '2.40.0',
      },
    }
  }

  async getEnvironment() {
    return {
      isPreview: false,
      platform: 'hyperfy',
    }
  }

  // --- Entity Lifecycle ---

  createEntity() {
    return EntityStore.createEntity()
  }

  destroyEntity(handle) {
    EntityStore.destroyEntity(handle)
  }

  entityExists(handle) {
    return !!EntityStore.getEntity(handle)
  }

  // --- Transform ---

  setTransform(entity, transform) {
    EntityStore.updateEntity(entity, { transform })
  }

  // --- Rendering ---

  setPlaneRenderer(entity) {
    EntityStore.updateEntity(entity, { type: 'plane' })
  }

  setGltfModel(entity, src) {
    EntityStore.updateEntity(entity, { type: 'model', model: { src } })
  }

  setMaterial(entity, material) {
    EntityStore.updateEntity(entity, { material })
  }

  setVideoMaterial(entity, video) {
    EntityStore.updateEntity(entity, { type: 'video', video })
  }

  // --- Video ---

  createVideoPlayer(entity, options) {
    EntityStore.updateEntity(entity, {
      type: 'video',
      video: { ...options },
    })
  }

  updateVideoSource(entity, src) {
    const e = EntityStore.getEntity(entity)
    if (e?.video) {
      EntityStore.updateEntity(entity, {
        video: { ...e.video, src },
      })
    }
  }

  setVideoVolume(entity, volume) {
    const e = EntityStore.getEntity(entity)
    if (e?.video) {
      EntityStore.updateEntity(entity, {
        video: { ...e.video, volume },
      })
    }
  }

  getVideoState(entity) {
    return EntityStore.getEntity(entity)?.video?.state || 'none'
  }

  // --- Audio ---

  setAudioSource(entity, options) {
    EntityStore.updateEntity(entity, {
      type: 'audio',
      audio: { ...options },
    })
  }

  playAudio(entity) {
    const e = EntityStore.getEntity(entity)
    if (e?.audio) {
      EntityStore.updateEntity(entity, {
        audio: { ...e.audio, playing: true },
      })
    }
  }

  stopAudio(entity) {
    const e = EntityStore.getEntity(entity)
    if (e?.audio) {
      EntityStore.updateEntity(entity, {
        audio: { ...e.audio, playing: false },
      })
    }
  }

  // --- Physics ---

  setCollider(entity, options) {
    EntityStore.updateEntity(entity, { collider: options })
  }

  removeCollider(entity) {
    EntityStore.updateEntity(entity, { collider: null })
  }

  // --- Input ---

  onPointerDown(entity, options, cb) {
    EntityStore.updateEntity(entity, { pointerDown: { options, callback: cb } })
  }

  removePointerEvents(entity) {
    EntityStore.updateEntity(entity, { pointerDown: null })
  }

  // --- Player Actions ---

  openUrl(url) {
    window.open(url, '_blank')
  }

  teleportPlayer() { /* not supported */ }
  movePlayer() { /* not supported */ }
  triggerEmote() { /* not supported */ }

  // --- Frame Loop ---

  _systems = []

  registerSystem(update) {
    this._systems.push(update)
    // Hyperfy's world.onUpdate handles the frame loop
  }

  unregisterSystem(update) {
    this._systems = this._systems.filter(s => s !== update)
  }

  tick(dt) {
    this._systems.forEach(fn => fn(dt))
  }
}
```

### 3.5 HyperfyRenderer — React Component

```jsx
// packages/vlm-adapter-hyperfy/src/HyperfyRenderer.js

import React, { useState, useEffect, useCallback } from 'react'
import { EntityStore } from './EntityStore'
import { VideoElement } from './elements/VideoElement'
import { ImageElement } from './elements/ImageElement'
import { ModelElement } from './elements/ModelElement'
import { SoundElement } from './elements/SoundElement'

export function HyperfyRenderer() {
  const [, forceUpdate] = useState(0)

  useEffect(() => {
    EntityStore.subscribe(() => forceUpdate(n => n + 1))
  }, [])

  const entities = EntityStore.getAllEntities()

  return (
    <>
      {entities.map(entity => {
        if (!entity.transform) return null

        const pos = entity.transform.position
        const rot = entity.transform.rotation
        const scale = entity.transform.scale
        const position = [pos.x, pos.y, pos.z]
        const rotation = [rot.x, rot.y, rot.z]

        const onPointerDown = entity.pointerDown
          ? () => entity.pointerDown.callback()
          : undefined
        const hint = entity.pointerDown?.options?.hoverText

        switch (entity.type) {
          case 'video':
            return (
              <app key={entity.id} position={position} rotation={rotation}>
                <VideoElement entity={entity} onPointerDown={onPointerDown} hint={hint} />
              </app>
            )
          case 'image':
          case 'plane':
            return (
              <app key={entity.id} position={position} rotation={rotation}>
                <ImageElement entity={entity} onPointerDown={onPointerDown} hint={hint} />
              </app>
            )
          case 'model':
            return (
              <app key={entity.id} position={position} rotation={rotation}>
                <ModelElement entity={entity} onPointerDown={onPointerDown} hint={hint} />
              </app>
            )
          case 'audio':
            return (
              <app key={entity.id} position={position} rotation={rotation}>
                <SoundElement entity={entity} />
              </app>
            )
          default:
            return null
        }
      })}
    </>
  )
}
```

### 3.6 VideoElement — Dynamic Video with Live/Playlist/Image

```jsx
// packages/vlm-adapter-hyperfy/src/elements/VideoElement.js

import React from 'react'

export function VideoElement({ entity, onPointerDown, hint }) {
  const { video } = entity
  if (!video) return null

  const scale = entity.transform?.scale
  const width = scale?.x || 2
  const height = scale?.y || 1.125

  // The video.src is set by vlm-core's VideoManager which handles
  // live/playlist/image switching. The adapter just renders whatever src is current.
  if (video.isImage) {
    return (
      <image
        src={video.src}
        width={width}
        height={height}
        onPointerDown={onPointerDown}
        onPointerDownHint={hint}
      />
    )
  }

  return (
    <video
      src={video.src}
      width={width}
      height={height}
      autoplay
      loop={video.loop ?? false}
      volume={video.volume ?? 1}
      onPointerDown={onPointerDown}
      onPointerDownHint={hint}
    />
  )
}
```

### 3.7 Entry Point

```jsx
// packages/vlm-adapter-hyperfy/src/index.js

import React, { useEffect, useRef } from 'react'
import { useWorld, useFields } from 'hyperfy'
import { VLM } from 'vlm-core'
import { HyperfyAdapter } from './HyperfyAdapter'
import { HyperfyRenderer } from './HyperfyRenderer'

export default function VLMApp() {
  const world = useWorld()
  const fields = useFields()
  const vlmRef = useRef(null)

  useEffect(() => {
    if (!world.isServer) return
    if (!fields.sceneId || fields.sceneId === '00000000-0000-0000-0000-000000000000') return

    const adapter = new HyperfyAdapter(world)
    const vlm = new VLM(adapter)
    vlmRef.current = vlm

    vlm.init({
      env: fields.env || 'prod',
      sceneId: fields.sceneId,
      debug: fields.debug,
    })

    // Tick the adapter's frame loop systems
    const unsubscribe = world.onUpdate((dt) => {
      adapter.tick(dt)
    })

    return () => {
      vlm.destroy()
      unsubscribe()
    }
  }, [fields.sceneId])

  return (
    <app>
      <HyperfyRenderer />
    </app>
  )
}

export const getStore = (state = {}) => ({
  state,
  actions: {},
  fields: [
    { type: 'section', label: 'Virtual Land Manager' },
    {
      type: 'text', key: 'sceneId', label: 'Scene ID',
      initial: '00000000-0000-0000-0000-000000000000',
      placeholder: 'Paste Scene ID from vlm.gg',
      instant: false,
    },
    { type: 'section', label: 'Advanced' },
    {
      type: 'switch', key: 'env', label: 'Environment',
      options: [
        { label: 'Production', value: 'prod' },
        { label: 'Staging', value: 'staging' },
        { label: 'Dev', value: 'dev' },
      ],
      initial: 'prod',
    },
    {
      type: 'switch', key: 'debug', label: 'Debug',
      options: [{ label: 'Off', value: false }, { label: 'On', value: true }],
      initial: false,
    },
  ],
})
```

### 3.8 Key Design Decision: Where Does Video Mode Switching Happen?

In V2, the **VideoManager in vlm-core** handles live/playlist/image switching — not the adapter. When the API broadcasts `scene_video_status` with `isLive: false`, vlm-core's VideoManager:

1. Checks `offType` on the video config
2. If `offType === IMAGE`: calls `adapter.setVideoMaterial(entity, { src: offImageSrc, isImage: true })`
3. If `offType === PLAYLIST`: calls `adapter.updateVideoSource(entity, playlist[currentIndex])`
4. If `offType === NONE`: calls `adapter.destroyEntity(entity)` or hides it

The adapter doesn't need to know about video modes. It just renders whatever `src` vlm-core tells it to render. This is why the `VideoElement` component above is simple — it renders `video.src` and checks `video.isImage` to decide between `<video>` and `<image>`.

---

## 4. Second Life Adapter

### 4.1 Why It's Different

Second Life cannot run JavaScript. There is no `vlm-core`, no `vlm-client`, no `VLMPlatformAdapter`. The SL integration is **standalone LSL scripts** that talk directly to the V2 API via HTTP.

However, the V2 API provides dedicated endpoints (the platform hooks from Section 15 of the build spec) that serve the same function as the Colyseus room — just over HTTP push instead of WebSocket.

### 4.2 V2-Compatible LSL Scripts

The V2 scripts differ from the V1 scripts in:

1. **Endpoint paths** — use V2 paths (`/hook/register` not `/hook/sl/register`)
2. **Data shapes** — expect V2 element format (`id` not `sk`, properties from JSONB)
3. **Auth** — register with `platform: 'secondlife'` for the generic hook system

### 4.3 V2 Data Shape Mapping

The V2 API should serialize hook responses in a **compact format** designed for LSL's 16KB limit.

V2 video element (from `scene_elements` table):
```json
{
  "id": "uuid",
  "type": "video",
  "name": "Main Screen",
  "enabled": true,
  "customId": "main-screen",
  "properties": {
    "liveSrc": "https://stream.example.com/live.m3u8",
    "isLive": false,
    "enableLiveStream": true,
    "offImageSrc": "https://example.com/offline.png",
    "offType": 1,
    "playlist": ["https://example.com/v1.mp4"],
    "volume": 80
  }
}
```

For the SL hook response, the API flattens `properties` to top-level fields (same as the hook spec in the build doc):
```json
{
  "id": "uuid",
  "liveSrc": "https://stream.example.com/live.m3u8",
  "isLive": false,
  "offImageSrc": "https://example.com/offline.png",
  "offType": 1,
  "playlist": ["https://example.com/v1.mp4"],
  "volume": 80
}
```

### 4.4 V2 LSL Script Changes from V1

The V2 LSL scripts are nearly identical to V1 with these differences:

```lsl
// V1:
string CONFIG_API_URL = "https://api.vlm.gg";
// V2:
string CONFIG_API_URL = "https://api.vlm.gg/v2";

// V1 registration:
gRegisterReqId = llHTTPRequest(CONFIG_API_URL + "/hook/sl/register", ...);
// V2 registration:
gRegisterReqId = llHTTPRequest(CONFIG_API_URL + "/hook/register", ...);

// V1 config poll:
string url = CONFIG_API_URL + "/hook/sl/config?sceneId=...";
// V2 config poll:
string url = CONFIG_API_URL + "/hook/config?sceneId=...";

// V1 scene poll (controller):
string url = CONFIG_API_URL + "/hook/sl/scene?sceneId=...";
// V2 scene poll:
string url = CONFIG_API_URL + "/hook/scene?sceneId=...";

// V1 element ID field:
string videoId = jsonGetString(body, "sk");
// V2 element ID field:
string videoId = jsonGetString(body, "id");
```

That's it. The push notification format is the same (defined in V2 spec Section 15). The MOAP rendering logic doesn't change at all.

### 4.5 V2-Compatible Script Template

Rather than full scripts (which are already written in `/vlm-sl/scripts/`), here's the minimal diff to upgrade them:

```lsl
// In each script, change these lines:

// Old (V1):
string CONFIG_API_URL = "https://api.vlm.gg";
// New (V2):
string CONFIG_API_URL = "https://api.vlm.gg/v2";

// In registerCallback():
// Old:
gRegisterReqId = llHTTPRequest(CONFIG_API_URL + "/hook/sl/register", ...);
// New:
gRegisterReqId = llHTTPRequest(CONFIG_API_URL + "/hook/register", ...);

// In pollConfig():
// Old:
string url = CONFIG_API_URL + "/hook/sl/config?...";
// New:
string url = CONFIG_API_URL + "/hook/config?...";
```

---

## 5. Shared Patterns

### 5.1 How vlm-core Drives the Adapters

The flow is identical regardless of platform:

```
1. createVLM(config)
2. vlm-core creates VLM instance with the adapter
3. vlm-client authenticates (using adapter.getAuthProof())
4. vlm-client joins Colyseus room
5. Server sends 'scene_preset_update' with action 'init'
6. vlm-core's SceneManager routes to element managers
7. VideoManager iterates video configs:
   for each config:
     entity = adapter.createEntity()
     adapter.setPlaneRenderer(entity)
     adapter.setTransform(entity, instance.transform)
     adapter.createVideoPlayer(entity, { src, volume, loop })
8. When 'scene_video_status' arrives:
   VideoManager.updateLiveState(videoId, isLive)
     if isLive:  adapter.updateVideoSource(entity, config.liveSrc)
     if !isLive:  adapter.updateVideoSource(entity, config.offImageSrc)  // or playlist
9. When 'scene_preset_update' with action 'update' arrives:
   VideoManager.updateInstance(instanceId, property, value)
     adapter.setTransform(entity, newTransform)  // if position changed
     adapter.setVideoVolume(entity, newVolume)   // if volume changed
```

The adapter never makes decisions about what to render. It's a pure rendering slave to vlm-core.

### 5.2 Platform Capability Graceful Degradation

When vlm-core's VideoManager initializes, it checks `adapter.capabilities.video`. If false, it skips all video elements entirely — no errors, no empty renders.

Same for every element type:
- `capabilities.gltfModels === false` → MeshManager skips model elements
- `capabilities.spatialAudio === false` → SoundManager skips sound elements
- `capabilities.colliders === false` → no colliders set on any entity
- `capabilities.externalUrls === false` → click events with external links are suppressed

### 5.3 Adding a New Platform

To add support for a new metaverse platform (e.g., VRChat if they add HTTP):

1. Create `packages/vlm-adapter-vrchat/`
2. Implement `VLMPlatformAdapter` using UdonSharp APIs
3. Set `capabilities` accurately
4. Implement `getAuthProof()` — return `{ type: 'api-key', payload: { key: '...' } }` if no platform auth
5. Export `createVLM()` entry point
6. Publish as `vlm-adapter-vrchat`

For HTTP-only platforms (like Second Life), create LSL/Lua/C# scripts that talk to `/hook/register` and `/hook/config`. No vlm-core needed.

### 5.4 Testing Strategy

Each adapter should have:
1. **Unit tests** with a mocked `vlm-core` that calls adapter methods and verifies the platform API was called correctly
2. **Integration tests** in the actual platform (DCL preview, Hyperfy dev server) that verify elements render
3. **Capability tests** that verify graceful degradation when features are missing

vlm-core should have:
1. **Unit tests** with a mock adapter that records all calls — verify the correct adapter methods are called for each Colyseus message
2. **Protocol tests** that verify message parsing matches the V2 spec
