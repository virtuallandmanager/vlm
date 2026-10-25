/**
 * Deploys a Virvi scene to its owner's Decentraland World, then links the World to the scene.
 *
 * Mode A (`startVirviDeploy`): Virvi's permitted deploy wallet signs; the work runs in the background.
 * Mode B (`prepareSignedDeploy` + `submitSignedDeploy`): the owner signs the entity id in their browser.
 * Between the two calls Virvi keeps only what rebuilds the upload byte-for-byte (model URLs and hashes,
 * small generated files inline, the runtime by version), never the model bytes.
 *
 * Every deploy starts from what is live: a fresh destination gets the generic runtime, anything else
 * builds on the live entity at its base. If the live entity is not the one Virvi last deployed, it stops.
 */
import { and, eq } from 'drizzle-orm'
import { DCL_MAX_FILE_BYTES, DCL_PARCEL_M, parseParcel } from 'vlm-shared'
import { db } from '../../db/connection.js'
import { dclWorldDestinations, sceneDeployments, scenes } from '../../db/schema.js'
import { linkWorldLocation } from '../../setup/setups.js'
import {
  assembleFresh, assembleRedeploy, defaultModelFetcher, modelsInScene, wizardSceneJson,
  type Assembled, type ModelFetcher,
} from './assemble.js'
import { buildEntity, dclHash, verifyChain, virviSigner, type AuthChain, type ContentRef, type SceneMetadata } from './entity.js'
import { DCL_RUNTIME_VERSION, runtimeFiles } from './runtime.js'
import { getWorldsClient, WorldsError, type LiveEntity } from './worlds-client.js'

/** The server's limit, inside Decentraland's ~5-minute entity timestamp window. */
export const DEPLOY_WINDOW_MS = 240_000
/** Packing that took longer than this gets a fresh timestamp before signing. */
const RETIMESTAMP_AFTER_MS = 10_000
/** Generated files at most this big are kept inline in a mode B bundle. */
const INLINE_MAX_BYTES = 64 * 1024
const CHANGED_OUTSIDE = 'Your World changed outside Virvi'
const UNREACHABLE = "Couldn't read your World from Decentraland"

export type Destination = typeof dclWorldDestinations.$inferSelect
export type Deployment = typeof sceneDeployments.$inferSelect

export class DeployerError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code)
  }
}

export interface DeployOptions {
  /** Model downloader; tests inject one. */
  fetch?: ModelFetcher
}

/** How to recreate one new file of a prepared deployment. */
export type NewFileSource =
  | { file: string; hash: string; url: string }
  | { file: string; hash: string; base64: string }
  | { file: string; hash: string; runtimeVersion: number }

export interface SignedBundle {
  entityId: string
  timestamp: number
  pointers: string[]
  deployedFiles: string[]
  added: string[]
  refused: Assembled['refused']
  newFiles: NewFileSource[]
  existing: ContentRef[]
  /** scene.json metadata as exact JSON text: jsonb reorders keys, which would change the entity id. */
  metadataJson: string
  /** The live entity this deployment builds on (or replaces); null when the World was empty. */
  baseEntityId: string | null
}

async function loadDestination(id: string): Promise<Destination> {
  const dest = await db.query.dclWorldDestinations.findFirst({ where: eq(dclWorldDestinations.id, id) })
  if (!dest) throw new DeployerError(404, 'not_found')
  return dest
}

async function setDestStatus(id: string, status: Destination['status'], statusDetail: string | null) {
  await db.update(dclWorldDestinations).set({ status, statusDetail, updatedAt: new Date() }).where(eq(dclWorldDestinations.id, id))
}

/**
 * The live entity at the destination's base (null when there is none). Stops with 409 needs_review when
 * Virvi has deployed here before and the live entity is no longer that one (adopted scenes too), and
 * with 503 world_unreachable when the World can't be read. Shared by deploys and the sweep.
 */
export async function liveBaseFor(dest: Destination): Promise<LiveEntity | null> {
  let entities: LiveEntity[]
  try {
    entities = await getWorldsClient().getWorldEntities(dest.worldName)
  } catch {
    await setDestStatus(dest.id, 'unreachable', UNREACHABLE)
    throw new DeployerError(503, 'world_unreachable', UNREACHABLE)
  }
  const live = entities.find((e) => e.pointers.includes(dest.base)) ?? null
  if (dest.lastEntityId && live?.id !== dest.lastEntityId) {
    await setDestStatus(dest.id, 'needs_review', CHANGED_OUTSIDE)
    throw new DeployerError(409, 'needs_review', CHANGED_OUTSIDE)
  }
  if (dest.status === 'unreachable') await setDestStatus(dest.id, 'ok', null)
  return live
}

/** Default spawn: the plot's centre along x, on the ground, 1 m in from the base edge. */
function defaultSpawn(parcels: string[]) {
  const xs = parcels.map((p) => parseParcel(p)?.x ?? 0)
  const width = Math.max(...xs) - Math.min(...xs) + 1
  return { x: (width * DCL_PARCEL_M) / 2, y: 0, z: 1 }
}

async function assembleFor(dest: Destination, timestamp: number, fetch?: ModelFetcher) {
  const live = await liveBaseFor(dest)
  const models = await modelsInScene(dest.sceneId)
  if (dest.lastEntityId == null && !dest.adopted) {
    const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, dest.sceneId), columns: { name: true } })
    const metadata = wizardSceneJson({
      title: scene?.name ?? dest.worldName, world: dest.worldName, base: dest.base, parcels: dest.parcels,
      spawn: dest.spawn ?? defaultSpawn(dest.parcels),
    })
    return { assembled: await assembleFresh({ metadata, models, timestamp, fetch }), baseEntityId: live?.id ?? null }
  }
  if (!live) throw new DeployerError(409, 'no_live_scene', 'Your World has no scene to add models to')
  return { assembled: await assembleRedeploy({ live, adopted: dest.adopted, models, timestamp, fetch }), baseEntityId: live.id }
}

/** Path to hash for every file in the entity, read from the entity file itself. */
function contentOf(a: { entityId: string; files: Map<string, Uint8Array> }): Map<string, string> {
  const entity = JSON.parse(new TextDecoder().decode(a.files.get(a.entityId)!)) as { content: ContentRef[] }
  return new Map(entity.content.map((c) => [c.file, c.hash]))
}

/** The new (not referenced-by-hash) files of an assembled deployment, path to bytes. */
function newFileBytes(a: Assembled): Map<string, Uint8Array> {
  const existing = new Set(a.existing.map((e) => e.file))
  const out = new Map<string, Uint8Array>()
  for (const [file, hash] of contentOf(a)) if (!existing.has(file)) out.set(file, a.files.get(hash)!)
  return out
}

/** Rebuilds the entity with a fresh timestamp when packing took long, so the signing window stays full. */
async function retimestamp(a: Assembled, timestamp: number): Promise<{ a: Assembled; timestamp: number }> {
  const now = Date.now()
  if (now - timestamp <= RETIMESTAMP_AFTER_MS) return { a, timestamp }
  const { entityId, files } = await buildEntity({ pointers: a.pointers, metadata: a.metadata, existing: a.existing, newFiles: newFileBytes(a), timestamp: now })
  return { a: { ...a, entityId, files }, timestamp: now }
}

async function describeNewFiles(a: Assembled): Promise<NewFileSource[]> {
  const existing = new Set(a.existing.map((e) => e.file))
  const models = new Map(a.newFileSources.map((s) => [s.file, s]))
  const runtime = await runtimeFiles(DCL_RUNTIME_VERSION)
  const out: NewFileSource[] = []
  for (const [file, hash] of contentOf(a)) {
    if (existing.has(file)) continue
    const model = models.get(file)
    if (model) { out.push({ file, hash, url: model.url }); continue }
    const rt = runtime.get(file)
    if (rt && (await dclHash(rt)) === hash) { out.push({ file, hash, runtimeVersion: DCL_RUNTIME_VERSION }); continue }
    const bytes = a.files.get(hash)!
    if (bytes.byteLength > INLINE_MAX_BYTES) throw new Error(`Cannot keep ${file} for signing`)
    out.push({ file, hash, base64: Buffer.from(bytes).toString('base64') })
  }
  return out
}

async function rebuildNewFiles(sources: NewFileSource[], fetch: ModelFetcher): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>()
  for (const s of sources) {
    if ('url' in s) {
      let bytes: Uint8Array
      try {
        bytes = await fetch(s.url)
      } catch {
        throw new DeployerError(502, 'model_unavailable', `Couldn't download ${s.file} again`)
      }
      if (bytes.byteLength > DCL_MAX_FILE_BYTES) throw new DeployerError(502, 'model_unavailable', `${s.file} is over the 50 MB file limit`)
      out.set(s.file, bytes)
    } else if ('base64' in s) {
      out.set(s.file, new Uint8Array(Buffer.from(s.base64, 'base64')))
    } else {
      const rt = (await runtimeFiles(s.runtimeVersion)).get(s.file)
      if (!rt) throw new DeployerError(500, 'entity_mismatch')
      out.set(s.file, rt)
    }
  }
  return out
}

/** A plain-language reason for the deploy page. */
function plainError(err: unknown): string {
  if (err instanceof DeployerError) return err.message
  if (err instanceof WorldsError) {
    if (err.status === 0) return "Couldn't reach Decentraland's Worlds server. Try again in a minute."
    let reason = err.body
    try {
      const j = JSON.parse(err.body) as { message?: string; error?: string; errors?: string[] }
      reason = j.errors?.join('; ') || j.message || j.error || err.body
    } catch { /* not JSON: keep the body */ }
    return `Decentraland rejected the deploy: ${reason.slice(0, 500) || `HTTP ${err.status}`}`
  }
  return `The deploy failed: ${(err as Error)?.message ?? String(err)}`
}

async function markFailed(deploymentId: string, err: unknown) {
  await db
    .update(sceneDeployments)
    .set({ status: 'failed', errorMessage: plainError(err) })
    .where(eq(sceneDeployments.id, deploymentId))
}

/**
 * After the World accepted `entityId`: record it on the destination and deployment, then link the
 * World's location to the Virvi scene.
 */
export async function afterWorldDeploy(dest: Destination, entityId: string, deployedFiles: string[], deploymentId: string): Promise<void> {
  const now = new Date()
  await db.transaction(async (tx) => {
    await tx
      .update(dclWorldDestinations)
      .set({ lastEntityId: entityId, deployedFiles: deployedFiles.map((f) => f.toLowerCase()), status: 'ok', statusDetail: null, pendingSince: null, updatedAt: now })
      .where(eq(dclWorldDestinations.id, dest.id))
    await tx
      .update(sceneDeployments)
      .set({ status: 'deployed', deployedAt: now, catalystEntityId: entityId, errorMessage: null })
      .where(eq(sceneDeployments.id, deploymentId))
  })
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, dest.sceneId), columns: { name: true } })
  await linkWorldLocation({
    world: dest.worldName, vlmSceneId: dest.sceneId, hostUserId: dest.ownerUserId, entityId,
    title: scene?.name ?? dest.worldName, base: dest.base, parcels: dest.parcels,
  }, now)
}

const running = new Map<string, Promise<void>>()

/** Resolves when a background deploy started here has finished (now, if none is running). */
export function whenSettled(deploymentId: string): Promise<void> {
  return running.get(deploymentId) ?? Promise.resolve()
}

/** Mode A: inserts the deployment and returns it; packing, signing and uploading run in the background. */
export async function startVirviDeploy(destinationId: string, by: string | null, opts: DeployOptions = {}): Promise<Deployment> {
  const dest = await loadDestination(destinationId)
  const signer = virviSigner()
  if (!signer) throw new DeployerError(503, 'virvi_deploys_unavailable', 'Virvi deploys are not available right now')
  if (dest.mode !== 'virvi' || !dest.grantedAt) throw new DeployerError(409, 'not_granted', 'Virvi has no deploy permission on this World')

  const [dep] = await db.insert(sceneDeployments).values({
    sceneId: dest.sceneId, platform: 'decentraland', deploymentType: 'world', destinationId: dest.id,
    target: { world: dest.worldName, parcels: dest.parcels }, status: 'building', deployedBy: by,
  }).returning()

  const run = runVirviDeploy(dep.id, dest, signer, opts).finally(() => running.delete(dep.id))
  running.set(dep.id, run)
  return dep
}

async function runVirviDeploy(
  deploymentId: string,
  dest: Destination,
  signer: NonNullable<ReturnType<typeof virviSigner>>,
  opts: DeployOptions,
): Promise<void> {
  let live = false
  try {
    const started = Date.now()
    const packed = await assembleFor(dest, started, opts.fetch)
    const { a } = await retimestamp(packed.assembled, started)
    const progress = { modelsTotal: a.added.length, modelsUploaded: 0 }
    const bundle = { entityId: a.entityId, pointers: a.pointers, deployedFiles: a.deployedFiles, added: a.added, refused: a.refused, baseEntityId: packed.baseEntityId }
    await db.update(sceneDeployments).set({ status: 'deploying', assetBundle: { ...bundle, progress } }).where(eq(sceneDeployments.id, deploymentId))
    const authChain = await signer.signChain(a.entityId)
    await getWorldsClient().deploy({ entityId: a.entityId, authChain, files: a.files })
    live = true
    await db
      .update(sceneDeployments)
      .set({ assetBundle: { ...bundle, progress: { ...progress, modelsUploaded: progress.modelsTotal } } })
      .where(eq(sceneDeployments.id, deploymentId))
    await afterWorldDeploy(dest, a.entityId, a.deployedFiles, deploymentId)
  } catch (err) {
    console.error('[world-deployer] deploy failed:', deploymentId, err instanceof Error ? err.message : err)
    // Once the World has accepted it the deployment is live; a later bookkeeping error must not say otherwise.
    if (!live) await markFailed(deploymentId, err).catch(() => {})
  }
}

/** Mode B, step 1: packs the deployment and returns the entity id for the owner to sign. */
export async function prepareSignedDeploy(
  destinationId: string,
  by: string,
  opts: DeployOptions = {},
): Promise<{ deployment: Deployment; payload: string; expiresAt: string }> {
  const dest = await loadDestination(destinationId)
  const started = Date.now()
  const packed = await assembleFor(dest, started, opts.fetch)
  const { a, timestamp } = await retimestamp(packed.assembled, started)
  const bundle: SignedBundle = {
    entityId: a.entityId,
    timestamp,
    pointers: a.pointers,
    deployedFiles: a.deployedFiles,
    added: a.added,
    refused: a.refused,
    newFiles: await describeNewFiles(a),
    existing: a.existing,
    metadataJson: JSON.stringify(a.metadata),
    baseEntityId: packed.baseEntityId,
  }
  const [deployment] = await db.insert(sceneDeployments).values({
    sceneId: dest.sceneId, platform: 'decentraland', deploymentType: 'world', destinationId: dest.id,
    target: { world: dest.worldName, parcels: dest.parcels }, status: 'awaiting_signature', deployedBy: by, assetBundle: bundle,
  }).returning()
  return { deployment, payload: a.entityId, expiresAt: new Date(timestamp + DEPLOY_WINDOW_MS).toISOString() }
}

/** Mode B, step 2: checks the owner's signature, rebuilds the exact upload and sends it. */
export async function submitSignedDeploy(deploymentId: string, chain: AuthChain, opts: DeployOptions = {}): Promise<Deployment> {
  const dep = await db.query.sceneDeployments.findFirst({ where: eq(sceneDeployments.id, deploymentId) })
  if (!dep || !dep.destinationId) throw new DeployerError(404, 'not_found')
  if (dep.status !== 'awaiting_signature') throw new DeployerError(409, 'not_awaiting_signature', 'This deploy is not waiting for a signature')
  const bundle = dep.assetBundle as SignedBundle
  if (Date.now() - bundle.timestamp > DEPLOY_WINDOW_MS) {
    const err = new DeployerError(409, 'expired', 'The signature came too late. Start the deploy again.')
    await markFailed(dep.id, err)
    throw err
  }
  const dest = await loadDestination(dep.destinationId)
  if (!(await verifyChain(chain, bundle.entityId, dest.ownerWallet))) {
    throw new DeployerError(403, 'not_world_owner', "That signature isn't from the wallet that owns this World")
  }
  // Claim it, so a second submit of the same signature can't upload twice.
  const [claimed] = await db
    .update(sceneDeployments)
    .set({ status: 'deploying' })
    .where(and(eq(sceneDeployments.id, dep.id), eq(sceneDeployments.status, 'awaiting_signature')))
    .returning({ id: sceneDeployments.id })
  if (!claimed) throw new DeployerError(409, 'not_awaiting_signature', 'This deploy is not waiting for a signature')

  let live = false
  try {
    const base = await liveBaseFor(dest)
    if ((base?.id ?? null) !== bundle.baseEntityId) {
      throw new DeployerError(409, 'stale', 'Your World changed since this deploy was prepared. Start it again.')
    }
    const newFiles = await rebuildNewFiles(bundle.newFiles, opts.fetch ?? defaultModelFetcher)
    const { entityId, files } = await buildEntity({
      pointers: bundle.pointers, metadata: JSON.parse(bundle.metadataJson) as SceneMetadata, existing: bundle.existing, newFiles, timestamp: bundle.timestamp,
    })
    if (entityId !== bundle.entityId) throw new DeployerError(500, 'entity_mismatch', 'The rebuilt deployment did not match what was signed')
    await getWorldsClient().deploy({ entityId, authChain: chain, files })
    live = true
    await afterWorldDeploy(dest, entityId, bundle.deployedFiles, dep.id)
  } catch (err) {
    if (!live) {
      await markFailed(dep.id, err).catch(() => {})
      if (err instanceof WorldsError) throw new DeployerError(502, 'deploy_rejected', plainError(err))
      throw err
    }
    console.error('[world-deployer] after deploy failed:', dep.id, err instanceof Error ? err.message : err)
  }
  return (await db.query.sceneDeployments.findFirst({ where: eq(sceneDeployments.id, dep.id) }))!
}
