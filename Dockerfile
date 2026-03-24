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

# Copy the Next.js static export into the server's dashboard directory
RUN cp -r apps/web/out dashboard

# Remove source files to reduce image size (keep dist + node_modules)
# Keep apps/server/src/db/schema.ts — drizzle-kit push needs it at runtime
RUN find apps/server/src -name '*.ts' -not -path '*/db/schema.ts' -delete 2>/dev/null; \
    find packages -name '*.ts' -not -path '*/node_modules/*' -delete 2>/dev/null; \
    rm -rf apps/web/src apps/docs/src apps/streaming/src test-scenes .git; \
    true

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# Optional: FFmpeg for HLS streaming support
RUN apk add --no-cache ffmpeg

# Copy the entire built monorepo (preserves pnpm symlink structure)
COPY --from=builder /app ./

# Create uploads directory for local storage
RUN mkdir -p /app/uploads

ENV NODE_ENV=production

# Make entrypoint executable
RUN chmod +x apps/server/entrypoint.sh

# Entrypoint: sync DB schema then start server
CMD ["apps/server/entrypoint.sh"]
