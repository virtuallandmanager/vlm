/**
 * HyperfyProvisioner — Orchestrates Hyperfy world lifecycle.
 *
 * Handles the full provisioning flow:
 *   1. Generate credentials (JWT secret, admin code)
 *   2. Call infrastructure provider to create instance
 *   3. Store instance metadata in scene_deployments
 *   4. Track status transitions (pending → building → deploying → deployed)
 *   5. Handle destruction and cleanup
 */

import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../../db/connection.js'
import { sceneDeployments } from '../../db/schema.js'
import {
  createInfrastructureProvider,
  type InfrastructureProvider,
  type InstanceInfo,
} from './infrastructure.js'

export interface ProvisionRequest {
  sceneId: string
  name: string
  region?: string
  deployedBy: string
}

export interface ProvisionResult {
  deploymentId: string
  instanceUrl: string
  wsUrl: string
  adminCode: string
  status: string
}

export class HyperfyProvisioner {
  private provider: InfrastructureProvider

  constructor(provider?: InfrastructureProvider) {
    this.provider = provider || createInfrastructureProvider()
  }

  /**
   * Provision a new Hyperfy world instance.
   */
  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    const jwtSecret = randomBytes(32).toString('hex')
    const adminCode = randomBytes(8).toString('hex')
    const slug = this.slugify(request.name)

    // Create the deployment record (pending)
    const [deployment] = await db
      .insert(sceneDeployments)
      .values({
        sceneId: request.sceneId,
        platform: 'hyperfy',
        status: 'pending',
        deploymentType: 'instance',
        target: {
          name: request.name,
          slug,
          region: request.region || 'default',
        },
        deployedBy: request.deployedBy,
      })
      .returning()

    try {
      // Transition to building
      await this.updateStatus(deployment.id, 'building')

      // Create the instance via infrastructure provider
      const instance = await this.provider.createInstance({
        name: slug,
        region: request.region,
        env: {
          JWT_SECRET: jwtSecret,
          ADMIN_CODE: adminCode,
          PUBLIC_WS_URL: '', // Will be set after we get the URL
          PUBLIC_API_URL: '',
          PUBLIC_ASSETS_URL: '',
          VLM_SCENE_ID: request.sceneId,
          VLM_API_URL: process.env.PUBLIC_URL || 'http://localhost:3010',
        },
      })

      // Transition to deploying
      await this.updateStatus(deployment.id, 'deploying')

      // Store instance metadata
      await db
        .update(sceneDeployments)
        .set({
          status: 'deployed',
          infrastructureId: instance.instanceId,
          target: {
            name: request.name,
            slug,
            region: request.region || 'default',
            instanceUrl: instance.url,
            wsUrl: instance.wsUrl,
            adminCode, // stored encrypted in production
            provider: instance.provider,
          },
          deployedAt: new Date(),
        })
        .where(eq(sceneDeployments.id, deployment.id))

      return {
        deploymentId: deployment.id,
        instanceUrl: instance.url,
        wsUrl: instance.wsUrl,
        adminCode,
        status: 'deployed',
      }
    } catch (err) {
      // Mark as failed
      await db
        .update(sceneDeployments)
        .set({
          status: 'failed',
          errorMessage: err instanceof Error ? err.message : String(err),
        })
        .where(eq(sceneDeployments.id, deployment.id))

      throw err
    }
  }

  /**
   * Destroy a running Hyperfy world instance.
   */
  async destroy(deploymentId: string): Promise<void> {
    const deployment = await db.query.sceneDeployments.findFirst({
      where: eq(sceneDeployments.id, deploymentId),
    })

    if (!deployment) {
      throw new Error('Deployment not found')
    }

    if (!deployment.infrastructureId) {
      throw new Error('No infrastructure ID — instance may not be running')
    }

    await this.provider.destroyInstance(deployment.infrastructureId)

    await db
      .update(sceneDeployments)
      .set({
        status: 'failed', // reuse 'failed' as terminated state
        errorMessage: 'Destroyed by user',
      })
      .where(eq(sceneDeployments.id, deploymentId))
  }

  /**
   * Get the live status of a Hyperfy instance from the infrastructure provider.
   */
  async getInstanceStatus(deploymentId: string): Promise<InstanceInfo | null> {
    const deployment = await db.query.sceneDeployments.findFirst({
      where: eq(sceneDeployments.id, deploymentId),
    })

    if (!deployment?.infrastructureId) return null

    return this.provider.getStatus(deployment.infrastructureId)
  }

  /**
   * Get logs from a running instance.
   */
  async getLogs(deploymentId: string, lines = 100): Promise<string> {
    const deployment = await db.query.sceneDeployments.findFirst({
      where: eq(sceneDeployments.id, deploymentId),
    })

    if (!deployment?.infrastructureId) return ''

    return this.provider.getLogs(deployment.infrastructureId, lines)
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private async updateStatus(
    deploymentId: string,
    status: 'pending' | 'building' | 'deploying' | 'deployed' | 'failed',
  ): Promise<void> {
    await db
      .update(sceneDeployments)
      .set({ status })
      .where(eq(sceneDeployments.id, deploymentId))
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32)
  }
}
