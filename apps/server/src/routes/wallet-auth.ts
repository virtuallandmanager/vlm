import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { getAddress, verifyMessage } from 'ethers'
import { db } from '../db/connection.js'
import { walletChallenges } from '../db/schema.js'
import { config } from '../config.js'
import { actorFromClaims } from '../auth/actor.js'
import { linkWalletGrants } from '../auth/permissions.js'
import { linkVerifiedWallet, resolveVerifiedWalletUser } from '../auth/wallet-users.js'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const TTL_MS = 5 * 60_000

export default async function walletAuthRoutes(app: FastifyInstance) {
  app.post<{ Body: { address?: string } }>('/api/auth/wallet/challenge', async (request, reply) => {
    const address = request.body?.address
    if (!address || !ADDRESS_RE.test(address)) return reply.status(400).send({ error: 'address must be a 0x wallet address' })
    const nonce = randomBytes(16).toString('hex')
    const url = new URL(config.publicUrl)
    const issuedAt = new Date()
    const expiresAt = new Date(issuedAt.getTime() + TTL_MS)
    const message = [
      `${url.host} wants you to sign in with your Ethereum account:`,
      getAddress(address.toLowerCase()),
      '',
      'Sign in to VLM to manage your scenes and analytics.',
      '',
      `URI: ${url.origin}`,
      'Version: 1',
      'Chain ID: 1',
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt.toISOString()}`,
      `Expiration Time: ${expiresAt.toISOString()}`,
    ].join('\n')
    await db.insert(walletChallenges).values({ nonce, address: address.toLowerCase(), message, expiresAt })
    return reply.send({ nonce, message })
  })

  app.post<{ Body: { address?: string; nonce?: string; signature?: string } }>('/api/auth/wallet/verify', async (request, reply) => {
    const { address, nonce, signature } = request.body ?? {}
    if (!address || !ADDRESS_RE.test(address) || !nonce || !signature) return reply.status(400).send({ error: 'address, nonce and signature are required' })
    // Single use: delete first so a failed attempt also burns the nonce.
    const [challenge] = await db.delete(walletChallenges).where(eq(walletChallenges.nonce, nonce)).returning()
    if (!challenge || challenge.expiresAt < new Date() || challenge.address !== address.toLowerCase()) {
      return reply.status(401).send({ error: 'Challenge expired or invalid' })
    }
    let recovered: string
    try {
      recovered = verifyMessage(challenge.message, signature).toLowerCase()
    } catch {
      return reply.status(401).send({ error: 'Invalid signature' })
    }
    if (recovered !== challenge.address) return reply.status(401).send({ error: 'Invalid signature' })

    const auth = request.headers.authorization
    if (auth?.startsWith('Bearer ')) {
      let bearer: { id: string; refresh?: boolean; guest?: boolean; verified?: boolean } | null = null
      try {
        bearer = app.jwt.verify<{ id: string; refresh?: boolean; guest?: boolean; verified?: boolean }>(auth.slice(7))
      } catch {
        return reply.status(401).send({ error: 'Invalid token' })
      }
      const actor = actorFromClaims(bearer)
      if (bearer!.refresh || !actor.userId || !actor.verified) return reply.status(401).send({ error: 'Invalid token' })
      const result = await linkVerifiedWallet(actor.userId, recovered)
      if (result === 'conflict') return reply.status(409).send({ error: 'That wallet is linked to another account' })
      await linkWalletGrants(actor.userId, recovered)
      return reply.send({ linked: true })
    }

    const user = await resolveVerifiedWalletUser(recovered, `${recovered.slice(0, 6)}…${recovered.slice(-4)}`)
    await linkWalletGrants(user.id, recovered)
    const claims = { id: user.id, email: user.email, role: user.role, orgId: user.activeOrgId || null, wallet: recovered, verified: true }
    return reply.send({
      user: { id: user.id, displayName: user.displayName, email: user.email, role: user.role },
      accessToken: app.jwt.sign(claims, { expiresIn: config.jwtAccessExpiry }),
      refreshToken: app.jwt.sign({ ...claims, refresh: true }, { expiresIn: config.jwtRefreshExpiry }),
    })
  })
}
