import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // The main-process code imports 'electron' in a few modules; unit tests only import pure modules.
    server: { deps: { external: ['electron'] } },
  },
})
