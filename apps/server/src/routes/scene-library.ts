import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { assetLibraryItems, mediaAssets, sceneLibrary } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, hasScope, isFullAccess } from '../auth/permissions.js'
import { fromParam, isUuid } from '../auth/scene-from.js'
import { linkToScene, listSceneLibrary, uploadDestination } from '../library/scene-library.js'
import { storeMedia, StoreMediaError } from '../media/store.js'
import { publishLibraryChanged } from '../realtime/bus.js'

export default async function sceneLibraryRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  // Malformed ids would reach Postgres as invalid uuids (500); they name nothing, so 404.
  app.addHook('preHandler', async (request, reply) => {
    const p = (request.params ?? {}) as Record<string, unknown>
    for (const k of ['sceneId', 'id']) if (k in p && !isUuid(p[k])) return reply.status(404).send({ error: 'Not found' })
  })
  const access = (request: any, sceneId: string) => getSceneAccess(actorFromClaims(request.user), sceneId)

  app.get<{ Params: { sceneId: string } }>('/api/scenes/:sceneId/library', { config: { scenePass: { sceneFrom: fromParam('sceneId') } } }, async (request, reply) => {
    if ((await access(request, request.params.sceneId)).level === 'none') return reply.status(403).send({ error: 'forbidden' })
    return reply.send({ items: await listSceneLibrary(request.params.sceneId) })
  })

  // Account tokens only: no scenePass config, so authenticate refuses passes by default deny (a pass can't pull files out of the owner's account).
  app.post<{ Params: { sceneId: string }; Body: { mediaAssetId?: string; assetItemId?: string } }>('/api/scenes/:sceneId/library', async (request, reply) => {
    const { sceneId } = request.params
    const { mediaAssetId, assetItemId } = request.body ?? {}
    if (!!mediaAssetId === !!assetItemId) return reply.status(400).send({ error: 'Give exactly one of mediaAssetId or assetItemId' })
    if (!isUuid(mediaAssetId ?? assetItemId)) return reply.status(400).send({ error: 'Invalid id' })
    if (!hasScope(await access(request, sceneId), 'scene.edit')) return reply.status(403).send({ error: 'forbidden' })
    const owns = mediaAssetId
      ? await db.query.mediaAssets.findFirst({ where: and(eq(mediaAssets.id, mediaAssetId), eq(mediaAssets.ownerId, request.user.id)) })
      : await db.query.assetLibraryItems.findFirst({ where: and(eq(assetLibraryItems.id, assetItemId!), eq(assetLibraryItems.uploadedBy, request.user.id)) })
    if (!owns) return reply.status(403).send({ error: 'forbidden' })
    return reply.status(201).send({ id: await linkToScene(sceneId, { mediaAssetId, assetItemId }, request.user.id) })
  })

  app.delete<{ Params: { sceneId: string; id: string } }>('/api/scenes/:sceneId/library/:id', { config: { scenePass: { sceneFrom: fromParam('sceneId') } } }, async (request, reply) => {
    const { sceneId, id } = request.params
    const row = await db.query.sceneLibrary.findFirst({ where: and(eq(sceneLibrary.id, id), eq(sceneLibrary.sceneId, sceneId)) })
    if (!row) return reply.status(404).send({ error: 'Not found' })
    const a = await access(request, sceneId)
    const allowed = isFullAccess(a) || (hasScope(a, 'scene.edit') && row.addedBy === request.user.id)
    if (!allowed) return reply.status(403).send({ error: 'forbidden' })
    await db.delete(sceneLibrary).where(eq(sceneLibrary.id, id))
    await publishLibraryChanged(sceneId, id, true)
    return reply.status(204).send()
  })

  app.post<{ Params: { sceneId: string }; Body: { filename?: string; contentType?: string; data?: string } }>(
    '/api/scenes/:sceneId/library/upload',
    { config: { scenePass: { sceneFrom: fromParam('sceneId') } } },
    async (request, reply) => {
      const { sceneId } = request.params
      const { filename, contentType, data } = request.body ?? {}
      if (!filename || !contentType || !data) return reply.status(400).send({ error: 'filename, contentType and data are required' })
      const dest = await uploadDestination(actorFromClaims(request.user), sceneId)
      if (!dest) return reply.status(403).send({ error: 'forbidden' })
      try {
        const m = await storeMedia(dest.ownerId, { filename, contentType, data: Buffer.from(data, 'base64') }, { quotaStatus: 413, quotaMessage: dest.bookingId ? undefined : "The scene owner's storage is full" })
        await linkToScene(sceneId, { mediaAssetId: m.id }, request.user.id, dest.bookingId)
        const item = (await listSceneLibrary(sceneId)).find((i) => i.url === m.publicUrl)
        return reply.status(201).send({ item })
      } catch (e) {
        if (e instanceof StoreMediaError) return reply.status(e.status).send(e.body)
        throw e
      }
    },
  )
}
