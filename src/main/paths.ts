import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function uid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : os.userInfo().uid
}

export function dbPath(): string {
  return path.join(app.getPath('userData'), 'claude-deck.sqlite')
}

/**
 * Private runtime directory for SSH control sockets and terminal launcher scripts.
 * Lives in /tmp because Unix socket paths are limited to ~104 bytes on macOS.
 * Ownership and permissions are verified so another user cannot pre-create it.
 */
export function runtimeDir(): string {
  const dir = `/tmp/cdeck-${uid()}`
  try {
    fs.mkdirSync(dir, { mode: 0o700 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  const st = fs.lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a directory`)
  if (st.uid !== uid()) throw new Error(`${dir} is owned by another user; refusing to use it`)
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700)
  return dir
}

export function launcherDir(): string {
  const dir = path.join(runtimeDir(), 'launch')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

/** Remove generated launcher scripts older than maxAgeMs. */
export function cleanLaunchers(maxAgeMs = 60 * 60 * 1000): void {
  try {
    const dir = launcherDir()
    const now = Date.now()
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name)
      try {
        if (now - fs.statSync(file).mtimeMs > maxAgeMs) fs.rmSync(file, { force: true })
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}
