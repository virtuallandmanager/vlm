/**
 * Decentraland Catalyst Deployer
 *
 * Handles the full DCL deployment lifecycle:
 *   1. Build scene content (scene.json entity descriptor)
 *   2. Hash all content files (SHA-256)
 *   3. Sign the entity with the deployment wallet
 *   4. Upload to the Decentraland catalyst content server
 *   5. Track status transitions in the database
 */

import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { Wallet } from 'ethers'
import { eq } from 'drizzle-orm'
import { db } from '../../db/connection.js'
import {
  sceneDeployments,
  deploymentWallets,
  scenes,
  scenePresets,
  sceneElements,
  sceneElementInstances,
} from '../../db/schema.js'

// ── Types ──────────────────────────────────────────────────────────────────

export interface DCLDeployTarget {
  parcels: string[] // e.g. ["0,0", "0,1", "1,0", "1,1"]
  contentServer: string // e.g. "https://peer.decentraland.org"
  worldName?: string // for world deployments
}

interface ContentFile {
  name: string
  content: Buffer
}

interface HashedContent {
  hash: string
  file: ContentFile
}

interface EntityDefinition {
  type: string
  pointers: string[]
  timestamp: number
  content: Array<{ file: string; hash: string }>
  metadata: Record<string, unknown>
}

interface DeploymentAuthChain {
  type: string
  payload: string
  signature?: string
}

// ── Encryption helpers ─────────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm'

function getEncryptionKey(): Buffer {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    throw new Error('JWT_SECRET is required to decrypt deployment wallet keys')
  }
  // Derive a 32-byte key from the JWT secret via SHA-256
  return createHash('sha256').update(secret).digest()
}

export function encryptPrivateKey(privateKey: string): string {
  const key = getEncryptionKey()
  const iv = randomBytes(16)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  let encrypted = cipher.update(privateKey, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag().toString('hex')

  // Format: iv:authTag:encryptedData
  return `${iv.toString('hex')}:${authTag}:${encrypted}`
}

export function decryptPrivateKey(encryptedData: string): string {
  const key = getEncryptionKey()
  const [ivHex, authTagHex, encrypted] = encryptedData.split(':')

  if (!ivHex || !authTagHex || !encrypted) {
    throw new Error('Invalid encrypted private key format')
  }

  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  let decrypted = decipher.update(encrypted, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

// ── Content hashing ────────────────────────────────────────────────────────

function hashContent(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function hashContentFiles(files: ContentFile[]): HashedContent[] {
  return files.map((file) => ({
    hash: hashContent(file.content),
    file,
  }))
}

// ── Scene content generation ───────────────────────────────────────────────

function buildSceneJson(
  sceneName: string,
  sceneId: string,
  parcels: string[],
  worldName?: string,
): Record<string, unknown> {
  // The base parcel is the first in the list
  const baseParcel = parcels[0] || '0,0'

  const sceneJson: Record<string, unknown> = {
    display: {
      title: sceneName,
      description: `VLM Scene: ${sceneName}`,
      favicon: 'favicon_asset',
    },
    owner: '',
    contact: {
      name: 'VLM',
      email: '',
    },
    main: 'bin/game.js',
    tags: ['vlm'],
    scene: {
      parcels,
      base: baseParcel,
    },
    requiredPermissions: [
      'ALLOW_TO_TRIGGER_AVATAR_EMOTE',
      'ALLOW_TO_MOVE_PLAYER_INSIDE_SCENE',
    ],
    vlm: {
      sceneId,
      version: '2.0.0',
    },
  }

  if (worldName) {
    sceneJson.worldConfiguration = {
      name: worldName,
    }
  }

  return sceneJson
}

async function loadSceneData(sceneId: string) {
  // Load the scene with its active preset, elements, and instances
  const scene = await db.query.scenes.findFirst({
    where: eq(scenes.id, sceneId),
  })

  if (!scene) {
    throw new Error(`Scene not found: ${sceneId}`)
  }

  // Load the active preset (or the first one)
  const presetId = scene.activePresetId
  let preset
  if (presetId) {
    preset = await db.query.scenePresets.findFirst({
      where: eq(scenePresets.id, presetId),
    })
  }

  if (!preset) {
    // Fall back to the first preset
    preset = await db.query.scenePresets.findFirst({
      where: eq(scenePresets.sceneId, sceneId),
    })
  }

  let elements: Array<{
    id: string
    type: string
    name: string
    enabled: boolean
    properties: unknown
  }> = []
  let instances: Array<{
    id: string
    elementId: string
    enabled: boolean
    position: unknown
    rotation: unknown
    scale: unknown
    properties: unknown
  }> = []

  if (preset) {
    elements = await db
      .select()
      .from(sceneElements)
      .where(eq(sceneElements.presetId, preset.id))

    // Load instances for all elements in this preset
    for (const element of elements) {
      const elementInstances = await db
        .select()
        .from(sceneElementInstances)
        .where(eq(sceneElementInstances.elementId, element.id))
      instances.push(...elementInstances)
    }
  }

  return { scene, preset, elements, instances }
}

function buildContentFiles(
  sceneName: string,
  sceneId: string,
  parcels: string[],
  worldName?: string,
): ContentFile[] {
  const sceneJson = buildSceneJson(sceneName, sceneId, parcels, worldName)
  const sceneJsonBuffer = Buffer.from(JSON.stringify(sceneJson, null, 2), 'utf-8')

  return [
    { name: 'scene.json', content: sceneJsonBuffer },
  ]
}

// ── Entity building ────────────────────────────────────────────────────────

function buildEntityDefinition(
  hashedFiles: HashedContent[],
  parcels: string[],
  worldName?: string,
): EntityDefinition {
  const pointers = worldName
    ? [worldName]
    : parcels.map((p) => p.trim())

  return {
    type: 'scene',
    pointers,
    timestamp: Date.now(),
    content: hashedFiles.map((hc) => ({
      file: hc.file.name,
      hash: hc.hash,
    })),
    metadata: {
      // The entity metadata includes all scene.json content
      // The catalyst expects the scene.json content to also be in metadata
      ...JSON.parse(hashedFiles.find((hc) => hc.file.name === 'scene.json')!.file.content.toString('utf-8')),
    },
  }
}

// ── Signing ────────────────────────────────────────────────────────────────

async function signEntity(
  entityId: string,
  privateKey: string,
): Promise<DeploymentAuthChain[]> {
  const wallet = new Wallet(privateKey)
  const address = await wallet.getAddress()

  // Build the auth chain: signer → entity hash
  // DCL auth chain format:
  // [0] = { type: "SIGNER", payload: <address> }
  // [1] = { type: "ECDSA_SIGNED_ENTITY", payload: <entityId>, signature: <sig> }
  const signature = await wallet.signMessage(entityId)

  return [
    {
      type: 'SIGNER',
      payload: address,
    },
    {
      type: 'ECDSA_SIGNED_ENTITY',
      payload: entityId,
      signature,
    },
  ]
}

// ── Catalyst upload ────────────────────────────────────────────────────────

async function uploadToCatalyst(
  contentServer: string,
  entityId: string,
  hashedFiles: HashedContent[],
  authChain: DeploymentAuthChain[],
): Promise<string> {
  const url = `${contentServer.replace(/\/$/, '')}/content/entities`

  // Build a multipart form with all files and the entity definition
  const form = new FormData()

  // Add each content file as a blob named by its hash
  for (const hc of hashedFiles) {
    form.append(hc.hash, new Blob([hc.file.content]), hc.file.name)
  }

  // Add the entity ID
  form.append('entityId', entityId)

  // Add the auth chain entries
  authChain.forEach((entry, index) => {
    form.append(`authChain[${index}][type]`, entry.type)
    form.append(`authChain[${index}][payload]`, entry.payload)
    if (entry.signature) {
      form.append(`authChain[${index}][signature]`, entry.signature)
    }
  })

  const response = await fetch(url, {
    method: 'POST',
    body: form,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Catalyst upload failed (${response.status}): ${errorText}`,
    )
  }

  const result = await response.json() as { creationTimestamp?: number }
  return entityId
}

// ── Status update helper ───────────────────────────────────────────────────

async function updateDeploymentStatus(
  deploymentId: string,
  status: 'pending' | 'building' | 'deploying' | 'deployed' | 'failed',
  extra?: Partial<{
    errorMessage: string
    catalystEntityId: string
    deployedAt: Date
  }>,
): Promise<void> {
  await db
    .update(sceneDeployments)
    .set({ status, ...extra })
    .where(eq(sceneDeployments.id, deploymentId))
}

// ── Main deploy function ───────────────────────────────────────────────────

export async function executeDCLDeploy(
  deploymentId: string,
  walletId?: string,
): Promise<void> {
  // Load deployment record
  const deployment = await db.query.sceneDeployments.findFirst({
    where: eq(sceneDeployments.id, deploymentId),
  })

  if (!deployment) {
    throw new Error(`Deployment not found: ${deploymentId}`)
  }

  const target = deployment.target as DCLDeployTarget
  if (!target.parcels?.length || !target.contentServer) {
    await updateDeploymentStatus(deploymentId, 'failed', {
      errorMessage: 'Invalid target: parcels and contentServer are required',
    })
    return
  }

  // Resolve the deployment wallet
  let privateKey: string | null = null

  if (walletId) {
    const wallet = await db.query.deploymentWallets.findFirst({
      where: eq(deploymentWallets.id, walletId),
    })
    if (!wallet?.encryptedPrivateKey) {
      await updateDeploymentStatus(deploymentId, 'failed', {
        errorMessage: 'Deployment wallet not found or has no private key',
      })
      return
    }
    privateKey = decryptPrivateKey(wallet.encryptedPrivateKey)
  } else {
    // Look for a wallet belonging to the deployer for the DCL platform
    if (deployment.deployedBy) {
      const wallets = await db
        .select()
        .from(deploymentWallets)
        .where(eq(deploymentWallets.userId, deployment.deployedBy))

      const dclWallet = wallets.find(
        (w) => w.platform === 'decentraland' && w.encryptedPrivateKey,
      )
      if (dclWallet?.encryptedPrivateKey) {
        privateKey = decryptPrivateKey(dclWallet.encryptedPrivateKey)
      }
    }
  }

  if (!privateKey) {
    await updateDeploymentStatus(deploymentId, 'failed', {
      errorMessage: 'No deployment wallet with private key found',
    })
    return
  }

  try {
    // ── Step 1: Building ─────────────────────────────────────────────
    await updateDeploymentStatus(deploymentId, 'building')

    const { scene } = await loadSceneData(deployment.sceneId)

    const contentFiles = buildContentFiles(
      scene.name,
      scene.id,
      target.parcels,
      target.worldName,
    )

    const hashedFiles = hashContentFiles(contentFiles)

    // Build the entity definition
    const entity = buildEntityDefinition(
      hashedFiles,
      target.parcels,
      target.worldName,
    )

    // The entity ID is the hash of the serialized entity definition
    const entityBuffer = Buffer.from(JSON.stringify(entity), 'utf-8')
    const entityId = hashContent(entityBuffer)

    // Add the entity definition itself as a content file
    const entityFile: ContentFile = { name: 'entity.json', content: entityBuffer }
    const entityHashed: HashedContent = { hash: entityId, file: entityFile }

    // ── Step 2: Deploying ────────────────────────────────────────────
    await updateDeploymentStatus(deploymentId, 'deploying')

    // Sign the entity
    const authChain = await signEntity(entityId, privateKey)

    // Upload all content + entity to catalyst
    // The catalyst expects all hashed files plus the entity file
    const allFiles = [...hashedFiles, entityHashed]

    await uploadToCatalyst(
      target.contentServer,
      entityId,
      allFiles,
      authChain,
    )

    // ── Step 3: Success ──────────────────────────────────────────────
    await updateDeploymentStatus(deploymentId, 'deployed', {
      catalystEntityId: entityId,
      deployedAt: new Date(),
    })
  } catch (err) {
    await updateDeploymentStatus(deploymentId, 'failed', {
      errorMessage: err instanceof Error ? err.message : String(err),
    })
  }
}
