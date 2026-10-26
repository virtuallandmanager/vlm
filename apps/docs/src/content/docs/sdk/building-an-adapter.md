---
title: Building an Adapter
description: How to add Virvi support to a new metaverse platform
---

To support a new platform, create a package that implements `VirviPlatformAdapter` from `@virvixr/shared`.

## Steps

1. Create `packages/adapter-yourplatform/`
2. Implement `VirviPlatformAdapter` using your platform's APIs
3. Set `capabilities` accurately — @virvixr/core skips unsupported features
4. Implement `getAuthProof()` — return `{ type: 'api-key', payload: { key } }` if no platform auth
5. Export a `createVirvi()` entry point

## Minimal Example

```typescript
import { Virvi } from '@virvixr/core'
import type { VirviPlatformAdapter } from '@virvixr/shared'

class MyAdapter implements VirviPlatformAdapter {
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

export async function createVirvi(config) {
  const adapter = new MyAdapter()
  const virvi = new Virvi(adapter)
  await virvi.init(config ?? { env: 'prod' })
  return virvi
}
```

## Key Principles

- **The adapter is a rendering slave** — it never decides _what_ to render, only _how_
- **@virvixr/core handles all business logic** — scene state, Colyseus messages, video mode switching
- **Capabilities drive graceful degradation** — set them honestly and @virvixr/core adapts
- **For HTTP-only platforms** (like Second Life) — skip the adapter entirely, use the `/hook/*` API routes instead
