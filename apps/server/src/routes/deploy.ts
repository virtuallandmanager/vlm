/**
 * Scene Deployment Routes — Build and deploy scenes to platforms.
 *
 * POST   /api/deploy                  — Start a new deployment
 * GET    /api/deploy/:id              — Get deployment status
 * GET    /api/deploy/scene/:sceneId   — List deployments for a scene
 * POST   /api/deploy/:id/cancel       — Cancel a pending/building deployment
 * POST   /api/deploy/:id/redeploy     — Redeploy a previous deployment
 *
 * POST   /api/deploy/wallets          — Store a deployment wallet
 * GET    /api/deploy/wallets          — List user's deployment wallets
 * DELETE /api/deploy/wallets/:id      — Remove a deployment wallet
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eq, desc, and } from 'drizzle-orm'
import { db } from '../db/connection.js'
import {
  sceneDeployments,
  deploymentWallets,
  scenes,
} from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { requireFeature } from '../middleware/feature-gate.js'
import { HyperfyProvisioner } from '../services/hyperfy/provisioner.js'
import { hyperfyHosting } from '../services/hyperfy/infrastructure.js'
import { executeDCLDeploy } from '../services/dcl/deployer.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, hasScope, isFullAccess } from '../auth/permissions.js'
import { assertPublicHttpUrl } from '../net/public-url.js'

type Deployment = typeof sceneDeployments.$inferSelect

/** Copy of a deployment safe to send to clients: the Hyperfy admin code never leaves the server. */
export function publicDeployment(d: Deployment): Deployment {
  const { adminCode: _, ...target } = (d.target ?? {}) as Record<string, unknown>
  return { ...d, target }
}

/** Load a deployment the caller may see (`read`: scene.edit) or change (`manage`: full access); null otherwise. */
export async function deploymentForCaller(
  request: FastifyRequest,
  id: string,
  need: 'read' | 'manage',
): Promise<Deployment | null> {
  if (!UUID.test(id)) return null
  const deployment = await db.query.sceneDeployments.findFirst({ where: eq(sceneDeployments.id, id) })
  if (!deployment) return null
  const access = await getSceneAccess(actorFromClaims(request.user), deployment.sceneId)
  const ok = need === 'manage' ? isFullAccess(access) : hasScope(access, 'scene.edit')
  return ok ? deployment : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Deploy targets are never local: https only, public addresses only. */
async function validContentServer(target: Record<string, unknown>): Promise<boolean> {
  try {
    const url = await assertPublicHttpUrl(String(target.contentServer ?? ''))
    return url.protocol === 'https:'
  } catch {
    return false
  }
}

export default async function deployRoutes(app: FastifyInstance) {
  // ── Start Deployment ──────────────────────────────────────────────────
  app.post(
    '/api/deploy',
    { preHandler: [authenticate, requireFeature('deployment')] },
    async (request, reply) => {
      const body = request.body as {
        sceneId: string
        platform: string
        deploymentType: string // 'parcel' | 'world' | 'instance'
        target: Record<string, unknown> // platform-specific target config
        walletId?: string // for server-side signing
      }

      if (!body.sceneId || !body.platform || !body.deploymentType || !body.target) {
        return reply.status(400).send({
          error: 'Missing required fields: sceneId, platform, deploymentType, target',
        })
      }

      // Verify scene exists and user has access
      const scene = await db.query.scenes.findFirst({
        where: eq(scenes.id, body.sceneId),
      })

      if (!scene) {
        return reply.status(404).send({ error: 'Scene not found' })
      }

      const access = await getSceneAccess(actorFromClaims(request.user), body.sceneId)
      if (access.level === 'none') return reply.status(404).send({ error: 'Scene not found' })
      if (!isFullAccess(access)) return reply.status(403).send({ error: 'Forbidden' })

      if (body.walletId) {
        const wallet = await db.query.deploymentWallets.findFirst({
          where: and(eq(deploymentWallets.id, body.walletId), eq(deploymentWallets.userId, request.user.id)),
        })
        if (!wallet) return reply.status(404).send({ error: 'Wallet not found' })
      }

      if (body.platform === 'decentraland' && !(await validContentServer(body.target))) {
        return reply.status(400).send({ error: 'invalid_content_server' })
      }

      // Hyperfy: use the provisioner for end-to-end deployment
      if (body.platform === 'hyperfy') {
        if (!hyperfyHosting().available) return reply.status(503).send({ error: 'hyperfy_hosting_unavailable', message: "Hyperfy hosting isn't set up on this server yet" })
        const provisioner = new HyperfyProvisioner()
        try {
          const result = await provisioner.provision({
            sceneId: body.sceneId,
            name: (body.target as any).name || scene.name,
            region: (body.target as any).region,
            deployedBy: request.user.id,
          })
          return reply.status(201).send({ deployment: result })
        } catch (err) {
          return reply.status(500).send({
            error: 'Hyperfy provisioning failed',
            message: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // Other platforms: create record for async processing
      const [deployment] = await db
        .insert(sceneDeployments)
        .values({
          sceneId: body.sceneId,
          platform: body.platform,
          status: 'pending',
          deploymentType: body.deploymentType,
          target: body.target,
          deployedBy: request.user.id,
        })
        .returning()

      // DCL: kick off catalyst deployment in the background
      if (body.platform === 'decentraland') {
        executeDCLDeploy(deployment.id, body.walletId).catch((err) => {
          console.error(`[dcl-deploy] background deploy failed for ${deployment.id}:`, err)
        })
      }

      return reply.status(201).send({ deployment })
    },
  )

  // ── Get Deployment Status ─────────────────────────────────────────────
  app.get(
    '/api/deploy/:id',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const deployment = await deploymentForCaller(request, id, 'read')

      if (!deployment) {
        return reply.status(404).send({ error: 'Deployment not found' })
      }

      return reply.send({ deployment: publicDeployment(deployment) })
    },
  )

  // ── List Deployments for Scene ────────────────────────────────────────
  app.get(
    '/api/deploy/scene/:sceneId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { sceneId } = request.params as { sceneId: string }

      if (!UUID.test(sceneId) || !hasScope(await getSceneAccess(actorFromClaims(request.user), sceneId), 'scene.edit')) {
        return reply.status(404).send({ error: 'Scene not found' })
      }

      const deployments = await db
        .select()
        .from(sceneDeployments)
        .where(eq(sceneDeployments.sceneId, sceneId))
        .orderBy(desc(sceneDeployments.createdAt))
        .limit(20)

      return reply.send({ deployments: deployments.map(publicDeployment) })
    },
  )

  // ── Cancel Deployment ─────────────────────────────────────────────────
  app.post(
    '/api/deploy/:id/cancel',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const deployment = await deploymentForCaller(request, id, 'manage')

      if (!deployment) {
        return reply.status(404).send({ error: 'Deployment not found' })
      }

      if (deployment.status !== 'pending' && deployment.status !== 'building') {
        return reply.status(400).send({
          error: 'Can only cancel pending or building deployments',
        })
      }

      const [updated] = await db
        .update(sceneDeployments)
        .set({ status: 'failed', errorMessage: 'Cancelled by user' })
        .where(eq(sceneDeployments.id, id))
        .returning()

      return reply.send({ deployment: publicDeployment(updated) })
    },
  )

  // ── Redeploy ──────────────────────────────────────────────────────────
  app.post(
    '/api/deploy/:id/redeploy',
    { preHandler: [authenticate, requireFeature('deployment')] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const original = await deploymentForCaller(request, id, 'manage')

      if (!original) {
        return reply.status(404).send({ error: 'Deployment not found' })
      }

      if (original.platform === 'decentraland' && !(await validContentServer(original.target as Record<string, unknown>))) {
        return reply.status(400).send({ error: 'invalid_content_server' })
      }

      // Create a new deployment based on the original
      const [deployment] = await db
        .insert(sceneDeployments)
        .values({
          sceneId: original.sceneId,
          platform: original.platform,
          status: 'pending',
          deploymentType: original.deploymentType,
          target: original.target,
          assetBundle: original.assetBundle,
          deployedBy: request.user.id,
        })
        .returning()

      // DCL: kick off catalyst redeployment in the background
      if (original.platform === 'decentraland') {
        // Try to find a wallet for the redeployer
        executeDCLDeploy(deployment.id).catch((err) => {
          console.error(`[dcl-deploy] background redeploy failed for ${deployment.id}:`, err)
        })
      }

      return reply.status(201).send({ deployment: publicDeployment(deployment) })
    },
  )

  // ── Wallet Management ─────────────────────────────────────────────────

  app.post(
    '/api/deploy/wallets',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const body = request.body as {
        platform: string
        walletAddress: string
        encryptedPrivateKey?: string
        label?: string
      }

      if (!body.platform || !body.walletAddress) {
        return reply.status(400).send({
          error: 'Missing required fields: platform, walletAddress',
        })
      }

      const [wallet] = await db
        .insert(deploymentWallets)
        .values({
          userId: request.user.id,
          platform: body.platform,
          walletAddress: body.walletAddress,
          encryptedPrivateKey: body.encryptedPrivateKey || null,
          label: body.label || null,
        })
        .returning()

      // Don't return encrypted private key
      const { encryptedPrivateKey: _, ...safe } = wallet
      return reply.status(201).send({ wallet: safe })
    },
  )

  app.get(
    '/api/deploy/wallets',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const wallets = await db
        .select({
          id: deploymentWallets.id,
          platform: deploymentWallets.platform,
          walletAddress: deploymentWallets.walletAddress,
          label: deploymentWallets.label,
          hasPrivateKey: sql<boolean>`${deploymentWallets.encryptedPrivateKey} IS NOT NULL`,
          createdAt: deploymentWallets.createdAt,
        })
        .from(deploymentWallets)
        .where(eq(deploymentWallets.userId, request.user.id))

      return reply.send({ wallets })
    },
  )

  app.delete(
    '/api/deploy/wallets/:id',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const wallet = await db.query.deploymentWallets.findFirst({
        where: eq(deploymentWallets.id, id),
      })

      if (!wallet || wallet.userId !== request.user.id) {
        return reply.status(404).send({ error: 'Wallet not found' })
      }

      await db.delete(deploymentWallets).where(eq(deploymentWallets.id, id))

      return reply.send({ deleted: true })
    },
  )

  /** Which platforms this server can deploy to right now. */
  app.get('/api/deploy/platforms', { preHandler: [authenticate] }, async () => ({
    platforms: { decentraland: true, hyperfy: hyperfyHosting().available },
  }))

  // ── Hyperfy-Specific Routes ─────────────────────────────────────────

  /** Provision a new Hyperfy world (convenience endpoint). */
  app.post(
    '/api/deploy/hyperfy/provision',
    { preHandler: [authenticate, requireFeature('deployment')] },
    async (request, reply) => {
      const body = request.body as {
        sceneId: string
        name: string
        region?: string
      }

      if (!body.sceneId || !body.name) {
        return reply.status(400).send({
          error: 'Missing required fields: sceneId, name',
        })
      }

      const scene = await db.query.scenes.findFirst({
        where: eq(scenes.id, body.sceneId),
      })

      if (!scene) {
        return reply.status(404).send({ error: 'Scene not found' })
      }

      const access = await getSceneAccess(actorFromClaims(request.user), body.sceneId)
      if (access.level === 'none') return reply.status(404).send({ error: 'Scene not found' })
      if (!isFullAccess(access)) return reply.status(403).send({ error: 'Forbidden' })
      if (!hyperfyHosting().available) return reply.status(503).send({ error: 'hyperfy_hosting_unavailable', message: "Hyperfy hosting isn't set up on this server yet" })

      const provisioner = new HyperfyProvisioner()
      try {
        const result = await provisioner.provision({
          sceneId: body.sceneId,
          name: body.name,
          region: body.region,
          deployedBy: request.user.id,
        })
        return reply.status(201).send(result)
      } catch (err) {
        return reply.status(500).send({
          error: 'Hyperfy provisioning failed',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
  )

  /** Destroy a running Hyperfy world instance. */
  app.post(
    '/api/deploy/hyperfy/:id/destroy',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      if (!(await deploymentForCaller(request, id, 'manage'))) {
        return reply.status(404).send({ error: 'Deployment not found' })
      }

      const provisioner = new HyperfyProvisioner()
      try {
        await provisioner.destroy(id)
        return reply.send({ destroyed: true })
      } catch (err) {
        return reply.status(500).send({
          error: 'Destroy failed',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
  )

  /** Get live instance status from the infrastructure provider. */
  app.get(
    '/api/deploy/hyperfy/:id/status',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      if (!(await deploymentForCaller(request, id, 'read'))) {
        return reply.status(404).send({ error: 'Deployment not found' })
      }

      const provisioner = new HyperfyProvisioner()
      const status = await provisioner.getInstanceStatus(id)

      if (!status) {
        return reply.status(404).send({ error: 'Instance not found or not running' })
      }

      return reply.send({ instance: status })
    },
  )

  /** Get logs from a running Hyperfy instance. */
  app.get(
    '/api/deploy/hyperfy/:id/logs',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const query = request.query as { lines?: string }

      if (!(await deploymentForCaller(request, id, 'manage'))) {
        return reply.status(404).send({ error: 'Deployment not found' })
      }

      const provisioner = new HyperfyProvisioner()
      const logs = await provisioner.getLogs(id, parseInt(query.lines || '100'))

      return reply.send({ logs })
    },
  )
}

// Re-export sql for use in route
import { sql } from 'drizzle-orm'
