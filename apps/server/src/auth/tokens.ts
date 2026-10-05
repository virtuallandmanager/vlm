import { createVerifier } from 'fast-jwt'
import { config } from '../config.js'

export interface SessionClaims {
  id: string
  email: string | null
  role: string
  orgId?: string | null
  wallet?: string | null
  verified?: boolean
  guest?: boolean
  refresh?: boolean
}

const verifier = createVerifier({ key: config.jwtSecret })

/** Verify an access token outside Fastify (e.g. Colyseus onAuth). Refresh tokens are rejected. */
export function verifySessionToken(token: string | undefined | null): SessionClaims | null {
  if (!token) return null
  try {
    const claims = verifier(token) as SessionClaims
    if (claims.refresh) return null
    return claims
  } catch {
    return null
  }
}
