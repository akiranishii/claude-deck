// Repository layer over SQLite. Column names come only from the whitelisted maps below, so
// dynamic SQL never contains caller-supplied identifiers; all values are bound parameters.

import type { Db } from './database'
import type { Account, Conversation, DeckEvent, Host, Project, Runtime, Settings } from '../../shared/types'
import { DEFAULT_SETTINGS, DEFAULT_STATUS_PATTERNS } from '../../shared/constants'
import { environmentUrl, isEnvironmentId } from '../../shared/urls'

type Row = Record<string, unknown>
interface Col {
  col: string
  to?: (v: unknown) => unknown
  from?: (v: unknown) => unknown
}

const bool: Omit<Col, 'col'> = { to: (v) => (v ? 1 : 0), from: (v) => v === 1 || v === true }
const nullableBool: Omit<Col, 'col'> = {
  to: (v) => (v === null || v === undefined ? null : v ? 1 : 0),
  from: (v) => (v === null || v === undefined ? null : v === 1),
}
const num: Omit<Col, 'col'> = { from: (v) => (v === null || v === undefined ? null : Number(v)) }
const json = (fallback: unknown): Omit<Col, 'col'> => ({
  to: (v) => (v === undefined || v === null ? null : JSON.stringify(v)),
  from: (v) => {
    if (typeof v !== 'string' || v === '') return fallback
    try {
      return JSON.parse(v)
    } catch {
      return fallback
    }
  },
})

function c(col: string, codec: Omit<Col, 'col'> = {}): Col {
  return { col, ...codec }
}

const HOST_COLS: Record<keyof Host, Col> = {
  id: c('id'),
  displayName: c('display_name'),
  sshAlias: c('ssh_alias'),
  remoteUser: c('remote_username'),
  homePath: c('home_path'),
  hostname: c('hostname'),
  claudePath: c('claude_path'),
  pythonCommand: c('python_command'),
  shellMode: c('shell_mode'),
  defaultParentDir: c('default_parent_dir'),
  capabilities: c('capabilities_json', json(null)),
  probe: c('probe_json', json(null)),
  lastConnectionStatus: c('last_connection_status'),
  lastConnectionError: c('last_connection_error'),
  lastConnectedAt: c('last_connected_at'),
  createdAt: c('created_at'),
  updatedAt: c('updated_at'),
}

const ACCOUNT_COLS: Record<keyof Account, Col> = {
  id: c('id'),
  displayName: c('display_name'),
  label: c('optional_email'),
  configDir: c('config_directory'),
  color: c('color'),
  chromeProfileDir: c('chrome_profile_directory'),
  chromeProfileName: c('chrome_profile_name'),
  chromeProfileConfirmedAt: c('chrome_profile_confirmed_at'),
  authState: c('last_auth_status'),
  authEmail: c('auth_email'),
  authPlan: c('auth_plan'),
  authOrg: c('auth_org'),
  authMethod: c('auth_method'),
  authError: c('auth_error'),
  authCheckedAt: c('last_checked_at'),
  lastAuthOkAt: c('last_verified_at'),
  sortOrder: c('sort_order', num),
  archived: c('archived', bool),
  createdAt: c('created_at'),
  updatedAt: c('updated_at'),
}

const PROJECT_COLS: Record<keyof Project, Col> = {
  id: c('id'),
  hostId: c('host_id'),
  displayName: c('display_name'),
  remotePath: c('remote_path'),
  repositoryRoot: c('repository_root'),
  isWorktree: c('is_worktree', bool),
  parentProjectId: c('parent_project_id'),
  taskSummary: c('task_summary'),
  taskStatus: c('task_status'),
  notes: c('notes'),
  tags: c('tags', json([])),
  pinned: c('pinned', bool),
  archived: c('archived', bool),
  lastActiveAt: c('last_active_at'),
  git: c('git_json', json(null)),
  pathStatus: c('path_status'),
  pathCheckedAt: c('path_checked_at'),
  container: c('container_json', json(null)),
  containerState: c('container_state_json', json(null)),
  createdAt: c('created_at'),
  updatedAt: c('updated_at'),
}

const RUNTIME_COLS: Record<keyof Runtime, Col> = {
  id: c('id'),
  projectId: c('project_id'),
  accountId: c('account_id'),
  accountConfirmed: c('account_confirmed', bool),
  accountEvidence: c('account_evidence'),
  observedConfigDir: c('observed_config_json', json(null)),
  tmuxSessionName: c('tmux_session_name'),
  tmuxSessionId: c('tmux_session_id'),
  tmuxPaneId: c('tmux_pane_id'),
  managed: c('managed', bool),
  importedExisting: c('imported_existing', bool),
  remoteControlName: c('remote_control_name'),
  spawnMode: c('spawn_mode'),
  permissionMode: c('permission_mode'),
  capacity: c('capacity', num),
  createSessionInDir: c('create_session_in_dir', nullableBool),
  observedFlags: c('observed_flags_json', json(null)),
  taskSummary: c('task_summary'),
  environmentId: c('environment_id'),
  observedStatus: c('observed_status'),
  statusDetail: c('status_detail'),
  statusEvidence: c('status_evidence_json', json([])),
  serverPid: c('server_pid', num),
  serverStart: c('server_start'),
  serverStartedAt: c('server_started_at'),
  lastStartedAt: c('last_started_at'),
  lastStoppedAt: c('last_stopped_at'),
  lastSeenAt: c('last_seen_at'),
  lastConnectedAt: c('last_connected_at'),
  lastExitStatus: c('last_exit_status', num),
  lastLaunchCommand: c('last_launch_command'),
  activeConversations: c('active_conversations', num),
  archived: c('archived', bool),
  createdAt: c('created_at'),
  updatedAt: c('updated_at'),
}

const CONVERSATION_COLS: Record<keyof Conversation, Col> = {
  id: c('id'),
  projectId: c('project_id'),
  runtimeId: c('runtime_id'),
  remoteSessionId: c('remote_session_id'),
  url: c('conversation_url'),
  displayTitle: c('display_title'),
  autoTitle: c('auto_title'),
  source: c('source'),
  pinned: c('pinned', bool),
  live: c('live', bool),
  claudeStatus: c('claude_status'),
  model: c('model'),
  lastSeenAt: c('last_seen_at'),
  lastOpenedAt: c('last_opened_at'),
  archived: c('archived', bool),
  createdAt: c('created_at'),
  updatedAt: c('updated_at'),
}

class Table<T extends { id: string }> {
  constructor(
    private readonly db: Db,
    readonly name: string,
    private readonly cols: Record<string, Col>,
    private readonly extra: (patch: Partial<T>) => Row = () => ({}),
  ) {}

  fromRow(row: Row): T {
    const out: Record<string, unknown> = {}
    for (const [key, col] of Object.entries(this.cols)) {
      const raw = row[col.col] ?? null
      out[key] = col.from ? col.from(raw) : raw
    }
    return out as T
  }

  toRow(patch: Partial<T>): Row {
    const row: Row = {}
    for (const [key, value] of Object.entries(patch)) {
      const col = this.cols[key]
      if (!col || value === undefined) continue
      row[col.col] = col.to ? col.to(value) : value
    }
    return { ...row, ...this.extra(patch) }
  }

  all(where = '', params: (string | number | null)[] = [], order = ''): T[] {
    const sql = `SELECT * FROM ${this.name}${where ? ` WHERE ${where}` : ''}${order ? ` ORDER BY ${order}` : ''}`
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => this.fromRow(r))
  }

  get(id: string): T | null {
    const row = this.db.prepare(`SELECT * FROM ${this.name} WHERE id = ?`).get(id) as Row | undefined
    return row ? this.fromRow(row) : null
  }

  insert(obj: T): void {
    const row = this.toRow(obj)
    const keys = Object.keys(row)
    this.db
      .prepare(`INSERT INTO ${this.name} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
      .run(...(keys.map((k) => row[k]) as (string | number | null)[]))
  }

  update(id: string, patch: Partial<T>): void {
    const row = this.toRow({ ...patch, id: undefined } as Partial<T>)
    delete row.id
    const keys = Object.keys(row)
    if (!keys.length) return
    this.db
      .prepare(`UPDATE ${this.name} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...(keys.map((k) => row[k]) as (string | number | null)[]), id)
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM ${this.name} WHERE id = ?`).run(id)
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}

export class Store {
  readonly hosts: Table<Host>
  readonly accounts: Table<Account>
  readonly projects: Table<Project>
  readonly runtimes: Table<Runtime>
  readonly conversations: Table<Conversation>
  private txDepth = 0

  constructor(readonly db: Db) {
    this.hosts = new Table<Host>(db, 'hosts', HOST_COLS)
    this.accounts = new Table<Account>(db, 'accounts', ACCOUNT_COLS)
    this.projects = new Table<Project>(db, 'projects', PROJECT_COLS)
    this.runtimes = new Table<Runtime>(db, 'runtimes', RUNTIME_COLS, (patch) =>
      'environmentId' in patch
        ? { environment_url: isEnvironmentId(patch.environmentId) ? environmentUrl(patch.environmentId as string) : null }
        : {},
    )
    this.conversations = new Table<Conversation>(db, 'conversations', CONVERSATION_COLS)
  }

  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.txDepth++
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    } finally {
      this.txDepth--
    }
  }

  // ------------------------------------------------------------------- convenience
  listHosts(): Host[] {
    return this.hosts.all('', [], 'created_at')
  }
  listAccounts(): Account[] {
    return this.accounts.all('', [], 'sort_order, created_at')
  }
  listProjects(): Project[] {
    return this.projects.all('', [], 'created_at')
  }
  listRuntimes(): Runtime[] {
    return this.runtimes.all('', [], 'created_at')
  }
  listConversations(): Conversation[] {
    return this.conversations.all('', [], 'created_at')
  }
  runtimesForHost(hostId: string): Runtime[] {
    return this.runtimes.all('project_id IN (SELECT id FROM projects WHERE host_id = ?)', [hostId], 'created_at')
  }
  projectsForHost(hostId: string): Project[] {
    return this.projects.all('host_id = ?', [hostId], 'created_at')
  }
  conversationsForRuntime(runtimeId: string): Conversation[] {
    return this.conversations.all('runtime_id = ?', [runtimeId], 'created_at')
  }
  conversationBySessionId(remoteSessionId: string): Conversation | null {
    return this.conversations.all('remote_session_id = ?', [remoteSessionId])[0] ?? null
  }
  accountByConfigDir(configDir: string | null): Account | null {
    return this.accounts.all('COALESCE(config_directory, \'\') = ?', [configDir ?? ''])[0] ?? null
  }

  // ------------------------------------------------------------------------- events
  addEvent(e: Omit<DeckEvent, 'id' | 'timestamp'> & { timestamp?: string }): void {
    this.db
      .prepare('INSERT INTO events (runtime_id, project_id, host_id, timestamp, level, event_type, summary) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(e.runtimeId ?? null, e.projectId ?? null, e.hostId ?? null, e.timestamp ?? nowIso(), e.level, e.type, e.summary.slice(0, 500))
  }

  listEvents(filter: { runtimeId?: string; projectId?: string; limit?: number } = {}): DeckEvent[] {
    const where: string[] = []
    const params: (string | number)[] = []
    if (filter.runtimeId) {
      where.push('runtime_id = ?')
      params.push(filter.runtimeId)
    }
    if (filter.projectId) {
      where.push('project_id = ?')
      params.push(filter.projectId)
    }
    const limit = Math.max(1, Math.min(1000, filter.limit ?? 200))
    const rows = this.db
      .prepare(`SELECT * FROM events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`)
      .all(...params) as Row[]
    return rows.map((r) => ({
      id: Number(r.id),
      timestamp: String(r.timestamp),
      level: r.level as DeckEvent['level'],
      type: String(r.event_type),
      summary: String(r.summary),
      hostId: (r.host_id as string) ?? null,
      projectId: (r.project_id as string) ?? null,
      runtimeId: (r.runtime_id as string) ?? null,
    }))
  }

  pruneEvents(keep = 5000): void {
    this.db.prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?').run(keep)
  }

  // ----------------------------------------------------------------------- settings
  getSettings(): Settings {
    const rows = this.db.prepare('SELECT key, value_json FROM settings').all() as { key: string; value_json: string }[]
    const stored: Record<string, unknown> = {}
    for (const row of rows) {
      if (!(row.key in DEFAULT_SETTINGS)) continue
      try {
        stored[row.key] = JSON.parse(row.value_json)
      } catch {
        /* ignore corrupt value */
      }
    }
    const merged = { ...DEFAULT_SETTINGS, ...stored } as Settings
    merged.browser = { ...DEFAULT_SETTINGS.browser, ...((stored.browser as object) ?? {}) }
    merged.statusPatterns = { ...DEFAULT_STATUS_PATTERNS, ...((stored.statusPatterns as object) ?? {}) }
    return merged
  }

  setSettings(patch: Partial<Settings>): Settings {
    const stmt = this.db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    this.tx(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in DEFAULT_SETTINGS) || value === undefined) continue
        stmt.run(key, JSON.stringify(value))
      }
    })
    return this.getSettings()
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(`meta:${key}`) as { value_json: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.value_json) as string
    } catch {
      return null
    }
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(`meta:${key}`)
      return
    }
    this.db
      .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
      .run(`meta:${key}`, JSON.stringify(value))
  }
}
