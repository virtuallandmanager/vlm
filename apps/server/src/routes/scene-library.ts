import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { assetLibraryItems, mediaAssets, sceneLibrary } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, hasScope, isFullAccess } from '../auth/permissions.js'
import { fromParam } from '../auth/scene-from.js'
import { linkToScene, listSceneLibrary } from '../library/scene-library.js'

export default async function sceneLibraryRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  const access = (request: any, sceneId: string) => getSceneAccess(actorFromClaims(request.user), sceneId)

  app.get<{ Params: { sceneId: string } }>('/api/scenes/:sceneId/library', { config: { scenePass: { sceneFrom: fromParam('sceneId') } } }, async (request, reply) => {
    if ((await access(request, request.params.sceneId)).level === 'none') return reply.status(403).send({ error: 'forbidden' })
    return reply.send({ items: await listSceneLibrary(request.params.sceneId) })
  })

  // Account tokens only (no scenePass config): a pass can't pull files out of the owner's account.
  app.post<{ Params: { sceneId: string }; Body: { mediaAssetId?: string; assetItemId?: string } }>('/api/scenes/:sceneId/library', async (request, reply) => {
    const { sceneId } = request.params
    const { mediaAssetId, assetItemId } = request.body ?? {}
    if (!!mediaAssetId === !!assetItemId) return reply.status(400).send({ error: 'Give exactly one of mediaAssetId or assetItemId' })
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
    return reply.status(204).send()
  })
}
