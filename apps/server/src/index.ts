import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const { Server: ColyseusServer } = _require('colyseus') as any
const { WebSocketTransport } = _require('@colyseus/ws-transport') as any
import { config } from './config.js'
import { registerJwt } from './middleware/auth.js'
import authRoutes from './routes/auth.js'
import sceneRoutes from './routes/scenes.js'
import analyticsRoutes from './routes/analytics.js'
import eventRoutes from './routes/events.js'
import giveawayRoutes from './routes/giveaways.js'
import mediaRoutes from './routes/media.js'
import hookRoutes from './routes/hooks.js'
import assetRoutes from './routes/assets.js'
import deployRoutes from './routes/deploy.js'
import commandCenterRoutes from './routes/command-center.js'
import streamingRoutes from './routes/streaming.js'
import billingRoutes from './routes/billing.js'
import companionUploadRoutes from './routes/companion-upload.js'
import { startHookCrons } from './integrations/platform-hooks.js'
import { VLMSceneRoom } from './ws/VLMSceneRoom.js'
import { VLMCommandCenterRoom } from './ws/VLMCommandCenterRoom.js'
import { runMigrations } from './db/migrate.js'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

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
  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
  })

  // CORS
  await app.register(fastifyCors, {
    origin: true,
    credentials: true,
  })

  // JWT
  await registerJwt(app, config.jwtSecret)

  // ── API Routes ───────────────────────────────────────────────────────────
  await app.register(authRoutes)
  await app.register(sceneRoutes)
  await app.register(analyticsRoutes)
  await app.register(eventRoutes)
  await app.register(giveawayRoutes)
  await app.register(mediaRoutes)
  await app.register(hookRoutes)
  await app.register(assetRoutes)
  await app.register(deployRoutes)
  await app.register(commandCenterRoutes)
  await app.register(streamingRoutes)
  await app.register(billingRoutes)
  await app.register(companionUploadRoutes)

  // Health check
  app.get('/api/health', async () => ({
    status: 'ok',
    mode: config.mode,
    version: '2.0.0',
    timestamp: new Date().toISOString(),
  }))

  // ── Static Dashboard ─────────────────────────────────────────────────────
  const dashboardPath = resolve(config.dashboardDir)
  console.log(`[vlm-server] Dashboard path: ${dashboardPath} (exists: ${existsSync(dashboardPath)})`)
  if (existsSync(dashboardPath)) {
    console.log(`[vlm-server] Serving dashboard from ${dashboardPath}`)
    await app.register(fastifyStatic, {
      root: dashboardPath,
      prefix: '/',
    })

    // ── Serve uploaded media files ─────────────────────────────────────────
    const uploadsPath = resolve(process.env.LOCAL_STORAGE_PATH || './uploads')
    if (existsSync(uploadsPath)) {
      await app.register(fastifyStatic, {
        root: uploadsPath,
        prefix: '/uploads/',
        decorateReply: false,
      })
    }

    // SPA fallback: serve the closest pre-rendered page for unmatched routes.
    // Dynamic routes like /scenes/[id] only have a placeholder at /scenes/_/,
    // so we serve that HTML and let the client-side router handle the real param.
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ error: 'Not found' })
      }

      // Try to find a pre-rendered placeholder for dynamic routes
      const url = request.url.split('?')[0].replace(/\/$/, '')
      const segments = url.split('/').filter(Boolean)

      // Walk up the path looking for a _/index.html placeholder
      for (let i = segments.length; i >= 1; i--) {
        const parent = segments.slice(0, i - 1)
        const placeholderPath = [...parent, '_', 'index.html'].join('/')
        const fullPath = resolve(dashboardPath, placeholderPath)
        if (existsSync(fullPath)) {
          return reply.type('text/html').send(readFileSync(fullPath))
        }
      }

      return reply.sendFile('index.html')
    })
  } else {
    console.log(`[vlm-server] No dashboard directory at ${dashboardPath} — API-only mode`)
    app.setNotFoundHandler(async (_request, reply) => {
      return reply.status(404).send({ error: 'Not found' })
    })
  }

  // ── Start HTTP server ────────────────────────────────────────────────────
  await app.listen({ port: config.port, host: '0.0.0.0' })
  console.log(`[vlm-server] HTTP listening on port ${config.port}`)

  // ── Colyseus WebSocket server ────────────────────────────────────────────
  const httpServer = app.server

  const gameServer = new ColyseusServer({
    transport: new WebSocketTransport({
      server: httpServer,
      pingInterval: 5000,
      pingMaxRetries: 3,
    }),
  })

  // Register rooms
  gameServer.define('vlm_scene', VLMSceneRoom)
  gameServer.define('vlm_command_center', VLMCommandCenterRoom)

  console.log(`[vlm-server] Colyseus WebSocket attached`)

  // ── Platform hook crons (cleanup stale callbacks + keepalive ping) ─────
  startHookCrons()
  console.log(`[vlm-server] Platform hook crons started`)

  console.log(`[vlm-server] Ready at ${config.publicUrl}`)
}

main().catch((err) => {
  console.error('[vlm-server] Fatal error:', err)
  process.exit(1)
})
