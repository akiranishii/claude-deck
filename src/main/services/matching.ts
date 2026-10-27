// Matches tracked runtimes to what is actually running on the VM, and turns untracked tmux
// panes into import candidates. Account mapping comes ONLY from process evidence
// (CLAUDE_CONFIG_DIR read from the process environment) or explicit user choice — never from
// tmux session names or directory names.

import type { Account, DiscoveryCandidate, Project, Runtime } from '../../shared/types'
import { basename, sameConfigDir } from '../../shared/naming'
import { isEnvironmentId, isSessionId } from '../../shared/urls'
import type { RawPane, RawServer, RawSession, RawSnapshot } from '../ssh/helperTypes'
import { mapConfigDir, mapFlags, observedDirValue } from './mappers'

export interface RuntimeMatch {
  session: RawSession | null
  pane: RawPane | null
  server: RawServer | null
}

function sortPanes(panes: RawPane[]): RawPane[] {
  return [...panes].sort((a, b) => a.window_index - b.window_index || a.pane_index - b.pane_index)
}

export function matchRuntimes(snapshot: RawSnapshot, runtimes: Runtime[]): Map<string, RuntimeMatch> {
  const result = new Map<string, RuntimeMatch>()
  const claimed = new Set<string>()
  const sessionsByName = new Map(snapshot.sessions.map((s) => [s.name, s]))
  const sessionsById = new Map(snapshot.sessions.map((s) => [s.session_id, s]))
  const sessionsByMarker = new Map(snapshot.sessions.filter((s) => s.runtime_marker).map((s) => [s.runtime_marker as string, s]))
  const paneById = new Map(snapshot.panes.map((p) => [p.pane_id, p]))
  const panesBySession = new Map<string, RawPane[]>()
  for (const p of snapshot.panes) panesBySession.set(p.session_id, [...(panesBySession.get(p.session_id) ?? []), p])
  const serverByMarker = new Map(snapshot.servers.filter((s) => s.runtime_marker).map((s) => [s.runtime_marker as string, s]))
  const serversByPane = new Map<string, RawServer[]>()
  for (const s of snapshot.servers) if (s.pane_id) serversByPane.set(s.pane_id, [...(serversByPane.get(s.pane_id) ?? []), s])
  const serverInPane = (pane: RawPane | null) => (pane ? serversByPane.get(pane.pane_id)?.[0] ?? null : null)

  // Pass 1: Claude Deck markers (tmux session option / CLAUDE_DECK_RUNTIME_ID in the process env).
  for (const r of runtimes) {
    const server = serverByMarker.get(r.id) ?? null
    let session = sessionsByMarker.get(r.id) ?? null
    let pane: RawPane | null = server?.pane_id ? paneById.get(server.pane_id) ?? null : null
    if (!session && pane) session = sessionsById.get(pane.session_id) ?? null
    if (!session && !server) continue
    if (!pane && session) pane = sortPanes(panesBySession.get(session.session_id) ?? [])[0] ?? null
    if (pane) claimed.add(pane.pane_id)
    result.set(r.id, { session, pane, server: server ?? serverInPane(pane) })
  }

  // Pass 2: exact tmux session name, preferring the pane recorded at import/launch time.
  const remaining = runtimes.filter((r) => !result.has(r.id))
  const ordered = [
    ...remaining.filter((r) => r.tmuxPaneId && paneById.get(r.tmuxPaneId)?.session_name === r.tmuxSessionName),
    ...remaining.filter((r) => !(r.tmuxPaneId && paneById.get(r.tmuxPaneId)?.session_name === r.tmuxSessionName)),
  ]
  for (const r of ordered) {
    const session = sessionsByName.get(r.tmuxSessionName) ?? null
    if (!session || (session.runtime_marker && session.runtime_marker !== r.id)) {
      result.set(r.id, { session: null, pane: null, server: null })
      continue
    }
    const panes = sortPanes(panesBySession.get(session.session_id) ?? []).filter((p) => !claimed.has(p.pane_id))
    const pane =
      panes.find((p) => p.pane_id === r.tmuxPaneId) ?? panes.find((p) => serversByPane.has(p.pane_id)) ?? panes[0] ?? null
    if (pane) claimed.add(pane.pane_id)
    result.set(r.id, { session, pane, server: serverInPane(pane) })
  }
  return result
}

export function accountForConfigDir(accounts: Account[], dir: string | null | undefined, home: string | null): Account | null {
  if (dir === undefined) return null
  return accounts.find((a) => sameConfigDir(a.configDir, dir, home)) ?? null
}

export interface CandidateContext {
  hostId: string
  home: string | null
  accounts: Account[]
  runtimes: Runtime[]
  projects: Project[]
}

export function buildCandidates(snapshot: RawSnapshot, ctx: CandidateContext): DiscoveryCandidate[] {
  const matches = matchRuntimes(snapshot, ctx.runtimes)
  const trackedByPane = new Map<string, string>()
  for (const [rid, m] of matches) if (m.pane) trackedByPane.set(m.pane.pane_id, rid)
  const loginSessions = new Set(snapshot.sessions.filter((s) => s.login).map((s) => s.session_id))
  const sessionsById = new Map(snapshot.sessions.map((s) => [s.session_id, s]))
  const out: DiscoveryCandidate[] = []

  for (const pane of snapshot.panes) {
    if (loginSessions.has(pane.session_id)) continue
    const server = snapshot.servers.find((s) => s.pane_id === pane.pane_id) ?? null
    const other = pane.other_claude[0] ?? null
    const kind: DiscoveryCandidate['kind'] = server
      ? server.kind
      : pane.dead
        ? 'dead'
        : other || pane.foreground.kind === 'claude'
          ? 'interactive'
          : pane.foreground.kind === 'shell-idle'
            ? 'shell'
            : 'other'
    const configDir = mapConfigDir(server?.config_dir ?? other?.config_dir ?? null)
    const matched = accountForConfigDir(ctx.accounts, observedDirValue(configDir), ctx.home)
    const cwd = server?.cwd ?? pane.cwd
    const envId = server?.pointer?.environment_id ?? pane.capture?.env_ids.at(-1) ?? null
    const session = sessionsById.get(pane.session_id)
    const suggested = cwd ? ctx.projects.find((p) => !p.archived && p.hostId === ctx.hostId && p.remotePath === cwd) ?? null : null
    out.push({
      key: `${pane.session_name}|${pane.pane_id}`,
      hostId: ctx.hostId,
      tmuxSessionName: pane.session_name,
      tmuxSessionId: pane.session_id,
      paneId: pane.pane_id,
      windowIndex: pane.window_index,
      paneIndex: pane.pane_index,
      cwd,
      kind,
      foreground: pane.foreground.comm ?? pane.foreground.claude_kind ?? pane.foreground.kind,
      serverPid: server?.pid ?? null,
      serverStart: server?.start ?? null,
      serverStartedAt: server?.started_at ? new Date(server.started_at * 1000).toISOString() : null,
      flags: server ? mapFlags(server.flags, pane.capture) : null,
      configDir,
      matchedAccountId: matched?.id ?? null,
      environmentId: isEnvironmentId(envId) ? envId : null,
      conversations: (server?.conversations ?? [])
        .filter((c) => isSessionId(c.meta?.bridgeSessionId))
        .map((c) => ({ remoteSessionId: c.meta!.bridgeSessionId as string, name: c.meta?.name ?? null, status: c.meta?.status ?? null, model: c.model })),
      statusWord: pane.capture?.state_word ?? null,
      connected: server ? pane.capture?.state_word === 'Connected' || (server.tcp?.https ?? 0) > 0 : null,
      managedMarker: session?.runtime_marker ?? null,
      trackedRuntimeId: trackedByPane.get(pane.pane_id) ?? null,
      suggestedProjectId: suggested?.id ?? null,
      suggestedProjectName: suggested?.displayName ?? (cwd ? basename(cwd) : pane.session_name),
      attached: (session?.attached ?? 0) > 0,
    })
  }
  return out
}
