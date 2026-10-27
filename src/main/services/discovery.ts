// "Import existing sessions": read-only scan of tmux + processes, then create dashboard records.
// Nothing on the VM is modified — no tmux options are set, nothing is restarted or detached.

import type { DiscoveryResult, ImportRequest, ImportResult } from '../../shared/ipc'
import type { Conversation, PermissionMode, Project, Runtime, SpawnMode } from '../../shared/types'
import { PERMISSION_MODE_META, SPAWN_MODE_META } from '../../shared/constants'
import { basename, newId } from '../../shared/naming'
import { isSessionId, sessionUrl } from '../../shared/urls'
import { nowIso } from '../db/store'
import type { RawSnapshot } from '../ssh/helperTypes'
import type { AccountsService } from './accounts'
import { DeckError, type Ctx } from './context'
import { observedDirValue } from './mappers'
import { accountForConfigDir, buildCandidates } from './matching'
import type { Monitor } from './monitor'

const RUNTIME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/

export class DiscoveryService {
  private cache = new Map<string, { result: DiscoveryResult; at: number }>()

  constructor(
    private readonly ctx: Ctx,
    private readonly accounts: AccountsService,
    private readonly monitor: Monitor,
  ) {}

  async scan(hostId: string, checkAuth = true): Promise<DiscoveryResult> {
    const { store } = this.ctx
    const host = store.hosts.get(hostId)
    if (!host) throw new DeckError('not_found', 'Host not found')
    const snap = await this.ctx.hosts.helper(hostId).call<RawSnapshot>('snapshot', { capture: true }, 45_000)
    this.ctx.live.snapshots.set(hostId, { snap, at: Date.now() })
    const candidates = buildCandidates(snap, {
      hostId,
      home: host.homePath,
      accounts: store.listAccounts(),
      runtimes: store.runtimesForHost(hostId),
      projects: store.projectsForHost(hostId),
    })
    const configDirs = await this.accounts.listConfigDirs(hostId, checkAuth)
    const result: DiscoveryResult = { hostId, scannedAt: nowIso(), candidates, configDirs, home: host.homePath }
    this.cache.set(hostId, { result, at: Date.now() })
    return result
  }

  async import(req: ImportRequest): Promise<ImportResult> {
    const { store } = this.ctx
    const host = store.hosts.get(req.hostId)
    if (!host) throw new DeckError('not_found', 'Host not found')
    let cached = this.cache.get(req.hostId)
    if (!cached || Date.now() - cached.at > 5 * 60_000) {
      await this.scan(req.hostId, false)
      cached = this.cache.get(req.hostId)!
    }
    const result: ImportResult = { projects: 0, runtimes: 0, conversations: 0, accountsCreated: 0, skipped: [] }
    const now = nowIso()

    store.tx(() => {
      for (const spec of req.createAccounts ?? []) {
        if (store.accountByConfigDir(spec.configDir)) continue
        this.accounts.create({ displayName: spec.displayName, configDir: spec.configDir, color: spec.color, chromeProfileDir: spec.chromeProfileDir ?? null })
        result.accountsCreated++
      }
      const accounts = store.listAccounts()
      const projectForCwd = new Map<string, string>()

      for (const item of req.items) {
        const cand = cached!.result.candidates.find((c) => c.key === item.key)
        if (!cand) {
          result.skipped.push({ key: item.key, reason: 'Not found in the latest scan' })
          continue
        }
        if (cand.trackedRuntimeId || store.runtimesForHost(req.hostId).some((r) => r.tmuxSessionName === cand.tmuxSessionName && r.tmuxPaneId === cand.paneId)) {
          result.skipped.push({ key: item.key, reason: 'Already on the dashboard' })
          continue
        }

        // Account: explicit user choice, else process evidence. Never inferred from names.
        const evidence = accountForConfigDir(accounts, observedDirValue(cand.configDir), host.homePath)
        let accountId: string | null
        let accountEvidence: Runtime['accountEvidence']
        let accountConfirmed: boolean
        if (item.accountId !== undefined && item.accountId !== null) {
          if (!accounts.some((a) => a.id === item.accountId)) throw new DeckError('not_found', 'Account not found')
          accountId = item.accountId
          accountEvidence = evidence?.id === item.accountId ? 'process-env' : 'user'
          accountConfirmed = evidence ? evidence.id === item.accountId : true
        } else if (item.accountId === null) {
          accountId = null
          accountEvidence = null
          accountConfirmed = false
        } else {
          accountId = evidence?.id ?? null
          accountEvidence = evidence ? 'process-env' : null
          accountConfirmed = Boolean(evidence)
        }

        // Project: explicit, else one created earlier in this import / existing one with the same folder.
        const cwd = cand.cwd ?? host.homePath ?? '~'
        let projectId = item.projectId ?? projectForCwd.get(cwd) ?? cand.suggestedProjectId ?? null
        if (projectId && !store.projects.get(projectId)) projectId = null
        if (!projectId) {
          const project: Project = {
            id: newId('prj'),
            hostId: req.hostId,
            displayName: item.newProjectName?.trim() || cand.suggestedProjectName || basename(cwd),
            remotePath: cwd,
            repositoryRoot: null,
            isWorktree: false,
            parentProjectId: null,
            taskSummary: null,
            taskStatus: null,
            notes: null,
            tags: [],
            pinned: false,
            archived: false,
            lastActiveAt: cand.serverStartedAt,
            git: null,
            pathStatus: 'ok',
            pathCheckedAt: now,
            container: null,
            containerState: null,
            createdAt: now,
            updatedAt: now,
          }
          store.projects.insert(project)
          projectId = project.id
          result.projects++
        }
        projectForCwd.set(cwd, projectId)

        const flags = cand.flags
        const spawn = flags?.spawn && flags.spawn in SPAWN_MODE_META ? (flags.spawn as SpawnMode) : null
        const perm = flags?.permissionMode && flags.permissionMode in PERMISSION_MODE_META ? (flags.permissionMode as PermissionMode) : null
        // A Claude Deck marker from an earlier install lets us restore the original runtime id.
        const reuseId = cand.managedMarker && RUNTIME_ID_RE.test(cand.managedMarker) && !store.runtimes.get(cand.managedMarker) ? cand.managedMarker : null
        const running = cand.kind === 'rc-server' || cand.kind === 'interactive-rc'
        const runtime: Runtime = {
          id: reuseId ?? newId('rt'),
          projectId,
          accountId,
          accountConfirmed,
          accountEvidence,
          observedConfigDir: cand.configDir,
          tmuxSessionName: cand.tmuxSessionName,
          tmuxSessionId: cand.tmuxSessionId,
          tmuxPaneId: cand.paneId,
          managed: Boolean(reuseId),
          importedExisting: true,
          remoteControlName: flags?.name ?? null,
          spawnMode: spawn,
          permissionMode: perm,
          capacity: flags?.capacity ?? null,
          createSessionInDir: null,
          observedFlags: flags,
          taskSummary: item.taskSummary?.trim() || null,
          environmentId: cand.environmentId,
          observedStatus: running ? (cand.connected ? 'connected' : 'running') : 'stopped',
          statusDetail: running ? null : `Imported (${cand.kind === 'shell' ? 'idle shell' : cand.foreground ?? cand.kind})`,
          statusEvidence: [],
          serverPid: cand.serverPid,
          serverStart: cand.serverStart,
          serverStartedAt: cand.serverStartedAt,
          lastStartedAt: cand.serverStartedAt,
          lastStoppedAt: null,
          lastSeenAt: running ? now : null,
          lastConnectedAt: cand.connected ? now : null,
          lastExitStatus: null,
          lastLaunchCommand: null,
          activeConversations: cand.conversations.length,
          archived: false,
          createdAt: now,
          updatedAt: now,
        }
        store.runtimes.insert(runtime)
        result.runtimes++

        for (const conv of cand.conversations) {
          if (!isSessionId(conv.remoteSessionId)) continue
          const existing = store.conversationBySessionId(conv.remoteSessionId)
          if (existing) {
            store.conversations.update(existing.id, { runtimeId: runtime.id, projectId, live: true, updatedAt: now })
            continue
          }
          const record: Conversation = {
            id: newId('conv'),
            projectId,
            runtimeId: runtime.id,
            remoteSessionId: conv.remoteSessionId,
            url: sessionUrl(conv.remoteSessionId),
            displayTitle: null,
            autoTitle: conv.name,
            source: 'claude-metadata',
            pinned: false,
            live: true,
            claudeStatus: conv.status,
            model: conv.model,
            lastSeenAt: now,
            lastOpenedAt: null,
            archived: false,
            createdAt: now,
            updatedAt: now,
          }
          store.conversations.insert(record)
          result.conversations++
        }
        store.addEvent({
          level: 'info',
          type: 'runtime.imported',
          summary: `Imported existing tmux session “${cand.tmuxSessionName}” without restarting it${accountId ? '' : ' — account unconfirmed'}`,
          runtimeId: runtime.id,
          projectId,
          hostId: req.hostId,
        })
      }
    })
    this.cache.delete(req.hostId)
    this.ctx.changed()
    void this.monitor.refresh(req.hostId)
    return result
  }
}
