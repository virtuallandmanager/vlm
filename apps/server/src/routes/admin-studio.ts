import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../middleware/auth.js'
import { isUuid } from '../auth/scene-from.js'
import { dismissFlag, listFlags, pauseUser, resumeUser } from '../studio/scope.js'
import { approveReport, declineReport, heldReports, PaymentError } from '../studio/payments.js'

/** Admins only: the Studio flags page (src/studio/scope.ts). Accounts that keep sending off-topic work, and pausing them. */
async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (request.user.role !== 'admin') {
    return reply.status(403).send({ error: 'Forbidden', message: 'Admin access required' })
  }
}

export default async function adminStudioRoutes(app: FastifyInstance) {
  const admin = { preHandler: [authenticate, requireAdmin] }

  app.get('/api/admin/studio/flags', admin, async (request) => {
    const status = (request.query as { status?: string }).status === 'closed' ? 'closed' : 'open'
    return { flags: await listFlags(status, new Date()) }
  })

  app.post('/api/admin/studio/flags/:id/dismiss', admin, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!isUuid(id) || !(await dismissFlag(id, request.user.id, new Date()))) return reply.status(404).send({ error: 'flag_not_found' })
    return reply.status(204).send()
  })

  app.post('/api/admin/studio/users/:userId/pause', admin, async (request, reply) => {
    const { userId } = request.params as { userId: string }
    if (!isUuid(userId) || !(await pauseUser(userId, request.user.id, new Date()))) return reply.status(404).send({ error: 'user_not_found' })
    return reply.status(204).send()
  })

  app.delete('/api/admin/studio/users/:userId/pause', admin, async (request, reply) => {
    const { userId } = request.params as { userId: string }
    if (!isUuid(userId)) return reply.status(404).send({ error: 'user_not_found' })
    await resumeUser(userId)
    return reply.status(204).send()
  })

  app.get('/api/admin/studio/reports', admin, async () => ({ reports: await heldReports(new Date()) }))

  app.post('/api/admin/studio/reports/:id/approve', admin, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!isUuid(id)) return reply.status(404).send({ error: 'report_not_found' })
    try {
      return await approveReport(id, request.user.id, new Date())
    } catch (err) {
      if (err instanceof PaymentError) return reply.status(err.status).send({ error: err.code, code: err.code })
      throw err
    }
  })

  app.post('/api/admin/studio/reports/:id/decline', admin, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!isUuid(id) || !(await declineReport(id, request.user.id, new Date()))) return reply.status(409).send({ error: 'not_in_review', code: 'not_in_review' })
    return reply.status(204).send()
  })
}
