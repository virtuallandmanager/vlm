---
title: Docker Compose
description: Run Virvi with Docker Compose
---

## Single Mode

`docker-compose.single.yml` — Virvi + Postgres, no Redis needed.

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: vlm  # virvi-rename: keep (local database name)
      POSTGRES_USER: vlm  # virvi-rename: keep (local database name)
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-vlm_prod}
    volumes:
      - pgdata:/var/lib/postgresql/data

  virvi:
    build: .
    ports:
      - "3010:3010"
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      VIRVI_MODE: single
      DATABASE_URL: postgresql://vlm:${POSTGRES_PASSWORD}@postgres:5432/vlm
      JWT_SECRET: ${JWT_SECRET}
      PUBLIC_URL: ${PUBLIC_URL:-http://localhost:3010}
```

```bash
# Start
JWT_SECRET=$(openssl rand -hex 32) docker compose -f docker-compose.single.yml up -d

# Stop
docker compose -f docker-compose.single.yml down
```

## Scalable Mode

`docker-compose.scalable.yml` — adds Redis for cross-server Colyseus presence.

```bash
# Start with 3 API servers
docker compose -f docker-compose.scalable.yml up -d --scale virvi=3
```

Put a reverse proxy (nginx, Caddy, Traefik) in front for load balancing and SSL termination.

## Development

`docker-compose.dev.yml` — Postgres + Redis + MinIO (for local S3). Run the Virvi server outside Docker with `tsx`.

```bash
docker compose -f docker-compose.dev.yml up -d
cd apps/server
DATABASE_URL="postgresql://vlm:vlm_dev@localhost:5432/vlm" JWT_SECRET="dev" npx tsx src/index.ts
```
