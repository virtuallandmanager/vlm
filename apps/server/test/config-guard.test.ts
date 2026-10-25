import { describe, it, expect, vi } from 'vitest'
import { assertProductionSecrets, validDeployKey } from '../src/config.js'

describe('assertProductionSecrets', () => {
  it('refuses the dev or an empty secret in cloud mode or NODE_ENV=production', () => {
    expect(() => assertProductionSecrets({ mode: 'cloud', jwtSecret: 'dev-secret-change-me' })).toThrow('JWT_SECRET must be set in production')
    expect(() => assertProductionSecrets({ mode: 'single', nodeEnv: 'production', jwtSecret: '' })).toThrow('JWT_SECRET must be set in production')
  })
  it('allows the dev secret locally and real secrets in production', () => {
    expect(() => assertProductionSecrets({ mode: 'single', jwtSecret: 'dev-secret-change-me' })).not.toThrow()
    expect(() => assertProductionSecrets({ mode: 'cloud', jwtSecret: 'a-real-secret' })).not.toThrow()
  })
})

describe('validDeployKey', () => {
  const key = 'ab'.repeat(32)
  it('accepts a 32-byte hex private key, with or without 0x', () => {
    expect(validDeployKey(key)).toBe(`0x${key}`)
    expect(validDeployKey(` 0x${key.toUpperCase()} `)).toBe(`0x${key.toUpperCase()}`)
    expect(validDeployKey(undefined)).toBeNull()
  })
  it('treats a malformed key as unset and warns without printing it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const bad of ['0x1234', `${key}00`, 'z'.repeat(64), '0'.repeat(64), 'f'.repeat(64)]) expect(validDeployKey(bad)).toBeNull()
      expect(warn).toHaveBeenCalled()
      for (const call of warn.mock.calls) expect(String(call)).not.toMatch(/zzzz|ffff|1234/)
    } finally {
      warn.mockRestore()
    }
  })
})
