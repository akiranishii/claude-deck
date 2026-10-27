// Typed IPC contract between the renderer and the main process.
// The renderer can only call these named operations; there is no generic command channel.

import type {
  Account,
  AuthState,
  ClaudeCapabilities,
  ConfigDirInfo,
  ContainerConfig,
  Conversation,
  DeckEvent,
  DeckState,
  DiscoveryCandidate,
  GitInfo,
  Host,
  HostProbe,
  ID,
  PermissionMode,
  Project,
  Runtime,
  RuntimeStatus,
  Settings,
  ShellMode,
  SpawnMode,
  TaskStatus,
} from './types'
import type { OpenPlan, OpenTarget } from './routing'

export interface HostInput {
  displayName: string
  sshAlias: string
  claudePath?: string | null
  shellMode?: ShellMode
  defaultParentDir?: string
  pythonCommand?: string
}

export type HostPatch = Partial<Pick<Host, 'displayName' | 'claudePath' | 'shellMode' | 'defaultParentDir' | 'pythonCommand'>>

export interface ProbeResult {
  probe: HostProbe
  capabilities: ClaudeCapabilities | null
  elapsedMs: number
}

export interface AccountInput {
  displayName: string
  label?: string | null
  configDir: string | null
  color?: string
  chromeProfileDir?: string | null
}

export type AccountPatch = Partial<
  Pick<Account, 'displayName' | 'label' | 'configDir' | 'color' | 'chromeProfileDir' | 'sortOrder' | 'archived'>
>

export interface AuthCheck {
  configDir: string | null
  state: 'ok' | 'missing' | 'unsupported' | 'timeout' | 'error'
  loggedIn: boolean | null
  email: string | null
  orgName: string | null
  subscription: string | null
  authMethod: string | null
  error: string | null
}

export interface ConfigDirWithAuth extends ConfigDirInfo {
  /** null => the default configuration (CLAUDE_CONFIG_DIR unset) */
  configDir: string | null
  auth: AuthCheck | null
  accountId: ID | null
  inUseByServers: number
}

export interface ProjectInput {
  hostId: ID
  displayName: string
  remotePath: string
  taskSummary?: string | null
  taskStatus?: TaskStatus | null
  notes?: string | null
  tags?: string[]
  pinned?: boolean
  parentProjectId?: ID | null
}

export type ProjectPatch = Partial<
  Pick<
    Project,
    'displayName' | 'remotePath' | 'taskSummary' | 'taskStatus' | 'notes' | 'tags' | 'pinned' | 'parentProjectId'
  >
> & { container?: ContainerConfig | null }

export interface DirListing {
  path: string
  parent: string | null
  home: string
  entries: { name: string; isGit: boolean; isSymlink: boolean }[]
  truncated: boolean
  writable: boolean
  gitRoot: string | null
}

export interface PathCheck {
  path: string
  exists: boolean
  isDir: boolean
  writable: boolean | null
  parent: string
  parentExists: boolean
  parentWritable: boolean | null
  insideHome: boolean
  gitRoot: string | null
  git: GitInfo | null
}

export type NewSessionLocation =
  | { kind: 'new-folder'; parent: string; name: string }
  | { kind: 'existing-folder'; path: string }
  | { kind: 'existing-project'; projectId: ID }

export interface NewSessionRequest {
  opId: string
  hostId: ID
  location: NewSessionLocation
  /** When the folder already belongs to a project: add the session to it instead of creating a new project. */
  attachToProjectId?: ID | null
  projectName: string
  taskSummary?: string | null
  tags?: string[]
  accountId: ID
  spawnMode: SpawnMode | null
  permissionMode: PermissionMode | null
  bypassAcknowledged: boolean
  remoteControlName?: string | null
  capacity?: number | null
  launch: boolean
}

export interface NewSessionResult {
  projectId: ID
  runtimeId: ID
  status: RuntimeStatus
  detail: string | null
}

export interface ProgressEvent {
  opId: string
  step: string
  label: string
  state: 'running' | 'done' | 'error' | 'warn' | 'skipped'
  detail?: string | null
}

export interface RuntimeActionResult {
  runtimeId: ID
  status: RuntimeStatus
  detail: string | null
  command?: string | null
}

export interface StopResult {
  state: 'stopped' | 'still_running' | 'not_running' | 'pane_missing'
  detail: string | null
  remainingSessions?: number
}

export interface EndResult {
  state: 'ended' | 'busy' | 'missing'
  busy?: { paneId: string; what: string }[]
  managed?: boolean
}

export interface LaunchPreview {
  command: string
  mode: 'tmux-new' | 'tmux-respawn' | 'type-in-shell'
  note: string | null
  warnings: string[]
  errors: string[]
  resumeSupported: boolean
  resumeRecommended: boolean
  resumeNote: string | null
  accountName: string | null
  configDirLabel: string
}

export interface RuntimePatch {
  /** Paste of a https://claude.ai/code?environment=env_… URL (or null to clear). */
  environmentUrl?: string | null
  accountId?: ID | null
  taskSummary?: string | null
  remoteControlName?: string | null
  spawnMode?: SpawnMode | null
  permissionMode?: PermissionMode | null
  bypassAcknowledged?: boolean
  capacity?: number | null
  createSessionInDir?: boolean | null
  projectId?: ID
  tmuxSessionName?: string
  archived?: boolean
}

export interface LinkConversationInput {
  url: string
  projectId: ID
  runtimeId: ID | null
  title?: string | null
  pinned?: boolean
  source?: 'user' | 'clipboard' | 'chrome-tab'
}

export type ConversationPatch = Partial<Pick<Conversation, 'displayTitle' | 'pinned' | 'runtimeId' | 'projectId' | 'archived'>>

export interface OpenResult {
  opened: boolean
  plan: OpenPlan
}

export interface DiscoveryResult {
  hostId: ID
  scannedAt: string
  candidates: DiscoveryCandidate[]
  configDirs: ConfigDirWithAuth[]
  home: string | null
}

export interface ImportAccountSpec {
  /** null = default config (CLAUDE_CONFIG_DIR unset) */
  configDir: string | null
  displayName: string
  color?: string
  chromeProfileDir?: string | null
}

export interface ImportItem {
  key: string
  projectId?: ID | null
  newProjectName?: string | null
  /** Explicit user choice. Omit to use the account matched from process evidence. */
  accountId?: ID | null
  taskSummary?: string | null
}

export interface ImportRequest {
  hostId: ID
  items: ImportItem[]
  createAccounts?: ImportAccountSpec[]
}

export interface ImportResult {
  projects: number
  runtimes: number
  conversations: number
  accountsCreated: number
  skipped: { key: string; reason: string }[]
}

export interface LoginSession {
  loginId: string
  sessionName: string
  hostId: ID
  accountId: ID
}

export interface LoginStatus {
  state: 'running' | 'exited' | 'gone'
  authUrl: string | null
  awaitingCode: boolean
  successHint: boolean
  screenTail: string[]
  loggedIn: boolean | null
  authState: AuthState | null
}

export interface ExportResult {
  path: string | null
}

export interface ImportDataResult {
  imported: boolean
  counts?: Record<string, number>
}

export type MenuCommand =
  | 'new-session'
  | 'refresh'
  | 'command-palette'
  | 'settings'
  | 'import-sessions'
  | 'toggle-view'
  | 'link-conversation'
  | 'focus-search'

/** Request/response map for every IPC operation. */
export interface DeckApi {
  'state.get': { req: void; res: DeckState }
  'state.refresh': { req: { hostId?: ID } | void; res: void }

  'host.listSshAliases': { req: void; res: string[] }
  'host.probe': { req: { alias: string; claudePath?: string | null; pythonCommand?: string }; res: ProbeResult }
  'host.save': { req: HostInput; res: Host }
  'host.update': { req: { id: ID; patch: HostPatch }; res: Host }
  'host.reprobe': { req: { id: ID }; res: Host }
  'host.remove': { req: { id: ID }; res: void }
  'host.reconnect': { req: { id: ID }; res: void }

  'discovery.scan': { req: { hostId: ID; checkAuth?: boolean }; res: DiscoveryResult }
  'discovery.import': { req: ImportRequest; res: ImportResult }

  'account.create': { req: AccountInput; res: Account }
  'account.update': { req: { id: ID; patch: AccountPatch }; res: Account }
  'account.delete': { req: { id: ID }; res: void }
  'account.checkAuth': { req: { id?: ID }; res: Account[] }
  'account.listConfigDirs': { req: { hostId: ID; checkAuth?: boolean }; res: ConfigDirWithAuth[] }
  'account.createConfigDir': { req: { hostId: ID; path: string }; res: { path: string } }
  'account.confirmProfile': { req: { id: ID; confirmed: boolean }; res: Account }

  'login.start': { req: { accountId: ID; hostId: ID; method?: 'claudeai' | 'console' | 'sso' }; res: LoginSession }
  'login.poll': { req: { loginId: string }; res: LoginStatus }
  'login.openUrl': { req: { loginId: string; url: string; profileDir?: string | null }; res: void }
  'login.openTerminal': { req: { loginId: string }; res: void }
  'login.finish': { req: { loginId: string }; res: Account | null }

  'chrome.profiles': { req: void; res: { profiles: DeckState['chromeProfiles']; error: string | null } }
  'chrome.test': { req: { profileDir: string; url?: string }; res: void }
  'chrome.createProfile': { req: void; res: { profileDir: string } }
  'chrome.activeTabUrl': { req: void; res: { url: string | null; error: string | null } }

  'project.create': { req: ProjectInput; res: Project }
  'project.update': { req: { id: ID; patch: ProjectPatch }; res: Project }
  'project.archive': { req: { id: ID; archived: boolean }; res: Project }
  'project.delete': { req: { id: ID }; res: void }

  'remote.listDir': { req: { hostId: ID; path: string; showHidden?: boolean }; res: DirListing }
  'remote.checkPath': { req: { hostId: ID; path: string }; res: PathCheck }

  'session.create': { req: NewSessionRequest; res: NewSessionResult }

  'runtime.start': { req: { id: ID; resume?: boolean; acknowledgeImportedShell?: boolean }; res: RuntimeActionResult }
  'runtime.stop': { req: { id: ID; mode: 'interrupt' | 'terminate' | 'kill' }; res: StopResult }
  'runtime.restart': { req: { id: ID; resume?: boolean; acknowledgeImportedShell?: boolean }; res: RuntimeActionResult }
  'runtime.end': { req: { id: ID; force?: boolean; allowUnmanaged?: boolean }; res: EndResult }
  'runtime.update': { req: { id: ID; patch: RuntimePatch }; res: Runtime }
  'runtime.remove': { req: { id: ID }; res: void }
  'runtime.capture': { req: { id: ID; lines?: number }; res: { lines: string[] } }
  'runtime.launchPreview': { req: { id: ID; resume?: boolean; restart?: boolean }; res: LaunchPreview }

  'conversation.link': { req: LinkConversationInput; res: Conversation }
  'conversation.update': { req: { id: ID; patch: ConversationPatch }; res: Conversation }
  'conversation.remove': { req: { id: ID }; res: void }

  'open.plan': { req: { runtimeId?: ID; conversationId?: ID; accountId?: ID; target?: OpenTarget }; res: OpenPlan }
  'open.claude': { req: { runtimeId?: ID; conversationId?: ID; accountId?: ID; target?: OpenTarget; acknowledge?: boolean }; res: OpenResult }
  'open.terminal': { req: { runtimeId: ID }; res: void }
  'open.containerTerminal': { req: { projectId: ID }; res: void }
  'open.external': { req: { url: string }; res: void }

  'clipboard.readUrl': { req: void; res: { url: string | null; text: string | null } }
  'clipboard.write': { req: { text: string }; res: void }

  'settings.update': { req: Partial<Settings>; res: Settings }
  'data.export': { req: void; res: ExportResult }
  'data.import': { req: void; res: ImportDataResult }
  'events.list': { req: { runtimeId?: ID; projectId?: ID; limit?: number }; res: DeckEvent[] }
  'extension.pairing': { req: { accountId: ID }; res: { code: string; port: number; profileDir: string | null } }
  'extension.dismissInbox': { req: { remoteSessionId: string }; res: void }
}

export type DeckChannel = keyof DeckApi

export interface DeckEvents {
  state: DeckState
  progress: ProgressEvent
  menu: { command: MenuCommand }
  toast: { level: 'info' | 'success' | 'warn' | 'error'; message: string }
  /** The tray asked to open a session that needs a confirmation dialog first. */
  'open-request': { runtimeId: ID }
  /** A notification was clicked. */
  'focus-runtime': { runtimeId: ID }
}

export interface IpcOk<T> {
  ok: true
  value: T
}
export interface IpcErr {
  ok: false
  error: { code: string; message: string }
}
export type IpcEnvelope<T> = IpcOk<T> | IpcErr

/** Shape exposed on window.deck by the preload script. */
export interface DeckBridge {
  invoke<K extends DeckChannel>(channel: K, req: DeckApi[K]['req']): Promise<IpcEnvelope<DeckApi[K]['res']>>
  on<E extends keyof DeckEvents>(event: E, listener: (payload: DeckEvents[E]) => void): () => void
  platform: string
}
