import type { FastifyInstance } from 'fastify'
import { eq, and, gte, isNull, sql } from 'drizzle-orm'
import { db } from '../db/connection'
import { analyticsSessions, analyticsActions, scenes } from '../db/schema'
import { authenticate } from '../middleware/auth'

export default async function analyticsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // ── GET /api/analytics/scenes/:sceneId/recent — Recent stats (last 24h) ──

  app.get<{ Params: { sceneId: string } }>(
    '/api/analytics/scenes/:sceneId/recent',
    async (request, reply) => {
      const { sceneId } = request.params

      // Verify scene exists and user has access
      const scene = await db.query.scenes.findFirst({
        where: eq(scenes.id, sceneId),
        with: { collaborators: true },
      })
      if (!scene) return reply.status(404).send({ error: 'Scene not found' })

      const isOwner = scene.ownerId === request.user.id
      const isCollaborator = scene.collaborators.some((c) => c.userId === request.user.id)
      if (!isOwner && !isCollaborator && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000)

      // Count visitors (unique sessions in last 24h)
      const [visitorResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(analyticsSessions)
        .where(
          and(
            eq(analyticsSessions.sceneId, sceneId),
            gte(analyticsSessions.startedAt, since),
          ),
        )

      // Count actions in last 24h
      const [actionResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(analyticsActions)
        .where(
          and(
            eq(analyticsActions.sceneId, sceneId),
            gte(analyticsActions.createdAt, since),
          ),
        )

      // Count active sessions (no endedAt)
      const [activeResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(analyticsSessions)
        .where(
          and(
            eq(analyticsSessions.sceneId, sceneId),
            isNull(analyticsSessions.endedAt),
          ),
        )

      // Recent sessions (last 24h, most recent first)
      const recentSessions = await db.query.analyticsSessions.findMany({
        where: and(
          eq(analyticsSessions.sceneId, sceneId),
          gte(analyticsSessions.startedAt, since),
        ),
        orderBy: (s, { desc }) => [desc(s.startedAt)],
        limit: 50,
        columns: {
          id: true,
          displayName: true,
          platform: true,
          startedAt: true,
          endedAt: true,
        },
      })

      return reply.send({
        visitors: visitorResult.count,
        actions: actionResult.count,
        activeSessions: activeResult.count,
        recentSessions,
      })
    },
  )

  // ── GET /api/analytics/scenes/:sceneId/sessions — List sessions ──────────

  app.get<{ Params: { sceneId: string }; Querystring: { limit?: string; offset?: string } }>(
    '/api/analytics/scenes/:sceneId/sessions',
    async (request, reply) => {
      const { sceneId } = request.params
      const limit = Math.min(parseInt(request.query.limit || '50', 10), 200)
      const offset = parseInt(request.query.offset || '0', 10)

      // Verify scene exists and user has access
      const scene = await db.query.scenes.findFirst({
        where: eq(scenes.id, sceneId),
        with: { collaborators: true },
      })
      if (!scene) return reply.status(404).send({ error: 'Scene not found' })

      const isOwner = scene.ownerId === request.user.id
      const isCollaborator = scene.collaborators.some((c) => c.userId === request.user.id)
      if (!isOwner && !isCollaborator && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const sessions = await db.query.analyticsSessions.findMany({
        where: eq(analyticsSessions.sceneId, sceneId),
        orderBy: (s, { desc }) => [desc(s.startedAt)],
        limit,
        offset,
        with: {
          actions: true,
        },
      })

      return reply.send({ sessions })
    },
  )
}
