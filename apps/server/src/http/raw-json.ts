import type { FastifyInstance } from 'fastify'

/**
 * Keep the raw JSON string on `request.rawBody` (for signed-body checks), then
 * delegate to Fastify's own parser (400s, prototype-poisoning protection).
 */
export function withRawJson(scope: FastifyInstance): void {
  const parseJson = scope.getDefaultJsonParser('error', 'error')
  scope.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    ;(req as any).rawBody = body
    parseJson(req, body as string, done)
  })
}
