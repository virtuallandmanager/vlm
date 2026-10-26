import { defineConfig } from 'vitest/config'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@virvixr/shared': resolve(here, '../shared/src/index.ts'),
      '@virvixr/client': resolve(here, '../client/src/index.ts'),
    },
  },
  test: { include: ['test/**/*.test.ts'] },
})
