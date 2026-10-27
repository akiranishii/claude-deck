// Naming helpers: tmux session names, default display names, and remote path utilities.

const MANAGED_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/

export function slugify(input: string, max = 20): string {
  const slug = (input || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
  return slug || 'x'
}

export function isValidManagedName(name: string): boolean {
  return MANAGED_NAME_RE.test(name)
}

/**
 * Allocate an identifiable, collision-free tmux session name such as `cd-myproj-main-a1b2`.
 * `taken` must contain every session name currently on the host plus names reserved in the DB.
 */
export function allocateTmuxName(
  projectName: string,
  accountName: string,
  taken: Iterable<string>,
  random: () => string = randomHex4,
): string {
  const used = new Set(taken)
  const base = `cd-${slugify(projectName, 18)}-${slugify(accountName, 10)}`
  for (let i = 0; i < 64; i++) {
    const candidate = `${base}-${random()}`
    if (!used.has(candidate) && isValidManagedName(candidate)) return candidate
  }
  throw new Error('Could not allocate a unique tmux session name')
}

export function randomHex4(): string {
  return Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0')
}

/** Default label for an account based on its config dir (purely cosmetic; never used to infer mappings). */
export function defaultAccountName(configDir: string | null): string {
  if (!configDir) return 'Main'
  const base = basename(configDir)
  const numbered = /^\.claude[-_.]?(?:account|acct|acc)[-_.]?(\d+)$/i.exec(base)
  if (numbered) return `Account ${numbered[1]}`
  const named = /^\.claude[-_.](.+)$/.exec(base)
  if (named) return named[1].replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  return base
}

export function defaultRemoteControlName(projectName: string, accountName: string): string {
  return `${projectName} · ${accountName}`.slice(0, 100)
}

// ------------------------------------------------------------------------- remote paths

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed
}

export function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  if (idx < 0) return '.'
  if (idx === 0) return '/'
  return trimmed.slice(0, idx)
}

/** Lexically normalise a POSIX path (keeps a leading ~). */
export function normalizeRemotePath(path: string): string {
  const raw = (path || '').trim()
  if (!raw) return raw
  const tilde = raw === '~' || raw.startsWith('~/')
  const body = tilde ? raw.slice(1) : raw
  const absolute = body.startsWith('/')
  const parts: string[] = []
  for (const seg of body.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop()
      else if (!absolute) parts.push('..')
      continue
    }
    parts.push(seg)
  }
  const joined = parts.join('/')
  if (tilde) return joined ? `~/${joined}` : '~'
  return absolute ? `/${joined}` : joined
}

export function expandTilde(path: string, home: string | null | undefined): string {
  if (!home) return path
  if (path === '~') return home
  if (path.startsWith('~/')) return `${home.replace(/\/+$/, '')}/${path.slice(2)}`
  return path
}

export function tildify(path: string | null | undefined, home: string | null | undefined): string {
  if (!path) return ''
  if (!home) return path
  const h = home.replace(/\/+$/, '')
  if (path === h) return '~'
  if (path.startsWith(h + '/')) return `~/${path.slice(h.length + 1)}`
  return path
}

export function joinRemote(parent: string, name: string): string {
  const p = (parent || '').replace(/\/+$/, '')
  return normalizeRemotePath(`${p || '/'}/${name}`)
}

export function validateFolderName(name: string): string | null {
  const n = (name || '').trim()
  if (!n) return 'Enter a folder name'
  if (n.length > 128) return 'Folder name is too long'
  if (/[\x00-\x1f\x7f]/.test(n)) return 'Folder name contains control characters'
  if (n.includes('/')) return 'Use the parent field for nested folders'
  if (n === '.' || n === '..') return 'Invalid folder name'
  if (n.startsWith('-')) return 'Folder names must not start with "-"'
  return null
}

export function validateRemotePathInput(path: string): string | null {
  const p = (path || '').trim()
  if (!p) return 'Enter a path'
  if (/[\x00-\x1f\x7f]/.test(p)) return 'Path contains control characters'
  if (!(p.startsWith('/') || p === '~' || p.startsWith('~/'))) return 'Use an absolute path or one starting with ~/'
  if (p.length > 1024) return 'Path is too long'
  return null
}

/** Human label for a CLAUDE_CONFIG_DIR value. */
export function configDirLabel(configDir: string | null, home?: string | null): string {
  if (!configDir) return '~/.claude (default)'
  return tildify(configDir, home)
}

/**
 * Two config dirs are the same account configuration only when both are the default (unset)
 * or both resolve to the same explicit path. Note: an explicit CLAUDE_CONFIG_DIR=~/.claude is NOT
 * the same as unset (Claude then keeps .claude.json in a different place).
 */
export function sameConfigDir(a: string | null, b: string | null, home?: string | null): boolean {
  if (a === null || b === null) return a === b
  return normalizeRemotePath(expandTilde(a, home ?? null)) === normalizeRemotePath(expandTilde(b, home ?? null))
}

export function newId(prefix: string): string {
  const bytes = new Uint8Array(10)
  globalThis.crypto.getRandomValues(bytes)
  const body = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${prefix}_${body}`
}
