// Claude URL handling. Conversation and environment URLs are only ever built from IDs that
// Claude itself emitted (terminal output / Claude's local metadata) or that the user supplied.

const SESSION_ID_RE = /^session_[A-Za-z0-9]{8,64}$/
const ENV_ID_RE = /^env_[A-Za-z0-9]{8,64}$/

export const CLAUDE_CODE_HOME = 'https://claude.ai/code'

export function isSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id)
}

export function isEnvironmentId(id: unknown): id is string {
  return typeof id === 'string' && ENV_ID_RE.test(id)
}

export function sessionUrl(id: string): string {
  if (!isSessionId(id)) throw new Error(`Invalid Claude session id: ${id}`)
  return `https://claude.ai/code/${id}`
}

export function environmentUrl(id: string): string {
  if (!isEnvironmentId(id)) throw new Error(`Invalid Remote Control environment id: ${id}`)
  return `https://claude.ai/code?environment=${id}`
}

export type ParsedClaudeUrl =
  | { kind: 'session'; sessionId: string; url: string }
  | { kind: 'environment'; environmentId: string; url: string }
  | { kind: 'home'; url: string }

/**
 * Accepts a full claude.ai/code URL (or a bare session_… id) and returns its canonical form.
 * Rejects other hosts, look-alike domains, credentials in URLs, plain http and unknown paths.
 */
export function parseClaudeUrl(input: string): ParsedClaudeUrl | null {
  const trimmed = (input ?? '').trim()
  if (!trimmed) return null
  if (isSessionId(trimmed)) return { kind: 'session', sessionId: trimmed, url: sessionUrl(trimmed) }
  if (isEnvironmentId(trimmed)) return { kind: 'environment', environmentId: trimmed, url: environmentUrl(trimmed) }
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.hostname !== 'claude.ai' || u.username || u.password || u.port) return null
  const path = u.pathname.replace(/\/+$/, '')
  const session = /^\/code\/(session_[A-Za-z0-9]{8,64})$/.exec(path)
  if (session) return { kind: 'session', sessionId: session[1], url: sessionUrl(session[1]) }
  if (path === '/code') {
    const env = u.searchParams.get('environment')
    if (env && isEnvironmentId(env)) return { kind: 'environment', environmentId: env, url: environmentUrl(env) }
    return { kind: 'home', url: CLAUDE_CODE_HOME }
  }
  return null
}

const OPENABLE_HOSTS = new Set(['claude.ai'])
const LOGIN_HOSTS = new Set([
  'claude.ai',
  'claude.com',
  'www.claude.com',
  'console.anthropic.com',
  'platform.claude.com',
  'auth.anthropic.com',
  'anthropic.com',
  'www.anthropic.com',
])

/** URLs Claude Deck may open in a browser profile: claude.ai pages only. */
export function isOpenableClaudeUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && OPENABLE_HOSTS.has(u.hostname) && !u.username && !u.password && !u.port
  } catch {
    return false
  }
}

/** Sign-in pages printed by `claude auth login` (opened in the account's Chrome profile). */
export function isLoginUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || !LOGIN_HOSTS.has(u.hostname) || u.username || u.password || u.port) return false
    const p = u.pathname.toLowerCase()
    return ['oauth', 'authorize', 'login', 'device'].some((k) => p.includes(k))
  } catch {
    return false
  }
}

/** Documentation/help links the renderer may open in the default browser. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && ['claude.ai', 'code.claude.com', 'docs.anthropic.com', 'support.claude.com', 'cloud.google.com'].includes(u.hostname)
  } catch {
    return false
  }
}
