// Discovery & reconciliation: account evidence, URL association, non-destructive behaviour.

import { describe, expect, it } from 'vitest'
import { reconcile, type ReconcileInput } from '../../src/main/services/reconcile'
import { buildCandidates, matchRuntimes } from '../../src/main/services/matching'
import { account, conv, conversation, HOME, NOW, pane, project, runtime, server, session, settings, snapshot } from './fixtures'

const A2 = `${HOME}/.claude-account2`
const A3 = `${HOME}/.claude-account3`

function baseSnapshot() {
  return snapshot({
    sessions: [session('$0', 'claude'), session('$3', 'claude-account2'), session('$4', 'claude-account3'), session('$9', 'research')],
    panes: [
      pane('%0', '$0', 'claude', { cwd: `${HOME}/myproj` }),
      pane('%3', '$3', 'claude-account2', { cwd: `${HOME}/proj` }),
      pane('%4', '$4', 'claude-account3', { cwd: `${HOME}/proj` }),
      pane('%9', '$9', 'research', { foreground: { kind: 'shell-idle', comm: 'bash', children: 0 }, capture: null }),
    ],
    servers: [
      server(100, '%0', null, { cwd: `${HOME}/myproj`, conversations: [conv(101, 'session_01MAINMAINMAINMAINMAINMA')] }),
      server(300, '%3', A2, { conversations: [conv(301, 'session_01Xy3ExampleSess10nIdAbc'), conv(302, 'session_01SECONDSECONDSECONDSEC')] }),
      server(400, '%4', 'unknown'),
    ],
  })
}

function input(patch: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    now: NOW,
    hostId: 'host_1',
    home: HOME,
    projects: [project('p_myproj', `${HOME}/myproj`), project('p_proj', `${HOME}/proj`)],
    runtimes: [],
    accounts: [account('main', null), account('acct2', A2), account('acct3', A3)],
    conversations: [],
    snapshot: baseSnapshot(),
    settings: settings(),
    launchedAt: new Map(),
    stopping: new Set(),
    ...patch,
  }
}

describe('buildCandidates (import discovery)', () => {
  const cands = buildCandidates(baseSnapshot(), { hostId: 'host_1', home: HOME, accounts: input().accounts, runtimes: [], projects: input().projects })

  it('identifies accounts only from the process environment', () => {
    expect(cands.find((c) => c.tmuxSessionName === 'claude')?.matchedAccountId).toBe('main')
    expect(cands.find((c) => c.tmuxSessionName === 'claude-account2')?.matchedAccountId).toBe('acct2')
  })

  it('never infers an account from the tmux session name', () => {
    const c = cands.find((x) => x.tmuxSessionName === 'claude-account3')!
    expect(c.configDir.state).toBe('unknown')
    expect(c.matchedAccountId).toBeNull()
  })

  it('records exact conversation ids from Claude’s own metadata', () => {
    const c = cands.find((x) => x.tmuxSessionName === 'claude-account2')!
    expect(c.conversations.map((x) => x.remoteSessionId)).toEqual(['session_01Xy3ExampleSess10nIdAbc', 'session_01SECONDSECONDSECONDSEC'])
    expect(c.environmentId).toBe('env_01AAAAAAAAAAAAAAAAAAAAAA')
  })

  it('classifies plain shells separately from Remote Control servers', () => {
    expect(cands.find((x) => x.tmuxSessionName === 'research')?.kind).toBe('shell')
    expect(cands.find((x) => x.tmuxSessionName === 'claude')?.kind).toBe('rc-server')
  })
})

describe('matchRuntimes', () => {
  it('distinguishes similarly named sessions exactly', () => {
    const snap = snapshot({ sessions: [session('$1', 'claude2'), session('$2', 'claude')], panes: [pane('%1', '$1', 'claude2'), pane('%2', '$2', 'claude')] })
    const m = matchRuntimes(snap, [runtime('r', 'p', 'claude')])
    expect(m.get('r')?.pane?.pane_id).toBe('%2')
  })

  it('follows a renamed managed session through its Claude Deck marker', () => {
    const snap = snapshot({ sessions: [session('$5', 'renamed', { runtime_marker: 'rt_managed' })], panes: [pane('%5', '$5', 'renamed')] })
    const m = matchRuntimes(snap, [runtime('rt_managed', 'p', 'cd-old-name', { managed: true })])
    expect(m.get('rt_managed')?.session?.name).toBe('renamed')
  })

  it('does not claim a session that belongs to another runtime', () => {
    const snap = snapshot({ sessions: [session('$5', 'cd-x', { runtime_marker: 'rt_other' })], panes: [pane('%5', '$5', 'cd-x')] })
    expect(matchRuntimes(snap, [runtime('rt_me', 'p', 'cd-x')]).get('rt_me')?.session).toBeNull()
  })
})

describe('reconcile', () => {
  it('marks connected runtimes, captures links and assigns accounts from evidence', () => {
    const rt = runtime('rt2', 'p_proj', 'claude-account2')
    const out = reconcile(input({ runtimes: [rt] }))
    const patch = out.runtimePatches.get('rt2')!
    expect(patch.observedStatus).toBe('connected')
    expect(patch.accountId).toBe('acct2')
    expect(patch.accountEvidence).toBe('process-env')
    expect(patch.environmentId).toBe('env_01AAAAAAAAAAAAAAAAAAAAAA')
    expect(patch.activeConversations).toBe(2)
    const urls = out.newConversations.map((c) => c.url)
    expect(urls).toEqual(['https://claude.ai/code/session_01Xy3ExampleSess10nIdAbc', 'https://claude.ai/code/session_01SECONDSECONDSECONDSEC'])
    expect(out.newConversations.every((c) => c.runtimeId === 'rt2' && c.projectId === 'p_proj' && c.live)).toBe(true)
  })

  it('keeps several conversations per runtime and updates existing links instead of duplicating', () => {
    const existing = conversation('c1', 'rt2', 'p_proj', 'session_01Xy3ExampleSess10nIdAbc', { displayTitle: 'My title' })
    const out = reconcile(input({ runtimes: [runtime('rt2', 'p_proj', 'claude-account2', { accountId: 'acct2', accountConfirmed: true })], conversations: [existing] }))
    expect(out.newConversations.map((c) => c.remoteSessionId)).toEqual(['session_01SECONDSECONDSECONDSEC'])
    expect(out.conversationPatches.get('c1')).toMatchObject({ live: true, autoTitle: 'conv-301' })
    expect(out.conversationPatches.get('c1')?.displayTitle).toBeUndefined()
  })

  it('flags (but never silently changes) a contradicting account mapping', () => {
    const rt = runtime('rt2', 'p_proj', 'claude-account2', { accountId: 'acct3', accountConfirmed: true, accountEvidence: 'user' })
    const out = reconcile(input({ runtimes: [rt] }))
    const patch = out.runtimePatches.get('rt2')!
    expect(patch.accountId).toBeUndefined()
    expect(patch.accountConfirmed).toBe(false)
    expect(out.events.some((e) => e.type === 'account.conflict')).toBe(true)
  })

  it('leaves the account unconfirmed when the environment cannot be read', () => {
    const out = reconcile(input({ runtimes: [runtime('rt3', 'p_proj', 'claude-account3')] }))
    expect(out.runtimePatches.get('rt3')?.accountId).toBeUndefined()
  })

  it('reports a vanished tmux session as missing and deletes nothing', () => {
    const snap = baseSnapshot()
    snap.sessions = snap.sessions.filter((s) => s.name !== 'claude-account2')
    snap.panes = snap.panes.filter((p) => p.session_name !== 'claude-account2')
    snap.servers = snap.servers.filter((s) => s.pane_id !== '%3')
    const live = conversation('c1', 'rt2', 'p_proj', 'session_01Xy3ExampleSess10nIdAbc', { live: true })
    const out = reconcile(input({ snapshot: snap, runtimes: [runtime('rt2', 'p_proj', 'claude-account2', { observedStatus: 'connected' })], conversations: [live] }))
    expect(out.runtimePatches.get('rt2')?.observedStatus).toBe('missing')
    expect(out.conversationPatches.get('c1')).toMatchObject({ live: false })
    expect(out.notifications.length).toBe(1)
  })

  it('surfaces Remote Control servers started outside Claude Deck', () => {
    const out = reconcile(input({ runtimes: [runtime('rt2', 'p_proj', 'claude-account2')] }))
    expect(out.untracked.map((c) => c.tmuxSessionName).sort()).toEqual(['claude', 'claude-account3'])
  })

  it('marks a missing project folder without deleting the project', () => {
    const out = reconcile(input({ snapshot: { ...baseSnapshot(), paths: { [`${HOME}/proj`]: { exists: false, is_dir: false } } } }))
    expect(out.projectPatches.get('p_proj')?.pathStatus).toBe('missing')
    expect(out.events.some((e) => e.type === 'project.path_missing')).toBe(true)
  })

  it('emits status transition events and attention notifications', () => {
    const snap = baseSnapshot()
    snap.panes[1] = pane('%3', '$3', 'claude-account2', {
      capture: { status_line: null, state_word: null, capacity: null, last_log: null, env_ids: [], session_ids: [], screen_tail: ['Trust /home/dev/proj? [y/N]'] },
    })
    const out = reconcile(input({ snapshot: snap, runtimes: [runtime('rt2', 'p_proj', 'claude-account2', { observedStatus: 'starting' })] }))
    expect(out.runtimePatches.get('rt2')?.observedStatus).toBe('needs_input')
    expect(out.notifications[0]?.title).toMatch(/Needs input/)
  })
})

describe('dev containers', () => {
  it('auto-links a devcontainer whose workspace folder is the project, without touching it', () => {
    const containers = {
      available: true,
      containers: [{ id: 'c1', name: 'agitated_keldysh', state: 'running', status: 'Up 2 months', image: 'vsc-myproj', local_folder: `${HOME}/myproj`, config_file: `${HOME}/myproj/.devcontainer/devcontainer.json` }],
    }
    const out = reconcile(input({ snapshot: { ...baseSnapshot(), containers } }))
    const patch = out.projectPatches.get('p_myproj')!
    expect(patch.container).toMatchObject({ enabled: true, matchBy: 'devcontainer', hostPath: `${HOME}/myproj` })
    expect(patch.containerState).toMatchObject({ found: true, name: 'agitated_keldysh', state: 'running' })
    expect(out.projectPatches.get('p_proj')?.container).toBeUndefined()
  })

  it('respects a user who disabled the integration', () => {
    const containers = { available: true, containers: [{ id: 'c1', name: 'x', state: 'running', status: 'Up', image: 'i', local_folder: `${HOME}/myproj`, config_file: null }] }
    const disabled = { enabled: false, matchBy: 'devcontainer' as const, name: null, hostPath: null, containerPath: null, user: null, shell: null, commandRunner: null }
    const out = reconcile(input({ projects: [project('p_myproj', `${HOME}/myproj`, { container: disabled })], snapshot: { ...baseSnapshot(), containers } }))
    expect(out.projectPatches.get('p_myproj')?.container).toBeUndefined()
  })
})

describe('race safety', () => {
  it('does not touch runtimes changed by an action after the snapshot was requested', () => {
    // Snapshot taken before a Start: the pane is still dead from the previous stop.
    const snap = baseSnapshot()
    snap.panes[1] = pane('%3', '$3', 'claude-account2', { dead: true, dead_status: 0, foreground: { kind: 'dead' }, capture: null })
    snap.servers = snap.servers.filter((s) => s.pane_id !== '%3')
    const justStarted = runtime('rt2', 'p_proj', 'claude-account2', { observedStatus: 'starting', accountId: 'acct2', accountConfirmed: true })
    const out = reconcile(input({ snapshot: snap, runtimes: [justStarted], launchedAt: new Map([['rt2', NOW - 1000]]), frozen: new Set(['rt2']) }))
    expect(out.runtimePatches.has('rt2')).toBe(false)
    expect(out.notifications).toEqual([])
    // …and its pane is still claimed, so it is not reported as an untracked server.
    expect(out.untracked.map((c) => c.tmuxSessionName)).not.toContain('claude-account2')
  })
})
