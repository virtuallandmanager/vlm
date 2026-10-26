import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../src/config.js'
import { redactPairingCode } from '../src/app.js'
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
    const dir = mkdtempSync(join(tmpdir(), 'virvi-dash-'))
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

  it('serves the space page for /s/:code with and without a trailing slash, and scrubs the code from logs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'virvi-dash-'))
    writeFileSync(join(dir, 'index.html'), 'HOME')
    mkdirSync(join(dir, 's/_'), { recursive: true })
    writeFileSync(join(dir, 's/_/index.html'), 'SPACE')
    ;(config as any).dashboardDir = dir
    await app.close()
    app = await testApp()
    for (const url of ['/s/ABCDEFG', '/s/ABCDEFG/']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(200)
      expect(res.body).toBe('SPACE')
    }
    expect(redactPairingCode('/s/ABCDEFG/')).toBe('/s/:code/')
    expect(redactPairingCode('/s/ABCDEFG')).toBe('/s/:code')
  })

  describe('/.well-known/assetlinks.json', () => {
    const prevLinks = { pkg: config.androidAppPackage, sha: config.androidCertSha256 }
    afterEach(() => {
      ;(config as any).androidAppPackage = prevLinks.pkg
      ;(config as any).androidCertSha256 = prevLinks.sha
    })

    // A dashboard with a catch-all index.html and a real file at the same path proves the route wins over both.
    async function appWithDashboard() {
      const dir = mkdtempSync(join(tmpdir(), 'virvi-dash-'))
      writeFileSync(join(dir, 'index.html'), 'HOME')
      mkdirSync(join(dir, '.well-known'), { recursive: true })
      writeFileSync(join(dir, '.well-known/assetlinks.json'), 'STATIC')
      ;(config as any).dashboardDir = dir
      await app.close()
      app = await testApp()
    }

    it('lists the package and certificate fingerprints', async () => {
      ;(config as any).androidAppPackage = 'gg.virvi.spaces'
      ;(config as any).androidCertSha256 = ['AA:BB', 'CC:DD']
      await appWithDashboard()
      const res = await app.inject({ method: 'GET', url: '/.well-known/assetlinks.json' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toMatch(/^application\/json/)
      expect(res.json()).toEqual([{
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: 'gg.virvi.spaces', sha256_cert_fingerprints: ['AA:BB', 'CC:DD'] },
      }])
    })

    it('serves [] when no fingerprint is configured, so nothing claims links before the app is signed', async () => {
      ;(config as any).androidCertSha256 = []
      await appWithDashboard()
      const res = await app.inject({ method: 'GET', url: '/.well-known/assetlinks.json' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual([])
    })

    it('is served without a dashboard too', async () => {
      ;(config as any).androidCertSha256 = ['AA:BB']
      ;(config as any).dashboardDir = '/nonexistent-dashboard-dir'
      await app.close()
      app = await testApp()
      expect((await app.inject({ method: 'GET', url: '/.well-known/assetlinks.json' })).json()).toHaveLength(1)
    })
  })
})
