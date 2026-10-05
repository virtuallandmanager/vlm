import { defineConfig } from 'vitest/config'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://vlm:vlm_dev@localhost:5432/vlm_test'

export default defineConfig({
  resolve: {
    alias: {
      'vlm-shared': resolve(here, '../../packages/vlm-shared/src/index.ts'),
    },
  },
  test: {
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: 'test-secret',
      VLM_MODE: 'single',
      LOG_LEVEL: 'silent',
      LIFECYCLE_SWEEP_MS: '0',
      ANALYTICS_JOBS: 'false',
    },
  },
})
