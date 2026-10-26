---
title: Decentraland Setup
description: Install and configure Virvi in a Decentraland SDK 7 scene
---

## Analytics only (one line)

```ts
import { startVirviAnalytics } from '@virvixr/adapter-dcl/analytics'
startVirviAnalytics()
```

This starts collecting visits, movement, interactions, video and emote analytics. No Virvi account is needed. When you're ready, sign in to the dashboard with the wallet that owns the LAND or World and **claim** the scene to see its data. `createVirvi()` also starts analytics by default (`createVirvi({ analytics: false })` turns it off). Visitors never see Virvi setup screens: only the LAND or World owner does.

Track your own events with `virvi.track('bought_ticket', { tier: 'vip' })`.

## Installation

```bash
npm install @virvixr/dcl
```

**Peer dependency:** `@dcl/sdk >=7.26.0` (the HUD scales with the SDK's virtual canvas, so it isn't tiny on high-DPI screens).

The HUD's launcher icon loads from `images/virvi/hud-v.png` in your scene. Run `npx @virvixr/dcl install` in the scene folder to copy it there (`npx @virvixr/dcl sync` keeps it up to date), and deploy it with the scene.

## Basic Usage

```typescript
import { createVirvi } from '@virvixr/adapter-dcl'

const virvi = await createVirvi()
```

That's it. All scene elements configured in the Virvi dashboard render automatically.

## Configuration

```typescript
const virvi = await createVirvi({
  env: 'prod',        // 'dev' | 'staging' | 'prod'
  sceneId: 'uuid',    // Override scene ID (default: from scene.json metadata)
  debug: true,        // Enable debug logging
})
```

Editing in-world needs Virvi set up at the scene's location. A `sceneId` set here, or in `scene.json`, still shows that scene's content anywhere, but you can edit it from the HUD only where it's the scene set up at that parcel or World. Anywhere else the HUD shows "Set up Virvi at this location to edit".

### Scene Metadata

Add your Virvi scene ID to `scene.json`:

```json
{
  "virvi": {
    "sceneId": "645c3a07-5d49-469f-88f3-1636fd55e701"
  }
}
```

If omitted, you must pass `sceneId` in the config.

## V1 Migration

If migrating from Virvi V1:

```typescript
// V1:
import Virvi from '@virvixr/dcl'
await Virvi.init()

// V2 (compatible wrapper):
import Virvi from '@virvixr/adapter-dcl'
const storage = await Virvi.init()
```

The default export provides a backward-compatible `init()` that returns `virvi.storage`.

## Developer APIs

```typescript
// Custom messaging between players
virvi.sendMessage('game-event', { score: 100 })
virvi.onMessage('game-event', (data) => console.log(data))

// Analytics
virvi.track('level-complete', { level: 3 })

// Direct element access
virvi.storage.videos.configs['my-screen']
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
