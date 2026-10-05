import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const { Server: ColyseusServer } = _require('colyseus') as any
const { WebSocketTransport } = _require('@colyseus/ws-transport') as any
import { config } from './config.js'
import { startHookCrons } from './integrations/platform-hooks.js'
import { VLMSceneRoom } from './ws/VLMSceneRoom.js'
import { VLMCommandCenterRoom } from './ws/VLMCommandCenterRoom.js'
import { runMigrations } from './db/migrate.js'
import { buildApp } from './app.js'
import { startLifecycleSweep } from './venues/lifecycle.js'
import { startAnalyticsJobs } from './analytics/jobs.js'
import { initBus } from './realtime/bus.js'

async function main() {
  console.log(`[vlm-server] Starting in "${config.mode}" mode`)

  // ── Auto-migrate ─────────────────────────────────────────────────────────
  if (config.databaseUrl) {
    try {
      await runMigrations()
    } catch (err) {
      console.warn('[vlm-server] Migration skipped or failed:', (err as Error).message)
      console.warn('[vlm-server] Server will continue — run db:migrate manually if needed')
    }
  }

  // ── Fastify ──────────────────────────────────────────────────────────────
  const app = await buildApp()

  // ── Start HTTP server ────────────────────────────────────────────────────
  await app.listen({ port: config.port, host: '0.0.0.0' })
  console.log(`[vlm-server] HTTP listening on port ${config.port}`)

  // ── Colyseus WebSocket server ────────────────────────────────────────────
  const httpServer = app.server

  const { LocalPresence } = _require('colyseus') as any
  let presence: any
  let driver: any

  if (config.useRedisPresence && config.redisUrl) {
    const { RedisPresence } = _require('@colyseus/redis-presence') as any
    const { RedisDriver } = _require('@colyseus/redis-driver') as any
    presence = new RedisPresence(config.redisUrl)
    driver = new RedisDriver(config.redisUrl)
    console.log(`[vlm-server] Redis presence enabled`)
  } else {
    presence = new LocalPresence()
    console.log(`[vlm-server] In-memory presence (single instance)`)
  }
  initBus(presence)

  const gameServer = new ColyseusServer({
    transport: new WebSocketTransport({
      server: httpServer,
      pingInterval: 5000,
      pingMaxRetries: 3,
    }),
    presence,
    ...(driver ? { driver } : {}),
  })

  // Register rooms
  gameServer.define('vlm_scene', VLMSceneRoom).filterBy(['sceneId'])
  gameServer.define('vlm_command_center', VLMCommandCenterRoom)

  console.log(`[vlm-server] Colyseus WebSocket attached`)

  // ── Platform hook crons (cleanup stale callbacks + keepalive ping) ─────
  startHookCrons()
  console.log(`[vlm-server] Platform hook crons started`)
  startLifecycleSweep(config.lifecycleSweepMs)
  console.log(`[vlm-server] Venue lifecycle sweep every ${config.lifecycleSweepMs}ms`)
  startAnalyticsJobs()
  console.log('[vlm-server] Analytics jobs started')

  console.log(`[vlm-server] Ready at ${config.publicUrl}`)
}

main().catch((err) => {
  console.error('[vlm-server] Fatal error:', err)
  process.exit(1)
})
