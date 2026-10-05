import type { FastifyInstance, FastifyReply } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { scenes, venues } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, hasScope, isFullAccess } from '../auth/permissions.js'
import {
  type CreateVenueInput,
  VenueError,
  addGrant,
  bookingsForActor,
  cancelBooking,
  createBooking,
  createVenue,
  getBookingWithVenue,
  getGrant,
  listGrants,
  revokeGrant,
  updateGrant,
  updateVenue,
} from '../venues/service.js'

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof VenueError) return reply.status(err.status).send({ error: err.message })
  throw err
}

export default async function venueRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  const actorOf = (request: { user: any }) => actorFromClaims(request.user)

  /** Admin, or owner of the scene. */
  async function canManageScene(request: { user: any }, sceneId: string) {
    const access = await getSceneAccess(actorOf(request), sceneId)
    return isFullAccess(access)
  }

  /** Crew management: needs `crew`; grant holders only for their own booking; non-hosts can't touch the host grant. */
  async function crewAccess(request: { user: any }, bookingId: string, targetRole?: string) {
    const booking = await getBookingWithVenue(bookingId)
    const access = await getSceneAccess(actorOf(request), booking.venue.sceneId)
    if (!hasScope(access, 'crew')) throw new VenueError(403, 'You cannot manage crew for this booking')
    if (access.level === 'grant') {
      if (access.booking!.bookingId !== bookingId) throw new VenueError(403, 'You cannot manage crew for this booking')
      if (targetRole === 'host' && access.booking!.role !== 'host') throw new VenueError(403, 'Only the host can change the host')
    }
    return booking
  }

  app.post<{ Body: Record<string, any> }>('/api/venues', async (request, reply) => {
    try {
      if (!(await canManageScene(request, request.body?.sceneId))) return reply.status(403).send({ error: 'Forbidden' })
      return reply.status(201).send({ venue: await createVenue(request.body as CreateVenueInput) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.get('/api/venues', async (_request, reply) => {
    const listed = await db.query.venues.findMany({ where: eq(venues.isListed, true) })
    return reply.send({ venues: listed })
  })

  app.get('/api/venues/bookings/mine', async (request, reply) => {
    const actor = actorOf(request)
    if (!actor.userId || !actor.verified) return reply.send({ bookings: [] })
    return reply.send({ bookings: await bookingsForActor(actor.userId, actor.wallet) })
  })

  app.get<{ Params: { venueId: string } }>('/api/venues/:venueId', async (request, reply) => {
    const venue = await db.query.venues.findFirst({ where: eq(venues.id, request.params.venueId) })
    if (!venue) return reply.status(404).send({ error: 'Venue not found' })
    return reply.send({ venue })
  })

  app.patch<{ Params: { venueId: string }; Body: Record<string, any> }>('/api/venues/:venueId', async (request, reply) => {
    try {
      const venue = await db.query.venues.findFirst({ where: eq(venues.id, request.params.venueId) })
      if (!venue) return reply.status(404).send({ error: 'Venue not found' })
      if (!(await canManageScene(request, venue.sceneId))) return reply.status(403).send({ error: 'Forbidden' })
      return reply.send({ venue: await updateVenue(venue.id, request.body ?? {}) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.post<{ Params: { venueId: string }; Body: Record<string, any> }>('/api/venues/:venueId/bookings', async (request, reply) => {
    // Admin-only until self-serve booking + payments (sub-project 5).
    if (request.user.role !== 'admin') return reply.status(403).send({ error: 'Only admins can create bookings right now' })
    try {
      const result = await createBooking({ ...(request.body as any), venueId: request.params.venueId, createdByUserId: request.user.id })
      return reply.status(201).send(result)
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.post<{ Params: { bookingId: string } }>('/api/venues/bookings/:bookingId/cancel', async (request, reply) => {
    if (request.user.role !== 'admin') return reply.status(403).send({ error: 'Forbidden' })
    try {
      return reply.send({ booking: await cancelBooking(request.params.bookingId) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.get<{ Params: { bookingId: string } }>('/api/venues/bookings/:bookingId/grants', async (request, reply) => {
    try {
      await crewAccess(request, request.params.bookingId)
      return reply.send({ grants: await listGrants(request.params.bookingId) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.post<{ Params: { bookingId: string }; Body: Record<string, any> }>('/api/venues/bookings/:bookingId/grants', async (request, reply) => {
    try {
      await crewAccess(request, request.params.bookingId)
      const grant = await addGrant({ ...(request.body as any), bookingId: request.params.bookingId, grantedByUserId: request.user.id })
      return reply.status(201).send({ grant })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.patch<{ Params: { grantId: string }; Body: Record<string, any> }>('/api/venues/grants/:grantId', async (request, reply) => {
    try {
      const grant = await getGrant(request.params.grantId)
      await crewAccess(request, grant.bookingId, grant.role)
      return reply.send({ grant: await updateGrant(grant.id, request.body ?? {}) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.delete<{ Params: { grantId: string } }>('/api/venues/grants/:grantId', async (request, reply) => {
    try {
      const grant = await getGrant(request.params.grantId)
      await crewAccess(request, grant.bookingId, grant.role)
      await revokeGrant(grant.id)
      return reply.status(204).send()
    } catch (err) {
      return fail(reply, err)
    }
  })
}
