# VLM's Hyperfy world image: Hyperfy dev at b4081eb with infra/hyperfy/patches applied in order, and the VLM app
# (installed as blueprint `vlm` on every boot by 0002-vlm-app.patch). Build from the repo root:
#   docker build --platform linux/amd64 -f infra/hyperfy/Dockerfile .
FROM node:22.11.0-bookworm AS builder
ARG HYPERFY_COMMIT=b4081eb14478972eb7070d3b5bc0bf2b9f8cf92a
WORKDIR /app
RUN git init -q \
  && git remote add origin https://github.com/hyperfy-xyz/hyperfy \
  && git fetch -q --depth 1 origin ${HYPERFY_COMMIT} \
  && git checkout -q FETCH_HEAD
COPY infra/hyperfy/patches/*.patch /patches/
RUN for p in /patches/*.patch; do echo "applying $p" && git apply --whitespace=nowarn "$p" || exit 1; done
RUN npm ci && npm run build

FROM node:22.11.0-bookworm-slim
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY packages/vlm-hyperfy-app/dist/vlm.hyp /app/vlm/vlm.hyp
ENV NODE_ENV=production PORT=3000 WORLD=world
EXPOSE 3000
CMD ["node", "build/index.js"]
