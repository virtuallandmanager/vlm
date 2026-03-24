import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { eq, sql, ilike, or, count } from 'drizzle-orm'
import { db } from '../db/connection.js'
import {
  users,
  organizations,
  orgMembers,
  scenes,
  mediaAssets,
  subscriptions,
} from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'

/**
 * Reusable preHandler that ensures the authenticated user has the 'admin' role.
 * Must be used AFTER `authenticate` so that `request.user` is populated.
 */
async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (request.user.role !== 'admin') {
    return reply.status(403).send({ error: 'Forbidden', message: 'Admin access required' })
  }
}

export default async function adminRoutes(app: FastifyInstance) {
  // All admin routes require authentication + admin role
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireAdmin)

  // ── GET /api/admin/stats — system-wide statistics ─────────────────────────

  app.get('/api/admin/stats', async (_request, reply) => {
    const [
      [{ totalUsers }],
      [{ totalOrgs }],
      [{ totalScenes }],
      [{ totalMedia }],
      [{ totalStorageBytes }],
      subscriptionsByTier,
    ] = await Promise.all([
      db.select({ totalUsers: sql<number>`count(*)::int` }).from(users),
      db.select({ totalOrgs: sql<number>`count(*)::int` }).from(organizations),
      db.select({ totalScenes: sql<number>`count(*)::int` }).from(scenes),
      db.select({ totalMedia: sql<number>`count(*)::int` }).from(mediaAssets),
      db.select({ totalStorageBytes: sql<string>`coalesce(sum(${mediaAssets.sizeBytes}), 0)::bigint` }).from(mediaAssets),
      db
        .select({
          tier: subscriptions.tier,
          count: sql<number>`count(*)::int`,
        })
        .from(subscriptions)
        .where(eq(subscriptions.status, 'active'))
        .groupBy(subscriptions.tier),
    ])

    const activeSubscriptionsByTier: Record<string, number> = {}
    for (const row of subscriptionsByTier) {
      activeSubscriptionsByTier[row.tier] = row.count
    }

    return reply.send({
      totalUsers,
      totalOrgs,
      totalScenes,
      totalMedia,
      totalStorageBytes: Number(totalStorageBytes),
      activeSubscriptionsByTier,
    })
  })

  // ── GET /api/admin/users — list all users with pagination ─────────────────

  app.get<{
    Querystring: { limit?: string; offset?: string; search?: string }
  }>('/api/admin/users', async (request, reply) => {
    const limit = Math.min(Number(request.query.limit) || 50, 200)
    const offset = Number(request.query.offset) || 0
    const search = request.query.search?.trim()

    const conditions = search
      ? or(
          ilike(users.displayName, `%${search}%`),
          ilike(users.email, `%${search}%`),
        )
      : undefined

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          id: users.id,
          displayName: users.displayName,
          email: users.email,
          role: users.role,
          createdAt: users.createdAt,
          activeOrgId: users.activeOrgId,
        })
        .from(users)
        .where(conditions)
        .orderBy(users.createdAt)
        .limit(limit)
        .offset(offset),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(users)
        .where(conditions),
    ])

    return reply.send({ users: rows, total, limit, offset })
  })

  // ── GET /api/admin/users/:userId — single user details ────────────────────

  app.get<{ Params: { userId: string } }>('/api/admin/users/:userId', async (request, reply) => {
    const { userId } = request.params

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      with: {
        orgMemberships: {
          with: {
            org: true,
          },
        },
      },
    })

    if (!user) {
      return reply.status(404).send({ error: 'User not found' })
    }

    // Fetch subscription for this user
    const [subscription] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1)

    return reply.send({ user, subscription: subscription || null })
  })

  // ── PUT /api/admin/users/:userId/role — update user role ──────────────────

  app.put<{ Params: { userId: string }; Body: { role: string } }>(
    '/api/admin/users/:userId/role',
    async (request, reply) => {
      const { userId } = request.params
      const { role } = request.body

      if (!role || !['admin', 'creator', 'viewer'].includes(role)) {
        return reply.status(400).send({ error: 'Invalid role. Must be admin, creator, or viewer.' })
      }

      const existing = await db.query.users.findFirst({ where: eq(users.id, userId) })
      if (!existing) {
        return reply.status(404).send({ error: 'User not found' })
      }

      const [updated] = await db
        .update(users)
        .set({ role: role as 'admin' | 'creator' | 'viewer', updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning()

      return reply.send({ user: updated })
    },
  )

  // ── DELETE /api/admin/users/:userId — delete user ─────────────────────────

  app.delete<{ Params: { userId: string } }>('/api/admin/users/:userId', async (request, reply) => {
    const { userId } = request.params

    // Prevent self-deletion
    if (userId === request.user.id) {
      return reply.status(400).send({ error: 'Cannot delete your own admin account' })
    }

    const existing = await db.query.users.findFirst({ where: eq(users.id, userId) })
    if (!existing) {
      return reply.status(404).send({ error: 'User not found' })
    }

    await db.delete(users).where(eq(users.id, userId))
    return reply.status(204).send()
  })

  // ── GET /api/admin/orgs — list all organizations with counts ──────────────

  app.get<{
    Querystring: { limit?: string; offset?: string; search?: string }
  }>('/api/admin/orgs', async (request, reply) => {
    const limit = Math.min(Number(request.query.limit) || 50, 200)
    const offset = Number(request.query.offset) || 0
    const search = request.query.search?.trim()

    const conditions = search
      ? or(
          ilike(organizations.name, `%${search}%`),
          ilike(organizations.slug, `%${search}%`),
        )
      : undefined

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
          createdAt: organizations.createdAt,
          memberCount: sql<number>`(SELECT count(*)::int FROM org_members WHERE org_id = ${organizations.id})`,
          sceneCount: sql<number>`(SELECT count(*)::int FROM scenes WHERE org_id = ${organizations.id})`,
        })
        .from(organizations)
        .where(conditions)
        .orderBy(organizations.createdAt)
        .limit(limit)
        .offset(offset),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(organizations)
        .where(conditions),
    ])

    return reply.send({ organizations: rows, total, limit, offset })
  })

  // ── DELETE /api/admin/orgs/:orgId — delete organization ───────────────────

  app.delete<{ Params: { orgId: string } }>('/api/admin/orgs/:orgId', async (request, reply) => {
    const { orgId } = request.params

    const existing = await db.query.organizations.findFirst({ where: eq(organizations.id, orgId) })
    if (!existing) {
      return reply.status(404).send({ error: 'Organization not found' })
    }

    await db.delete(organizations).where(eq(organizations.id, orgId))
    return reply.status(204).send()
  })
}
