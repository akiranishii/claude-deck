// Fixtures modelled on a real `snapshot` from the VM (IDs and e-mails replaced).

import type { Account, ChromeProfile, Conversation, Project, Runtime, Settings } from '../../src/shared/types'
import { DEFAULT_SETTINGS } from '../../src/shared/constants'
import type { RawConversation, RawPane, RawServer, RawSession, RawSnapshot } from '../../src/main/ssh/helperTypes'

export const HOME = '/home/dev'
export const NOW = Date.parse('2026-10-22T20:00:00Z')
export const ISO = new Date(NOW).toISOString()

export function settings(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch }
}

export function account(id: string, configDir: string | null, patch: Partial<Account> = {}): Account {
  return {
    id,
    displayName: id,
    label: null,
    configDir,
    color: '#6E7FD8',
    chromeProfileDir: null,
    chromeProfileName: null,
    chromeProfileConfirmedAt: null,
    authState: 'authenticated',
    authEmail: `${id}@example.com`,
    authPlan: 'max',
    authOrg: null,
    authMethod: 'claude.ai',
    authError: null,
    authCheckedAt: ISO,
    lastAuthOkAt: ISO,
    sortOrder: 0,
    archived: false,
    createdAt: ISO,
    updatedAt: ISO,
    ...patch,
  }
}

export function project(id: string, remotePath: string, patch: Partial<Project> = {}): Project {
  return {
    id,
    hostId: 'host_1',
    displayName: id,
    remotePath,
    repositoryRoot: null,
    isWorktree: false,
    parentProjectId: null,
    taskSummary: null,
    taskStatus: null,
    notes: null,
    tags: [],
    pinned: false,
    archived: false,
    lastActiveAt: null,
    git: null,
    pathStatus: 'ok',
    pathCheckedAt: null,
    container: null,
    containerState: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...patch,
  }
}

export function runtime(id: string, projectId: string, tmuxSessionName: string, patch: Partial<Runtime> = {}): Runtime {
  return {
    id,
    projectId,
    accountId: null,
    accountConfirmed: false,
    accountEvidence: null,
    observedConfigDir: null,
    tmuxSessionName,
    tmuxSessionId: null,
    tmuxPaneId: null,
    managed: false,
    importedExisting: true,
    remoteControlName: null,
    spawnMode: null,
    permissionMode: null,
    capacity: null,
    createSessionInDir: null,
    observedFlags: null,
    taskSummary: null,
    environmentId: null,
    observedStatus: 'unknown',
    statusDetail: null,
    statusEvidence: [],
    serverPid: null,
    serverStart: null,
    serverStartedAt: null,
    lastStartedAt: null,
    lastStoppedAt: null,
    lastSeenAt: null,
    lastConnectedAt: null,
    lastExitStatus: null,
    lastLaunchCommand: null,
    activeConversations: 0,
    archived: false,
    createdAt: ISO,
    updatedAt: ISO,
    ...patch,
  }
}

export function conversation(id: string, runtimeId: string | null, projectId: string, sid: string, patch: Partial<Conversation> = {}): Conversation {
  return {
    id,
    projectId,
    runtimeId,
    remoteSessionId: sid,
    url: `https://claude.ai/code/${sid}`,
    displayTitle: null,
    autoTitle: null,
    source: 'claude-metadata',
    pinned: false,
    live: false,
    claudeStatus: null,
    model: null,
    lastSeenAt: null,
    lastOpenedAt: null,
    archived: false,
    createdAt: ISO,
    updatedAt: ISO,
    ...patch,
  }
}

export function profile(directory: string, name: string, email: string | null = null): ChromeProfile {
  return { directory, name, email, gaiaName: null, isManaged: false, avatarColor: null, lastActive: null, isLastUsed: false }
}

export function session(id: string, name: string, patch: Partial<RawSession> = {}): RawSession {
  return { session_id: id, name, windows: 1, attached: 0, created: 1, activity: 1, runtime_marker: null, managed: false, login: false, ...patch }
}

export const CONNECTED_SCREEN = [
  '[QR code]',
  '·✔︎· Connected · my_project · master',
  '    Capacity: 1/32 · New sessions will be created in the current directory',
  'Continue coding in the Claude mobile app or https://claude.ai/code?environment=env_01AAAAAAAAAAAAAAAAAAAAAA',
  'space to show QR code · w to toggle spawn mode',
]

export function pane(paneId: string, sessionId: string, sessionName: string, patch: Partial<RawPane> = {}): RawPane {
  return {
    session_id: sessionId,
    session_name: sessionName,
    window_id: `@${paneId.slice(1)}`,
    window_index: 0,
    window_name: 'claude',
    pane_id: paneId,
    pane_index: 0,
    pane_pid: 1000 + Number(paneId.slice(1)),
    current_command: 'claude',
    cwd: `${HOME}/proj`,
    dead: false,
    dead_status: null,
    width: 80,
    height: 24,
    active: true,
    foreground: { kind: 'claude', claude_kind: 'rc-server', pid: 2000 },
    rc_server_pids: [],
    other_claude: [],
    capture: {
      status_line: '·✔︎· Connected · my_project · master',
      state_word: 'Connected',
      capacity: { used: 1, max: 32, note: 'New sessions will be created in the current directory' },
      last_log: null,
      env_ids: ['env_01AAAAAAAAAAAAAAAAAAAAAA'],
      session_ids: [],
      screen_tail: CONNECTED_SCREEN,
    },
    ...patch,
  }
}

export function conv(pid: number, sid: string, patch: Partial<RawConversation> = {}): RawConversation {
  return {
    pid,
    start: String(pid * 10),
    started_at: 1792000000,
    cse_id: sid.replace('session_', 'cse_'),
    model: 'claude-opus-5-5',
    permission_mode: 'bypassPermissions',
    meta: { bridgeSessionId: sid, name: `conv-${pid}`, status: 'idle', statusUpdatedAt: NOW - 60_000, updatedAt: NOW - 60_000 },
    ...patch,
  }
}

export function server(pid: number, paneId: string | null, configDir: string | null | 'unknown', patch: Partial<RawServer> = {}): RawServer {
  return {
    pid,
    start: String(pid * 10),
    started_at: 1792000000,
    kind: 'rc-server',
    flags: { name: `GCP ${pid}`, spawn: 'same-dir', permission_mode: 'bypassPermissions', capacity: null, continue: false },
    config_dir: configDir === 'unknown' ? { state: 'unknown', value: null } : configDir === null ? { state: 'default', value: null } : { state: 'env', value: configDir },
    runtime_marker: null,
    exe: '/home/dev/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
    cwd: `${HOME}/proj`,
    pane_id: paneId,
    conversations: [],
    pointer: { environment_id: 'env_01AAAAAAAAAAAAAAAAAAAAAA', session_id: null, source: 'standalone' },
    tcp: { established: 1, https: 1 },
    ...patch,
  }
}

export function snapshot(patch: Partial<RawSnapshot> = {}): RawSnapshot {
  return { time: NOW / 1000, boot_time: 1, tmux_running: true, sessions: [], panes: [], servers: [], paths: {}, git: {}, elapsed_ms: 10, ...patch }
}
