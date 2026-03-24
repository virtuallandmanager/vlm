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

import { FastifyInstance } from 'fastify'
import { eq, desc } from 'drizzle-orm'
import { db } from '../db/connection.js'
import {
  sceneDeployments,
  deploymentWallets,
  scenes,
} from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { requireFeature } from '../middleware/feature-gate.js'
import { HyperfyProvisioner } from '../services/hyperfy/provisioner.js'

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

      if (scene.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      // Hyperfy: use the provisioner for end-to-end deployment
      if (body.platform === 'hyperfy') {
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

      // TODO: Queue DCL catalyst deploy job
      return reply.status(201).send({ deployment })
    },
  )

  // ── Get Deployment Status ─────────────────────────────────────────────
  app.get(
    '/api/deploy/:id',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const deployment = await db.query.sceneDeployments.findFirst({
        where: eq(sceneDeployments.id, id),
      })

      if (!deployment) {
        return reply.status(404).send({ error: 'Deployment not found' })
      }

      return reply.send({ deployment })
    },
  )

  // ── List Deployments for Scene ────────────────────────────────────────
  app.get(
    '/api/deploy/scene/:sceneId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { sceneId } = request.params as { sceneId: string }

      const deployments = await db
        .select()
        .from(sceneDeployments)
        .where(eq(sceneDeployments.sceneId, sceneId))
        .orderBy(desc(sceneDeployments.createdAt))
        .limit(20)

      return reply.send({ deployments })
    },
  )

  // ── Cancel Deployment ─────────────────────────────────────────────────
  app.post(
    '/api/deploy/:id/cancel',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const deployment = await db.query.sceneDeployments.findFirst({
        where: eq(sceneDeployments.id, id),
      })

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

      return reply.send({ deployment: updated })
    },
  )

  // ── Redeploy ──────────────────────────────────────────────────────────
  app.post(
    '/api/deploy/:id/redeploy',
    { preHandler: [authenticate, requireFeature('deployment')] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const original = await db.query.sceneDeployments.findFirst({
        where: eq(sceneDeployments.id, id),
      })

      if (!original) {
        return reply.status(404).send({ error: 'Deployment not found' })
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

      // TODO: Queue deployment job
      return reply.status(201).send({ deployment })
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

      if (scene.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

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

      const provisioner = new HyperfyProvisioner()
      const logs = await provisioner.getLogs(id, parseInt(query.lines || '100'))

      return reply.send({ logs })
    },
  )
}

// Re-export sql for use in route
import { sql } from 'drizzle-orm'
