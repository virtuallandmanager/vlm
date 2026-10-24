import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { RING_MAX_DIAMETER_MM } from 'vlm-shared'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess } from '../auth/permissions.js'
import { fromParam, type SceneFrom } from '../auth/scene-from.js'
import { fromFloor, fromMarker, fromSpace, mayBuild } from '../ar/access.js'
import { addFloor, addMarker, createSpace, deleteFloor, deleteMarker, deleteSpace, listSpaces, updateFloor, updateMarker, updateSpace } from '../ar/spaces.js'

const MIN_DIAMETER_MM = 60

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 200
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const optText = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.length <= 500)
const validDiameter = (v: unknown) => v === undefined || (isNum(v) && v >= MIN_DIAMETER_MM && v <= RING_MAX_DIAMETER_MM)

export default async function arSpaceRoutes(app: FastifyInstance) {
  // Setup is a dashboard job, not a headset one: only the read-only space list takes an AR pass (`ar: true`).
  const cfg = (sceneFrom: SceneFrom) => ({ preHandler: [authenticate], config: { scenePass: { sceneFrom } } })

  /** Resolves the scene (404 when unknown), then requires build access (403 no_access). */
  async function guard(request: FastifyRequest, reply: FastifyReply, sceneFrom: SceneFrom) {
    const sceneId = await sceneFrom(request)
    if (!sceneId) {
      reply.status(404).send({ error: 'not_found' })
      return null
    }
    const access = await getSceneAccess(actorFromClaims(request.user), sceneId)
    if (!mayBuild(access)) {
      reply.status(403).send({ error: 'no_access' })
      return null
    }
    return sceneId
  }

  const bad = (reply: FastifyReply, error = 'bad_request') => reply.status(400).send({ error })
  const missing = (reply: FastifyReply) => reply.status(404).send({ error: 'not_found' })
  const fromSceneId = fromParam('sceneId')

  app.get<{ Params: { sceneId: string } }>('/api/scenes/:sceneId/ar/spaces', { preHandler: [authenticate], config: { scenePass: { sceneFrom: fromSceneId, ar: true as const } } }, async (request, reply) => {
    const sceneId = await guard(request, reply, fromSceneId)
    if (!sceneId) return
    return reply.send(await listSpaces(sceneId))
  })

  app.post<{ Params: { sceneId: string }; Body: { name?: unknown; place?: unknown } }>('/api/scenes/:sceneId/ar/spaces', cfg(fromSceneId), async (request, reply) => {
    const sceneId = await guard(request, reply, fromSceneId)
    if (!sceneId) return
    const { name, place } = request.body ?? {}
    if (!isStr(name) || !optText(place)) return bad(reply)
    return reply.status(201).send(await createSpace(sceneId, { name: name.trim(), place: (place as string | null | undefined) ?? null }))
  })

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/ar/spaces/:id', cfg(fromSpace), async (request, reply) => {
    if (!(await guard(request, reply, fromSpace))) return
    const b = request.body ?? {}
    const patch: Parameters<typeof updateSpace>[1] = {}
    if (b.name !== undefined) { if (!isStr(b.name)) return bad(reply); patch.name = b.name.trim() }
    if (b.place !== undefined) { if (!optText(b.place)) return bad(reply); patch.place = b.place as string | null }
    if (b.lat !== undefined) { if (b.lat !== null && !(isNum(b.lat) && Math.abs(b.lat) <= 90)) return bad(reply); patch.lat = b.lat as number | null }
    if (b.lng !== undefined) { if (b.lng !== null && !(isNum(b.lng) && Math.abs(b.lng) <= 180)) return bad(reply); patch.lng = b.lng as number | null }
    if (b.published !== undefined) { if (typeof b.published !== 'boolean') return bad(reply); patch.published = b.published }
    const view = await updateSpace(request.params.id, patch)
    return view ? reply.send(view) : missing(reply)
  })

  app.delete<{ Params: { id: string } }>('/api/ar/spaces/:id', cfg(fromSpace), async (request, reply) => {
    if (!(await guard(request, reply, fromSpace))) return
    return (await deleteSpace(request.params.id)) ? reply.status(204).send() : missing(reply)
  })

  app.post<{ Params: { id: string }; Body: { name?: unknown; heightM?: unknown } }>('/api/ar/spaces/:id/floors', cfg(fromSpace), async (request, reply) => {
    if (!(await guard(request, reply, fromSpace))) return
    const { name, heightM } = request.body ?? {}
    if (!isStr(name) || !isNum(heightM)) return bad(reply)
    const floor = await addFloor(request.params.id, { name: name.trim(), heightM })
    return floor ? reply.status(201).send(floor) : missing(reply)
  })

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/ar/floors/:id', cfg(fromFloor), async (request, reply) => {
    if (!(await guard(request, reply, fromFloor))) return
    const b = request.body ?? {}
    const patch: Parameters<typeof updateFloor>[1] = {}
    if (b.name !== undefined) { if (!isStr(b.name)) return bad(reply); patch.name = b.name.trim() }
    if (b.heightM !== undefined) { if (!isNum(b.heightM)) return bad(reply); patch.heightM = b.heightM }
    if (b.sortOrder !== undefined) { if (!isNum(b.sortOrder) || !Number.isInteger(b.sortOrder)) return bad(reply); patch.sortOrder = b.sortOrder }
    if (!Object.keys(patch).length) return bad(reply)
    const floor = await updateFloor(request.params.id, patch)
    return floor ? reply.send(floor) : missing(reply)
  })

  app.delete<{ Params: { id: string } }>('/api/ar/floors/:id', cfg(fromFloor), async (request, reply) => {
    if (!(await guard(request, reply, fromFloor))) return
    const result = await deleteFloor(request.params.id)
    if (result === 'last_floor') return reply.status(409).send({ error: 'last_floor' })
    return result ? reply.status(204).send() : missing(reply)
  })

  app.post<{ Params: { id: string }; Body: { diameterMm?: unknown; whereText?: unknown } }>('/api/ar/floors/:id/markers', cfg(fromFloor), async (request, reply) => {
    if (!(await guard(request, reply, fromFloor))) return
    const { diameterMm, whereText } = request.body ?? {}
    if (!validDiameter(diameterMm)) return bad(reply, 'bad_diameter')
    if (!optText(whereText)) return bad(reply)
    const marker = await addMarker(request.params.id, { diameterMm: diameterMm as number | undefined, whereText: (whereText as string | null | undefined) ?? null })
    return marker ? reply.status(201).send(marker) : missing(reply)
  })

  app.put<{ Params: { id: string }; Body: { diameterMm?: unknown; whereText?: unknown } }>('/api/ar/markers/:id', cfg(fromMarker), async (request, reply) => {
    if (!(await guard(request, reply, fromMarker))) return
    const { diameterMm, whereText } = request.body ?? {}
    if (!validDiameter(diameterMm)) return bad(reply, 'bad_diameter')
    if (!optText(whereText)) return bad(reply)
    const patch: Parameters<typeof updateMarker>[1] = {}
    if (diameterMm !== undefined) patch.diameterMm = diameterMm as number
    if (whereText !== undefined) patch.whereText = whereText as string | null
    if (!Object.keys(patch).length) return bad(reply)
    const marker = await updateMarker(request.params.id, patch)
    return marker ? reply.send(marker) : missing(reply)
  })

  app.delete<{ Params: { id: string } }>('/api/ar/markers/:id', cfg(fromMarker), async (request, reply) => {
    if (!(await guard(request, reply, fromMarker))) return
    return (await deleteMarker(request.params.id)) ? reply.status(204).send() : missing(reply)
  })
}
