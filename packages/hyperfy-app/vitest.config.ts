import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

// The edit mode uses virvi-core's transform session from source, as the bundle does (scripts/bundle-options.mjs).
export default defineConfig({
  resolve: {
    alias: {
      '@virvixr/core/transform/session': join(here, '../core/src/transform/session.ts'),
      '@virvixr/core/transform/math': join(here, '../core/src/transform/math.ts'),
    },
  },
})
