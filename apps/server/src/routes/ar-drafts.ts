import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { users } from '../db/schema.js'
import { config } from '../config.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess } from '../auth/permissions.js'
import { boundScene, fromInstance, type SceneFrom } from '../auth/scene-from.js'
import { mayBuild } from '../ar/access.js'
import { onDeviceEnded } from '../ar/devices.js'
import { hold, holderOf, release, releaseAll } from '../ws/draft-holds.js'
import { isValidDraft, roomsForScene } from '../ws/VLMSceneRoom.js'

/**
 * The headset's live drafts. Quest has no Colyseus client, so it posts each draft here and the server relays it into
 * the scene room as the room's own `transform_draft` / `transform_draft_end`; Decentraland editors see no difference.
 * Holds live in the process-wide registry (`ws/draft-holds.ts`), so this needs `VLM_MODE=single`; elsewhere the
 * routes answer 503 `drafts_unavailable` and the headset saves without a live preview.
 */

/** A headset hold lapses this long after its last draft for the item. */
const AR_HOLD_MS = 10 * 60_000
const DRAFT_LIMIT = 20
const DRAFT_WINDOW_MS = 1000

const arKey = (deviceId: string) => `ar:${deviceId}`

let clock = () => Date.now()
/** Test hook: the clock the per-device rate limit reads (null restores the real one). */
export function setArDraftClock(c: (() => number) | null): void {
  clock = c ?? (() => Date.now())
}

/** Recent draft times per device, for the 20-per-second limit. */
const draftTimes = new Map<string, number[]>()
/** Per-device count of drafts, taken on arrival (before any await). */
const draftSeq = new Map<string, number>()
/** `${deviceId}\n${sk}` -> drafts for sk that arrived but haven't finished. */
const inFlight = new Map<string, number>()
/** `${deviceId}\n${sk}` -> the device's draft count when it ended sk: drafts older than that still in flight are dropped. */
const ended = new Map<string, number>()

/** The pass's own scene, when the body's `sk` is an instance in it. */
const boundSceneWithInstance: SceneFrom = async (r) => {
  const sceneId = boundScene(r)
  const sk = (r.body as Record<string, unknown> | undefined)?.sk
  if (!sceneId || typeof sk !== 'string') return null
  const instanceScene = await fromInstance({ params: { instanceId: sk } } as unknown as FastifyRequest)
  return instanceScene === sceneId ? sceneId : null
}

/** The device and scene of an AR pass, or a refusal sent. */
function arPass(request: FastifyRequest, reply: FastifyReply): { deviceId: string; sceneId: string } | null {
  const u = request.user
  if (u.via !== 'ar' || !u.deviceId || !u.sceneId) {
    void reply.status(403).send({ error: 'ar_pass_required' })
    return null
  }
  if (config.mode !== 'single') {
    void reply.status(503).send({ error: 'drafts_unavailable' })
    return null
  }
  return { deviceId: u.deviceId, sceneId: u.sceneId }
}

async function holderNameOf(userId: string): Promise<string> {
  const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { displayName: true } })
  return `${u?.displayName || 'Someone'} (headset)`
}

async function relayEnd(sceneId: string, sk: string, saved: boolean) {
  await Promise.all(roomsForScene(sceneId).map((room) => room.relayArDraftEnd(sk, saved)))
}

/** A headset's session ended or it was revoked: its drafts end unsaved. */
onDeviceEnded(async (deviceId) => {
  draftTimes.delete(deviceId)
  // Drafts already past `authenticate` must not re-take a hold once it's released.
  for (const key of inFlight.keys()) if (key.startsWith(`${deviceId}\n`)) ended.set(key, draftSeq.get(deviceId) ?? 0)
  await Promise.all(releaseAll(arKey(deviceId)).map(({ sceneId, sk }) => relayEnd(sceneId, sk, false)))
})

export default async function arDraftRoutes(app: FastifyInstance) {
  app.post<{ Body: Record<string, any> }>(
    '/api/ar/drafts',
    { preHandler: [authenticate], config: { scenePass: { sceneFrom: boundSceneWithInstance, ar: true } } },
    async (request, reply) => {
      const pass = arPass(request, reply)
      if (!pass) return
      const { deviceId, sceneId } = pass
      const body = request.body
      if (!isValidDraft(body) || typeof body.sk !== 'string') return reply.status(400).send({ error: 'bad_request' })
      const sk: string = body.sk
      const key = `${deviceId}\n${sk}`
      const seq = (draftSeq.get(deviceId) ?? 0) + 1
      draftSeq.set(deviceId, seq)
      inFlight.set(key, (inFlight.get(key) ?? 0) + 1)
      try {
        const access = await getSceneAccess(actorFromClaims(request.user), sceneId)
        if (!mayBuild(access)) return reply.status(403).send({ error: 'no_access' })
        const name = await holderNameOf(request.user.id)
        const endedAt = ended.get(key)
        if (endedAt !== undefined) {
          if (seq <= endedAt) return reply.status(204).send() // sent before the headset ended sk: stale
          ended.delete(key)
        }
        const holder = holderOf(sceneId, sk)
        if (holder && holder.key !== arKey(deviceId)) return reply.status(409).send({ error: 'held', holderName: holder.name })
        const now = clock()
        const times = (draftTimes.get(deviceId) ?? []).filter((t) => now - t < DRAFT_WINDOW_MS)
        if (times.length >= DRAFT_LIMIT) {
          draftTimes.set(deviceId, times)
          return reply.status(204).send() // over the limit: dropped, as in the room
        }
        times.push(now)
        draftTimes.set(deviceId, times)
        hold(sceneId, sk, { key: arKey(deviceId), name, expiresAt: Date.now() + AR_HOLD_MS })
        const msg = { element: body.element, sk, position: body.position, rotation: body.rotation, scale: body.scale, holderName: name }
        await Promise.all(roomsForScene(sceneId).map((room) => room.relayArDraft(msg)))
        return reply.status(204).send()
      } finally {
        const left = (inFlight.get(key) ?? 1) - 1
        if (left > 0) inFlight.set(key, left)
        else {
          inFlight.delete(key)
          ended.delete(key) // nothing older is left to drop
        }
      }
    },
  )

  // The holder can always end its own draft, even if the instance was deleted since: the pass's scene is enough.
  app.post<{ Body: Record<string, any> }>(
    '/api/ar/drafts/end',
    { preHandler: [authenticate], config: { scenePass: { sceneFrom: boundScene, ar: true } } },
    async (request, reply) => {
      const pass = arPass(request, reply)
      if (!pass) return
      const { deviceId, sceneId } = pass
      const sk = request.body?.sk
      if (typeof sk !== 'string') return reply.status(400).send({ error: 'bad_request' })
      const key = `${deviceId}\n${sk}`
      if (inFlight.has(key)) ended.set(key, draftSeq.get(deviceId) ?? 0)
      if (release(sceneId, sk, arKey(deviceId))) await relayEnd(sceneId, sk, !!request.body.saved)
      return reply.status(204).send()
    },
  )
}
