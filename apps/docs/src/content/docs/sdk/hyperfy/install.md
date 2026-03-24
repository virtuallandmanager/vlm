---
title: Hyperfy Setup
description: Install and configure VLM in a Hyperfy world
---

## Installation

Add the `vlm-adapter-hyperfy` app to your Hyperfy world's `apps/` directory.

The VLM Hyperfy adapter is a standard Hyperfy app that connects your world to the VLM server. It renders all scene elements (videos, images, 3D models, sounds) as Hyperfy JSX.

## Configuration

After adding the app to your world, select it and configure:

| Field | Description |
|-------|-------------|
| **Scene ID** | Your VLM scene UUID (from the dashboard) |
| **Environment** | `prod` / `staging` / `dev` |
| **Debug** | Enable debug logging |

## How It Works

The adapter uses a **virtual scene graph** pattern:

1. VLM core calls imperative adapter methods (`createEntity`, `setTransform`, etc.)
2. The `HyperfyAdapter` writes to an `EntityStore` (observable map)
3. The `HyperfyRenderer` React component subscribes to the store and re-renders Hyperfy JSX
4. Hyperfy renders the `<video>`, `<image>`, `<model>`, and `<audio>` elements

```
vlm-core (imperative) → EntityStore (bridge) → React (declarative) → Hyperfy (renders)
```

## Platform Capabilities

| Capability | Supported |
|-----------|-----------|
| Video | Yes |
| Spatial Audio | Yes |
| glTF Models | Yes |
| Custom Emotes | No |
| Player Teleport | No |
| External URLs | Yes |
| Colliders | Yes |
| Screen-Space UI | No |

Unsupported capabilities are gracefully skipped — vlm-core's managers check `adapter.capabilities` before rendering.

## Hyperfy World Provisioning

VLM can auto-provision Hyperfy worlds via the dashboard:

1. Click "Create World" → select region
2. VLM provisions a container (Fly.io, Docker, or local)
3. World starts with your VLM scene pre-configured
4. Assets can be uploaded at any time — no redeploy needed

See [Deployment](/dashboard/deployment) for details.
