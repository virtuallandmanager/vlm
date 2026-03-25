# VLM Smart Item for Decentraland

Drop this into any Decentraland scene to connect it to Virtual Land Manager. No code required.

## Creator Hub (No Code)

1. Import the VLM asset pack into Creator Hub
2. Drag "VLM Manager" into your scene
3. Set your **Scene ID** (from the VLM dashboard)
4. Deploy

Your scene is now VLM-managed. Video screens, images, 3D models, sounds, and widgets configured in the VLM dashboard will appear in your scene and update in real-time.

## From Code

```typescript
import { VLMSmartItem } from 'vlm-smart-item-dcl'

const vlmItem = new VLMSmartItem()

// Initialize (call once)
vlmItem.init({ inventory: {} })

// Spawn (call for each instance)
vlmItem.spawn(myEntity, {
  sceneId: 'your-scene-id-here',
  serverUrl: 'https://vlm.gg',
  showBeacon: false,
  enableHud: true,
  enableAnalytics: true,
  autoConnect: true,
  env: 'prod',
}, channel)
```

Or use `createVLM` directly for full control:

```typescript
import { createVLM } from 'vlm-smart-item-dcl'

const vlm = await createVLM({ sceneId: 'your-scene-id' })
```

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| sceneId | text | — | Your VLM scene ID (required) |
| serverUrl | text | https://vlm.gg | VLM server URL |
| showBeacon | boolean | false | Show VLM logo cube in scene |
| enableHud | boolean | true | Enable in-world management HUD |
| enableAnalytics | boolean | true | Track visitor sessions and actions |
| autoConnect | boolean | true | Connect on scene load |
| env | options | prod | Server environment |

## Actions

Other Smart Items can trigger these actions on the VLM Manager:

| Action | Description |
|--------|-------------|
| connect | Connect to VLM server |
| disconnect | Disconnect from VLM |
| toggleHud | Show/hide the management HUD |
| switchPreset | Switch to a different scene preset |
| triggerGiveaway | Trigger a giveaway by ID |
| sendMessage | Send a custom message to other clients |
| recordAction | Log an analytics action |
