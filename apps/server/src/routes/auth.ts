import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { OAuth2Client } from 'google-auth-library'
import { eq, and } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { users, userAuthMethods, passwordResetTokens } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { config } from '../config.js'
import { sendPasswordResetEmail } from '../services/email.js'
import { verifyDclSignedFetch, hasDclAuthHeaders } from '../middleware/dcl-auth.js'

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
  // ── GET /api/auth/providers — which OAuth providers are configured ──────

  app.get('/api/auth/providers', async () => ({
    google: !!(config.googleClientId && config.googleClientSecret),
    discord: !!(config.discordClientId && config.discordClientSecret),
  }))

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
      { id: user.id, email: user.email, role: user.role, orgId: user.activeOrgId || null },
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
    })

    if (!authMethod || !authMethod.credentialHash) {
      return reply.status(401).send({ error: 'Invalid email or password' })
    }

    const valid = await bcrypt.compare(password, authMethod.credentialHash)
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid email or password' })
    }

    let user: any
    try {
      const [row] = await db.select().from(users).where(eq(users.id, authMethod.userId))
      user = row
    } catch {
      // Fallback if active_org_id column doesn't exist yet (pre-migration)
      const [row] = await db.select({
        id: users.id,
        displayName: users.displayName,
        email: users.email,
        role: users.role,
      }).from(users).where(eq(users.id, authMethod.userId))
      user = { ...row, activeOrgId: null }
    }

    const accessToken = app.jwt.sign(
      { id: user.id, email: user.email, role: user.role, orgId: user.activeOrgId || null },
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
        { id: user.id, email: user.email, role: user.role, orgId: user.activeOrgId || null },
        { expiresIn: config.jwtAccessExpiry },
      )

      return reply.send({ accessToken })
    } catch {
      return reply.status(401).send({ error: 'Invalid or expired refresh token' })
    }
  })

  // ── POST /api/auth/platform — Platform-specific auth ───────────────────
  // Verifies Decentraland signed fetch headers (AuthChain) to cryptographically
  // prove the request comes from a specific Ethereum wallet.
  // Falls back to unverified auth for non-DCL platforms or preview mode.

  app.post<{ Body: { sceneId?: string; user?: any; world?: string; [key: string]: any } }>(
    '/api/auth/platform',
    async (request, reply) => {
      const { sceneId, user: platformUser, world } = request.body

      let verifiedWallet: string | null = null
      let displayName = platformUser?.displayName || platformUser?.name || 'Guest'

      // ── Try to verify DCL signed fetch headers ────────────────────────────
      if (hasDclAuthHeaders(request.headers as Record<string, string | string[] | undefined>)) {
        try {
          const dclAuth = await verifyDclSignedFetch(
            request.method,
            request.url,
            request.headers as Record<string, string | string[] | undefined>,
          )
          verifiedWallet = dclAuth.walletAddress.toLowerCase()
          request.log.info({ wallet: verifiedWallet }, 'DCL signed fetch verified')
        } catch (err) {
          request.log.warn({ err }, 'DCL signed fetch verification failed')
          // Don't reject — fall through to unverified path for preview mode
        }
      }

      // Use verified wallet if available, otherwise fall back to body data
      const platformId = verifiedWallet
        || platformUser?.id
        || platformUser?.walletAddress
        || `guest-${Date.now()}`

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
          metadata: { world, sceneId, verified: !!verifiedWallet },
        })

        dbUser = newUser
      }

      const accessToken = app.jwt.sign(
        { id: dbUser.id, email: dbUser.email, role: dbUser.role, orgId: dbUser.activeOrgId || null },
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
        verified: !!verifiedWallet,
      })
    },
  )

  // ── GET /api/auth/google — Redirect to Google OAuth consent screen ───────

  app.get('/api/auth/google', async (request, reply) => {
    if (!config.googleClientId || !config.googleClientSecret) {
      return reply.status(501).send({ error: 'Google OAuth is not configured' })
    }

    const redirectUri = `${config.oauthCallbackUrl}/api/auth/google/callback`

    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'email profile',
      access_type: 'offline',
      prompt: 'consent',
    })

    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`)
  })

  // ── GET /api/auth/google/callback — Handle the OAuth callback ────────────

  app.get<{ Querystring: { code?: string; error?: string } }>(
    '/api/auth/google/callback',
    async (request, reply) => {
      if (!config.googleClientId || !config.googleClientSecret) {
        return reply.status(501).send({ error: 'Google OAuth is not configured' })
      }

      const { code, error: oauthError } = request.query

      if (oauthError || !code) {
        return reply.redirect(`${config.publicUrl}/auth/callback?error=${oauthError || 'missing_code'}`)
      }

      const redirectUri = `${config.oauthCallbackUrl}/api/auth/google/callback`
      const oauthClient = new OAuth2Client(config.googleClientId, config.googleClientSecret, redirectUri)

      try {
        // Exchange code for tokens
        const { tokens } = await oauthClient.getToken(code)
        oauthClient.setCredentials(tokens)

        // Verify and decode the id_token
        const ticket = await oauthClient.verifyIdToken({
          idToken: tokens.id_token!,
          audience: config.googleClientId,
        })
        const payload = ticket.getPayload()

        if (!payload || !payload.sub) {
          return reply.redirect(`${config.publicUrl}/auth/callback?error=invalid_token`)
        }

        const googleUserId = payload.sub
        const email = payload.email || null
        const displayName = payload.name || payload.email || 'Google User'
        const identifier = `google:${googleUserId}`

        // Look up existing auth method
        let authMethod = await db.query.userAuthMethods.findFirst({
          where: and(
            eq(userAuthMethods.type, 'oauth'),
            eq(userAuthMethods.identifier, identifier),
          ),
          with: { user: true },
        })

        let dbUser

        if (authMethod) {
          // Existing user — log them in
          dbUser = authMethod.user
        } else {
          // New user — create account

          // Auto-promote the first user to admin in single/scalable mode
          let role: 'admin' | 'creator' = 'creator'
          if (config.autoPromoteFirstUser) {
            const userCount = await db.query.users.findFirst()
            if (!userCount) {
              role = 'admin'
            }
          }

          const [newUser] = await db
            .insert(users)
            .values({
              displayName,
              email: email?.toLowerCase() || null,
              role,
            })
            .returning()

          await db.insert(userAuthMethods).values({
            userId: newUser.id,
            type: 'oauth',
            identifier,
            metadata: {
              provider: 'google',
              googleUserId,
              email,
              name: payload.name,
              picture: payload.picture,
            },
          })

          dbUser = newUser
        }

        const accessToken = app.jwt.sign(
          { id: dbUser.id, email: dbUser.email, role: dbUser.role, orgId: dbUser.activeOrgId || null },
          { expiresIn: config.jwtAccessExpiry },
        )
        const refreshToken = app.jwt.sign(
          { id: dbUser.id, email: dbUser.email, role: dbUser.role, refresh: true },
          { expiresIn: config.jwtRefreshExpiry },
        )

        // Redirect to frontend with tokens
        const params = new URLSearchParams({
          token: accessToken,
          refresh: refreshToken,
        })

        return reply.redirect(`${config.publicUrl}/auth/callback?${params.toString()}`)
      } catch (err) {
        request.log.error(err, 'Google OAuth callback error')
        return reply.redirect(`${config.publicUrl}/auth/callback?error=oauth_failed`)
      }
    },
  )

  // ── GET /api/auth/discord — Redirect to Discord OAuth consent screen ──────

  app.get('/api/auth/discord', async (request, reply) => {
    if (!config.discordClientId || !config.discordClientSecret) {
      return reply.status(501).send({ error: 'Discord OAuth is not configured' })
    }

    const redirectUri = `${config.oauthCallbackUrl}/api/auth/discord/callback`

    const params = new URLSearchParams({
      client_id: config.discordClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'identify email',
    })

    return reply.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`)
  })

  // ── GET /api/auth/discord/callback — Handle the OAuth callback ────────────

  app.get<{ Querystring: { code?: string; error?: string } }>(
    '/api/auth/discord/callback',
    async (request, reply) => {
      if (!config.discordClientId || !config.discordClientSecret) {
        return reply.status(501).send({ error: 'Discord OAuth is not configured' })
      }

      const { code, error: oauthError } = request.query

      if (oauthError || !code) {
        return reply.redirect(`${config.publicUrl}/auth/callback?error=${oauthError || 'missing_code'}`)
      }

      const redirectUri = `${config.oauthCallbackUrl}/api/auth/discord/callback`

      try {
        // Exchange code for access token
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.discordClientId,
            client_secret: config.discordClientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
          }),
        })

        if (!tokenRes.ok) {
          request.log.error({ status: tokenRes.status }, 'Discord token exchange failed')
          return reply.redirect(`${config.publicUrl}/auth/callback?error=token_exchange_failed`)
        }

        const tokenData = (await tokenRes.json()) as { access_token: string; token_type: string }

        // Get user profile from Discord
        const userRes = await fetch('https://discord.com/api/users/@me', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        })

        if (!userRes.ok) {
          request.log.error({ status: userRes.status }, 'Discord user fetch failed')
          return reply.redirect(`${config.publicUrl}/auth/callback?error=user_fetch_failed`)
        }

        const discordUser = (await userRes.json()) as {
          id: string
          username: string
          email: string | null
          avatar: string | null
        }

        const discordUserId = discordUser.id
        const email = discordUser.email || null
        const displayName = discordUser.username || 'Discord User'
        const identifier = `discord:${discordUserId}`

        // Look up existing auth method
        let authMethod = await db.query.userAuthMethods.findFirst({
          where: and(
            eq(userAuthMethods.type, 'oauth'),
            eq(userAuthMethods.identifier, identifier),
          ),
          with: { user: true },
        })

        let dbUser

        if (authMethod) {
          // Existing user — log them in
          dbUser = authMethod.user
        } else {
          // New user — create account

          // Auto-promote the first user to admin in single/scalable mode
          let role: 'admin' | 'creator' = 'creator'
          if (config.autoPromoteFirstUser) {
            const userCount = await db.query.users.findFirst()
            if (!userCount) {
              role = 'admin'
            }
          }

          const [newUser] = await db
            .insert(users)
            .values({
              displayName,
              email: email?.toLowerCase() || null,
              role,
            })
            .returning()

          await db.insert(userAuthMethods).values({
            userId: newUser.id,
            type: 'oauth',
            identifier,
            metadata: {
              provider: 'discord',
              discordUserId,
              email,
              username: discordUser.username,
              avatar: discordUser.avatar,
            },
          })

          dbUser = newUser
        }

        const accessToken = app.jwt.sign(
          { id: dbUser.id, email: dbUser.email, role: dbUser.role, orgId: dbUser.activeOrgId || null },
          { expiresIn: config.jwtAccessExpiry },
        )
        const refreshToken = app.jwt.sign(
          { id: dbUser.id, email: dbUser.email, role: dbUser.role, refresh: true },
          { expiresIn: config.jwtRefreshExpiry },
        )

        // Redirect to frontend with tokens
        const params = new URLSearchParams({
          token: accessToken,
          refresh: refreshToken,
        })

        return reply.redirect(`${config.publicUrl}/auth/callback?${params.toString()}`)
      } catch (err) {
        request.log.error(err, 'Discord OAuth callback error')
        return reply.redirect(`${config.publicUrl}/auth/callback?error=oauth_failed`)
      }
    },
  )

  // ── PUT /api/auth/profile — Update display name ──────────────────────────

  app.put<{ Body: { displayName: string } }>(
    '/api/auth/profile',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { displayName } = request.body

      if (!displayName || !displayName.trim()) {
        return reply.status(400).send({ error: 'displayName is required' })
      }

      const [updated] = await db
        .update(users)
        .set({ displayName: displayName.trim(), updatedAt: new Date() })
        .where(eq(users.id, request.user.id))
        .returning()

      return reply.send({
        user: { id: updated.id, displayName: updated.displayName, email: updated.email, role: updated.role },
      })
    },
  )

  // ── PUT /api/auth/password — Change password ─────────────────────────────

  app.put<{ Body: { currentPassword: string; newPassword: string } }>(
    '/api/auth/password',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { currentPassword, newPassword } = request.body

      if (!currentPassword || !newPassword) {
        return reply.status(400).send({ error: 'currentPassword and newPassword are required' })
      }

      if (newPassword.length < 8) {
        return reply.status(400).send({ error: 'New password must be at least 8 characters' })
      }

      // Find email auth method for this user
      const authMethod = await db.query.userAuthMethods.findFirst({
        where: and(
          eq(userAuthMethods.userId, request.user.id),
          eq(userAuthMethods.type, 'email'),
        ),
      })

      if (!authMethod || !authMethod.credentialHash) {
        return reply.status(400).send({ error: 'No password-based auth method found for this account' })
      }

      const valid = await bcrypt.compare(currentPassword, authMethod.credentialHash)
      if (!valid) {
        return reply.status(401).send({ error: 'Current password is incorrect' })
      }

      const newHash = await bcrypt.hash(newPassword, 12)

      await db
        .update(userAuthMethods)
        .set({ credentialHash: newHash, updatedAt: new Date() })
        .where(eq(userAuthMethods.id, authMethod.id))

      return reply.send({ success: true })
    },
  )

  // ── POST /api/auth/forgot-password — Request password reset ──────────────

  app.post<{ Body: { email: string } }>(
    '/api/auth/forgot-password',
    async (request, reply) => {
      const { email } = request.body

      // Always return 200 to prevent email enumeration
      if (!email) {
        return reply.send({ message: 'If an account with that email exists, a reset link has been sent.' })
      }

      const authMethod = await db.query.userAuthMethods.findFirst({
        where: and(
          eq(userAuthMethods.type, 'email'),
          eq(userAuthMethods.identifier, email.toLowerCase()),
        ),
      })

      if (!authMethod) {
        return reply.send({ message: 'If an account with that email exists, a reset link has been sent.' })
      }

      const token = crypto.randomBytes(32).toString('hex')
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

      await db.insert(passwordResetTokens).values({
        userId: authMethod.userId,
        token,
        expiresAt,
      })

      await sendPasswordResetEmail(email.toLowerCase(), token)

      return reply.send({
        message: 'If an account with that email exists, a reset link has been sent.',
      })
    },
  )

  // ── POST /api/auth/reset-password — Reset password with token ────────────

  app.post<{ Body: { token: string; newPassword: string } }>(
    '/api/auth/reset-password',
    async (request, reply) => {
      const { token, newPassword } = request.body

      if (!token || !newPassword) {
        return reply.status(400).send({ error: 'token and newPassword are required' })
      }

      if (newPassword.length < 8) {
        return reply.status(400).send({ error: 'New password must be at least 8 characters' })
      }

      const resetToken = await db.query.passwordResetTokens.findFirst({
        where: eq(passwordResetTokens.token, token),
      })

      if (!resetToken) {
        return reply.status(400).send({ error: 'Invalid or expired reset token' })
      }

      if (resetToken.usedAt) {
        return reply.status(400).send({ error: 'This reset token has already been used' })
      }

      if (new Date(resetToken.expiresAt) < new Date()) {
        return reply.status(400).send({ error: 'Invalid or expired reset token' })
      }

      const newHash = await bcrypt.hash(newPassword, 12)

      // Update credential hash on the user's email auth method
      await db
        .update(userAuthMethods)
        .set({ credentialHash: newHash, updatedAt: new Date() })
        .where(
          and(
            eq(userAuthMethods.userId, resetToken.userId),
            eq(userAuthMethods.type, 'email'),
          ),
        )

      // Invalidate the token
      await db
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(eq(passwordResetTokens.id, resetToken.id))

      return reply.send({ success: true })
    },
  )

  // ── DELETE /api/auth/account — Delete account ────────────────────────────

  app.delete<{ Body: { password: string } }>(
    '/api/auth/account',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { password } = request.body

      if (!password) {
        return reply.status(400).send({ error: 'Password is required to delete account' })
      }

      // Find email auth method for this user
      const authMethod = await db.query.userAuthMethods.findFirst({
        where: and(
          eq(userAuthMethods.userId, request.user.id),
          eq(userAuthMethods.type, 'email'),
        ),
      })

      if (!authMethod || !authMethod.credentialHash) {
        return reply.status(400).send({ error: 'No password-based auth method found for this account' })
      }

      const valid = await bcrypt.compare(password, authMethod.credentialHash)
      if (!valid) {
        return reply.status(401).send({ error: 'Incorrect password' })
      }

      // Delete user — cascading deletes handle related data
      await db.delete(users).where(eq(users.id, request.user.id))

      return reply.status(204).send()
    },
  )
}
