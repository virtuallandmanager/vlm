import { defineConfig } from 'vitest/config'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      'vlm-shared': resolve(here, '../vlm-shared/src/index.ts'),
      'vlm-client': resolve(here, '../vlm-client/src/index.ts'),
    },
  },
  test: { include: ['test/**/*.test.ts'] },
})
