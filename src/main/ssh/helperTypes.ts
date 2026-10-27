// Raw (snake_case) result shapes returned by resources/remote/cdeck_helper.py.

export interface RawConfigDir {
  state: 'env' | 'default' | 'unknown'
  value: string | null
}

export interface RawSession {
  session_id: string
  name: string
  windows: number
  attached: number
  created: number | null
  activity: number | null
  runtime_marker: string | null
  managed: boolean
  login: boolean
}

export interface RawCapture {
  status_line: string | null
  state_word: string | null
  capacity: { used: number; max: number; note: string } | null
  last_log: { time: string; text: string } | null
  env_ids: string[]
  session_ids: string[]
  screen_tail: string[]
}

export interface RawForeground {
  kind: 'claude' | 'shell-idle' | 'other' | 'dead' | 'unknown'
  comm?: string
  pid?: number
  claude_kind?: string
  children?: number
}

export interface RawPane {
  session_id: string
  session_name: string
  window_id: string
  window_index: number
  window_name: string
  pane_id: string
  pane_index: number
  pane_pid: number | null
  current_command: string
  cwd: string | null
  dead: boolean
  dead_status: number | null
  width: number
  height: number
  active: boolean
  foreground: RawForeground
  rc_server_pids: number[]
  other_claude: { pid: number; kind: string; config_dir: RawConfigDir; started_at: number | null }[]
  capture: RawCapture | null
}

export interface RawFlags {
  name: string | null
  spawn?: string | null
  permission_mode?: string | null
  capacity?: number | null
  continue?: boolean
  session_id?: string | null
  create_session_in_dir?: boolean | null
  chrome?: boolean | null
  verbose?: boolean
  debug?: boolean
}

export interface RawConversation {
  pid: number
  start: string
  started_at: number | null
  cse_id: string | null
  model: string | null
  permission_mode: string | null
  meta: {
    bridgeSessionId?: string
    name?: string
    status?: string
    statusUpdatedAt?: number
    startedAt?: number
    updatedAt?: number
    version?: string
    cwd?: string
  } | null
}

export interface RawServer {
  pid: number
  start: string
  started_at: number | null
  kind: 'rc-server' | 'interactive-rc'
  flags: RawFlags
  config_dir: RawConfigDir
  runtime_marker: string | null
  exe: string | null
  cwd: string | null
  pane_id: string | null
  conversations: RawConversation[]
  pointer: { environment_id: string | null; session_id: string | null; source: string | null } | null
  tcp?: { established: number; https: number }
}

export interface RawGit {
  exists: boolean
  is_repo?: boolean
  root?: string
  branch?: string | null
  detached?: boolean
  head?: string | null
  is_worktree?: boolean
  dirty_count?: number | null
  last_commit?: { hash: string; subject: string; time: number | null }
  ahead?: number
  behind?: number
  error?: string
  /** not checked this round (time budget exceeded) */
  skipped?: boolean
}

export interface RawContainer {
  id: string
  name: string
  state: string
  status: string
  image: string
  local_folder: string | null
  config_file: string | null
  mounts?: { source: string; destination: string }[]
  remote_user?: string | null
  config_user?: string | null
}

export interface RawContainers {
  available: boolean
  reason?: string
  containers?: RawContainer[]
}

export interface RawSnapshot {
  time: number
  boot_time: number | null
  tmux_running: boolean
  sessions: RawSession[]
  panes: RawPane[]
  servers: RawServer[]
  paths: Record<string, { exists: boolean; is_dir: boolean }>
  git: Record<string, RawGit>
  containers?: RawContainers
  elapsed_ms: number
}

export interface RawCandidate {
  path: string
  realpath: string
  sources: string[]
  version: string | null
  error: string | null
}

export interface RawCapabilities {
  claude_path: string
  version: string | null
  version_error?: string | null
  rc_supported: boolean
  flags: string[]
  spawn_modes: string[]
  permission_modes: string[]
  supports_name: boolean
  supports_spawn: boolean
  supports_permission_mode: boolean
  supports_continue: boolean
  supports_session_id: boolean
  supports_capacity: boolean
  supports_create_session_in_dir: boolean
  supports_chrome: boolean
  auth_status_supported: boolean
  auth_login_supported: boolean
  rc_help_error?: string
}

export interface RawConfigDirInfo {
  path: string
  name: string
  is_default_dir: boolean
  has_credentials: boolean
  has_projects: boolean
  mtime: number | null
}

export interface RawProbe {
  helper_version: string
  protocol: number
  python: string
  hostname: string
  user: string
  uid: number
  home: string
  login_shell: string
  os: string | null
  kernel: string
  arch: string
  tmux: { path: string | null; version: string | null }
  git: { path: string | null; version: string | null }
  docker: { path: string | null; accessible?: boolean; version?: string | null; error?: string | null }
  projects_dir_exists: boolean
  claude_candidates?: RawCandidate[]
  claude_recommended?: string | null
  capabilities?: RawCapabilities
  config_dirs: RawConfigDirInfo[]
}

export interface RawAuth {
  config_dir: string | null
  exists: boolean
  state: 'ok' | 'missing' | 'unsupported' | 'timeout'
  logged_in: boolean | null
  auth_method?: string | null
  api_provider?: string | null
  email?: string | null
  org_name?: string | null
  subscription?: string | null
  credentials_file?: boolean
  error?: string | null
}

export interface RawLaunch {
  session_id: string
  window_id: string
  pane_id: string
  pane_pid?: number | null
  respawned: boolean
  command: string
}

export interface RawStop {
  state: 'stopped' | 'still_running' | 'not_running' | 'pane_missing'
  pid?: number
  elapsed_ms?: number
  remaining_sessions?: number
  note?: string | null
  dead?: boolean
  dead_status?: number | null
}

export interface RawEnd {
  state: 'ended' | 'busy' | 'missing'
  busy?: { pane_id: string; what: string }[]
  managed?: boolean
}

export interface RawDirListing {
  path: string
  parent: string | null
  home: string
  entries: { name: string; is_git: boolean; is_symlink: boolean }[]
  truncated: boolean
  writable: boolean
  git_root: string | null
}

export interface RawPathCheck {
  path: string
  exists: boolean
  is_dir: boolean
  writable: boolean | null
  parent: string
  parent_exists: boolean
  parent_writable: boolean | null
  inside_home: boolean
  git_root: string | null
  git?: RawGit
}

export interface RawLoginPoll {
  state: 'running' | 'exited' | 'gone'
  exit_status?: number | null
  pane_id?: string
  auth_url?: string | null
  success_hint?: boolean
  awaiting_code?: boolean
  screen_tail?: string[]
}
