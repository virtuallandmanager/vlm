import client, { Registry } from 'prom-client'

export const register = new Registry()

// Collect Node.js default metrics (CPU, memory, event loop, etc.)
client.collectDefaultMetrics({ register })

// ── Custom metrics ──────────────────────────────────────────────────────────

export const httpRequestsTotal = new client.Counter({
  name: 'vlm_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
})

export const httpRequestDurationSeconds = new client.Histogram({
  name: 'vlm_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
})

export const activeWebsocketConnections = new client.Gauge({
  name: 'vlm_active_websocket_connections',
  help: 'Number of active WebSocket connections',
  registers: [register],
})

export const activeColyseusRooms = new client.Gauge({
  name: 'vlm_active_colyseus_rooms',
  help: 'Number of active Colyseus rooms',
  registers: [register],
})

export const mediaUploadsTotal = new client.Counter({
  name: 'vlm_media_uploads_total',
  help: 'Total number of media uploads',
  registers: [register],
})

export const mediaUploadBytesTotal = new client.Counter({
  name: 'vlm_media_upload_bytes_total',
  help: 'Total bytes uploaded for media',
  registers: [register],
})
