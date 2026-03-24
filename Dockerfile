# =============================================================================
# VLM V2 — Production Dockerfile
# One image for all modes (single / scalable / cloud). Behavior controlled by
# environment variables at runtime. See .env.example for full reference.
# =============================================================================

# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copy workspace config and package manifests first (layer cache)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/streaming/package.json apps/streaming/
COPY apps/docs/package.json apps/docs/
COPY packages/vlm-shared/package.json packages/vlm-shared/
COPY packages/vlm-core/package.json packages/vlm-core/
COPY packages/vlm-client/package.json packages/vlm-client/
COPY packages/vlm-hud/package.json packages/vlm-hud/
COPY packages/vlm-adapter-dcl/package.json packages/vlm-adapter-dcl/
COPY packages/vlm-adapter-hyperfy/package.json packages/vlm-adapter-hyperfy/

RUN pnpm install --frozen-lockfile

# Copy source and build everything
COPY . .
RUN pnpm turbo build

# Use pnpm deploy to create a standalone server bundle with all deps resolved
RUN pnpm --filter vlm-server deploy /app/server-bundle --prod

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# Optional: FFmpeg for HLS streaming support
RUN apk add --no-cache ffmpeg

# Copy the standalone server bundle (includes node_modules with real files, not symlinks)
COPY --from=builder /app/server-bundle ./

# Copy the compiled server code
COPY --from=builder /app/apps/server/dist ./dist

# Create uploads directory for local storage
RUN mkdir -p /app/uploads

ENV NODE_ENV=production
ENV PORT=3010

EXPOSE 3010

CMD ["node", "dist/index.js"]
