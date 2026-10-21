import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs shared with the build script
import { bundleOptions } from '../scripts/bundle-options.mjs'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('production bundling of the pure modules', () => {
  for (const entry of ['src/pairing.ts', 'src/vlm-api.ts', 'src/sha256.ts']) {
    it(`${entry} bundles with the production alias and uses no forbidden globals`, async () => {
      const out = await build({ ...bundleOptions(pkg, join(pkg, entry)), format: 'iife', globalName: 'M' })
      const js = Buffer.from(out.outputFiles![0].contents).toString('utf8')
      const forbidden: Array<[string, RegExp]> = [
        ['WebSocket', /\bWebSocket\b/],
        ['TextEncoder', /\bTextEncoder\b/],
        ['setInterval', /\bsetInterval\b/],
        ['crypto', /\bcrypto\b/],
        ['localStorage', /\blocalStorage\b/],
        ['require', /\brequire\b/],
        ['import', /\bimport\b/],
        ['URL', /\bnew\s+URL\b|(?<![\w$.])URL\s*[.(]/],
        ['new Date', /\bnew\s+Date\b/],
      ]
      for (const [name, re] of forbidden) expect(re.test(js), name).toBe(false)
    })
  }
})
