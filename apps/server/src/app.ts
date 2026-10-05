import Fastify, { type FastifyInstance } from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import { randomUUID } from 'node:crypto'
import { config } from './config.js'
import { registerJwt } from './middleware/auth.js'
import authRoutes from './routes/auth.js'
import walletAuthRoutes from './routes/wallet-auth.js'
import analyticsClaimRoutes from './routes/analytics-claims.js'
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
import organizationRoutes from './routes/organizations.js'
import apiKeyRoutes from './routes/api-keys.js'
import adminRoutes from './routes/admin.js'
import venueRoutes from './routes/venues.js'
import ingestRoutes from './routes/ingest.js'
import { db } from './db/connection.js'
import { sql } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { register, httpRequestsTotal, httpRequestDurationSeconds } from './metrics.js'

export interface BuildAppOptions {
  rateLimit?: boolean
  logger?: boolean
  /** Test hook: capture log output. */
  logStream?: { write(msg: string): void }
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel, ...(opts.logStream ? { stream: opts.logStream } : {}) },
    trustProxy: config.trustProxyHops, // request.ip = real client behind the proxy (per-IP ingest limits)
    genReqId: () => randomUUID(),
    bodyLimit: config.maxUploadSize, // default 100MB, set MAX_UPLOAD_MB to override
  })

  // CORS — lock down origins in production, allow all in development
  const isProduction = process.env.NODE_ENV === 'production'
  await app.register(fastifyCors, {
    origin: isProduction ? [...config.corsOrigins] : true,
    credentials: true,
  })

  // Rate limiting (global)
  if (opts.rateLimit !== false) {
    await app.register(import('@fastify/rate-limit'), {
      max: config.rateLimitMax,
      timeWindow: '1 minute',
    })
  }

  // JWT
  await registerJwt(app, config.jwtSecret)

  // Swagger / OpenAPI docs
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'VLM API',
        description: 'Virtual Land Manager API',
        version: '2.0.0',
      },
      servers: [{ url: config.publicUrl }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'JWT access token or API key (vlm_...)',
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  })

  await app.register(fastifySwaggerUi, {
    routePrefix: '/api/docs',
  })

  console.log('[vlm-server] API docs available at /api/docs')

  // ── API Routes ───────────────────────────────────────────────────────────
  // Auth routes get stricter rate limits to mitigate brute-force attacks
  await app.register(async (scope) => {
    scope.addHook('onRoute', (routeOptions) => {
      routeOptions.config = {
        ...((routeOptions.config as Record<string, unknown>) || {}),
        rateLimit: { max: 20, timeWindow: '1 minute' },
      }
    })
    await scope.register(authRoutes)
    await scope.register(walletAuthRoutes)
  })
  await app.register(sceneRoutes)
  await app.register(analyticsRoutes)
  await app.register(analyticsClaimRoutes)
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
  await app.register(organizationRoutes)
  await app.register(apiKeyRoutes)
  await app.register(adminRoutes)
  await app.register(venueRoutes)
  await app.register(ingestRoutes)

  // Health check
  app.get('/api/health', async (_request, reply) => {
    let postgresStatus = 'ok'
    try {
      await db.execute(sql`SELECT 1`)
    } catch (err) {
      postgresStatus = `error: ${(err as Error).message}`
    }

    let redisStatus: string
    if (config.useRedisPresence && config.redisUrl) {
      redisStatus = 'configured'
    } else {
      redisStatus = 'not_configured'
    }

    const isHealthy = postgresStatus === 'ok'

    const body = {
      status: isHealthy ? 'ok' : 'degraded',
      mode: config.mode,
      version: '2.0.0',
      timestamp: new Date().toISOString(),
      checks: {
        postgres: postgresStatus,
        redis: redisStatus,
        storage: config.storageProvider,
      },
      uptime: process.uptime(),
    }

    return reply.status(isHealthy ? 200 : 503).send(body)
  })

  // ── Prometheus Metrics ─────────────────────────────────────────────────────
  if (config.metricsEnabled) {
    // Request counting & duration hooks (skip /metrics to avoid recursion)
    app.addHook('onRequest', async (request) => {
      if (request.url === '/metrics') return
      ;(request as any).__metricsStart = process.hrtime.bigint()
    })

    app.addHook('onResponse', async (request, reply) => {
      if (request.url === '/metrics') return
      const start: bigint | undefined = (request as any).__metricsStart
      const route = request.routeOptions?.url || request.url
      const method = request.method
      const statusCode = String(reply.statusCode)

      httpRequestsTotal.inc({ method, route, status_code: statusCode })

      if (start !== undefined) {
        const durationNs = Number(process.hrtime.bigint() - start)
        httpRequestDurationSeconds.observe({ method, route }, durationNs / 1e9)
      }
    })

    app.get('/metrics', async (_request, reply) => {
      const metrics = await register.metrics()
      return reply.type(register.contentType).send(metrics)
    })

    console.log(`[vlm-server] Prometheus metrics enabled at /metrics`)
  }

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

    // SPA fallback: serve index.html for unmatched non-API routes.
    // The client-side Next.js router handles routing from there.
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ error: 'Not found' })
      }
      return reply.sendFile('index.html')
    })
  } else {
    console.log(`[vlm-server] No dashboard directory at ${dashboardPath} — API-only mode`)
    app.setNotFoundHandler(async (_request, reply) => {
      return reply.status(404).send({ error: 'Not found' })
    })
  }

  return app
}
