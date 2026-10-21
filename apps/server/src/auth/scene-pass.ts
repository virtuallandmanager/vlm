import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import type { SessionClaims } from './tokens.js'
import type { SessionUser } from './sessions.js'
import type { SceneBinding } from './scene-binding.js'

export function sceneClaims(user: { id: string; role: string }, wallet: string | null, b: SceneBinding): SessionClaims {
  return { id: user.id, email: null, role: user.role, orgId: null, wallet, verified: true, kind: 'scene', sceneId: b.sceneId, locationId: b.locationId }
}

/**
 * A scene pass: acts as the wallet's user only inside the bound scene (sceneId null = visitor).
 * No refresh token: a pass lives 15 min past the last signed request, so one taken by a hostile realm dies soon after the player leaves.
 */
export function issueScenePass(app: FastifyInstance, user: SessionUser, wallet: string, b: SceneBinding, expiresAt?: Date) {
  const claims = sceneClaims(user, wallet, b)
  return {
    user: { id: user.id, displayName: user.displayName, email: null, role: user.role },
    // expiresAt (hand-off): never later than the pass the code was minted from. A number here is seconds.
    accessToken: app.jwt.sign(claims, { expiresIn: expiresAt ? Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)) : config.jwtAccessExpiry }),
    refreshToken: null,
    scene: b,
  }
}

/**
 * A Hyperfy HUD pass: a scene pass for the world's scene, tied to a pairing so revoking the pairing kills it at once.
 * The wallet is the approving user's verified wallet, or null. No refresh token: the HUD renews through its pairing.
 */
export function issueHyperfyPass(
  app: FastifyInstance,
  user: { id: string; role: string },
  wallet: string | null,
  pairing: { id: string; worldId: string; sceneId: string },
): { pass: string; passExpiresAt: Date } {
  const claims: SessionClaims = { ...sceneClaims(user, wallet, { sceneId: pairing.sceneId, locationId: null }), via: 'hyperfy', pairingId: pairing.id, worldId: pairing.worldId }
  const pass = app.jwt.sign(claims, { expiresIn: config.jwtAccessExpiry })
  const exp = (app.jwt.decode(pass) as { exp: number }).exp
  return { pass, passExpiresAt: new Date(exp * 1000) }
}
