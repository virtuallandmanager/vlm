import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs shared with the build script
import { bundleOptions } from '../scripts/bundle-options.mjs'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('production bundling of the pure modules', () => {
  for (const entry of ['src/pairing.ts', 'src/vlm-api.ts', 'src/sha256.ts', 'src/edit/controller.ts', 'src/edit/rays.ts', 'src/edit/gizmo.ts', 'src/hud/model.ts', 'src/hud/view.ts', 'src/hud/client.ts', 'src/link-relay.ts', 'src/app.ts']) {
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
        // Hyperfy's sandbox Date is { now } only (Scripts.js): no parse, UTC, or calling Date.
        ['a Date member other than now', /(?<![\w$.])Date\s*(?:\.\s*(?!now\b)[\w$]+|\[|\()/],
        // The sandbox's globalThis has no timers, fetch or other host globals.
        ['globalThis', /\bglobalThis\b/],
      ]
      for (const [name, re] of forbidden) expect(re.test(js), name).toBe(false)
    })
  }

  it('edit mode takes only the transform session and its math from vlm-core', async () => {
    // What the app's edit wiring pulls in: the session (a value) next to the edit modules.
    const { entryPoints: _, ...opts } = bundleOptions(pkg, '')
    const out = await build({
      ...opts,
      stdin: {
        contents: [
          "export { TransformSession } from 'vlm-core/transform/session'",
          "export * from './src/edit/controller.ts'",
          "export * from './src/edit/rays.ts'",
          "export * from './src/edit/gizmo.ts'",
        ].join('\n'),
        resolveDir: pkg,
        loader: 'ts',
      },
      globalName: 'M',
      metafile: true,
    })
    const fromCore = Object.keys(out.metafile!.inputs).filter((p) => p.includes('vlm-core/')).map((p) => p.slice(p.indexOf('vlm-core/'))).sort()
    expect(fromCore).toEqual(['vlm-core/src/transform/math.ts', 'vlm-core/src/transform/session.ts'])
    const js = Buffer.from(out.outputFiles![0].contents).toString('utf8')
    expect(js).toMatch(/\bTransformSession = class\b|class TransformSession\b/)
  })
})
