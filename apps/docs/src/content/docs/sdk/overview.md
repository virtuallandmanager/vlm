---
title: SDK Overview
description: How the VLM SDK works across platforms
---

The VLM SDK is split into layered packages:

| Package | Purpose |
|---------|---------|
| `vlm-shared` | Types, enums, `VLMPlatformAdapter` interface, protocol types |
| `vlm-client` | HTTP client + Colyseus WebSocket manager |
| `vlm-core` | `VLM` class, `SceneManager`, element managers (Video, Image, Mesh, Sound) |
| `vlm-hud` | In-world management HUD (optional) |
| `vlm-adapter-dcl` | Decentraland SDK 7 adapter |
| `vlm-adapter-hyperfy` | Hyperfy adapter (React JSX) |

## How It Works

1. Your scene imports the platform-specific adapter (e.g., `vlm-adapter-dcl`)
2. The adapter creates a `VLM` instance with itself as the platform implementation
3. `VLM.init()` authenticates with the server, joins the Colyseus room, and receives the scene data
4. vlm-core's element managers call adapter methods to render everything
5. When the dashboard sends an update, vlm-core receives it and calls the adapter to apply changes

```typescript
// Decentraland scene
import { createVLM } from 'vlm-adapter-dcl'

const vlm = await createVLM()

// Everything renders automatically. Developer APIs:
vlm.sendMessage('game-event', { score: 100 })
vlm.onMessage('game-event', (data) => console.log(data))
vlm.setState('high-score', 9999)
vlm.recordAction('level-complete', { level: 3 })
```

## The VLM Class

The `VLM` class is the main entry point. After `init()`:

| Method | Purpose |
|--------|---------|
| `sendMessage(id, data)` | Send a custom message to other clients in the room |
| `onMessage(id, callback)` | Listen for custom messages |
| `setState(key, value)` | Store persistent key-value state on the server |
| `getState(key)` | Retrieve stored state |
| `recordAction(id, metadata)` | Log a user action for analytics |
| `initHUD(renderer, limits)` | Initialize the in-world management HUD (optional) |
| `destroy()` | Clean up — sends session_end, leaves room |

## Storage

`vlm.storage` provides read-only access to all scene elements:

```typescript
vlm.storage.videos.configs['my-screen']   // video element by customId
vlm.storage.images.configs['banner']       // image element
vlm.storage.models.configs['trophy']       // 3D model element
vlm.storage.sounds.configs['ambient']      // sound element
```
