import type { FastifyInstance } from 'fastify'
import { eq, and } from 'drizzle-orm'
import crypto from 'node:crypto'
import { db } from '../db/connection.js'
import { organizations, orgMembers, orgInvites, users } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { sendOrgInviteEmail } from '../services/email.js'

export default async function organizationRoutes(app: FastifyInstance) {
  // ── GET /api/orgs — list user's organizations ───────────────────────────

  app.get('/api/orgs', { preHandler: [authenticate] }, async (request) => {
    const memberships = await db
      .select({
        orgId: orgMembers.orgId,
        role: orgMembers.role,
        joinedAt: orgMembers.joinedAt,
        org: {
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
          logoUrl: organizations.logoUrl,
        },
      })
      .from(orgMembers)
      .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
      .where(eq(orgMembers.userId, request.user.id))

    return { organizations: memberships }
  })

  // ── POST /api/orgs — create organization ────────────────────────────────

  app.post<{ Body: { name: string; slug?: string } }>(
    '/api/orgs',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { name, slug: rawSlug } = request.body
      if (!name) return reply.status(400).send({ error: 'name is required' })

      const slug = (rawSlug || name).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')

      const existing = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug))
      if (existing.length > 0) return reply.status(409).send({ error: 'Organization slug already taken' })

      const [org] = await db.insert(organizations).values({
        name,
        slug,
        billingOwnerId: request.user.id,
      }).returning()

      // Creator becomes owner
      await db.insert(orgMembers).values({
        orgId: org.id,
        userId: request.user.id,
        role: 'owner',
      })

      // Set as active org if user has none
      const [user] = await db.select({ activeOrgId: users.activeOrgId }).from(users).where(eq(users.id, request.user.id))
      if (!user.activeOrgId) {
        await db.update(users).set({ activeOrgId: org.id }).where(eq(users.id, request.user.id))
      }

      return reply.status(201).send({ organization: org })
    },
  )

  // ── PUT /api/orgs/:orgId — update organization ─────────────────────────

  app.put<{ Params: { orgId: string }; Body: { name?: string; logoUrl?: string } }>(
    '/api/orgs/:orgId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { orgId } = request.params
      const membership = await getOrgMembership(request.user.id, orgId)
      if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
        return reply.status(403).send({ error: 'Must be org owner or admin' })
      }

      const { name, logoUrl } = request.body
      const [updated] = await db.update(organizations)
        .set({ ...(name ? { name } : {}), ...(logoUrl !== undefined ? { logoUrl } : {}), updatedAt: new Date() })
        .where(eq(organizations.id, orgId))
        .returning()

      return { organization: updated }
    },
  )

  // ── GET /api/orgs/:orgId/members — list members ────────────────────────

  app.get<{ Params: { orgId: string } }>(
    '/api/orgs/:orgId/members',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { orgId } = request.params
      const membership = await getOrgMembership(request.user.id, orgId)
      if (!membership) return reply.status(403).send({ error: 'Not a member of this organization' })

      const members = await db
        .select({
          userId: orgMembers.userId,
          role: orgMembers.role,
          joinedAt: orgMembers.joinedAt,
          user: {
            id: users.id,
            displayName: users.displayName,
            email: users.email,
          },
        })
        .from(orgMembers)
        .innerJoin(users, eq(orgMembers.userId, users.id))
        .where(eq(orgMembers.orgId, orgId))

      return { members }
    },
  )

  // ── POST /api/orgs/:orgId/invites — invite member ─────────────────────

  app.post<{ Params: { orgId: string }; Body: { email: string; role?: string } }>(
    '/api/orgs/:orgId/invites',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { orgId } = request.params
      const { email, role } = request.body

      if (!email) return reply.status(400).send({ error: 'email is required' })

      const membership = await getOrgMembership(request.user.id, orgId)
      if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
        return reply.status(403).send({ error: 'Must be org owner or admin to invite' })
      }

      const token = crypto.randomBytes(32).toString('hex')
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days

      const [invite] = await db.insert(orgInvites).values({
        orgId,
        email: email.toLowerCase(),
        role: (role as any) || 'member',
        invitedBy: request.user.id,
        token,
        expiresAt,
      }).returning()

      // Send invite email
      const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId))
      const [inviter] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, request.user.id))
      await sendOrgInviteEmail(email.toLowerCase(), org?.name || 'an organization', inviter?.displayName || 'Someone', token)

      return reply.status(201).send({ invite })
    },
  )

  // ── POST /api/orgs/accept-invite — accept invite by token ─────────────

  app.post<{ Body: { token: string } }>(
    '/api/orgs/accept-invite',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { token } = request.body
      if (!token) return reply.status(400).send({ error: 'token is required' })

      const [invite] = await db.select().from(orgInvites).where(eq(orgInvites.token, token))
      if (!invite) return reply.status(404).send({ error: 'Invite not found' })
      if (invite.status !== 'pending') return reply.status(400).send({ error: `Invite already ${invite.status}` })
      if (invite.expiresAt < new Date()) {
        await db.update(orgInvites).set({ status: 'expired' }).where(eq(orgInvites.id, invite.id))
        return reply.status(400).send({ error: 'Invite has expired' })
      }

      // Add user to org
      await db.insert(orgMembers).values({
        orgId: invite.orgId,
        userId: request.user.id,
        role: invite.role,
      }).onConflictDoNothing()

      // Mark invite accepted
      await db.update(orgInvites).set({ status: 'accepted' }).where(eq(orgInvites.id, invite.id))

      // Set active org if user has none
      const [user] = await db.select({ activeOrgId: users.activeOrgId }).from(users).where(eq(users.id, request.user.id))
      if (!user.activeOrgId) {
        await db.update(users).set({ activeOrgId: invite.orgId }).where(eq(users.id, request.user.id))
      }

      return { accepted: true, orgId: invite.orgId }
    },
  )

  // ── PUT /api/orgs/:orgId/active — set active org ──────────────────────

  app.put<{ Params: { orgId: string } }>(
    '/api/orgs/:orgId/active',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { orgId } = request.params
      const membership = await getOrgMembership(request.user.id, orgId)
      if (!membership) return reply.status(403).send({ error: 'Not a member of this organization' })

      await db.update(users).set({ activeOrgId: orgId }).where(eq(users.id, request.user.id))
      return { activeOrgId: orgId }
    },
  )

  // ── DELETE /api/orgs/:orgId/members/:userId — remove member ────────────

  app.delete<{ Params: { orgId: string; userId: string } }>(
    '/api/orgs/:orgId/members/:userId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { orgId, userId } = request.params

      const membership = await getOrgMembership(request.user.id, orgId)
      if (!membership || (membership.role !== 'owner' && membership.role !== 'admin' && request.user.id !== userId)) {
        return reply.status(403).send({ error: 'Insufficient permissions' })
      }

      if (membership.role === 'owner' && request.user.id === userId) {
        return reply.status(400).send({ error: 'Owner cannot remove themselves. Transfer ownership first.' })
      }

      await db.delete(orgMembers).where(
        and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId))
      )

      return reply.status(204).send()
    },
  )
}

async function getOrgMembership(userId: string, orgId: string) {
  const [membership] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.userId, userId), eq(orgMembers.orgId, orgId)))
  return membership || null
}
