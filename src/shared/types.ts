// Domain model shared by the Electron main process and the renderer.
// Everything here is plain data: it crosses the IPC boundary as structured clones.

export type ID = string

// ----------------------------------------------------------------------------- hosts

export type HostConnStatus = 'unknown' | 'connecting' | 'online' | 'offline' | 'auth_failed' | 'error'
export type ShellMode = 'interactive-login' | 'login' | 'direct'

export interface ClaudeCandidate {
  path: string
  realpath: string
  version: string | null
  sources: string[]
  error?: string | null
}

export interface ClaudeCapabilities {
  claudePath: string
  version: string | null
  rcSupported: boolean
  flags: string[]
  spawnModes: string[]
  permissionModes: string[]
  supportsName: boolean
  supportsSpawn: boolean
  supportsPermissionMode: boolean
  supportsContinue: boolean
  supportsSessionId: boolean
  supportsCapacity: boolean
  supportsCreateSessionInDir: boolean
  supportsChrome: boolean
  authStatusSupported: boolean
  authLoginSupported: boolean
  detectedAt: string
}

export interface ConfigDirInfo {
  path: string
  name: string
  isDefaultDir: boolean
  hasCredentials: boolean
  hasProjects: boolean
  mtime: number | null
}

export interface HostProbe {
  hostname: string
  user: string
  uid: number
  home: string
  loginShell: string
  os: string | null
  kernel: string
  arch: string
  python: string
  helperVersion: string
  tmuxVersion: string | null
  gitVersion: string | null
  docker: { path: string | null; accessible?: boolean; version?: string | null; error?: string | null }
  projectsDirExists: boolean
  claudeCandidates: ClaudeCandidate[]
  claudeRecommended: string | null
  configDirs: ConfigDirInfo[]
  probedAt: string
}

export interface Host {
  id: ID
  displayName: string
  sshAlias: string
  remoteUser: string | null
  homePath: string | null
  hostname: string | null
  claudePath: string | null
  pythonCommand: string
  shellMode: ShellMode
  defaultParentDir: string
  capabilities: ClaudeCapabilities | null
  probe: HostProbe | null
  lastConnectionStatus: HostConnStatus
  lastConnectionError: string | null
  lastConnectedAt: string | null
  createdAt: string
  updatedAt: string
}

// -------------------------------------------------------------------------- accounts

export type AuthState = 'unknown' | 'authenticated' | 'logged_out' | 'missing_dir' | 'error'

export interface Account {
  id: ID
  displayName: string
  /** Optional e-mail or descriptive label chosen by the user. */
  label: string | null
  /** Remote CLAUDE_CONFIG_DIR. null = default account (variable unset, uses ~/.claude). */
  configDir: string | null
  color: string
  chromeProfileDir: string | null
  chromeProfileName: string | null
  chromeProfileConfirmedAt: string | null
  authState: AuthState
  authEmail: string | null
  authPlan: string | null
  authOrg: string | null
  authMethod: string | null
  authError: string | null
  authCheckedAt: string | null
  lastAuthOkAt: string | null
  sortOrder: number
  archived: boolean
  createdAt: string
  updatedAt: string
}

// -------------------------------------------------------------------------- projects

export type TaskStatus = 'planned' | 'in_progress' | 'blocked' | 'completed'

export interface GitInfo {
  isRepo: boolean
  root?: string | null
  branch?: string | null
  detached?: boolean
  head?: string | null
  isWorktree?: boolean
  dirtyCount?: number | null
  ahead?: number
  behind?: number
  lastCommit?: { hash: string; subject: string; time: number | null } | null
  checkedAt: string
}

export interface ContainerConfig {
  enabled: boolean
  /** devcontainer = find by the devcontainer.local_folder label (survives container recreation). */
  matchBy: 'devcontainer' | 'name'
  name: string | null
  hostPath: string | null
  containerPath: string | null
  user: string | null
  shell: string | null
  commandRunner: string | null
}

export interface ContainerState {
  found: boolean
  id?: string | null
  name?: string | null
  state?: string | null
  status?: string | null
  image?: string | null
  remoteUser?: string | null
  workspaceMount?: { source: string; destination: string } | null
  checkedAt: string
  error?: string | null
}

export interface Project {
  id: ID
  hostId: ID
  displayName: string
  remotePath: string
  repositoryRoot: string | null
  isWorktree: boolean
  parentProjectId: ID | null
  taskSummary: string | null
  taskStatus: TaskStatus | null
  notes: string | null
  tags: string[]
  pinned: boolean
  archived: boolean
  lastActiveAt: string | null
  git: GitInfo | null
  pathStatus: 'ok' | 'missing' | 'unknown'
  pathCheckedAt: string | null
  container: ContainerConfig | null
  containerState: ContainerState | null
  createdAt: string
  updatedAt: string
}

// -------------------------------------------------------------------------- runtimes

export type SpawnMode = 'same-dir' | 'worktree' | 'session'
export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'dontAsk' | 'plan'

export type RuntimeStatus =
  | 'unknown'
  | 'starting'
  | 'connected'
  | 'running'
  | 'reconnecting'
  | 'needs_input'
  | 'auth_required'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'missing'

/** How we know which Claude account a runtime uses. */
export type AccountEvidence = 'process-env' | 'launched' | 'user'

export interface ObservedConfigDir {
  state: 'env' | 'default' | 'unknown'
  value: string | null
}

export interface ObservedFlags {
  name?: string | null
  spawn?: string | null
  permissionMode?: string | null
  capacity?: number | null
  continue?: boolean
  liveSpawnNote?: string | null
}

export interface Runtime {
  id: ID
  projectId: ID
  accountId: ID | null
  accountConfirmed: boolean
  accountEvidence: AccountEvidence | null
  observedConfigDir: ObservedConfigDir | null
  tmuxSessionName: string
  tmuxSessionId: string | null
  tmuxPaneId: string | null
  /** true when Claude Deck created the tmux session (marker @cdeck_runtime is set). */
  managed: boolean
  importedExisting: boolean
  remoteControlName: string | null
  spawnMode: SpawnMode | null
  permissionMode: PermissionMode | null
  capacity: number | null
  createSessionInDir: boolean | null
  observedFlags: ObservedFlags | null
  taskSummary: string | null
  environmentId: string | null
  observedStatus: RuntimeStatus
  statusDetail: string | null
  statusEvidence: string[]
  serverPid: number | null
  serverStart: string | null
  serverStartedAt: string | null
  lastStartedAt: string | null
  lastStoppedAt: string | null
  lastSeenAt: string | null
  lastConnectedAt: string | null
  lastExitStatus: number | null
  lastLaunchCommand: string | null
  activeConversations: number
  archived: boolean
  createdAt: string
  updatedAt: string
}

// --------------------------------------------------------------------- conversations

export type ConversationSource = 'claude-metadata' | 'pane-output' | 'user' | 'clipboard' | 'chrome-tab' | 'extension'

export interface Conversation {
  id: ID
  projectId: ID
  runtimeId: ID | null
  /** e.g. session_01Xy3ExampleSess10nIdAbc */
  remoteSessionId: string
  /** e.g. https://claude.ai/code/session_01Xy3ExampleSess10nIdAbc */
  url: string
  displayTitle: string | null
  autoTitle: string | null
  source: ConversationSource
  pinned: boolean
  /** A Claude process for this conversation was observed running at the last refresh. */
  live: boolean
  claudeStatus: string | null
  model: string | null
  lastSeenAt: string | null
  lastOpenedAt: string | null
  archived: boolean
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------- events

export interface DeckEvent {
  id: number
  timestamp: string
  level: 'info' | 'warn' | 'error'
  type: string
  summary: string
  hostId: ID | null
  projectId: ID | null
  runtimeId: ID | null
}

// -------------------------------------------------------------------------- settings

export type ThemePref = 'system' | 'light' | 'dark'
export type BrowserKind = 'chrome' | 'chrome-beta' | 'chrome-canary' | 'chromium' | 'brave' | 'edge'
export type TerminalApp = 'terminal' | 'iterm'

export interface BrowserSettings {
  kind: BrowserKind
  appPath: string
  userDataDir: string
}

export interface StatusPatterns {
  connected: string[]
  disconnected: string[]
  authRequired: string[]
  needsInput: string[]
  error: string[]
}

export interface Settings {
  theme: ThemePref
  viewMode: 'cards' | 'list'
  refreshIntervalSec: number
  gitRefreshIntervalSec: number
  authCheckIntervalMin: number
  startupGraceSec: number
  stopTimeoutSec: number
  browser: BrowserSettings
  terminalApp: TerminalApp
  notifications: boolean
  trayEnabled: boolean
  onboardingComplete: boolean
  statusPatterns: StatusPatterns
  extensionEnabled: boolean
  extensionPort: number
}

// ------------------------------------------------------------------------ live state

export interface HostLive {
  hostId: ID
  reachable: boolean | null
  refreshing: boolean
  lastSnapshotAt: string | null
  snapshotMs: number | null
  error: string | null
  errorKind: string | null
  tmuxRunning: boolean | null
  untracked: DiscoveryCandidate[]
}

export interface RuntimeLive {
  runtimeId: ID
  observedAt: string
  screenTail: string[]
  statusLine: string | null
  lastLog: string | null
  capacity: { used: number; max: number; note: string } | null
  httpsConnections: number | null
  foreground: string | null
  promptText: string | null
}

export interface ChromeProfile {
  directory: string
  name: string
  email: string | null
  gaiaName: string | null
  isManaged: boolean
  avatarColor: string | null
  lastActive: number | null
  isLastUsed: boolean
}

export interface DeckState {
  hosts: Host[]
  accounts: Account[]
  projects: Project[]
  runtimes: Runtime[]
  conversations: Conversation[]
  settings: Settings
  live: { hosts: Record<ID, HostLive>; runtimes: Record<ID, RuntimeLive> }
  chromeProfiles: ChromeProfile[]
  chromeError: string | null
  recentEvents: DeckEvent[]
  appVersion: string
  extension: {
    running: boolean
    port: number | null
    pairedProfiles: string[]
    inbox?: { remoteSessionId: string; url: string; title: string | null; accountId: string; seenAt: string }[]
  }
}

// ------------------------------------------------------------------------- discovery

export type CandidateKind = 'rc-server' | 'interactive-rc' | 'interactive' | 'shell' | 'other' | 'dead'

export interface DiscoveryCandidate {
  key: string
  hostId: ID
  tmuxSessionName: string
  tmuxSessionId: string
  paneId: string
  windowIndex: number
  paneIndex: number
  cwd: string | null
  kind: CandidateKind
  foreground: string | null
  serverPid: number | null
  serverStart: string | null
  serverStartedAt: string | null
  flags: ObservedFlags | null
  configDir: ObservedConfigDir
  matchedAccountId: ID | null
  environmentId: string | null
  conversations: { remoteSessionId: string; name: string | null; status: string | null; model: string | null }[]
  statusWord: string | null
  connected: boolean | null
  managedMarker: string | null
  trackedRuntimeId: ID | null
  suggestedProjectId: ID | null
  suggestedProjectName: string
  attached: boolean
}
