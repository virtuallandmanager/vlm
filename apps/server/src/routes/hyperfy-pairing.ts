/**
 * Hyperfy HUD pairing: a player's HUD gets a code, a Virvi user approves it on virvi.io, the HUD trades it for a scene pass.
 *
 * POST   /api/hyperfy/pair                  — (public, world key) Start a pairing; returns the code, approve link and QR
 * GET    /api/hyperfy/pair/:code/qr.png     — (public) QR of the approve link
 * GET    /api/hyperfy/pair/:code            — (signed in) What the approval page shows for a code
 * POST   /api/hyperfy/pair/:code/approve    — (signed in) Approve (or, without editing access, refuse) a code
 * POST   /api/hyperfy/pair/:code/claim      — (public, browser secret) Trade an approved code for a pass
 * POST   /api/hyperfy/pairings/:id/renew    — (public, browser secret) A fresh pass for a live pairing
 * POST   /api/hyperfy/pairings/vouch        — (public, world key + VIRVI_WORLD_SECRET) A hosted world speaks for a player: pass, a new code, or (with
 *                                             pendingPairingId) the state of that player's pending pairing
 * GET    /api/hyperfy/pairings              — (signed in) My live pairings
 * DELETE /api/hyperfy/pairings/:id          — (signed in) Revoke one of my pairings
 *
 * Codes, browser secrets and world secrets are credentials: never logged, never echoed except the code the caller just made.
 */

import type { FastifyInstance, FastifyReply } from 'fastify'
import QRCode from 'qrcode'
import { normalizePairingCode, type PairStartResponse } from '@virvixr/shared'
import { config } from '../config.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { findWorldBySecret } from '../hyperfy/worlds.js'
import { startPairing, pairingForApproval, approvePairing, claimPairing, renewPairing, revokePairing, listPairings, vouchPairing } from '../hyperfy/pairing.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256_HEX = /^[0-9a-f]{64}$/i
const MAX_NAME = 64
const MAX_SECRET = 256

/** Per-world vouch limit (callers are world servers: one IP, many players polling). Exported so tests can shrink it. */
export const vouchLimiter = { max: 600, windowMs: 60_000 }
/**
 * Per-IP vouch limit, checked before the secret so bad-secret calls (each one a DB lookup) are capped too. Generous:
 * well above one world's budget, since several hosted worlds can share a machine's IP.
 */
export const vouchIpLimiter = { max: 3000, windowMs: 60_000 }
type Window = { count: number; resetAt: number }
const vouchWindows = new Map<string, Window>()
const vouchIpWindows = new Map<string, Window>()
/** Counts one call for `key`; false when it is over its window's limit. */
function windowAllowed(windows: Map<string, Window>, key: string, limit: { max: number; windowMs: number }, now = Date.now()): boolean {
  if (windows.size > 1000) for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k)
  let w = windows.get(key)
  if (!w || w.resetAt <= now) windows.set(key, (w = { count: 0, resetAt: now + limit.windowMs }))
  return ++w.count <= limit.max
}

const approveUrlFor = (code: string) => `${config.webAppUrl}/pair/${code}`
const qrUrlFor = (code: string) => `${config.publicUrl}/api/hyperfy/pair/${code}/qr.png`

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null)
const optName = (v: unknown): string | null | undefined => (v === undefined || v === null ? null : typeof v === 'string' ? v.trim().slice(0, MAX_NAME) || null : undefined)

/** The normalized code in `:code`, or a 404 sent (null). */
function codeParam(request: { params: unknown }, reply: FastifyReply): string | null {
  const code = normalizePairingCode(String((request.params as { code?: string }).code ?? ''))
  if (!code) void reply.status(404).send({ error: 'not_found' })
  return code
}

export default async function hyperfyPairingRoutes(app: FastifyInstance) {
  app.post('/api/hyperfy/pair', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = (request.body ?? {}) as { worldKey?: unknown; secretHash?: unknown; playerName?: unknown }
    const worldKey = str(body.worldKey, MAX_SECRET)
    const playerName = optName(body.playerName)
    if (!worldKey || typeof body.secretHash !== 'string' || !SHA256_HEX.test(body.secretHash) || playerName === undefined) {
      return reply.status(400).send({ error: 'Missing or invalid fields: worldKey, secretHash (sha256 hex), playerName' })
    }
    try {
      const { code, expiresAt } = await startPairing(worldKey, body.secretHash.toLowerCase(), playerName, null)
      const res: PairStartResponse = { code, approveUrl: approveUrlFor(code), qrUrl: qrUrlFor(code), expiresAt: expiresAt.toISOString() }
      return reply.send(res)
    } catch (err) {
      if ((err as Error).message === 'invalid_world_key') return reply.status(401).send({ error: 'invalid_world_key' })
      throw err
    }
  })

  app.get('/api/hyperfy/pair/:code/qr.png', async (request, reply) => {
    const code = codeParam(request, reply)
    if (!code) return
    const info = await pairingForApproval(code)
    if (!info) return reply.status(404).send({ error: 'not_found' })
    const png = await QRCode.toBuffer(approveUrlFor(code), { margin: 2, width: 512, errorCorrectionLevel: 'M' })
    return reply.header('Cache-Control', 'private, no-store').type('image/png').send(png)
  })

  app.get('/api/hyperfy/pair/:code', { preHandler: [authenticate] }, async (request, reply) => {
    const code = codeParam(request, reply)
    if (!code) return
    const info = await pairingForApproval(code)
    if (!info) return reply.status(404).send({ error: 'not_found' })
    return reply.send(info)
  })

  // Per IP: a refused code is spent, so approve must not be a way to mass-refuse other people's codes.
  app.post('/api/hyperfy/pair/:code/approve', { preHandler: [authenticate], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const code = codeParam(request, reply)
    if (!code) return
    const result = await approvePairing(code, actorFromClaims(request.user))
    if (result === 'no_access') return reply.status(403).send({ error: 'no_access', result })
    if (result === 'expired') return reply.status(404).send({ error: 'not_found', result })
    return reply.send({ result })
  })

  // Each browser polls 30 a minute: 120 lets a few admins link at once from behind one NAT (an event venue, say).
  app.post('/api/hyperfy/pair/:code/claim', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const code = codeParam(request, reply)
    if (!code) return
    const secret = str((request.body as { secret?: unknown } | undefined)?.secret, MAX_SECRET)
    if (!secret) return reply.status(400).send({ error: 'Missing field: secret' })
    return reply.send(await claimPairing(code, secret, app))
  })

  app.post('/api/hyperfy/pairings/:id/renew', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const secret = str((request.body as { secret?: unknown } | undefined)?.secret, MAX_SECRET)
    if (!secret) return reply.status(400).send({ error: 'Missing field: secret' })
    // An id that is not a uuid cannot be a pairing: same answer as a revoked one.
    const result = UUID.test(id) ? await renewPairing(id, secret, app) : 'revoked'
    if (result === 'revoked') return reply.status(401).send({ error: 'pairing_revoked' })
    if (result === 'expired') return reply.status(401).send({ error: 'pairing_expired' })
    return reply.send(result)
  })

  // The world's own server calls this with VIRVI_WORLD_SECRET; the player id is trusted only because of that proof.
  // Not under the app-wide IP limit: a generous per-IP cap comes first, then the secret, then each world's own window.
  app.post('/api/hyperfy/pairings/vouch', { config: { rateLimit: false } }, async (request, reply) => {
    if (!windowAllowed(vouchIpWindows, request.ip, vouchIpLimiter)) return reply.status(429).send({ error: 'rate_limited' })
    const body = (request.body ?? {}) as { worldKey?: unknown; worldSecret?: unknown; hyperfyPlayerId?: unknown; playerName?: unknown; pendingPairingId?: unknown }
    const worldKey = str(body.worldKey, MAX_SECRET)
    const worldSecret = str(body.worldSecret, MAX_SECRET)
    if (!worldKey || !worldSecret) return reply.status(401).send({ error: 'invalid_world_secret' })
    // Unknown key, a world without a secret, or another world's secret: all the same 401.
    const world = await findWorldBySecret(worldKey, worldSecret)
    if (!world) return reply.status(401).send({ error: 'invalid_world_secret' })
    if (!windowAllowed(vouchWindows, world.id, vouchLimiter)) return reply.status(429).send({ error: 'rate_limited' })
    const playerId = str(body.hyperfyPlayerId, 128)
    const playerName = optName(body.playerName)
    if (!playerId || playerName === undefined) return reply.status(400).send({ error: 'Missing or invalid fields: hyperfyPlayerId, playerName' })
    const result = await vouchPairing(app, world, playerId, playerName, typeof body.pendingPairingId === 'string' ? body.pendingPairingId : undefined)
    if (result.status !== 'unlinked') return reply.send(result)
    return reply.send({ ...result, approveUrl: approveUrlFor(result.code), qrUrl: qrUrlFor(result.code) })
  })

  app.get('/api/hyperfy/pairings', { preHandler: [authenticate] }, async (request, reply) => {
    return reply.send({ pairings: await listPairings(request.user.id) })
  })

  app.delete('/api/hyperfy/pairings/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!UUID.test(id) || !(await revokePairing(id, request.user.id))) return reply.status(404).send({ error: 'not_found' })
    return reply.send({ revoked: true })
  })
}
