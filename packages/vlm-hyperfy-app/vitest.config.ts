import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

// The edit mode uses vlm-core's transform session from source, as the bundle does (scripts/bundle-options.mjs).
export default defineConfig({
  resolve: {
    alias: {
      'vlm-core/transform/session': join(here, '../vlm-core/src/transform/session.ts'),
      'vlm-core/transform/math': join(here, '../vlm-core/src/transform/math.ts'),
    },
  },
})
