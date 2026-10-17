import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import type { SessionClaims } from './tokens.js'
import type { SessionUser } from './sessions.js'
import type { SceneBinding } from './scene-binding.js'

export function sceneClaims(user: { id: string; role: string }, wallet: string, b: SceneBinding): SessionClaims {
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
