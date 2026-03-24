import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { eq, and } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { users, userAuthMethods } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { config } from '../config.js'

interface RegisterBody {
  email: string
  password: string
  displayName: string
}

interface LoginBody {
  email: string
  password: string
}

export default async function authRoutes(app: FastifyInstance) {
  // ── POST /api/auth/register ──────────────────────────────────────────────

  app.post<{ Body: RegisterBody }>('/api/auth/register', async (request, reply) => {
    const { email, password, displayName } = request.body

    if (!email || !password || !displayName) {
      return reply.status(400).send({ error: 'email, password, and displayName are required' })
    }

    // Check if email is already registered
    const existing = await db.query.userAuthMethods.findFirst({
      where: and(
        eq(userAuthMethods.type, 'email'),
        eq(userAuthMethods.identifier, email.toLowerCase()),
      ),
    })

    if (existing) {
      return reply.status(409).send({ error: 'Email already registered' })
    }

    const passwordHash = await bcrypt.hash(password, 12)

    // Auto-promote the first user to admin in single/scalable mode
    let role: 'admin' | 'creator' = 'creator'
    if (config.autoPromoteFirstUser) {
      const userCount = await db.query.users.findFirst()
      if (!userCount) {
        role = 'admin'
      }
    }

    const [user] = await db
      .insert(users)
      .values({
        displayName,
        email: email.toLowerCase(),
        role,
      })
      .returning()

    await db.insert(userAuthMethods).values({
      userId: user.id,
      type: 'email',
      identifier: email.toLowerCase(),
      credentialHash: passwordHash,
    })

    const accessToken = app.jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      { expiresIn: config.jwtAccessExpiry },
    )
    const refreshToken = app.jwt.sign(
      { id: user.id, email: user.email, role: user.role, refresh: true },
      { expiresIn: config.jwtRefreshExpiry },
    )

    return reply.status(201).send({
      user: { id: user.id, displayName: user.displayName, email: user.email, role: user.role },
      accessToken,
      refreshToken,
    })
  })

  // ── POST /api/auth/login ─────────────────────────────────────────────────

  app.post<{ Body: LoginBody }>('/api/auth/login', async (request, reply) => {
    const { email, password } = request.body

    if (!email || !password) {
      return reply.status(400).send({ error: 'email and password are required' })
    }

    const authMethod = await db.query.userAuthMethods.findFirst({
      where: and(
        eq(userAuthMethods.type, 'email'),
        eq(userAuthMethods.identifier, email.toLowerCase()),
      ),
      with: { user: true },
    })

    if (!authMethod || !authMethod.credentialHash) {
      return reply.status(401).send({ error: 'Invalid email or password' })
    }

    const valid = await bcrypt.compare(password, authMethod.credentialHash)
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid email or password' })
    }

    const user = authMethod.user

    const accessToken = app.jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      { expiresIn: config.jwtAccessExpiry },
    )
    const refreshToken = app.jwt.sign(
      { id: user.id, email: user.email, role: user.role, refresh: true },
      { expiresIn: config.jwtRefreshExpiry },
    )

    return reply.send({
      user: { id: user.id, displayName: user.displayName, email: user.email, role: user.role },
      accessToken,
      refreshToken,
    })
  })

  // ── POST /api/auth/refresh ───────────────────────────────────────────────

  app.post('/api/auth/refresh', async (request, reply) => {
    const authHeader = request.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Refresh token required' })
    }

    const token = authHeader.slice(7)

    try {
      const decoded = app.jwt.verify<{ id: string; email: string | null; role: string; refresh?: boolean }>(token)

      if (!decoded.refresh) {
        return reply.status(401).send({ error: 'Not a refresh token' })
      }

      // Verify user still exists
      const user = await db.query.users.findFirst({
        where: eq(users.id, decoded.id),
      })

      if (!user) {
        return reply.status(401).send({ error: 'User not found' })
      }

      const accessToken = app.jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        { expiresIn: config.jwtAccessExpiry },
      )

      return reply.send({ accessToken })
    } catch {
      return reply.status(401).send({ error: 'Invalid or expired refresh token' })
    }
  })

  // ── POST /api/auth/platform — Platform-specific auth ───────────────────
  // For now, this is a simplified flow that auto-creates users from platform data.
  // In production, this would verify signed fetch proofs, wallet signatures, etc.

  app.post<{ Body: { proof: any; sceneId: string; user: any; world: string; [key: string]: any } }>(
    '/api/auth/platform',
    async (request, reply) => {
      const { proof, sceneId, user: platformUser, world } = request.body

      if (!sceneId) {
        return reply.status(400).send({ error: 'sceneId is required' })
      }

      // Use platform user ID as identifier, or generate one
      const platformId = platformUser?.id || platformUser?.walletAddress || `guest-${Date.now()}`
      const displayName = platformUser?.displayName || platformUser?.name || 'Guest'

      // Check if this platform user already has an account
      let authMethod = await db.query.userAuthMethods.findFirst({
        where: and(
          eq(userAuthMethods.type, 'wallet'),
          eq(userAuthMethods.identifier, platformId),
        ),
        with: { user: true },
      })

      let dbUser

      if (authMethod) {
        // Existing user
        dbUser = authMethod.user
      } else {
        // Auto-create user for platform auth
        const [newUser] = await db
          .insert(users)
          .values({
            displayName,
            email: null,
            role: config.autoPromoteFirstUser ? 'admin' : 'creator',
          })
          .returning()

        await db.insert(userAuthMethods).values({
          userId: newUser.id,
          type: 'wallet',
          identifier: platformId,
          metadata: { world, sceneId },
        })

        dbUser = newUser
      }

      const accessToken = app.jwt.sign(
        { id: dbUser.id, email: dbUser.email, role: dbUser.role },
        { expiresIn: config.jwtAccessExpiry },
      )
      const refreshToken = app.jwt.sign(
        { id: dbUser.id, email: dbUser.email, role: dbUser.role, refresh: true },
        { expiresIn: config.jwtRefreshExpiry },
      )

      return reply.send({
        user: { id: dbUser.id, displayName: dbUser.displayName, email: dbUser.email, role: dbUser.role },
        accessToken,
        refreshToken,
      })
    },
  )
}
