---
title: Self-Hosting Overview
description: Run VLM on your own infrastructure
---

VLM is fully open-source. Self-hosters get every feature for free — no billing gates, no feature locks.

## Deployment Modes

| Mode | `VLM_MODE=single` | `VLM_MODE=scalable` |
|------|-------------------|---------------------|
| **Servers** | 1 container | Multiple containers + load balancer |
| **Colyseus** | In-memory presence | Redis presence (cross-server routing) |
| **Redis** | Not needed | Required |
| **Storage** | Local filesystem | S3/R2 (shared across servers) |
| **First signup** | Auto-promoted to admin | Auto-promoted to admin |
| **Max rooms** | 50 | 500 per server |

## Quick Start

### Single Mode (5 minutes)

```bash
docker compose -f docker-compose.single.yml up -d
```

Requires only `JWT_SECRET` and optionally `POSTGRES_PASSWORD`.

### Scalable Mode (30 minutes)

```bash
docker compose -f docker-compose.scalable.yml up -d --scale vlm=3
```

Requires `JWT_SECRET`, `POSTGRES_PASSWORD`, and a Redis instance.

## Cloud Providers

- **Railway** — `railway.toml` included, one-click deploy
- **Render** — `render.yaml` included, auto-generates JWT_SECRET
- **Fly.io** — `fly.toml` included, `fly launch` from repo root
- **Any VPS** — `docker build .` + set environment variables

## What's Included

The Docker image contains:

- VLM API server (Fastify + Colyseus)
- Next.js dashboard (standalone mode)
- Drizzle auto-migrations (runs on boot)
- FFmpeg (for optional HLS streaming)
