import { describe, it, expect } from 'vitest'
import { assertProductionSecrets } from '../src/config.js'

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
