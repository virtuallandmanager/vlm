import { describe, it, expect, afterAll } from 'vitest'
import { testApp } from './helpers/factories.js'

describe('buildApp', () => {
  it('serves the health check without listening on a port', async () => {
    const app = await testApp()
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json().checks.postgres).toBe('ok')
    await app.close()
  })
})
