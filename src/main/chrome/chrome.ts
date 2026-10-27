// Chrome profile discovery and profile-specific opening.
//
// Discovery reads only `profile.info_cache` display metadata from Chrome's "Local State" file
// (profile name, Google account e-mail, avatar colour). Cookies, passwords, tokens and the
// rest of the file are never used, stored or logged.
//
// Opening uses `open -n -a <Chrome.app> --args --profile-directory=<dir> <url>` via execFile
// (no shell). With -n, a running Chrome receives the request and opens the URL in a window of
// that profile, even when another profile's window is in front.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { BrowserSettings, ChromeProfile } from '../../shared/types'
import { isLoginUrl, isOpenableClaudeUrl } from '../../shared/urls'
import { expandHome } from '../paths'

const PROFILE_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/
const APP_NAME_RE = /^[A-Za-z0-9 ._-]{1,80}$/

export function isValidProfileDir(dir: string): boolean {
  return PROFILE_DIR_RE.test(dir) && !dir.includes('..')
}

function argbToHex(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return `#${(value >>> 0).toString(16).padStart(8, '0').slice(2)}`
}

/** Extract non-sensitive profile metadata from a parsed Local State document. */
export function parseLocalState(doc: unknown): ChromeProfile[] {
  const profile = (doc as { profile?: Record<string, unknown> } | null)?.profile ?? {}
  const rawCache = profile.info_cache
  const cache = (rawCache && typeof rawCache === 'object' && !Array.isArray(rawCache) ? rawCache : {}) as Record<string, Record<string, unknown>>
  const lastUsed = typeof profile.last_used === 'string' ? profile.last_used : null
  const order = Array.isArray(profile.profiles_order) ? (profile.profiles_order as string[]) : []
  const out: ChromeProfile[] = []
  for (const [dir, info] of Object.entries(cache)) {
    if (!isValidProfileDir(dir) || dir === 'System Profile' || dir === 'Guest Profile') continue
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
    out.push({
      directory: dir,
      name: str(info?.name) ?? dir,
      email: str(info?.user_name),
      gaiaName: str(info?.gaia_name),
      isManaged: Boolean(info?.is_managed),
      avatarColor: argbToHex(info?.default_avatar_fill_color) ?? argbToHex(info?.profile_highlight_color),
      lastActive: typeof info?.active_time === 'number' ? info.active_time : null,
      isLastUsed: dir === lastUsed,
    })
  }
  const rank = (d: string) => {
    const i = order.indexOf(d)
    return i < 0 ? 999 : i
  }
  return out.sort((a, b) => rank(a.directory) - rank(b.directory) || a.directory.localeCompare(b.directory, undefined, { numeric: true }))
}

export function readChromeProfiles(browser: BrowserSettings): { profiles: ChromeProfile[]; error: string | null } {
  const file = path.join(expandHome(browser.userDataDir), 'Local State')
  try {
    const st = fs.statSync(file)
    if (st.size > 50 * 1024 * 1024) return { profiles: [], error: 'Chrome Local State file is unexpectedly large' }
    const profiles = parseLocalState(JSON.parse(fs.readFileSync(file, 'utf8')))
    return { profiles, error: profiles.length ? null : 'No Chrome profiles found' }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return { profiles: [], error: code === 'ENOENT' ? `Chrome profile data not found at ${browser.userDataDir}` : `Could not read Chrome profiles: ${(err as Error).message}` }
  }
}

export function browserInstalled(browser: BrowserSettings): boolean {
  return fs.existsSync(browser.appPath)
}

/** argv for /usr/bin/open. Throws on anything that is not a known-safe profile/URL. */
export function chromeOpenArgs(appPath: string, profileDir: string, url: string): string[] {
  if (!isValidProfileDir(profileDir)) throw new Error(`Invalid Chrome profile directory: ${profileDir}`)
  if (!isOpenableClaudeUrl(url) && !isLoginUrl(url)) throw new Error('Refusing to open a URL outside claude.ai / Anthropic sign-in pages')
  if (!appPath.endsWith('.app') || /[\x00-\x1f]/.test(appPath)) throw new Error(`Invalid browser application path: ${appPath}`)
  return ['-n', '-a', appPath, '--args', `--profile-directory=${profileDir}`, url]
}

function execFileAsync(file: string, args: string[], timeout = 15_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr) }))
      else resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export async function openInProfile(browser: BrowserSettings, profileDir: string, url: string): Promise<void> {
  if (!browserInstalled(browser)) throw new Error(`${path.basename(browser.appPath, '.app')} is not installed at ${browser.appPath}`)
  await execFileAsync('/usr/bin/open', chromeOpenArgs(browser.appPath, profileDir, url))
}

/** Next unused "Profile N" directory name; Chrome creates the profile when launched with it. */
export function nextProfileDir(browser: BrowserSettings, known: ChromeProfile[]): string {
  const used = new Set(known.map((p) => p.directory))
  try {
    for (const name of fs.readdirSync(expandHome(browser.userDataDir))) used.add(name)
  } catch {
    /* ignore */
  }
  for (let n = 1; n < 500; n++) {
    const dir = `Profile ${n}`
    if (!used.has(dir)) return dir
  }
  throw new Error('Could not find a free Chrome profile directory name')
}

export function appNameFromPath(appPath: string): string {
  const name = path.basename(appPath, '.app')
  if (!APP_NAME_RE.test(name)) throw new Error(`Unsupported browser application name: ${name}`)
  return name
}

/** URL of the front tab of the front window (requires macOS Automation permission once). */
export async function frontTabUrl(browser: BrowserSettings): Promise<string | null> {
  const name = appNameFromPath(browser.appPath)
  const script = `tell application "${name}" to if (count of windows) > 0 then return URL of active tab of front window`
  const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script], 10_000)
  const url = stdout.trim()
  return url || null
}
