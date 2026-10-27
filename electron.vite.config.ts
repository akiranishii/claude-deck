import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

// Content-Security-Policy for the renderer. Production allows only bundled scripts; dev mode
// additionally allows Vite's HMR client and React Refresh preamble.
const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"
const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'"

function csp(command: 'build' | 'serve'): Plugin {
  return {
    name: 'claude-deck-csp',
    transformIndexHtml: (html) => html.replace('%CSP%', command === 'serve' ? DEV_CSP : PROD_CSP),
  }
}

export default defineConfig(({ command }) => ({
  main: {
    build: {
      externalizeDeps: true,
      rollupOptions: { external: ['node:sqlite'] },
    },
  },
  preload: {
    build: { externalizeDeps: true },
  },
  renderer: {
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared'), '@': resolve(__dirname, 'src/renderer/src') } },
    plugins: [react(), tailwindcss(), csp(command)],
  },
}))
