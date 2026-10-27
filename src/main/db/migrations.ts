// Versioned schema migrations. Each runs once, inside a transaction; the applied version is
// tracked both in PRAGMA user_version and in the schema_migrations table.
// To change the schema, append a new entry — never edit an applied migration.

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE hosts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  ssh_alias TEXT NOT NULL UNIQUE,
  remote_username TEXT,
  home_path TEXT,
  hostname TEXT,
  claude_path TEXT,
  python_command TEXT NOT NULL DEFAULT 'python3',
  shell_mode TEXT NOT NULL DEFAULT 'interactive-login',
  default_parent_dir TEXT NOT NULL DEFAULT '~/projects',
  capabilities_json TEXT,
  probe_json TEXT,
  last_connection_status TEXT NOT NULL DEFAULT 'unknown',
  last_connection_error TEXT,
  last_connected_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  optional_email TEXT,
  config_directory TEXT,
  chrome_profile_directory TEXT,
  chrome_profile_name TEXT,
  chrome_profile_confirmed_at TEXT,
  color TEXT NOT NULL,
  last_auth_status TEXT NOT NULL DEFAULT 'unknown',
  auth_email TEXT,
  auth_plan TEXT,
  auth_org TEXT,
  auth_method TEXT,
  auth_error TEXT,
  last_checked_at TEXT,
  last_verified_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX accounts_config_directory ON accounts (COALESCE(config_directory, ''));

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  remote_path TEXT NOT NULL,
  repository_root TEXT,
  is_worktree INTEGER NOT NULL DEFAULT 0,
  parent_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  task_summary TEXT,
  task_status TEXT,
  notes TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  last_active_at TEXT,
  git_json TEXT,
  path_status TEXT NOT NULL DEFAULT 'unknown',
  path_checked_at TEXT,
  container_json TEXT,
  container_state_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX projects_host ON projects (host_id);

CREATE TABLE runtimes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  account_confirmed INTEGER NOT NULL DEFAULT 0,
  account_evidence TEXT,
  observed_config_json TEXT,
  tmux_session_name TEXT NOT NULL,
  tmux_session_id TEXT,
  tmux_pane_id TEXT,
  managed INTEGER NOT NULL DEFAULT 0,
  imported_existing INTEGER NOT NULL DEFAULT 0,
  remote_control_name TEXT,
  spawn_mode TEXT,
  permission_mode TEXT,
  capacity INTEGER,
  create_session_in_dir INTEGER,
  observed_flags_json TEXT,
  task_summary TEXT,
  environment_url TEXT,
  environment_id TEXT,
  observed_status TEXT NOT NULL DEFAULT 'unknown',
  status_detail TEXT,
  status_evidence_json TEXT,
  server_pid INTEGER,
  server_start TEXT,
  server_started_at TEXT,
  last_started_at TEXT,
  last_stopped_at TEXT,
  last_seen_at TEXT,
  last_connected_at TEXT,
  last_exit_status INTEGER,
  last_launch_command TEXT,
  active_conversations INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX runtimes_project ON runtimes (project_id);
CREATE INDEX runtimes_tmux ON runtimes (tmux_session_name);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  runtime_id TEXT REFERENCES runtimes(id) ON DELETE SET NULL,
  display_title TEXT,
  auto_title TEXT,
  conversation_url TEXT NOT NULL,
  remote_session_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  live INTEGER NOT NULL DEFAULT 0,
  claude_status TEXT,
  model TEXT,
  last_seen_at TEXT,
  last_opened_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX conversations_runtime ON conversations (runtime_id);
CREATE INDEX conversations_project ON conversations (project_id);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  runtime_id TEXT,
  project_id TEXT,
  host_id TEXT,
  timestamp TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL
);
CREATE INDEX events_runtime ON events (runtime_id, id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
`,
  },
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version
