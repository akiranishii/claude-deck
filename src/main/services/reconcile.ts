// Turns one remote snapshot into concrete record updates. Pure: no I/O, so every rule is
// covered by unit tests with fixtures captured from a real VM.
//
// Key rules
// * Statuses come from classifyRuntime() (evidence based; tmux existing ≠ connected).
// * A missing tmux session or folder never deletes anything — records are only re-labelled.
// * Conversation links are only created from IDs Claude itself recorded (sessions/<pid>.json,
//   bridge-pointer.json) or printed on screen.
// * Account assignment changes only on process evidence (CLAUDE_CONFIG_DIR of the process).

import type { Account, Conversation, DiscoveryCandidate, Project, Runtime, RuntimeLive, RuntimeStatus, Settings } from '../../shared/types'
import { STATUS_META } from '../../shared/constants'
import { classifyRuntime, type StatusFacts } from '../../shared/status'
import { isEnvironmentId, isSessionId, sessionUrl } from '../../shared/urls'
import { newId, sameConfigDir } from '../../shared/naming'
import type { RawSnapshot } from '../ssh/helperTypes'
import { mapConfigDir, mapFlags, mapGit, matchContainer, observedDirValue } from './mappers'
import { accountForConfigDir, buildCandidates, matchRuntimes } from './matching'

export interface ReconcileInput {
  now: number
  hostId: string
  home: string | null
  projects: Project[]
  runtimes: Runtime[]
  accounts: Account[]
  conversations: Conversation[]
  snapshot: RawSnapshot
  settings: Settings
  launchedAt: Map<string, number>
  stopping: Set<string>
  /** Runtimes changed by an action after this snapshot was requested: keep their pane claimed, change nothing. */
  frozen?: Set<string>
}

export interface ReconcileEvent {
  level: 'info' | 'warn' | 'error'
  type: string
  summary: string
  projectId: string | null
  runtimeId: string | null
}

export interface ReconcileOutput {
  runtimePatches: Map<string, Partial<Runtime>>
  newConversations: Conversation[]
  conversationPatches: Map<string, Partial<Conversation>>
  projectPatches: Map<string, Partial<Project>>
  events: ReconcileEvent[]
  live: Map<string, RuntimeLive>
  untracked: DiscoveryCandidate[]
  notifications: { title: string; body: string; runtimeId: string }[]
}

const ATTENTION: RuntimeStatus[] = ['needs_input', 'auth_required', 'failed']

function diff<T extends object>(current: T, next: Partial<T>): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(next) as [keyof T, T[keyof T]][]) {
    if (JSON.stringify(current[k] ?? null) !== JSON.stringify(v ?? null)) out[k] = v
  }
  return out
}

export function reconcile(input: ReconcileInput): ReconcileOutput {
  const { snapshot, settings, accounts, home } = input
  const nowIso = new Date(input.now).toISOString()
  const out: ReconcileOutput = {
    runtimePatches: new Map(),
    newConversations: [],
    conversationPatches: new Map(),
    projectPatches: new Map(),
    events: [],
    live: new Map(),
    untracked: [],
    notifications: [],
  }
  const projectById = new Map(input.projects.map((p) => [p.id, p]))
  const convBySid = new Map(input.conversations.map((c) => [c.remoteSessionId, c]))
  const convPatch = (c: Conversation, patch: Partial<Conversation>) => {
    const d = diff(c, patch)
    if (Object.keys(d).length) out.conversationPatches.set(c.id, { ...(out.conversationPatches.get(c.id) ?? {}), ...d, updatedAt: nowIso })
  }
  const matches = matchRuntimes(snapshot, input.runtimes)
  const projectActivity = new Map<string, number>()
  const bumpActivity = (projectId: string, ms: number | null | undefined) => {
    if (!ms || !Number.isFinite(ms)) return
    projectActivity.set(projectId, Math.max(projectActivity.get(projectId) ?? 0, ms))
  }

  for (const r of input.runtimes) {
    if (input.frozen?.has(r.id)) continue
    const m = matches.get(r.id) ?? { session: null, pane: null, server: null }
    const { session, pane, server } = m
    const capture = pane?.capture ?? null
    const facts: StatusFacts = {
      now: input.now,
      sessionExists: Boolean(session) && snapshot.tmux_running,
      pane: pane
        ? {
            dead: pane.dead,
            deadStatus: pane.dead_status,
            foregroundKind: pane.foreground.kind,
            foregroundComm: pane.foreground.comm ?? null,
            claudeKind: pane.foreground.claude_kind ?? null,
          }
        : null,
      server: server ? { pid: server.pid, httpsConnections: server.tcp?.https ?? null } : null,
      screen: capture
        ? { statusLine: capture.status_line, stateWord: capture.state_word, lastLog: capture.last_log?.text ?? null, tail: capture.screen_tail }
        : null,
      launchedAt: input.launchedAt.get(r.id) ?? null,
      graceSec: settings.startupGraceSec,
      stopping: input.stopping.has(r.id),
    }
    const result = classifyRuntime(facts, settings.statusPatterns)
    const next: Partial<Runtime> = {
      observedStatus: result.status,
      statusDetail: result.detail,
      statusEvidence: result.evidence,
      tmuxSessionId: session?.session_id ?? null,
      serverPid: server?.pid ?? null,
      serverStart: server?.start ?? null,
      serverStartedAt: server?.started_at ? new Date(server.started_at * 1000).toISOString() : null,
      activeConversations: server ? server.conversations.length : 0,
    }
    if (pane) next.tmuxPaneId = pane.pane_id
    if (session && session.name !== r.tmuxSessionName) next.tmuxSessionName = session.name // renamed, found via marker
    if (pane?.dead) next.lastExitStatus = pane.dead_status
    if (server) {
      next.lastSeenAt = nowIso
      next.observedConfigDir = mapConfigDir(server.config_dir)
      next.observedFlags = mapFlags(server.flags, capture)
      if (r.importedExisting && !r.managed) {
        // Keep the remembered launch configuration in sync with what is actually running.
        if (!r.remoteControlName && server.flags.name) next.remoteControlName = server.flags.name
      }
    }
    if (result.status === 'connected') next.lastConnectedAt = nowIso
    const envId = server?.pointer?.environment_id ?? capture?.env_ids.at(-1) ?? null
    if (isEnvironmentId(envId)) next.environmentId = envId

    // ---- account evidence
    if (server) {
      const dir = observedDirValue(mapConfigDir(server.config_dir))
      if (dir !== undefined) {
        const matched = accountForConfigDir(accounts, dir, home)
        const assigned = r.accountId ? accounts.find((a) => a.id === r.accountId) ?? null : null
        if (!assigned && matched) {
          next.accountId = matched.id
          next.accountConfirmed = true
          next.accountEvidence = 'process-env'
          out.events.push({ level: 'info', type: 'account.identified', summary: `Account identified from the process environment: ${matched.displayName}`, projectId: r.projectId, runtimeId: r.id })
        } else if (assigned) {
          const consistent = sameConfigDir(assigned.configDir, dir, home)
          if (consistent && !r.accountConfirmed) next.accountConfirmed = true
          if (!consistent && r.accountConfirmed) {
            next.accountConfirmed = false
            out.events.push({
              level: 'warn',
              type: 'account.conflict',
              summary: `Account mapping conflict: the process uses ${dir ?? 'the default config'} but the session is mapped to ${assigned.displayName}`,
              projectId: r.projectId,
              runtimeId: r.id,
            })
          }
        }
      }
    }

    const patch = diff(r, next)
    if (Object.keys(patch).length) out.runtimePatches.set(r.id, { ...patch, updatedAt: nowIso })

    // ---- status transition events / notifications
    if (result.status !== r.observedStatus) {
      const meta = STATUS_META[result.status]
      const level = result.status === 'failed' || result.status === 'auth_required' ? 'error' : ATTENTION.includes(result.status) || result.status === 'missing' ? 'warn' : 'info'
      out.events.push({
        level,
        type: `status.${result.status}`,
        summary: result.detail && result.detail !== meta.label ? `${meta.label}: ${result.detail}` : meta.label,
        projectId: r.projectId,
        runtimeId: r.id,
      })
      const project = projectById.get(r.projectId)
      const label = `${project?.displayName ?? 'Session'} (${r.tmuxSessionName})`
      const wasRunning = STATUS_META[r.observedStatus]?.running ?? false
      if (ATTENTION.includes(result.status)) {
        out.notifications.push({ title: `${label}: ${meta.short}`, body: result.detail || meta.description, runtimeId: r.id })
      } else if (wasRunning && (result.status === 'stopped' || result.status === 'missing') && !input.stopping.has(r.id) && r.observedStatus !== 'stopping') {
        out.notifications.push({ title: `${label} stopped`, body: result.detail || meta.description, runtimeId: r.id })
      }
    }

    // ---- live (non-persisted) details
    if (pane || server) {
      out.live.set(r.id, {
        runtimeId: r.id,
        observedAt: nowIso,
        screenTail: capture?.screen_tail ?? [],
        statusLine: capture?.status_line ?? null,
        lastLog: capture?.last_log ? `[${capture.last_log.time}] ${capture.last_log.text}` : null,
        capacity: capture?.capacity ?? null,
        httpsConnections: server?.tcp?.https ?? null,
        foreground: pane ? (pane.foreground.comm ?? pane.foreground.claude_kind ?? pane.foreground.kind) : null,
        promptText: result.promptText,
      })
    }

    // ---- conversations
    const liveIds = new Set<string>()
    const upsert = (
      sid: string,
      fields: { live: boolean; source: Conversation['source']; claudeStatus?: string | null; model?: string | null; autoTitle?: string | null; activityMs?: number | null },
    ) => {
      const existing = convBySid.get(sid)
      if (existing) {
        const patchFields: Partial<Conversation> = { live: fields.live }
        if (fields.live) {
          patchFields.lastSeenAt = nowIso
          patchFields.claudeStatus = fields.claudeStatus ?? null
          if (fields.model) patchFields.model = fields.model
          if (fields.autoTitle) patchFields.autoTitle = fields.autoTitle
          if (existing.runtimeId !== r.id) {
            patchFields.runtimeId = r.id
            patchFields.projectId = r.projectId
          }
        }
        convPatch(existing, patchFields)
      } else {
        const conv: Conversation = {
          id: newId('conv'),
          projectId: r.projectId,
          runtimeId: r.id,
          remoteSessionId: sid,
          url: sessionUrl(sid),
          displayTitle: null,
          autoTitle: fields.autoTitle ?? null,
          source: fields.source,
          pinned: false,
          live: fields.live,
          claudeStatus: fields.claudeStatus ?? null,
          model: fields.model ?? null,
          lastSeenAt: fields.live ? nowIso : null,
          lastOpenedAt: null,
          archived: false,
          createdAt: nowIso,
          updatedAt: nowIso,
        }
        out.newConversations.push(conv)
        convBySid.set(sid, conv)
        out.events.push({
          level: 'info',
          type: 'conversation.discovered',
          summary: `Conversation link captured: ${fields.autoTitle ?? sid}`,
          projectId: r.projectId,
          runtimeId: r.id,
        })
      }
      if (fields.live) bumpActivity(r.projectId, fields.activityMs ?? null)
    }
    if (server) {
      for (const c of server.conversations) {
        const sid = c.meta?.bridgeSessionId
        if (!isSessionId(sid)) continue
        liveIds.add(sid)
        upsert(sid, {
          live: true,
          source: 'claude-metadata',
          claudeStatus: c.meta?.status ?? null,
          model: c.model,
          autoTitle: c.meta?.name ?? null,
          activityMs: c.meta?.statusUpdatedAt ?? c.meta?.updatedAt ?? null,
        })
      }
      const pointerSid = server.pointer?.session_id
      if (isSessionId(pointerSid) && !liveIds.has(pointerSid)) upsert(pointerSid, { live: false, source: 'claude-metadata' })
      for (const sid of capture?.session_ids ?? []) {
        if (isSessionId(sid) && !liveIds.has(sid) && !convBySid.has(sid)) upsert(sid, { live: false, source: 'pane-output' })
      }
    }
    for (const c of input.conversations) {
      if (c.runtimeId === r.id && c.live && !liveIds.has(c.remoteSessionId)) convPatch(c, { live: false })
    }
  }

  // ---- projects: folder existence, git, containers, activity
  for (const p of input.projects) {
    const next: Partial<Project> = {}
    const pathInfo = snapshot.paths?.[p.remotePath]
    if (pathInfo) {
      const status = pathInfo.exists && pathInfo.is_dir ? 'ok' : 'missing'
      next.pathStatus = status
      next.pathCheckedAt = nowIso
      if (status === 'missing' && p.pathStatus !== 'missing') {
        out.events.push({ level: 'warn', type: 'project.path_missing', summary: `Folder ${p.remotePath} was not found (renamed or removed?). Nothing was deleted.`, projectId: p.id, runtimeId: null })
      }
    }
    const git = snapshot.git?.[p.remotePath]
    if (git && !git.error && !git.skipped) {
      next.git = mapGit(git, nowIso)
      next.repositoryRoot = git.root ?? null
      next.isWorktree = Boolean(git.is_worktree)
    }
    if (p.container === null && snapshot.containers?.available) {
      // Auto-link a VS Code dev container whose workspace folder is this project (display only).
      const dc = (snapshot.containers.containers ?? []).find(
        (c) => c.local_folder && (c.local_folder === p.remotePath || p.remotePath.startsWith(`${c.local_folder}/`)),
      )
      if (dc) {
        next.container = { enabled: true, matchBy: 'devcontainer', name: null, hostPath: dc.local_folder, containerPath: null, user: null, shell: null, commandRunner: null }
        next.containerState = matchContainer({ ...p, container: next.container }, snapshot.containers, nowIso)
        out.events.push({ level: 'info', type: 'container.detected', summary: `Detected dev container ${dc.name} for ${p.displayName}`, projectId: p.id, runtimeId: null })
      }
    }
    if (p.container?.enabled && snapshot.containers) {
      const state = matchContainer(p, snapshot.containers, nowIso)
      next.containerState = state
      if (p.containerState?.found && p.containerState.id && state.found && state.id !== p.containerState.id) {
        out.events.push({ level: 'info', type: 'container.recreated', summary: `Dev container was recreated (${state.name})`, projectId: p.id, runtimeId: null })
      }
    }
    const activity = projectActivity.get(p.id)
    if (activity && activity > (Date.parse(p.lastActiveAt ?? '') || 0) + 1000) next.lastActiveAt = new Date(activity).toISOString()
    const patch = diff(p, next)
    delete patch.pathCheckedAt
    if (Object.keys(patch).length) out.projectPatches.set(p.id, { ...patch, pathCheckedAt: nowIso, updatedAt: nowIso })
  }

  // ---- untracked Remote Control servers (started outside Claude Deck)
  out.untracked = buildCandidates(snapshot, {
    hostId: input.hostId,
    home,
    accounts,
    runtimes: input.runtimes,
    projects: input.projects,
  }).filter((c) => !c.trackedRuntimeId && (c.kind === 'rc-server' || c.kind === 'interactive-rc'))

  return out
}
