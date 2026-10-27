import type { BrowserKind, PermissionMode, RuntimeStatus, Settings, SpawnMode, StatusPatterns, TaskStatus } from './types'

/** Distinct, slightly desaturated account colours that read well in light and dark mode. */
export const ACCOUNT_COLORS = [
  '#6E7FD8', // indigo
  '#3FA796', // teal
  '#D39B3A', // amber
  '#D06A84', // rose
  '#9A72D0', // violet
  '#4B9BD1', // sky
  '#8FA548', // olive
  '#DD7A5C', // coral
  '#7A8699', // slate
] as const

export type StatusTone = 'ok' | 'info' | 'progress' | 'warn' | 'danger' | 'muted' | 'offline'

export interface StatusMeta {
  label: string
  short: string
  tone: StatusTone
  description: string
  running: boolean
  pulse?: boolean
}

export const STATUS_META: Record<RuntimeStatus | 'host_unreachable', StatusMeta> = {
  unknown: { label: 'Not observed yet', short: 'Unknown', tone: 'muted', running: false, description: 'Claude Deck has not observed this runtime yet.' },
  starting: { label: 'Starting', short: 'Starting', tone: 'progress', running: true, pulse: true, description: 'Remote Control was launched and is starting up.' },
  connected: { label: 'Connected', short: 'Connected', tone: 'ok', running: true, description: 'Remote Control is running and has a confirmed live connection.' },
  running: { label: 'Running · connection unknown', short: 'Running', tone: 'info', running: true, description: 'The process is running but its connection could not be confirmed.' },
  reconnecting: { label: 'Reconnecting', short: 'Reconnecting', tone: 'warn', running: true, pulse: true, description: 'The process is running but reports it is disconnected or reconnecting.' },
  needs_input: { label: 'Needs input in terminal', short: 'Needs input', tone: 'warn', running: true, description: 'Claude is waiting for an answer in the tmux terminal (for example a folder-trust prompt).' },
  auth_required: { label: 'Authentication required', short: 'Sign-in needed', tone: 'danger', running: false, description: 'Claude reported that this account is not signed in or its login expired.' },
  stopping: { label: 'Stopping', short: 'Stopping', tone: 'progress', running: true, pulse: true, description: 'A stop request is in progress.' },
  stopped: { label: 'Stopped', short: 'Stopped', tone: 'muted', running: false, description: 'Remote Control is not running.' },
  failed: { label: 'Startup failed', short: 'Failed', tone: 'danger', running: false, description: 'Remote Control exited during startup.' },
  missing: { label: 'tmux session not found', short: 'Not found', tone: 'muted', running: false, description: 'The tmux session no longer exists on the VM. The record is kept until you remove it.' },
  host_unreachable: { label: 'VM unreachable', short: 'VM offline', tone: 'offline', running: false, description: 'The VM could not be reached over SSH. The last known state is shown greyed out.' },
}

export const RUNNING_STATUSES: RuntimeStatus[] = ['starting', 'connected', 'running', 'reconnecting', 'needs_input', 'stopping']

export const STATUS_FILTER_GROUPS: { id: string; label: string; statuses: (RuntimeStatus | 'host_unreachable')[] }[] = [
  { id: 'connected', label: 'Connected', statuses: ['connected'] },
  { id: 'running', label: 'Running (unconfirmed)', statuses: ['running', 'reconnecting', 'starting', 'stopping'] },
  { id: 'attention', label: 'Needs attention', statuses: ['needs_input', 'auth_required', 'failed'] },
  { id: 'stopped', label: 'Stopped', statuses: ['stopped', 'missing', 'unknown'] },
  { id: 'offline', label: 'VM unreachable', statuses: ['host_unreachable'] },
]

export interface PermissionModeMeta {
  label: string
  description: string
  risk: 'low' | 'medium' | 'high'
}

export const PERMISSION_MODE_META: Record<PermissionMode, PermissionModeMeta> = {
  default: { label: 'Default (ask)', description: 'Claude asks before running commands or editing files.', risk: 'low' },
  plan: { label: 'Plan', description: 'Read-only planning; Claude proposes changes without making them.', risk: 'low' },
  acceptEdits: { label: 'Accept edits', description: 'File edits are accepted automatically; commands still ask.', risk: 'medium' },
  auto: { label: 'Auto', description: 'A classifier approves routine actions and asks for risky ones.', risk: 'medium' },
  dontAsk: { label: "Don't ask", description: 'Anything not pre-approved is denied instead of prompting.', risk: 'medium' },
  bypassPermissions: {
    label: 'Bypass permissions',
    description: 'Claude runs commands and edits files without any approval prompts.',
    risk: 'high',
  },
}

export const SPAWN_MODE_META: Record<SpawnMode, { label: string; description: string }> = {
  'same-dir': { label: 'Same directory', description: 'All conversations share the project folder. Simplest, but parallel edits can conflict.' },
  worktree: { label: 'Worktree per conversation', description: 'Each new conversation gets its own git worktree. Safest for parallel work (git repos only).' },
  session: { label: 'Single session', description: 'Classic single-conversation mode; the server exits when that conversation ends.' },
}

export const TASK_STATUS_META: Record<TaskStatus, { label: string; tone: StatusTone }> = {
  planned: { label: 'Planned', tone: 'muted' },
  in_progress: { label: 'In progress', tone: 'info' },
  blocked: { label: 'Blocked', tone: 'danger' },
  completed: { label: 'Completed', tone: 'ok' },
}

export const BROWSER_PRESETS: Record<BrowserKind, { label: string; appPath: string; userDataDir: string }> = {
  chrome: { label: 'Google Chrome', appPath: '/Applications/Google Chrome.app', userDataDir: '~/Library/Application Support/Google/Chrome' },
  'chrome-beta': { label: 'Google Chrome Beta', appPath: '/Applications/Google Chrome Beta.app', userDataDir: '~/Library/Application Support/Google/Chrome Beta' },
  'chrome-canary': { label: 'Google Chrome Canary', appPath: '/Applications/Google Chrome Canary.app', userDataDir: '~/Library/Application Support/Google/Chrome Canary' },
  chromium: { label: 'Chromium', appPath: '/Applications/Chromium.app', userDataDir: '~/Library/Application Support/Chromium' },
  brave: { label: 'Brave Browser', appPath: '/Applications/Brave Browser.app', userDataDir: '~/Library/Application Support/BraveSoftware/Brave-Browser' },
  edge: { label: 'Microsoft Edge', appPath: '/Applications/Microsoft Edge.app', userDataDir: '~/Library/Application Support/Microsoft Edge' },
}

/**
 * Patterns are matched against sanitised terminal output. They are deliberately editable in
 * Settings because Claude Code's terminal UI may change between releases.
 */
export const DEFAULT_STATUS_PATTERNS: StatusPatterns = {
  connected: ['^Connected\\b', '\\bReconnected after\\b'],
  disconnected: ['\\bReconnecting\\b', '\\bConnecting\\b', '\\bDisconnected\\b', '\\bConnection lost\\b', '\\bOffline\\b', '\\bWaiting for network\\b'],
  authRequired: [
    '\\bnot logged in\\b',
    'please run /login',
    '\\bclaude (?:auth )?login\\b',
    'OAuth token (?:has )?expired',
    '\\bauthentication[_ ]error\\b',
    '\\bInvalid API key\\b',
    '\\bmust be logged in\\b',
    'requires a Claude (?:account|subscription)',
    '\\bsession expired\\b.*\\blog ?in\\b',
  ],
  needsInput: [
    '\\[y/N\\]\\s*$',
    '\\[Y/n\\]\\s*$',
    '\\(y/n\\)\\s*$',
    'Do you trust the files in this folder',
    '^\\s*(?:❯|>)\\s*1\\.',
    'Enter to confirm',
    'Press Enter to continue',
  ],
  error: ['^Error:', '\\bfailed to (?:start|connect|register|create)\\b', '\\bECONNREFUSED\\b', '\\bENOTFOUND\\b', '\\bfatal\\b'],
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  viewMode: 'cards',
  refreshIntervalSec: 15,
  gitRefreshIntervalSec: 60,
  authCheckIntervalMin: 30,
  startupGraceSec: 60,
  stopTimeoutSec: 15,
  browser: { kind: 'chrome', ...pickBrowser('chrome') },
  terminalApp: 'terminal',
  notifications: true,
  trayEnabled: true,
  onboardingComplete: false,
  statusPatterns: DEFAULT_STATUS_PATTERNS,
  extensionEnabled: false,
  extensionPort: 47821,
}

function pickBrowser(kind: BrowserKind): { appPath: string; userDataDir: string } {
  const p = BROWSER_PRESETS[kind]
  return { appPath: p.appPath, userDataDir: p.userDataDir }
}

export const DEFAULT_PARENT_DIR = '~/projects'
export const CLAUDE_HOME_URL = 'https://claude.ai/code'
export const STARTUP_POLL_MS = 1500
