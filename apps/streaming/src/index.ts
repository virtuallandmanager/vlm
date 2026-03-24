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
 */

import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const NodeMediaServer = _require('node-media-server')

import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { Transcoder } from './transcoder'

// ── Config ────────────────────────────────────────────────────────────────

const RTMP_PORT = parseInt(process.env.RTMP_PORT || '1935')
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8000')
const OUTPUT_DIR = process.env.OUTPUT_DIR || './streams'
const VLM_API_URL = process.env.VLM_API_URL || 'http://localhost:3010'
const VLM_WEBHOOK_KEY = process.env.VLM_WEBHOOK_KEY || ''
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg'
const ENABLE_ABR = process.env.ENABLE_ABR === 'true'

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

// Track active streams for webhook notifications
const activeStreams = new Map<string, { startedAt: Date }>()

// ── RTMP Events ───────────────────────────────────────────────────────────

nms.on('prePublish', (id: string, streamPath: string, _args: unknown) => {
  // streamPath format: /live/{streamKey}
  const streamKey = streamPath.split('/').pop() || ''
  console.log(`[rtmp] Stream started: ${streamKey} (session: ${id})`)

  activeStreams.set(streamKey, { startedAt: new Date() })

  // Start FFmpeg transcoding
  const outputDir = join(OUTPUT_DIR, streamKey)
  transcoder.start({
    streamKey,
    rtmpUrl: `rtmp://127.0.0.1:${RTMP_PORT}${streamPath}`,
    outputDir,
    abr: ENABLE_ABR,
  })

  // Notify VLM API that stream is live
  notifyVLMApi(streamKey, 'live').catch(() => {})
})

nms.on('donePublish', (id: string, streamPath: string) => {
  const streamKey = streamPath.split('/').pop() || ''
  console.log(`[rtmp] Stream ended: ${streamKey} (session: ${id})`)

  activeStreams.delete(streamKey)

  // Stop transcoding
  transcoder.stop(streamKey)

  // Notify VLM API that stream is offline
  notifyVLMApi(streamKey, 'offline').catch(() => {})
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
      streams: Array.from(activeStreams.entries()).map(([key, info]) => ({
        streamKey: key,
        startedAt: info.startedAt.toISOString(),
        hlsUrl: `/streams/${key}/playlist.m3u8`,
      })),
    }))
    return
  }

  // Serve HLS files from OUTPUT_DIR
  if (url.startsWith('/streams/')) {
    const filePath = join(OUTPUT_DIR, url.replace('/streams/', ''))
    const ext = extname(filePath)
    const mime = MIME_TYPES[ext]

    if (!mime || !existsSync(filePath)) {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    res.writeHead(200, {
      'Content-Type': mime,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': ext === '.m3u8' ? 'no-cache' : 'max-age=10',
    })
    res.end(readFileSync(filePath))
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

// ── VLM API Webhook ───────────────────────────────────────────────────────

async function notifyVLMApi(streamKey: string, status: 'live' | 'offline'): Promise<void> {
  try {
    const hlsUrl = `http://localhost:${HTTP_PORT}/streams/${streamKey}/playlist.m3u8`

    const res = await fetch(`${VLM_API_URL}/api/streaming/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(VLM_WEBHOOK_KEY ? { 'X-Webhook-Key': VLM_WEBHOOK_KEY } : {}),
      },
      body: JSON.stringify({
        streamKey,
        status,
        hlsUrl: status === 'live' ? hlsUrl : null,
        timestamp: Date.now(),
      }),
    })

    if (!res.ok) {
      console.error(`[webhook] VLM API returned ${res.status}`)
    }
  } catch (err) {
    console.error(`[webhook] Failed to notify VLM API:`, err)
  }
}

// ── Start ─────────────────────────────────────────────────────────────────

nms.run()
httpServer.listen(HTTP_PORT, () => {
  console.log(`[vlm-streaming] RTMP ingest on port ${RTMP_PORT}`)
  console.log(`[vlm-streaming] HLS HTTP on port ${HTTP_PORT}`)
  console.log(`[vlm-streaming] Output dir: ${OUTPUT_DIR}`)
  console.log(`[vlm-streaming] ABR: ${ENABLE_ABR ? 'enabled' : 'disabled'}`)
  console.log(`[vlm-streaming] VLM API webhook: ${VLM_API_URL}`)
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[vlm-streaming] Shutting down...')
  transcoder.stopAll()
  httpServer.close()
  process.exit(0)
})
