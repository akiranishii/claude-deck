import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Opt-in tests against a real VM: CDECK_REMOTE_TESTS=1 CDECK_TEST_HOST=my-vm npm run test:remote
export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    server: { deps: { external: ['electron'] } },
  },
})
