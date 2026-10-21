import { describe, expect, it } from 'vitest'
import { requestHeaders } from './request-headers'

describe('requestHeaders', () => {
  it('sends a JSON content type only when there is a body', () => {
    expect(requestHeaders('t', { method: 'POST', body: '{}' })['Content-Type']).toBe('application/json')
    // Fastify rejects an empty body labelled application/json with a 400
    expect(requestHeaders('t', { method: 'DELETE' })['Content-Type']).toBeUndefined()
    expect(requestHeaders('t', { method: 'POST' })['Content-Type']).toBeUndefined()
  })

  it('adds the bearer token and keeps caller headers', () => {
    const h = requestHeaders('tok', { body: 'x', headers: { 'Content-Type': 'text/plain', 'X-A': '1' } })
    expect(h).toEqual({ 'Content-Type': 'text/plain', Authorization: 'Bearer tok', 'X-A': '1' })
    expect(requestHeaders(null, {}).Authorization).toBeUndefined()
  })
})
