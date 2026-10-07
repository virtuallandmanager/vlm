# apps/streaming/Dockerfile — build from the repo root:
#   docker build -f apps/streaming/Dockerfile .
FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/streaming/package.json apps/streaming/
RUN pnpm install --frozen-lockfile --filter vlm-streaming
COPY apps/streaming/tsconfig.json apps/streaming/
COPY apps/streaming/src apps/streaming/src
RUN pnpm --filter vlm-streaming build && pnpm --filter vlm-streaming deploy --prod /out

FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out ./
ENV NODE_ENV=production RTMP_PORT=1935 HTTP_PORT=8000 OUTPUT_DIR=/data/streams
EXPOSE 1935 8000
CMD ["node", "dist/index.js"]
