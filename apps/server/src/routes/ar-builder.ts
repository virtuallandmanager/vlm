import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Adjustment, Vec3 } from '@virvixr/shared'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess } from '../auth/permissions.js'
import type { SceneFrom } from '../auth/scene-from.js'
import { fromMarker, fromSpace, mayBuild } from '../ar/access.js'
import { clearAdjustment, saveAdjustment } from '../ar/adjustments.js'
import { setMarkerPose } from '../ar/spaces.js'
import { endArDraftForSave } from './ar-drafts.js'

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const asVec3 = (v: unknown, ok: (n: number) => boolean = () => true): Vec3 | null => {
  const o = v as Record<string, unknown> | null
  return o && typeof o === 'object' && isNum(o.x) && isNum(o.y) && isNum(o.z) && ok(o.x) && ok(o.y) && ok(o.z) ? { x: o.x, y: o.y, z: o.z } : null
}

/** The builder's saves: ring alignments and "Just this place" adjustments. The headset may do both (`ar: true`). */
export default async function arBuilderRoutes(app: FastifyInstance) {
  const cfg = (sceneFrom: SceneFrom) => ({ preHandler: [authenticate], config: { scenePass: { sceneFrom, ar: true as const } } })

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

  /** A headset that saved this place's version of an instance ends its live draft of it (see ar-drafts.ts). */
  async function endHeadsetDraft(request: FastifyRequest, sceneId: string, instanceId: string) {
    const u = request.user
    if (u.via === 'ar' && u.deviceId) await endArDraftForSave(u.deviceId, sceneId, instanceId)
  }

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/ar/markers/:id/pose', cfg(fromMarker), async (request, reply) => {
    if (!(await guard(request, reply, fromMarker))) return
    const { x, y, z, headingDeg, heightAboveFloorM } = request.body ?? {}
    if (!isNum(x) || !isNum(y) || !isNum(z) || !isNum(headingDeg) || !isNum(heightAboveFloorM)) return reply.status(400).send({ error: 'bad_request' })
    const result = await setMarkerPose(request.params.id, { x, y, z, headingDeg, heightAboveFloorM })
    return result ? reply.send(result) : reply.status(404).send({ error: 'not_found' })
  })

  app.put<{ Params: { id: string; instanceId: string }; Body: Record<string, unknown> }>('/api/ar/spaces/:id/adjustments/:instanceId', cfg(fromSpace), async (request, reply) => {
    const sceneId = await guard(request, reply, fromSpace)
    if (!sceneId) return
    const b = request.body ?? {}
    const dPosition = asVec3(b.dPosition)
    const dRotation = asVec3(b.dRotation)
    const scaleFactor = asVec3(b.scaleFactor, (n) => n > 0)
    if (!dPosition || !dRotation || !scaleFactor) return reply.status(400).send({ error: 'bad_request' })
    const adj: Adjustment = { dPosition, dRotation, scaleFactor }
    const result = await saveAdjustment(request.params.id, request.params.instanceId, adj)
    if (result === null) return reply.status(404).send({ error: 'not_found' })
    if (result === 'instance_not_in_scene') return reply.status(400).send({ error: result })
    await endHeadsetDraft(request, sceneId, request.params.instanceId)
    return reply.send(adj)
  })

  app.delete<{ Params: { id: string; instanceId: string } }>('/api/ar/spaces/:id/adjustments/:instanceId', cfg(fromSpace), async (request, reply) => {
    const sceneId = await guard(request, reply, fromSpace)
    if (!sceneId) return
    if (!(await clearAdjustment(request.params.id, request.params.instanceId))) return reply.status(404).send({ error: 'not_found' })
    await endHeadsetDraft(request, sceneId, request.params.instanceId)
    return reply.status(204).send()
  })
}
