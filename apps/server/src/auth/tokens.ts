import { createVerifier } from 'fast-jwt'
import { config } from '../config.js'

export type TokenKind = 'account' | 'scene'
export interface SessionClaims {
  id: string
  email: string | null
  role: string
  orgId?: string | null
  wallet?: string | null
  verified?: boolean
  guest?: boolean
  refresh?: boolean
  kind?: TokenKind
  sceneId?: string | null
  locationId?: string | null
  /** Set on a Hyperfy HUD pass: the pairing that minted it, checked on every request. */
  via?: 'hyperfy'
  pairingId?: string
  worldId?: string
}

const verifier = createVerifier({ key: config.jwtSecret })

/** Verify an access token outside Fastify (e.g. Colyseus onAuth). Refresh and kind-less (pre-scene-pass) tokens are rejected; guest tokens pass (they carry guest: true). */
export function verifySessionToken(token: string | undefined | null): SessionClaims | null {
  if (!token) return null
  try {
    const claims = verifier(token) as SessionClaims
    if (claims.refresh) return null
    if (!claims.guest && claims.kind !== 'account' && claims.kind !== 'scene') return null
    return claims
  } catch {
    return null
  }
}
