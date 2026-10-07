/**
 * VLM Streaming Media Server
 *
 * RTMP ingest (via Node-Media-Server) + FFmpeg HLS transcoding.
 * Notifies the VLM API of stream status changes (online/offline)
 * via webhook so scenes can auto-switch between live stream and fallback.
 *
 * Environment variables:
 *   RTMP_PORT       — RTMP ingest port (default: 1935)
 *   HTTP_PORT       — HTTP port for HLS serving + health check (default: 8000)
 *   OUTPUT_DIR      — Directory for HLS segments (default: ./streams)
 *   VLM_API_URL     — VLM API base URL for webhooks (default: http://localhost:3010)
 *   VLM_WEBHOOK_KEY — Shared secret for webhook auth
 *   FFMPEG_PATH     — Path to FFmpeg binary (default: ffmpeg)
 *   ENABLE_ABR      — Enable adaptive bitrate (default: false)
 *   MAX_STREAMS     — Concurrent transcodes this machine accepts (default: 4)
 */

import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const NodeMediaServer = _require('node-media-server')

import { createServer } from 'node:http'
import { existsSync, createReadStream, rmSync } from 'node:fs'
import { join, extname } from 'node:path'
import { Transcoder } from './transcoder.js'
import { createIngest } from './ingest.js'
import { createApiClient } from './vlm-api.js'
import { sweepStaleLive } from './sweep.js'
import { resolveHlsPath } from './hls.js'

// ── Config ────────────────────────────────────────────────────────────────

const RTMP_PORT = parseInt(process.env.RTMP_PORT || '1935')
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8000')
const OUTPUT_DIR = process.env.OUTPUT_DIR || './streams'
const VLM_API_URL = process.env.VLM_API_URL || 'http://localhost:3010'
const VLM_WEBHOOK_KEY = process.env.VLM_WEBHOOK_KEY || ''
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

const api = createApiClient({ apiUrl: VLM_API_URL, webhookKey: VLM_WEBHOOK_KEY })

// A publish is transcoded and reported live only after the VLM API authorizes its key (fail closed)
const ingest = createIngest({
  authorize: (k) => api.authorize(k),
  notify: (k, s) => api.notify(k, s),
  startTranscode: (streamKey, streamPath) =>
    transcoder.start({ streamKey, rtmpUrl: `rtmp://127.0.0.1:${RTMP_PORT}${streamPath}`, outputDir: join(OUTPUT_DIR, streamKey), abr: ENABLE_ABR }),
  stopTranscode: (k) => transcoder.stop(k),
  reject: (id) => nms.getSession(id)?.reject(),
  removeOutput: (k) => rmSync(join(OUTPUT_DIR, k), { recursive: true, force: true }),
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

const MIME_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
}

const httpServer = createServer((req, res) => {
  const url = req.url || '/'

  // Health check
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      activeStreams: transcoder.getActiveStreams(),
      uptime: process.uptime(),
    }))
    return
  }

  // Status endpoint
  if (url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      streams: transcoder.getActiveStreams().map((streamKey) => ({ streamKey, hlsUrl: `/streams/${streamKey}/playlist.m3u8` })),
    }))
    return
  }

  // Serve HLS files from OUTPUT_DIR (paths confined to it)
  if (url.startsWith('/streams/')) {
    const filePath = resolveHlsPath(OUTPUT_DIR, url)
    const mime = filePath ? MIME_TYPES[extname(filePath)] : undefined
    if (!filePath || !mime || !existsSync(filePath)) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': extname(filePath) === '.m3u8' ? 'no-cache' : 'max-age=10',
    })
    createReadStream(filePath).on('error', () => res.destroy()).pipe(res)
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

// ── Start ─────────────────────────────────────────────────────────────────

nms.run()
httpServer.listen(HTTP_PORT, () => {
  console.log(`[vlm-streaming] RTMP ingest on port ${RTMP_PORT}`)
  console.log(`[vlm-streaming] HLS HTTP on port ${HTTP_PORT}`)
  console.log(`[vlm-streaming] Output dir: ${OUTPUT_DIR}`)
  console.log(`[vlm-streaming] ABR: ${ENABLE_ABR ? 'enabled' : 'disabled'}`)
  console.log(`[vlm-streaming] VLM API webhook: ${VLM_API_URL}`)
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
