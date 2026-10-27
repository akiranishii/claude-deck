// Apps launched from Finder/Dock get a minimal PATH, so `ssh my-vm` would fail to find
// `gcloud` (used by the IAP ProxyCommand). We read the user's login-shell environment once and
// keep only the variables that matter for SSH/gcloud. Nothing from it is logged.

import { spawn } from 'node:child_process'
import os from 'node:os'
import { log } from '../log'

const KEEP = /^(PATH|CLOUDSDK_[A-Z0-9_]+|SSH_AUTH_SOCK|GOOGLE_APPLICATION_CREDENTIALS|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|ALL_PROXY|all_proxy)$/
const FALLBACK_DIRS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/opt/homebrew/share/google-cloud-sdk/bin',
  '/usr/local/share/google-cloud-sdk/bin',
  `${os.homedir()}/google-cloud-sdk/bin`,
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
]

let cached: Promise<NodeJS.ProcessEnv> | null = null

export function shellEnv(): Promise<NodeJS.ProcessEnv> {
  if (!cached) cached = resolve()
  return cached
}

export function parseEnvDump(out: string, marker: string): Record<string, string> {
  const start = out.indexOf(marker)
  const end = out.lastIndexOf(marker)
  const found: Record<string, string> = {}
  if (start < 0 || end <= start) return found
  for (const entry of out.slice(start + marker.length, end).split('\0')) {
    const i = entry.indexOf('=')
    if (i <= 0) continue
    const key = entry.slice(0, i).replace(/^\n+/, '')
    if (KEEP.test(key)) found[key] = entry.slice(i + 1)
  }
  return found
}

export function withFallbackPath(path: string | undefined): string {
  const parts = (path || '').split(':').filter(Boolean)
  for (const dir of FALLBACK_DIRS) if (!parts.includes(dir)) parts.push(dir)
  return parts.join(':')
}

async function resolve(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const shell = process.env.SHELL || os.userInfo().shell || '/bin/zsh'
  const marker = `__CDECK_ENV_${process.pid}__`
  const script = `printf '%s' '${marker}'; env -0; printf '%s' '${marker}'`
  try {
    const out = await new Promise<string>((ok, fail) => {
      // Login (not interactive) shell: fast, and enough for Homebrew/gcloud PATH set in ~/.zprofile.
      const child = spawn(shell, ['-lc', script], {
        env: { ...process.env, TERM: 'dumb', DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTART: 'false' },
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
      })
      const chunks: Buffer[] = []
      const timer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
        fail(new Error('timed out reading login shell environment'))
      }, 5000)
      child.stdout.on('data', (d: Buffer) => chunks.push(d))
      child.on('error', (e) => {
        clearTimeout(timer)
        fail(e)
      })
      child.on('close', () => {
        clearTimeout(timer)
        ok(Buffer.concat(chunks).toString('utf8'))
      })
    })
    Object.assign(env, parseEnvDump(out, marker))
  } catch (err) {
    log.warn('Could not read login shell environment; using fallback PATH', { error: String(err) })
  }
  env.PATH = withFallbackPath(env.PATH)
  return env
}
