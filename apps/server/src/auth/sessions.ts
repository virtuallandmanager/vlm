import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'

export interface SessionUser {
  id: string
  email: string | null
  role: string
  activeOrgId: string | null
  displayName: string | null
}

/** Issue the access + refresh tokens of a verified-wallet session (wallet sign-in and in-world hand-off). */
export function issueWalletSession(app: FastifyInstance, user: SessionUser, wallet: string) {
  const claims = { id: user.id, email: user.email, role: user.role, orgId: user.activeOrgId || null, wallet, verified: true }
  return {
    user: { id: user.id, displayName: user.displayName, email: user.email, role: user.role },
    accessToken: app.jwt.sign(claims, { expiresIn: config.jwtAccessExpiry }),
    refreshToken: app.jwt.sign({ ...claims, refresh: true }, { expiresIn: config.jwtRefreshExpiry }),
  }
}
