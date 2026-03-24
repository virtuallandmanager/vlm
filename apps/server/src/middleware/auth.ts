import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify'

export interface AuthUser {
  id: string
  email: string | null
  role: string
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { id: string; email: string | null; role: string; refresh?: boolean }
    user: AuthUser
  }
}

/**
 * Fastify preHandler that verifies the JWT from the Authorization header
 * and attaches the decoded user to request.user.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    const decoded = await request.jwtVerify<AuthUser>()
    request.user = decoded
  } catch (err) {
    reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or missing token' })
  }
}

/**
 * Register the JWT plugin on a Fastify instance.
 */
export function registerJwt(app: FastifyInstance, secret: string) {
  return app.register(import('@fastify/jwt'), {
    secret,
    sign: { expiresIn: '15m' },
  })
}
