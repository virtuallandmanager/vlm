/**
 * Virvi Streaming Media Server
 *
 * RTMP ingest (via Node-Media-Server) + FFmpeg HLS transcoding.
 * Notifies the Virvi API of stream status changes (online/offline)
 * via webhook so scenes can auto-switch between live stream and fallback.
 *
 * Environment variables:
 *   RTMP_PORT       — RTMP ingest port (default: 1935)
 *   HTTP_PORT       — HTTP port for HLS serving + health check (default: 8000)
 *   OUTPUT_DIR      — Directory for HLS segments (default: ./streams)
 *   VIRVI_API_URL     — Virvi API base URL for webhooks (default: http://localhost:3010)
 *   VIRVI_WEBHOOK_KEY — Shared secret for webhook auth
 *   FFMPEG_PATH     — Path to FFmpeg binary (default: ffmpeg)
 *   ENABLE_ABR      — Enable adaptive bitrate (default: false)
 *   MAX_STREAMS     — Concurrent transcodes this machine accepts (default: 4)
 */

import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const NodeMediaServer = _require('node-media-server')

import { createServer } from 'node:http'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { Transcoder } from './transcoder.js'
import { createIngest } from './ingest.js'
import { createApiClient } from './virvi-api.js'
import { sweepStaleLive } from './sweep.js'
import { waitForFile } from './hls.js'
import { createHttpHandler } from './http.js'

// ── Config ────────────────────────────────────────────────────────────────

const RTMP_PORT = parseInt(process.env.RTMP_PORT || '1935')
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8000')
const OUTPUT_DIR = process.env.OUTPUT_DIR || './streams'
const VIRVI_API_URL = process.env.VIRVI_API_URL || 'http://localhost:3010'
const VIRVI_WEBHOOK_KEY = process.env.VIRVI_WEBHOOK_KEY || ''
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg'
const ENABLE_ABR = process.env.ENABLE_ABR === 'true'
const MAX_STREAMS = parseInt(process.env.MAX_STREAMS || '4')

// ── RTMP Ingest (Node-Media-Server) ───────────────────────────────────────

const nmsConfig = {
  rtmp: {
    port: RTMP_PORT,
    chunk_size: 60000,
    gop_cache: true,
    ping: 60,
    ping_timeout: 30,
  },
  http: {
    port: HTTP_PORT + 1, // NMS has its own HTTP — we use a separate one
    allow_origin: '*',
  },
}

const nms = new NodeMediaServer(nmsConfig)
const transcoder = new Transcoder(FFMPEG_PATH)

const api = createApiClient({ apiUrl: VIRVI_API_URL, webhookKey: VIRVI_WEBHOOK_KEY })

// A publish is transcoded and reported live only after the Virvi API authorizes its key (fail closed)
const ingest = createIngest({
  authorize: (k) => api.authorize(k),
  notify: (k, s) => api.notify(k, s),
  startTranscode: (streamKey, streamPath, playbackId) =>
    transcoder.start({ streamKey, rtmpUrl: `rtmp://127.0.0.1:${RTMP_PORT}${streamPath}`, outputDir: join(OUTPUT_DIR, playbackId), abr: ENABLE_ABR }),
  stopTranscode: (k) => transcoder.stop(k),
  waitForPlaylist: (playbackId) => waitForFile(join(OUTPUT_DIR, playbackId, 'playlist.m3u8')),
  reject: (id) => nms.getSession(id)?.reject(),
  removeOutput: (playbackId) => rmSync(join(OUTPUT_DIR, playbackId), { recursive: true, force: true }),
  maxStreams: MAX_STREAMS,
})

// ── RTMP Events ───────────────────────────────────────────────────────────

nms.on('prePublish', (id: string, streamPath: string) => {
  // streamPath format: /live/{streamKey}
  void ingest.onPrePublish(id, streamPath)
})

nms.on('donePublish', (id: string) => {
  void ingest.onDonePublish(id)
})

// ── HTTP Server (HLS serving + health check) ─────────────────────────────

const httpServer = createServer(createHttpHandler({ outputDir: OUTPUT_DIR, activeCount: () => ingest.liveCount() }))

// ── Start ─────────────────────────────────────────────────────────────────

nms.run()
httpServer.listen(HTTP_PORT, () => {
  console.log(`[vlm-streaming] RTMP ingest on port ${RTMP_PORT}`)
  console.log(`[vlm-streaming] HLS HTTP on port ${HTTP_PORT}`)
  console.log(`[vlm-streaming] Output dir: ${OUTPUT_DIR}`)
  console.log(`[vlm-streaming] ABR: ${ENABLE_ABR ? 'enabled' : 'disabled'}`)
  console.log(`[vlm-streaming] Virvi API webhook: ${VIRVI_API_URL}`)
  console.log(`[vlm-streaming] Max concurrent streams: ${MAX_STREAMS}`)
})

// Streams the API still thinks are live (e.g. after a crash) are marked offline
void sweepStaleLive({ liveKeys: () => api.liveKeys(), notify: (k, s) => api.notify(k, s), isLive: (k) => ingest.isLive(k) })
  .then((n) => console.log(`[vlm-streaming] startup sweep: ${n} stale live stream(s) marked offline`))

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[vlm-streaming] Shutting down...')
  transcoder.stopAll()
  httpServer.close()
  process.exit(0)
})
