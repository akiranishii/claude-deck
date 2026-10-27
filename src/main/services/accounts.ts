// Claude accounts = named CLAUDE_CONFIG_DIR values + their Chrome profile mapping.
// Auth state comes from `claude auth status --json` run on the VM with the account's config
// dir set for that one process. Claude Deck never reads or stores credentials or tokens; the
// login flow runs Claude's own `claude auth login` in a terminal the user controls.

import type { AccountInput, AccountPatch, AuthCheck, ConfigDirWithAuth, LoginSession, LoginStatus } from '../../shared/ipc'
import type { Account, AuthState } from '../../shared/types'
import { ACCOUNT_COLORS } from '../../shared/constants'
import { newId, normalizeRemotePath, randomHex4, slugify, sameConfigDir, validateRemotePathInput } from '../../shared/naming'
import { isLoginUrl } from '../../shared/urls'
import { nowIso } from '../db/store'
import type { RawAuth, RawConfigDirInfo, RawLoginPoll } from '../ssh/helperTypes'
import { isValidProfileDir, openInProfile } from '../chrome/chrome'
import { DeckError, type Ctx } from './context'
import { mapConfigDir, observedDirValue } from './mappers'

export interface LoginRecord {
  loginId: string
  hostId: string
  accountId: string
  sessionName: string
  startedAt: number
}

function mapAuth(raw: RawAuth): AuthCheck {
  return {
    configDir: raw.config_dir,
    state: raw.state === 'ok' || raw.state === 'missing' || raw.state === 'unsupported' || raw.state === 'timeout' ? raw.state : 'error',
    loggedIn: raw.logged_in,
    email: raw.email ?? null,
    orgName: raw.org_name ?? null,
    subscription: raw.subscription ?? null,
    authMethod: raw.auth_method ?? null,
    error: raw.error ?? null,
  }
}

export function authStateFrom(check: AuthCheck): AuthState {
  if (check.state === 'missing') return 'missing_dir'
  if (check.state !== 'ok') return 'error'
  return check.loggedIn ? 'authenticated' : 'logged_out'
}

export function normalizeConfigDir(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null
  const trimmed = input.trim()
  if (!trimmed || trimmed === '(default)') return null
  const err = validateRemotePathInput(trimmed)
  if (err) throw new DeckError('invalid_config_dir', `Config directory: ${err}`)
  return normalizeRemotePath(trimmed)
}

export class AccountsService {
  readonly logins = new Map<string, LoginRecord>()

  constructor(private readonly ctx: Ctx) {}

  private defaultHostId(): string {
    const host = this.ctx.store.listHosts()[0]
    if (!host) throw new DeckError('no_host', 'Connect a VM first')
    return host.id
  }

  private home(hostId: string): string | null {
    return this.ctx.store.hosts.get(hostId)?.homePath ?? null
  }

  /** Stored config dirs are absolute when the host home is known (so they compare reliably). */
  private resolveDir(dir: string | null, hostId?: string): string | null {
    if (dir === null) return null
    const home = hostId ? this.home(hostId) : this.ctx.store.listHosts()[0]?.homePath ?? null
    if (home && (dir === '~' || dir.startsWith('~/'))) return normalizeRemotePath(dir === '~' ? home : `${home}/${dir.slice(2)}`)
    return dir
  }

  nextColor(): string {
    const used = new Set(this.ctx.store.listAccounts().map((a) => a.color))
    return ACCOUNT_COLORS.find((c) => !used.has(c)) ?? ACCOUNT_COLORS[this.ctx.store.listAccounts().length % ACCOUNT_COLORS.length]
  }

  create(input: AccountInput): Account {
    const { store } = this.ctx
    const displayName = input.displayName.trim()
    if (!displayName) throw new DeckError('invalid_name', 'Enter a display name')
    const configDir = this.resolveDir(normalizeConfigDir(input.configDir))
    const home = store.listHosts()[0]?.homePath ?? null
    const clash = store.listAccounts().find((a) => sameConfigDir(a.configDir, configDir, home))
    if (clash) throw new DeckError('duplicate_config_dir', `${clash.displayName} already uses ${configDir ?? 'the default configuration'}`)
    if (input.chromeProfileDir && !isValidProfileDir(input.chromeProfileDir)) throw new DeckError('invalid_profile', 'Invalid Chrome profile')
    const profile = input.chromeProfileDir ? this.ctx.chromeProfiles().profiles.find((p) => p.directory === input.chromeProfileDir) : null
    const now = nowIso()
    const account: Account = {
      id: newId('acc'),
      displayName,
      label: input.label?.trim() || null,
      configDir,
      color: input.color ?? this.nextColor(),
      chromeProfileDir: input.chromeProfileDir ?? null,
      chromeProfileName: profile?.name ?? null,
      chromeProfileConfirmedAt: null,
      authState: 'unknown',
      authEmail: null,
      authPlan: null,
      authOrg: null,
      authMethod: null,
      authError: null,
      authCheckedAt: null,
      lastAuthOkAt: null,
      sortOrder: Math.max(0, ...store.listAccounts().map((a) => a.sortOrder + 1)),
      archived: false,
      createdAt: now,
      updatedAt: now,
    }
    store.accounts.insert(account)
    this.ctx.event({ level: 'info', type: 'account.created', summary: `Account ${displayName} registered (${configDir ?? 'default config'})` })
    return account
  }

  update(id: string, patch: AccountPatch): Account {
    const { store } = this.ctx
    const current = store.accounts.get(id)
    if (!current) throw new DeckError('not_found', 'Account not found')
    const next: Partial<Account> = { updatedAt: nowIso() }
    if (patch.displayName !== undefined) {
      if (!patch.displayName.trim()) throw new DeckError('invalid_name', 'Enter a display name')
      next.displayName = patch.displayName.trim()
    }
    if (patch.label !== undefined) next.label = patch.label?.trim() || null
    if (patch.color !== undefined) next.color = patch.color
    if (patch.sortOrder !== undefined) next.sortOrder = patch.sortOrder
    if (patch.archived !== undefined) next.archived = patch.archived
    if (patch.configDir !== undefined) {
      const dir = this.resolveDir(normalizeConfigDir(patch.configDir))
      const home = store.listHosts()[0]?.homePath ?? null
      const clash = store.listAccounts().find((a) => a.id !== id && sameConfigDir(a.configDir, dir, home))
      if (clash) throw new DeckError('duplicate_config_dir', `${clash.displayName} already uses ${dir ?? 'the default configuration'}`)
      if (!sameConfigDir(dir, current.configDir, home)) {
        next.configDir = dir
        next.authState = 'unknown'
        next.authEmail = null
        next.authCheckedAt = null
      }
    }
    if (patch.chromeProfileDir !== undefined && patch.chromeProfileDir !== current.chromeProfileDir) {
      if (patch.chromeProfileDir && !isValidProfileDir(patch.chromeProfileDir)) throw new DeckError('invalid_profile', 'Invalid Chrome profile')
      next.chromeProfileDir = patch.chromeProfileDir
      next.chromeProfileName = patch.chromeProfileDir
        ? this.ctx.chromeProfiles().profiles.find((p) => p.directory === patch.chromeProfileDir)?.name ?? null
        : null
      next.chromeProfileConfirmedAt = null // a new mapping must be verified again
    }
    store.accounts.update(id, next)
    return store.accounts.get(id)!
  }

  delete(id: string): void {
    const account = this.ctx.store.accounts.get(id)
    if (!account) return
    this.ctx.store.accounts.delete(id) // runtimes keep running; they become "account unconfirmed"
    this.ctx.event({ level: 'warn', type: 'account.deleted', summary: `Account ${account.displayName} removed from Claude Deck (nothing changed on the VM)` })
  }

  confirmProfile(id: string, confirmed: boolean): Account {
    const account = this.ctx.store.accounts.get(id)
    if (!account) throw new DeckError('not_found', 'Account not found')
    if (confirmed && !account.chromeProfileDir) throw new DeckError('no_profile', 'Assign a Chrome profile first')
    this.ctx.store.accounts.update(id, { chromeProfileConfirmedAt: confirmed ? nowIso() : null, updatedAt: nowIso() })
    return this.ctx.store.accounts.get(id)!
  }

  async authChecks(hostId: string, dirs: (string | null)[]): Promise<AuthCheck[]> {
    const host = this.ctx.store.hosts.get(hostId)
    if (!host?.claudePath) throw new DeckError('no_claude', 'Claude Code was not found on the VM; choose its path in Settings')
    const res = await this.ctx.hosts.helper(hostId).call<{ results: RawAuth[] }>(
      'auth_status',
      { claude_path: host.claudePath, config_dirs: dirs },
      40_000 + dirs.length * 8000,
    )
    return res.results.map(mapAuth)
  }

  /** Check one or all accounts on the (primary) host and record the result. */
  async checkAuth(accountId?: string, hostId = this.defaultHostId()): Promise<Account[]> {
    const { store } = this.ctx
    const accounts = store.listAccounts().filter((a) => !a.archived && (!accountId || a.id === accountId))
    if (!accounts.length) return []
    const checks = await this.authChecks(hostId, accounts.map((a) => a.configDir))
    const now = nowIso()
    accounts.forEach((account, i) => {
      const check = checks[i]
      if (!check) return
      const state = authStateFrom(check)
      const patch: Partial<Account> = {
        authState: state,
        authError: state === 'error' ? check.error ?? check.state : null,
        authCheckedAt: now,
        updatedAt: now,
      }
      if (state === 'authenticated') {
        patch.lastAuthOkAt = now
        patch.authEmail = check.email
        patch.authPlan = check.subscription
        patch.authOrg = check.orgName
        patch.authMethod = check.authMethod
      }
      if (account.authState === 'authenticated' && state === 'logged_out') {
        this.ctx.event({ level: 'warn', type: 'account.logged_out', summary: `${account.displayName} is no longer signed in on the VM` })
        if (this.ctx.settings().notifications) this.ctx.notify(`${account.displayName} needs to sign in`, 'Claude reports this account is not logged in on the VM.')
      }
      store.accounts.update(account.id, patch)
    })
    this.ctx.changed()
    return store.listAccounts()
  }

  async listConfigDirs(hostId: string, checkAuth: boolean): Promise<ConfigDirWithAuth[]> {
    const res = await this.ctx.hosts.helper(hostId).call<{ home: string; dirs: RawConfigDirInfo[] }>('list_config_dirs', {}, 30_000)
    const host = this.ctx.store.hosts.get(hostId)
    const home = host?.homePath ?? res.home
    const accounts = this.ctx.store.listAccounts()
    const snap = this.ctx.live.snapshots.get(hostId)?.snap
    const dirs = res.dirs.map((d) => ({ raw: d, configDir: d.is_default_dir ? null : d.path }))
    // Also list explicit dirs used by running servers that are not under ~/.claude*.
    for (const s of snap?.servers ?? []) {
      const v = observedDirValue(mapConfigDir(s.config_dir))
      if (typeof v === 'string' && !dirs.some((d) => d.configDir !== null && sameConfigDir(d.configDir, v, home))) {
        dirs.push({ raw: { path: v, name: v.split('/').pop() ?? v, is_default_dir: false, has_credentials: false, has_projects: false, mtime: null }, configDir: v })
      }
    }
    let checks: AuthCheck[] = []
    if (checkAuth && host?.claudePath) {
      try {
        checks = await this.authChecks(hostId, dirs.map((d) => d.configDir))
      } catch {
        checks = []
      }
    }
    return dirs.map((d, i) => ({
      path: d.raw.path,
      name: d.raw.name,
      isDefaultDir: d.raw.is_default_dir,
      hasCredentials: d.raw.has_credentials,
      hasProjects: d.raw.has_projects,
      mtime: d.raw.mtime,
      configDir: d.configDir,
      auth: checks[i] ?? null,
      accountId: accounts.find((a) => sameConfigDir(a.configDir, d.configDir, home))?.id ?? null,
      inUseByServers: (snap?.servers ?? []).filter((s) => {
        const v = observedDirValue(mapConfigDir(s.config_dir))
        return v !== undefined && sameConfigDir(v, d.configDir, home)
      }).length,
    }))
  }

  async createConfigDir(hostId: string, path: string): Promise<{ path: string }> {
    const err = validateRemotePathInput(path)
    if (err) throw new DeckError('invalid_path', err)
    return this.ctx.hosts.helper(hostId).call<{ path: string }>('create_config_dir', { path }, 20_000)
  }

  // ---------------------------------------------------------------------------- login

  async startLogin(accountId: string, hostId: string, method: 'claudeai' | 'console' | 'sso' = 'claudeai', openTerminal: (hostId: string, sessionName: string, title: string) => Promise<void>): Promise<LoginSession> {
    const account = this.ctx.store.accounts.get(accountId)
    const host = this.ctx.store.hosts.get(hostId)
    if (!account || !host) throw new DeckError('not_found', 'Account or host not found')
    if (!host.claudePath) throw new DeckError('no_claude', 'Claude Code was not found on the VM')
    const sessionName = `cdeck-login-${slugify(account.displayName, 14)}-${randomHex4()}`
    await this.ctx.hosts.helper(hostId).call('login_start', {
      session_name: sessionName,
      claude_path: host.claudePath,
      config_dir: account.configDir,
      method,
    })
    const record: LoginRecord = { loginId: sessionName, hostId, accountId, sessionName, startedAt: Date.now() }
    this.logins.set(sessionName, record)
    this.ctx.event({ level: 'info', type: 'account.login_started', summary: `Started \`claude auth login\` for ${account.displayName} in tmux ${sessionName}` })
    await openTerminal(hostId, sessionName, `Sign in · ${account.displayName}`)
    return { loginId: sessionName, sessionName, hostId, accountId }
  }

  private login(loginId: string): LoginRecord {
    const rec = this.logins.get(loginId)
    if (!rec) throw new DeckError('not_found', 'Login session not found')
    return rec
  }

  async pollLogin(loginId: string): Promise<LoginStatus> {
    const rec = this.login(loginId)
    const raw = await this.ctx.hosts.helper(rec.hostId).call<RawLoginPoll>('login_poll', { session_name: rec.sessionName }, 20_000)
    let loggedIn: boolean | null = null
    let authState: AuthState | null = null
    if (raw.state !== 'running' || raw.success_hint) {
      const [account] = (await this.checkAuth(rec.accountId, rec.hostId)).filter((a) => a.id === rec.accountId)
      authState = account?.authState ?? null
      loggedIn = authState === 'authenticated'
    }
    return {
      state: raw.state,
      authUrl: raw.auth_url && isLoginUrl(raw.auth_url) ? raw.auth_url : null,
      awaitingCode: Boolean(raw.awaiting_code),
      successHint: Boolean(raw.success_hint),
      screenTail: raw.screen_tail ?? [],
      loggedIn,
      authState,
    }
  }

  async openLoginUrl(loginId: string, url: string, profileDir: string | null): Promise<void> {
    const rec = this.login(loginId)
    if (!isLoginUrl(url)) throw new DeckError('invalid_url', 'That is not a Claude sign-in URL')
    const account = this.ctx.store.accounts.get(rec.accountId)
    const dir = profileDir ?? account?.chromeProfileDir ?? null
    if (!dir) throw new DeckError('no_profile', 'Choose which Chrome profile should be used to sign in')
    await openInProfile(this.ctx.settings().browser, dir, url)
  }

  async finishLogin(loginId: string): Promise<Account | null> {
    const rec = this.logins.get(loginId)
    if (!rec) return null
    try {
      await this.ctx.hosts.helper(rec.hostId).call('login_cleanup', { session_name: rec.sessionName }, 15_000)
    } finally {
      this.logins.delete(loginId)
    }
    const accounts = await this.checkAuth(rec.accountId, rec.hostId)
    return accounts.find((a) => a.id === rec.accountId) ?? null
  }
}
