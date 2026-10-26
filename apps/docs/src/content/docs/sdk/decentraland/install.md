---
title: Decentraland Setup
description: Install and configure VLM in a Decentraland SDK 7 scene
---

## Analytics only (one line)

```ts
import { startVLMAnalytics } from '@virvixr/adapter-dcl/analytics'
startVLMAnalytics()
```

This starts collecting visits, movement, interactions, video and emote analytics. No VLM account is needed. When you're ready, sign in to the dashboard with the wallet that owns the LAND or World and **claim** the scene to see its data. `createVLM()` also starts analytics by default (`createVLM({ analytics: false })` turns it off). Visitors never see VLM setup screens: only the LAND or World owner does.

Track your own events with `vlm.track('bought_ticket', { tier: 'vip' })`.

## Installation

```bash
npm install vlm-adapter-dcl vlm-core vlm-client vlm-shared
```

**Peer dependency:** `@dcl/sdk >=7.26.0` (the HUD scales with the SDK's virtual canvas, so it isn't tiny on high-DPI screens).

The HUD's launcher icon loads from `images/virvi/hud-v.png` in your scene. Run `npx vlm-dcl install` in the scene folder to copy it there (`npx vlm-dcl sync` keeps it up to date), and deploy it with the scene.

## Basic Usage

```typescript
import { createVLM } from '@virvixr/adapter-dcl'

const vlm = await createVLM()
```

That's it. All scene elements configured in the VLM dashboard render automatically.

## Configuration

```typescript
const vlm = await createVLM({
  env: 'prod',        // 'dev' | 'staging' | 'prod'
  sceneId: 'uuid',    // Override scene ID (default: from scene.json metadata)
  debug: true,        // Enable debug logging
})
```

Editing in-world needs VLM set up at the scene's location. A `sceneId` set here, or in `scene.json`, still shows that scene's content anywhere, but you can edit it from the HUD only where it's the scene set up at that parcel or World. Anywhere else the HUD shows "Set up VLM at this location to edit".

### Scene Metadata

Add your VLM scene ID to `scene.json`:

```json
{
  "vlm": {
    "sceneId": "645c3a07-5d49-469f-88f3-1636fd55e701"
  }
}
```

If omitted, you must pass `sceneId` in the config.

## V1 Migration

If migrating from VLM V1:

```typescript
// V1:
import VLM from '@virvixr/dcl'
await VLM.init()

// V2 (compatible wrapper):
import VLM from '@virvixr/adapter-dcl'
const storage = await VLM.init()
```

The default export provides a backward-compatible `init()` that returns `vlm.storage`.

## Developer APIs

```typescript
// Custom messaging between players
vlm.sendMessage('game-event', { score: 100 })
vlm.onMessage('game-event', (data) => console.log(data))

// Analytics
vlm.track('level-complete', { level: 3 })

// Direct element access
vlm.storage.videos.configs['my-screen']
```

## Platform Capabilities

The Decentraland adapter reports:

| Capability | Supported |
|-----------|-----------|
| Video | Yes |
| Spatial Audio | Yes |
| glTF Models | Yes |
| Custom Emotes | Yes |
| Player Teleport | Yes |
| External URLs | Yes |
| NFT Display | Yes |
| Colliders | Yes |
| Screen-Space UI | Yes |
