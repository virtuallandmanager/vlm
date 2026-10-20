/**
 * VLM-hosted Hyperfy worlds on Fly: create, destroy, switch scene, rotate key, reveal admin code.
 *
 * A create inserts the `provisioning` row and returns; the rest (world database, Fly app, IPs, machine, health wait)
 * finishes in the background, tracked in an in-process map so a destroy can cancel it and wait for it to unwind.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { HyperfyWorldSummary } from 'vlm-shared'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import { hyperfyWorlds } from '../db/schema.js'
import { getSubscription } from '../integrations/stripe.js'
import { FlyApi } from './fly.js'
import { hostedWorldSlots } from './slots.js'
import { deleteWorldFiles } from './worlds-bucket.js'
import { createWorldDatabase, dropWorldDatabase } from './worlds-db.js'
import { createWorldKey, worldSummary, type HyperfyWorldRow } from './worlds.js'

type Log = { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void }

export type HostingDeps = {
  fly: Pick<
    FlyApi,
    'createApp' | 'deleteApp' | 'allocatePublicIps' | 'allocatePrivateIp' | 'createMachine' | 'updateMachine' | 'listMachines' | 'getMachineEnv' | 'startMachine' | 'stopMachine'
  >
  createWorldDatabase: (slug: string) => Promise<{ dbUri: string; schema: string }>
  dropWorldDatabase: (slug: string) => Promise<void>
  deleteWorldFiles: (slug: string) => Promise<unknown>
  /** Used for the health wait only. */
  fetch: typeof fetch
  now: () => number
  sleep: (ms: number) => Promise<void>
  log: Log
}

export type HostingErrorCode = 'world_limit_reached' | 'world_not_found' | 'world_not_running' | 'world_update_failed' | 'not_restorable'

export class HostingError extends Error {
  code: HostingErrorCode
  /** Set on `world_limit_reached`. */
  slots?: { used: number; limit: number }
  constructor(code: HostingErrorCode, message: string = code, slots?: { used: number; limit: number }) {
    super(message)
    this.name = 'HostingError'
    this.code = code
    this.slots = slots
  }
}

const SLUG_MAX = 30
const HEALTH_TIMEOUT_MS = 180_000
const HEALTH_POLL_MS = 3_000
const HEALTH_REQUEST_TIMEOUT_MS = 10_000
/** Tiers whose worlds live under the router domain; others (creator) get their own `.fly.dev` address. */
const ROUTER_TIERS = new Set(['pro', 'studio', 'enterprise'])

function defaultDeps(): HostingDeps {
  let fly: FlyApi | undefined
  const lazyFly = () => (fly ??= new FlyApi({ token: config.flyApiToken ?? '', org: config.flyWorldsOrg ?? '' }))
  return {
    fly: {
      createApp: (...a) => lazyFly().createApp(...a),
      deleteApp: (...a) => lazyFly().deleteApp(...a),
      allocatePublicIps: (...a) => lazyFly().allocatePublicIps(...a),
      allocatePrivateIp: (...a) => lazyFly().allocatePrivateIp(...a),
      createMachine: (...a) => lazyFly().createMachine(...a),
      updateMachine: (...a) => lazyFly().updateMachine(...a),
      listMachines: (...a) => lazyFly().listMachines(...a),
      getMachineEnv: (...a) => lazyFly().getMachineEnv(...a),
      startMachine: (...a) => lazyFly().startMachine(...a),
      stopMachine: (...a) => lazyFly().stopMachine(...a),
    },
    createWorldDatabase: (slug) => createWorldDatabase(slug),
    dropWorldDatabase: (slug) => dropWorldDatabase(slug),
    deleteWorldFiles: (slug) => deleteWorldFiles(slug),
    fetch: (...a) => fetch(...a),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: {
      info: (...a) => console.info('[hyperfy-hosting]', ...a),
      warn: (...a) => console.warn('[hyperfy-hosting]', ...a),
      error: (...a) => console.error('[hyperfy-hosting]', ...a),
    },
  }
}

export const withDeps = (deps?: Partial<HostingDeps>): HostingDeps => ({ ...defaultDeps(), ...deps })

// ── Admin code encryption (AES-256-GCM, as services/dcl/deployer.ts; keyed by HYPERFY_SECRET_KEY) ──

const ALGORITHM = 'aes-256-gcm'

function secretKey(): Buffer {
  const hex = config.hyperfySecretKey
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) throw new Error('HYPERFY_SECRET_KEY must be 32 bytes of hex')
  return Buffer.from(hex, 'hex')
}

function encryptAdminCode(code: string): string {
  const iv = randomBytes(16)
  const cipher = createCipheriv(ALGORITHM, secretKey(), iv)
  let encrypted = cipher.update(code, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  // Format: iv:authTag:encryptedData
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted}`
}

function decryptAdminCode(data: string): string {
  const [ivHex, authTagHex, encrypted] = data.split(':')
  if (!ivHex || !authTagHex || !encrypted) throw new Error('Invalid encrypted admin code format')
  const decipher = createDecipheriv(ALGORITHM, secretKey(), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'))
  let decrypted = decipher.update(encrypted, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

// ── Slugs and addresses ────────────────────────────────────────────────────

/** Lowercase [a-z0-9-], 3–30 chars, starting and ending with a letter or digit (the router's rule). */
export function slugFromName(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SLUG_MAX).replace(/-+$/, '')
  if (s.length >= 3) return s
  return s ? `${s}-world` : 'world'
}

function withSuffix(base: string, n: number): string {
  if (n === 1) return base
  const suffix = `-${n}`
  return `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`
}

const flyAppName = (slug: string) => `vlm-w-${slug}`

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function freeSlug(tx: Tx, base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = withSuffix(base, n)
    const [taken] = await tx
      .select({ id: hyperfyWorlds.id })
      .from(hyperfyWorlds)
      .where(and(eq(hyperfyWorlds.slug, candidate), isNull(hyperfyWorlds.purgedAt)))
      .limit(1)
    if (!taken) return candidate
  }
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } }
  return e?.code === '23505' || e?.cause?.code === '23505'
}

// ── In-flight creates ──────────────────────────────────────────────────────

const inFlight = new Map<string, { promise: Promise<void>; abort: AbortController }>()

/** Resolves once the world's background create (if one is running in this process) has finished. Never rejects. */
export function hostedWorldSettled(worldId: string): Promise<void> {
  return inFlight.get(worldId)?.promise ?? Promise.resolve()
}

/** Throws `world_limit_reached` (with used and limit) unless the owner has a free hosted-world slot. Call inside the owner's lock. */
async function assertFreeSlot(ownerId: string, executor: Parameters<typeof hostedWorldSlots>[1]): Promise<void> {
  const { used, limit } = await hostedWorldSlots(ownerId, executor)
  if (used >= limit) {
    throw new HostingError(
      'world_limit_reached',
      limit === 0 ? "Your plan doesn't include hosted worlds" : `You've used all ${limit} of your hosted worlds`,
      { used, limit },
    )
  }
}

// ── Create ─────────────────────────────────────────────────────────────────

export async function createHostedWorld(
  input: { ownerId: string; sceneId: string; name: string; endsAt: Date | null },
  deps?: Partial<HostingDeps>,
): Promise<{ world: HyperfyWorldSummary; adminCode: string }> {
  const d = withDeps(deps)
  const { tier } = await getSubscription(input.ownerId)
  const routed = ROUTER_TIERS.has(tier)
  const key = createWorldKey()
  const adminCode = randomBytes(12).toString('hex')
  const adminCodeEnc = encryptAdminCode(adminCode)
  const base = slugFromName(input.name)

  let row: HyperfyWorldRow | undefined
  for (let attempt = 1; !row; attempt++) {
    try {
      row = await db.transaction(async (tx) => {
        // One create at a time per owner, so two can't both take the last slot.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hyperfy-hosted:${input.ownerId}`}))`)
        await assertFreeSlot(input.ownerId, tx)
        const slug = await freeSlug(tx, base)
        const [inserted] = await tx
          .insert(hyperfyWorlds)
          .values({
            sceneId: input.sceneId,
            ownerId: input.ownerId,
            name: input.name,
            kind: 'hosted',
            keyHash: key.hash,
            keyPrefix: key.prefix,
            slug,
            address: routed ? `${slug}.${config.hyperfyRouterDomain}` : `${flyAppName(slug)}.fly.dev`,
            flyApp: flyAppName(slug),
            status: 'provisioning',
            adminCodeEnc,
            endsAt: input.endsAt,
          })
          .returning()
        return inserted
      })
    } catch (err) {
      // Another owner took the same slug between our check and insert; pick again.
      if (attempt < 5 && isUniqueViolation(err)) continue
      throw err
    }
  }

  const world = row
  d.log.info({ worldId: world.id, slug: world.slug, address: world.address }, 'hosted world provisioning')
  const abort = new AbortController()
  const promise = finishCreate(world, { worldKey: key.raw, adminCode }, d, abort.signal)
  inFlight.set(world.id, { promise, abort })
  promise.finally(() => inFlight.delete(world.id))
  return { world: worldSummary(world), adminCode }
}

class Cancelled extends Error {
  constructor() {
    super('cancelled: the world is being destroyed')
  }
}

/** Database, app, IPs, machine, health; then `running`. Any failure cleans up and marks the world `failed`. */
async function finishCreate(
  world: HyperfyWorldRow,
  secrets: { worldKey: string; adminCode: string },
  d: HostingDeps,
  signal: AbortSignal,
): Promise<void> {
  const slug = world.slug!
  const app = world.flyApp!
  const address = world.address!
  const ctx = { worldId: world.id, slug }
  const hidden = [secrets.worldKey, secrets.adminCode]
  const check = () => {
    if (signal.aborted) throw new Cancelled()
  }
  // Cleanup removes only what this create made: never an app that already existed under the name.
  const made = { database: false, app: false, files: false }
  try {
    const { dbUri, schema } = await d.createWorldDatabase(slug)
    made.database = true
    hidden.push(dbUri, safeUrlPassword(dbUri))
    check()
    await d.fly.createApp(app)
    made.app = true
    check()
    if (address.endsWith('.fly.dev')) await d.fly.allocatePublicIps(app)
    else await d.fly.allocatePrivateIp(app)
    check()
    const env = worldEnv({ slug, address, dbUri, schema, ...secrets })
    hidden.push(env.JWT_SECRET, env.ASSETS_S3_URI)
    // Once a machine may exist (even if this call fails or times out), it may have written under the prefix.
    made.files = true
    await d.fly.createMachine(app, { image: requireValue(config.hyperfyImage, 'HYPERFY_IMAGE'), env })
    d.log.info(ctx, 'hosted world machine created, waiting for health')
    await waitForHealth(address, d, signal)
    const updated = await db
      .update(hyperfyWorlds)
      .set({ status: 'running', errorMessage: null })
      .where(and(eq(hyperfyWorlds.id, world.id), eq(hyperfyWorlds.status, 'provisioning')))
      .returning({ id: hyperfyWorlds.id })
    if (!updated.length) {
      // Destroyed (or settled) elsewhere while we ran; don't leave a billed app behind.
      d.log.warn(ctx, 'hosted world row gone or no longer provisioning; removing what this create made')
      await cleanUp(world, d, made)
      return
    }
    d.log.info(ctx, 'hosted world running')
  } catch (err) {
    hidden.push(config.hyperfyAssetsS3Uri ?? '', config.flyApiToken ?? '')
    const message = redact(err instanceof Error ? err.message : String(err), hidden).slice(0, 500)
    d.log.error({ ...ctx, error: message }, 'hosted world provisioning failed')
    await cleanUp(world, d, made)
    await db
      .update(hyperfyWorlds)
      .set({ status: 'failed', errorMessage: message })
      .where(eq(hyperfyWorlds.id, world.id))
      .catch((e) => d.log.error({ ...ctx, error: e instanceof Error ? e.message : String(e) }, 'could not mark world failed'))
  }
}

function worldEnv(w: { slug: string; address: string; dbUri: string; schema: string; worldKey: string; adminCode: string }): Record<string, string> {
  const assetsUri = requireValue(config.hyperfyAssetsS3Uri, 'HYPERFY_ASSETS_S3_URI').replace(/\/+$/, '')
  const assetsBase = requireValue(config.hyperfyAssetsBaseUrl, 'HYPERFY_ASSETS_BASE_URL').replace(/\/+$/, '')
  return {
    PORT: '3000',
    WORLD: 'world',
    PUBLIC_WS_URL: `wss://${w.address}/ws`,
    PUBLIC_API_URL: `https://${w.address}/api`,
    ASSETS: 's3',
    // No trailing slash: Hyperfy's AssetsS3 appends one, so `<slug>/` would key files under `<slug>//`.
    ASSETS_S3_URI: `${assetsUri}/${w.slug}`,
    ASSETS_BASE_URL: `${assetsBase}/${w.slug}`,
    DB_URI: w.dbUri,
    DB_SCHEMA: w.schema,
    JWT_SECRET: randomBytes(32).toString('hex'),
    ADMIN_CODE: w.adminCode,
    SAVE_INTERVAL: '60',
    CLEAN: 'true',
    PUBLIC_SCRIPT_WEBSOCKET_ORIGINS: 'wss://api.vlm.gg',
    PUBLIC_MAX_UPLOAD_SIZE: '12', // MB; Hyperfy refuses to boot without it
    VLM_FEED_URL: config.publicUrl,
    VLM_WORLD_KEY: w.worldKey,
  }
}

async function waitForHealth(address: string, d: HostingDeps, signal: AbortSignal): Promise<void> {
  const url = `https://${address}/`
  const start = d.now()
  for (;;) {
    if (signal.aborted) throw new Cancelled()
    try {
      const res = await d.fetch(url, { signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS) })
      await res.body?.cancel().catch(() => {})
      if (res.status === 200) return
    } catch {
      /* not up yet */
    }
    if (d.now() - start >= HEALTH_TIMEOUT_MS) throw new Error(`the world didn't answer at ${url} within ${HEALTH_TIMEOUT_MS / 1000} s`)
    await d.sleep(HEALTH_POLL_MS)
  }
}

/** Removes what a create made on Fly, in the worlds database and in the bucket. Each step is safe to repeat. */
export async function cleanUp(world: HyperfyWorldRow, d: HostingDeps, made: { database: boolean; app: boolean; files: boolean }): Promise<void> {
  const slug = world.slug!
  const steps: [string, () => Promise<unknown>][] = []
  if (made.app) steps.push(['delete fly app', () => d.fly.deleteApp(world.flyApp ?? flyAppName(slug))])
  if (made.database) steps.push(['drop world database', () => d.dropWorldDatabase(slug)])
  if (made.files) steps.push(['delete world files', () => d.deleteWorldFiles(slug)])
  for (const [what, step] of steps) {
    await step().catch((e) => d.log.error({ worldId: world.id, slug, error: e instanceof Error ? e.message : String(e) }, `cleanup: could not ${what}`))
  }
}

function requireValue(v: string | undefined, name: string): string {
  if (!v) throw new Error(`${name} is not set`)
  return v
}

function safeUrlPassword(uri: string): string {
  try {
    return decodeURIComponent(new URL(uri).password)
  } catch {
    return ''
  }
}

function redact(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('[redacted]')
  return out
}

// ── Destroy, switch, rotate, reveal ────────────────────────────────────────

async function hostedWorld(worldId: string): Promise<HyperfyWorldRow> {
  const [w] = await db
    .select()
    .from(hyperfyWorlds)
    .where(and(eq(hyperfyWorlds.id, worldId), eq(hyperfyWorlds.kind, 'hosted')))
  if (!w) throw new HostingError('world_not_found')
  return w
}

/** Cancels and waits for an in-flight create, then deletes the Fly app, database, files and finally the row. */
export async function destroyHostedWorld(worldId: string, deps?: Partial<HostingDeps>): Promise<void> {
  const d = withDeps(deps)
  const w = await hostedWorld(worldId)
  const running = inFlight.get(worldId)
  if (running) {
    running.abort.abort()
    await running.promise
  }
  const slug = w.slug!
  await d.fly.deleteApp(w.flyApp ?? flyAppName(slug))
  await d.dropWorldDatabase(slug)
  await d.deleteWorldFiles(slug)
  await db.delete(hyperfyWorlds).where(eq(hyperfyWorlds.id, worldId))
  d.log.info({ worldId, slug }, 'hosted world destroyed')
}

/** The feed follows the world key's scene, so the machine needs no change. */
export async function switchHostedWorldScene(worldId: string, sceneId: string): Promise<void> {
  const updated = await db
    .update(hyperfyWorlds)
    .set({ sceneId })
    .where(and(eq(hyperfyWorlds.id, worldId), eq(hyperfyWorlds.kind, 'hosted')))
    .returning({ id: hyperfyWorlds.id })
  if (!updated.length) throw new HostingError('world_not_found')
}

/** New key: stores its hash and swaps only VLM_WORLD_KEY in the machine's env (the update restarts the machine). */
export async function rotateHostedWorldKey(worldId: string, deps?: Partial<HostingDeps>): Promise<{ key: string }> {
  const d = withDeps(deps)
  const w = await hostedWorld(worldId)
  if (w.status !== 'running' || !w.flyApp) throw new HostingError('world_not_running')
  const [machine] = await d.fly.listMachines(w.flyApp)
  if (!machine) throw new HostingError('world_not_running', 'the world has no machine')
  const env = await d.fly.getMachineEnv(w.flyApp, machine.id)
  const key = createWorldKey()
  await db.update(hyperfyWorlds).set({ keyHash: key.hash, keyPrefix: key.prefix }).where(eq(hyperfyWorlds.id, worldId))
  try {
    await d.fly.updateMachine(w.flyApp, machine.id, {
      image: requireValue(config.hyperfyImage, 'HYPERFY_IMAGE'),
      env: { ...env, VLM_WORLD_KEY: key.raw },
    })
  } catch (err) {
    d.log.error({ worldId, slug: w.slug, error: err instanceof Error ? err.message : String(err) }, 'hosted world key rotation: machine update failed')
    throw new HostingError(
      'world_update_failed',
      "The world key was changed but the world couldn't be updated with it; rotate the key again",
    )
  }
  d.log.info({ worldId, slug: w.slug }, 'hosted world key rotated')
  return { key: key.raw }
}

export async function revealAdminCode(worldId: string): Promise<string> {
  const w = await hostedWorld(worldId)
  if (!w.adminCodeEnc) throw new HostingError('world_not_found', 'the world has no admin code')
  return decryptAdminCode(w.adminCodeEnc)
}

/**
 * Brings an ended world back within its retention window, if its owner has a free slot: claims the slot (status
 * `running`, end dates cleared), then starts the machines. If they won't start the world goes back to `ended`.
 */
export async function restoreHostedWorld(worldId: string, deps?: Partial<HostingDeps>): Promise<HyperfyWorldRow> {
  const d = withDeps(deps)
  const w = await hostedWorld(worldId)
  const restored = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hyperfy-hosted:${w.ownerId}`}))`)
    const [cur] = await tx.select().from(hyperfyWorlds).where(eq(hyperfyWorlds.id, worldId))
    if (!cur || cur.purgedAt || cur.status !== 'ended' || !cur.flyApp || !cur.purgeAfter || cur.purgeAfter.getTime() <= Date.now()) {
      throw new HostingError('not_restorable', "This world can't be restored")
    }
    await assertFreeSlot(w.ownerId, tx)
    const [updated] = await tx
      .update(hyperfyWorlds)
      .set({ status: 'running', endsAt: null, endedAt: null, purgeAfter: null })
      .where(eq(hyperfyWorlds.id, worldId))
      .returning()
    return { before: cur, after: updated }
  })
  try {
    for (const m of await d.fly.listMachines(restored.after.flyApp!)) await d.fly.startMachine(restored.after.flyApp!, m.id)
  } catch (err) {
    d.log.error({ worldId, slug: w.slug, error: err instanceof Error ? err.message : String(err) }, 'hosted world restore: machine start failed')
    const { endsAt, endedAt, purgeAfter } = restored.before
    await db.update(hyperfyWorlds).set({ status: 'ended', endsAt, endedAt, purgeAfter }).where(eq(hyperfyWorlds.id, worldId))
    throw new HostingError('world_update_failed', "The world couldn't be started; try restoring it again")
  }
  d.log.info({ worldId, slug: w.slug }, 'hosted world restored')
  return restored.after
}
