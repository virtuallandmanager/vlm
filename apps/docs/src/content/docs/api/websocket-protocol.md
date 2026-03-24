---
title: WebSocket Protocol
description: Colyseus message types for real-time sync
---

VLM uses [Colyseus](https://colyseus.io/) for real-time WebSocket communication. Two room types are available.

## vlm_scene Room

Join with: `{ sessionToken, sceneId, clientType, user }`

### Client → Server Messages

| Type | Data | Description |
|------|------|-------------|
| `scene_preset_update` | `{ action, element, instance, elementData, instanceData }` | Create/update/delete elements |
| `scene_change_preset` | `{ presetId }` | Switch active preset |
| `scene_setting_update` | `{ setting, value }` | Update scene setting |
| `scene_video_update` | `{ sk, isLive, url }` | Change video live/offline status |
| `session_start` | `{ sessionToken, sceneId }` | Start analytics session |
| `session_action` | `{ action, metadata }` | Log user action |
| `session_end` | `{}` | End session |
| `user_message` | `{ messageId, data }` | Custom message to other clients |
| `set_user_state` | `{ key, value }` | Store persistent state |
| `get_user_state` | `{ key }` | Retrieve state |

### Server → Client Messages

| Type | Data | Description |
|------|------|-------------|
| `scene_preset_update` | `{ action: 'init', scenePreset }` | Full scene data on join |
| `scene_preset_update` | `{ action, elementData, ... }` | Element change broadcast |
| `scene_change_preset` | `{ scenePreset }` | New preset data |
| `scene_video_status` | `{ sk, isLive, url }` | Video status change |
| `session_started` | `{ session, user }` | Session acknowledged |
| `user_message` | `{ messageId, data, type: 'inbound' }` | Custom message from other client |
| `host_joined` / `host_left` | `{ displayName }` | Host client joined/left |

## vlm_command_center Room

Join with: `{ sessionToken, eventId }`

### Client → Server

| Type | Data | Description |
|------|------|-------------|
| `cross_world_update` | `{ eventId, targetScenes, action }` | Fan out action to all linked scenes |

### Server → Client

| Type | Data | Description |
|------|------|-------------|
| `command_center_status` | `{ eventId, worlds[], aggregate }` | Periodic status (every 5s) |
| `cross_world_dispatched` | `{ eventId, targetScenes, action }` | Confirmation of dispatch |
