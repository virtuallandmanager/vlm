import { describe, it, expect } from 'vitest'
import { config } from '../src/config.js'

describe('config defaults', () => {
  it('point at virvi.io and the Virvi AR app when nothing is set', () => {
    if (!process.env.EMAIL_FROM) expect(config.emailFrom).toBe('noreply@virvi.io')
    if (!process.env.AR_REPORTS_EMAIL) expect(config.arReportsEmail).toBe('support@virvi.io')
    if (!process.env.ANDROID_APP_PACKAGE) expect(config.androidAppPackage).toBe('io.virvi.ar')
  })
})
