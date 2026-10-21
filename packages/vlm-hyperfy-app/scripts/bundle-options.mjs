// esbuild options for the app bundle, shared by build-hyp.mjs and the bundling test.
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
    // Only the Hyperfy feed and pairing constants are needed; this dependency-free entry keeps the rest of vlm-shared out.
    alias: { 'vlm-shared': join(root, '../vlm-shared/src/hyperfy-entry.ts') },
  }
}
