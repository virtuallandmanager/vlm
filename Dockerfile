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
COPY packages/vlm-shared/package.json packages/vlm-shared/
COPY packages/vlm-core/package.json packages/vlm-core/
COPY packages/vlm-client/package.json packages/vlm-client/
COPY packages/vlm-adapter-dcl/package.json packages/vlm-adapter-dcl/
COPY packages/vlm-adapter-hyperfy/package.json packages/vlm-adapter-hyperfy/

RUN pnpm install --frozen-lockfile

# Copy source and build everything
COPY . .
RUN pnpm turbo build

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# Optional: FFmpeg for HLS streaming support
RUN apk add --no-cache ffmpeg

# Copy the compiled API server
COPY --from=builder /app/apps/server/dist ./dist
COPY --from=builder /app/apps/server/package.json ./

# Copy Drizzle migrations (auto-applied on boot)
COPY --from=builder /app/apps/server/drizzle ./drizzle

# Copy Next.js standalone dashboard
# The standalone output includes a minimal Node server + all required node_modules
COPY --from=builder /app/apps/web/.next/standalone ./dashboard-standalone
COPY --from=builder /app/apps/web/.next/static ./dashboard-standalone/apps/web/.next/static
COPY --from=builder /app/apps/web/public ./dashboard-standalone/apps/web/public

# Copy production node_modules for the server
# (pruned — only production deps, no devDependencies)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/vlm-shared/dist ./node_modules/vlm-shared/dist
COPY --from=builder /app/packages/vlm-shared/package.json ./node_modules/vlm-shared/
COPY --from=builder /app/packages/vlm-core/dist ./node_modules/vlm-core/dist
COPY --from=builder /app/packages/vlm-core/package.json ./node_modules/vlm-core/
COPY --from=builder /app/packages/vlm-client/dist ./node_modules/vlm-client/dist
COPY --from=builder /app/packages/vlm-client/package.json ./node_modules/vlm-client/

# Create uploads directory for local storage
RUN mkdir -p /app/uploads

ENV NODE_ENV=production
ENV PORT=3010

EXPOSE 3010

CMD ["node", "dist/index.js"]
