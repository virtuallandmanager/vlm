---
title: Decentraland Setup
description: Install and configure VLM in a Decentraland SDK 7 scene
---

## Installation

```bash
npm install vlm-adapter-dcl vlm-core vlm-client vlm-shared
```

**Peer dependency:** `@dcl/sdk ~7.7.9`

## Basic Usage

```typescript
import { createVLM } from 'vlm-adapter-dcl'

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
import VLM from 'vlm-dcl'
await VLM.init()

// V2 (compatible wrapper):
import VLM from 'vlm-adapter-dcl'
const storage = await VLM.init()
```

The default export provides a backward-compatible `init()` that returns `vlm.storage`.

## Developer APIs

```typescript
// Custom messaging between players
vlm.sendMessage('game-event', { score: 100 })
vlm.onMessage('game-event', (data) => console.log(data))

// Persistent state
vlm.setState('high-score', 9999)
const score = await vlm.getState('high-score')

// Analytics
vlm.recordAction('level-complete', { level: 3 })

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
