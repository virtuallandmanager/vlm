import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../src/config.js'
import { testApp } from './helpers/factories.js'

describe('AR static pages', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const prev = { dashboardDir: config.dashboardDir }
  beforeEach(async () => { app = await testApp() })
  afterEach(async () => {
    ;(config as any).dashboardDir = prev.dashboardDir
    await app.close()
  })

  it('serves the headset approval page for /pair/headset/:code, apart from the Hyperfy page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vlm-dash-'))
    writeFileSync(join(dir, 'index.html'), 'HOME')
    for (const [sub, body] of [['pair/_', 'PAIR'], ['pair/headset/_', 'HEADSET']]) {
      mkdirSync(join(dir, sub), { recursive: true })
      writeFileSync(join(dir, sub, 'index.html'), body)
    }
    ;(config as any).dashboardDir = dir
    await app.close()
    app = await testApp()
    for (const url of ['/pair/headset/ABC234', '/pair/headset/ABC234/']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(200)
      expect(res.body).toBe('HEADSET')
    }
    expect((await app.inject({ method: 'GET', url: '/pair/ABC234' })).body).toBe('PAIR')
  })
})
