---
title: What is VLM?
description: An introduction to Virtual Land Manager
sidebar:
  order: 1
---

Virtual Land Manager (VLM) is an open-source platform for managing virtual metaverse scenes across multiple platforms from a single interface. One operator can deploy worlds, manage live events, place and arrange 3D assets, control video streams, and monitor analytics across Decentraland, Hyperfy, Second Life, and any future platform.

## The Problem

Managing a brand presence across multiple metaverse platforms is painful:

- Each platform has its own tools, SDKs, and deployment processes
- Making a change means logging into each platform separately
- Live events across multiple worlds require constant tab-switching
- There's no unified analytics view across platforms

## The Solution

VLM provides:

- **One dashboard** to manage scenes across all platforms
- **Real-time sync** — change a video URL in the dashboard and it updates in-world within milliseconds
- **Multi-platform adapters** — the same scene definition renders natively in Decentraland, Hyperfy, or any supported platform
- **In-world HUD** — manage everything without leaving the virtual world
- **Command Center** — orchestrate live events across multiple worlds simultaneously
- **HLS streaming** — push RTMP from OBS, get HLS in every world

## Architecture

```
Web Dashboard ──→ VLM API (Fastify + Colyseus) ──→ Platform Adapters
                       │                              ├── Decentraland (SDK 7)
                       │                              ├── Hyperfy (React JSX)
                       ├── PostgreSQL                 └── Second Life (HTTP hooks)
                       ├── Redis (optional)
                       └── Streaming Server (RTMP → HLS)
```

## Deployment Modes

| Mode | For | Setup |
|------|-----|-------|
| `single` | Solo creator, small team | 5 minutes, one container |
| `scalable` | Studio, organization | 30 minutes, multiple containers + Redis |
| `cloud` | Hosted vlm.gg SaaS | Managed by us, multi-tenant with billing |

Self-hosters get every feature for free. No billing gates, no feature locks.
