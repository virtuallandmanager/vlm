// esbuild options for the app bundle, shared by build-hyp.mjs and the bundling tests.
import { join } from 'node:path'

export function bundleOptions(root, entry) {
  return {
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'neutral',
    target: 'es2020',
    write: false,
    legalComments: 'none',
    // Only the Hyperfy feed and pairing constants are needed; this dependency-free entry keeps the rest of virvi-shared out.
    alias: {
      '@virvixr/shared': join(root, '../shared/src/hyperfy-entry.ts'),
      // Edit mode reuses virvi-core's transform session; aliasing its two source files keeps the rest of virvi-core out.
      '@virvixr/core/transform/session': join(root, '../core/src/transform/session.ts'),
      '@virvixr/core/transform/math': join(root, '../core/src/transform/math.ts'),
    },
  }
}
