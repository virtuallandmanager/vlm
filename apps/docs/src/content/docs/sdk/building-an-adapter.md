---
title: Building an Adapter
description: How to add VLM support to a new metaverse platform
---

To support a new platform, create a package that implements `VLMPlatformAdapter` from `vlm-shared`.

## Steps

1. Create `packages/vlm-adapter-yourplatform/`
2. Implement `VLMPlatformAdapter` using your platform's APIs
3. Set `capabilities` accurately — vlm-core skips unsupported features
4. Implement `getAuthProof()` — return `{ type: 'api-key', payload: { key } }` if no platform auth
5. Export a `createVLM()` entry point

## Minimal Example

```typescript
import { VLM } from 'vlm-core'
import type { VLMPlatformAdapter } from 'vlm-shared'

class MyAdapter implements VLMPlatformAdapter {
  capabilities = {
    video: true,
    spatialAudio: false,
    gltfModels: true,
    customEmotes: false,
    playerTeleport: false,
    externalUrls: true,
    nftDisplay: false,
    colliders: true,
    spatialUI: false,
    screenSpaceUI: false,
    platformName: 'myplatform',
    platformVersion: '1',
  }

  // Implement all 27 interface methods...
  createEntity() { /* ... */ }
  setTransform(entity, transform) { /* ... */ }
  // etc.
}

export async function createVLM(config) {
  const adapter = new MyAdapter()
  const vlm = new VLM(adapter)
  await vlm.init(config ?? { env: 'prod' })
  return vlm
}
```

## Key Principles

- **The adapter is a rendering slave** — it never decides _what_ to render, only _how_
- **vlm-core handles all business logic** — scene state, Colyseus messages, video mode switching
- **Capabilities drive graceful degradation** — set them honestly and vlm-core adapts
- **For HTTP-only platforms** (like Second Life) — skip the adapter entirely, use the `/hook/*` API routes instead
