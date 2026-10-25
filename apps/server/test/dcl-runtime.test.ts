import { describe, it, expect } from 'vitest'
import { runtimeFiles, DCL_RUNTIME_VERSION } from '../src/services/dcl/runtime.js'

describe('dcl runtime', () => {
  it('returns the built generic runtime', async () => {
    const files = await runtimeFiles()
    const js = files.get('bin/index.js')
    expect(js && js.byteLength).toBeGreaterThan(0)
    expect(Buffer.from(js!).toString('utf8')).toContain('getSceneInformation')
    expect(DCL_RUNTIME_VERSION).toBe(1)
  })

  it('rejects an unknown version', async () => {
    await expect(runtimeFiles(99)).rejects.toThrow()
  })
})
