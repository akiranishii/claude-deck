// Runtime lifecycle: create folder/project → launch Remote Control in tmux with the selected
// account → wait for a confirmed connection → stop / restart / end.
//
// Safety rules
// * CLAUDE_CONFIG_DIR is applied to the launched process only (env(1) inside the tmux pane).
// * Stop = Ctrl+C sent to the verified Remote Control pane, then wait. Force stop is separate and
//   must be requested explicitly after a timeout.
// * End Session only kills tmux sessions Claude Deck created, unless the user explicitly confirms
//   an imported one. Folders, repositories and worktrees are never deleted.

import type { EndResult, LaunchPreview, NewSessionRequest, NewSessionResult, RuntimeActionResult, RuntimePatch, StopResult } from '../../shared/ipc'
import type { Account, Host, PermissionMode, Project, Runtime, SpawnMode } from '../../shared/types'
import { PERMISSION_MODE_META, SPAWN_MODE_META, STATUS_META } from '../../shared/constants'
import {
  allocateTmuxName,
  configDirLabel,
  defaultRemoteControlName,
  isValidManagedName,
  joinRemote,
  newId,
  normalizeRemotePath,
  validateFolderName,
  validateRemotePathInput,
} from '../../shared/naming'
import { parseClaudeUrl } from '../../shared/urls'
import { nowIso } from '../db/store'
import type { RawEnd, RawLaunch, RawPathCheck, RawSnapshot, RawStop } from '../ssh/helperTypes'
import { RemoteOpError } from '../ssh/helper'
import { DeckError, type Ctx } from './context'
import type { AccountsService } from './accounts'
import { canResume, displayLaunchCommand, rcOptionsFor } from './launchSpec'
import { matchRuntimes, type RuntimeMatch } from './matching'
import type { Monitor } from './monitor'

const SETTLED = new Set(['connected', 'needs_input', 'auth_required', 'failed', 'stopped', 'missing'])

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function friendlyRemoteError(err: unknown): never {
  if (err instanceof RemoteOpError) throw new DeckError(err.code, err.message)
  throw err
}

export class LifecycleService {
  constructor(
    private readonly ctx: Ctx,
    private readonly monitor: Monitor,
    private readonly accounts: AccountsService,
  ) {}

  private resolve(runtimeId: string): { runtime: Runtime; project: Project; host: Host; account: Account | null } {
    const { store } = this.ctx
    const runtime = store.runtimes.get(runtimeId)
    if (!runtime) throw new DeckError('not_found', 'Session not found')
    const project = store.projects.get(runtime.projectId)
    if (!project) throw new DeckError('not_found', 'Project not found')
    const host = store.hosts.get(project.hostId)
    if (!host) throw new DeckError('not_found', 'Host not found')
    const account = runtime.accountId ? store.accounts.get(runtime.accountId) : null
    return { runtime, project, host, account }
  }

  private currentMatch(hostId: string, runtime: Runtime): RuntimeMatch | null {
    const snap = this.ctx.live.snapshots.get(hostId)?.snap
    if (!snap) return null
    const others = this.ctx.store.runtimesForHost(hostId)
    return matchRuntimes(snap, others).get(runtime.id) ?? null
  }

  private takenNames(hostId: string, snap?: RawSnapshot): Set<string> {
    const s = snap ?? this.ctx.live.snapshots.get(hostId)?.snap
    return new Set([...(s?.sessions ?? []).map((x) => x.name), ...this.ctx.store.listRuntimes().map((r) => r.tmuxSessionName)])
  }

  /** Refresh only when the last snapshot is older than maxAgeMs (keeps Stop/End snappy). */
  private async ensureFresh(hostId: string, maxAgeMs = 15_000): Promise<void> {
    const last = this.ctx.live.snapshots.get(hostId)
    if (!last || Date.now() - last.at > maxAgeMs) await this.monitor.refresh(hostId, Date.now())
  }

  private assertReachable(hostId: string): void {
    const live = this.ctx.live.host(hostId)
    if (live.reachable === false) throw new DeckError('host_unreachable', `The VM is unreachable${live.error ? `: ${live.error}` : ''}`)
  }

  resumeAdvice(runtime: Runtime, project: Project, host: Host): { supported: boolean; recommended: boolean; note: string | null } {
    if (!host.capabilities?.supportsContinue) return { supported: false, recommended: false, note: 'This Claude Code version cannot reattach to a previous session.' }
    if (!canResume(runtime)) {
      return { supported: false, recommended: false, note: 'Claude can only reattach (--continue) when no spawn mode other than same-dir, capacity or no-create-session option is set.' }
    }
    const supported = true
    const sharing = this.ctx.store
      .listRuntimes()
      .filter((r) => r.id !== runtime.id && !r.archived && r.accountId === runtime.accountId && this.ctx.store.projects.get(r.projectId)?.remotePath === project.remotePath)
    if (sharing.length) {
      return { supported, recommended: false, note: 'Another session uses this folder with the same account, so --continue could attach to its conversation instead.' }
    }
    const last = Date.parse(runtime.lastSeenAt ?? runtime.lastStartedAt ?? '') || 0
    const recent = Date.now() - last < 4 * 3600_000
    return {
      supported,
      recommended: recent,
      note: recent
        ? 'Reattaches to the previous conversation so its claude.ai link keeps working (falls back to a fresh start if Claude cannot).'
        : 'The previous run is older than ~4 hours; Claude can only reattach to recent sessions.',
    }
  }

  launchPreview(id: string, resume?: boolean, restart = false): LaunchPreview {
    const { runtime, project, host, account } = this.resolve(id)
    const advice = this.resumeAdvice(runtime, project, host)
    const useResume = (resume ?? advice.recommended) && advice.supported
    const spec = rcOptionsFor(runtime, host.capabilities, useResume)
    const errors = [...spec.errors]
    if (!account) errors.push('Choose which Claude account this session uses first.')
    if (!host.claudePath) errors.push('Claude Code was not found on the VM — set its path in Settings.')
    const command = account && host.claudePath ? displayLaunchCommand(account.configDir, host.claudePath, spec.options) : ''
    const m = this.currentMatch(host.id, runtime)
    let mode: LaunchPreview['mode'] = m?.session ? 'tmux-respawn' : 'tmux-new'
    let note: string | null = m?.session
      ? `Restarts Remote Control inside tmux session “${runtime.tmuxSessionName}”.`
      : `Creates tmux session “${runtime.tmuxSessionName}” on ${host.displayName} in ${project.remotePath}.`
    if (!runtime.managed && m?.session) {
      mode = 'type-in-shell'
      if (m.server && !restart) errors.push('Remote Control is already running in this tmux session.')
      else if (!m.pane || m.pane.dead) errors.push(`The tmux pane in “${runtime.tmuxSessionName}” has exited; end that session first.`)
      else if (!m.server && m.pane.foreground.kind !== 'shell-idle') errors.push(`The tmux pane is busy (${m.pane.foreground.comm ?? 'another program'}). Open the terminal to check it.`)
      note = `This tmux session was started outside Claude Deck. ${restart && m.server ? 'Claude Deck stops Remote Control with Ctrl+C, clears the prompt, then types' : 'Claude Deck clears the idle shell prompt and types'} the command below (pane ${m.pane?.pane_id ?? '?'}) — nothing else in the session is touched.`
    } else if (restart && m?.server) {
      note = `Stops Remote Control with Ctrl+C, then restarts it inside tmux session “${runtime.tmuxSessionName}”.`
    }
    return {
      command,
      mode,
      note,
      warnings: spec.warnings,
      errors,
      resumeSupported: advice.supported,
      resumeRecommended: advice.recommended,
      resumeNote: advice.note,
      accountName: account?.displayName ?? null,
      configDirLabel: configDirLabel(account?.configDir ?? null, host.homePath),
    }
  }

  async start(id: string, opts: { resume?: boolean; acknowledgeImportedShell?: boolean } = {}): Promise<RuntimeActionResult> {
    const pre = this.resolve(id)
    await this.ensureFresh(pre.host.id, 5000)
    this.assertReachable(pre.host.id)
    const { runtime, project, host, account } = this.resolve(id)
    if (!account) throw new DeckError('no_account', 'Choose which Claude account this session should use before starting it.')
    if (!host.claudePath) throw new DeckError('no_claude', 'Claude Code was not found on the VM — set its path in Settings.')
    if (project.pathStatus === 'missing') throw new DeckError('cwd_missing', `The project folder ${project.remotePath} no longer exists on the VM.`)
    const advice = this.resumeAdvice(runtime, project, host)
    const resume = Boolean(opts.resume) && advice.supported
    const spec = rcOptionsFor(runtime, host.capabilities, resume)
    if (spec.errors.length) throw new DeckError('unsupported_flag', spec.errors.join(' '))
    const m = this.currentMatch(host.id, runtime)
    if (m?.server) throw new DeckError('already_running', 'Remote Control is already running for this session. Use Restart instead.')
    const helper = this.ctx.hosts.helper(host.id)
    const patch: Partial<Runtime> = {}
    let command: string

    try {
      if (!runtime.managed && m?.session && m.pane && !m.pane.dead) {
        if (m.pane.foreground.kind !== 'shell-idle') {
          throw new DeckError('pane_busy', `The tmux pane is running ${m.pane.foreground.comm ?? 'another program'}. Open the terminal to check it.`)
        }
        if (!opts.acknowledgeImportedShell) throw new DeckError('needs_ack', 'Confirm that Claude Deck may type the launch command into this shell.')
        const res = await helper.call<{ command: string; pane_id: string }>(
          'restart_in_shell',
          { pane_id: m.pane.pane_id, claude_path: host.claudePath, config_dir: account.configDir, options: spec.options },
          30_000,
        )
        command = res.command
        patch.tmuxPaneId = res.pane_id
      } else {
        if (!runtime.managed && m?.session && m.pane?.dead) {
          throw new DeckError('pane_dead', `The tmux pane in “${runtime.tmuxSessionName}” has exited. End that session first, then start again.`)
        }
        let sessionName = runtime.tmuxSessionName
        if (!runtime.managed && !isValidManagedName(sessionName)) {
          sessionName = allocateTmuxName(project.displayName, account.displayName, this.takenNames(host.id))
        }
        const res = await helper.call<RawLaunch>(
          'launch_runtime',
          {
            mode: runtime.managed ? 'restart' : 'new',
            session_name: sessionName,
            runtime_id: runtime.id,
            cwd: project.remotePath,
            claude_path: host.claudePath,
            config_dir: account.configDir,
            options: spec.options,
            shell_mode: host.shellMode,
          },
          40_000,
        )
        command = res.command
        Object.assign(patch, { managed: true, tmuxSessionName: sessionName, tmuxSessionId: res.session_id, tmuxPaneId: res.pane_id })
      }
    } catch (err) {
      friendlyRemoteError(err)
    }

    const now = nowIso()
    this.ctx.store.runtimes.update(id, {
      ...patch,
      lastStartedAt: now,
      lastLaunchCommand: command,
      observedStatus: 'starting',
      statusDetail: resume ? 'Reattaching to the previous session…' : 'Launching Remote Control…',
      statusEvidence: [],
      accountEvidence: 'launched',
      accountConfirmed: true,
      observedConfigDir: { state: account.configDir === null ? 'default' : 'env', value: account.configDir },
      updatedAt: now,
    })
    this.ctx.store.projects.update(project.id, { lastActiveAt: now, updatedAt: now })
    for (const w of spec.warnings) this.ctx.event({ level: 'warn', type: 'runtime.flag_unsupported', summary: w, runtimeId: id, projectId: project.id, hostId: host.id })
    this.ctx.event({
      level: 'info',
      type: 'runtime.started',
      summary: `Launched Remote Control as ${account.displayName}${resume ? ' (reattaching with --continue)' : ''}`,
      runtimeId: id,
      projectId: project.id,
      hostId: host.id,
    })
    this.monitor.markLaunched(id, host.id)
    this.ctx.changed()
    // If Claude cannot reattach (--continue), fall back to a fresh start automatically.
    if (resume) void this.waitForStartup(id, undefined, true).catch(() => undefined)
    return { runtimeId: id, status: 'starting', detail: null, command }
  }

  /** Poll until Remote Control settles (connected / needs input / failed …). */
  async waitForStartup(id: string, opId?: string, resumeFallback = false): Promise<Runtime> {
    const { host } = this.resolve(id)
    const settings = this.ctx.settings()
    const deadline = Date.now() + (settings.startupGraceSec + 5) * 1000
    const step = 'wait'
    const label = 'Wait for Remote Control to connect'
    let current = this.ctx.store.runtimes.get(id)!
    while (Date.now() < deadline) {
      await sleep(1500)
      await this.monitor.refresh(host.id, Date.now())
      current = this.ctx.store.runtimes.get(id)!
      if (opId) {
        const meta = STATUS_META[current.observedStatus]
        this.ctx.progress({ opId, step, label, state: 'running', detail: `${meta.label}${current.statusDetail && current.statusDetail !== meta.label ? ` — ${current.statusDetail}` : ''}` })
      }
      if (SETTLED.has(current.observedStatus)) break
    }
    if (current.observedStatus === 'failed' && resumeFallback) {
      if (!current.managed) {
        // Never type into a shell the user owns without asking again.
        this.ctx.event({ level: 'warn', type: 'runtime.resume_failed', summary: 'Claude could not reattach to the previous session (--continue). Press Start to begin a fresh session.', runtimeId: id })
        return current
      }
      this.ctx.event({ level: 'warn', type: 'runtime.resume_failed', summary: 'Could not reattach to the previous session (--continue); starting a fresh session instead', runtimeId: id })
      if (opId) this.ctx.progress({ opId, step: 'resume', label: 'Reattach to previous session', state: 'warn', detail: 'Claude could not reattach; starting fresh' })
      try {
        await this.start(id, { resume: false })
      } catch (err) {
        this.ctx.event({ level: 'error', type: 'runtime.start_failed', summary: `Fresh start after a failed reattach did not launch: ${(err as Error).message}`, runtimeId: id })
        return this.ctx.store.runtimes.get(id)!
      }
      return this.waitForStartup(id, opId, false)
    }
    if (current.observedStatus === 'connected') {
      // Give Claude a moment to record the environment and the pre-created conversation.
      const until = Date.now() + 8000
      while (Date.now() < until && (!current.environmentId || !this.ctx.store.conversationsForRuntime(id).length)) {
        await sleep(1500)
        await this.monitor.refresh(host.id, Date.now())
        current = this.ctx.store.runtimes.get(id)!
      }
    }
    if (opId) {
      const s = current.observedStatus
      const meta = STATUS_META[s]
      this.ctx.progress({
        opId,
        step,
        label,
        state: s === 'connected' ? 'done' : s === 'needs_input' || s === 'running' || s === 'starting' || s === 'reconnecting' ? 'warn' : 'error',
        detail:
          s === 'needs_input'
            ? `Claude is waiting for an answer in the terminal: “${current.statusDetail}”. Open the terminal to respond.`
            : s === 'connected'
              ? 'Connected to claude.ai'
              : `${meta.label}${current.statusDetail ? ` — ${current.statusDetail}` : ''}`,
      })
      if (current.environmentId) this.ctx.progress({ opId, step: 'env', label: 'Capture environment link', state: 'done', detail: current.environmentId })
      const convs = this.ctx.store.conversationsForRuntime(id)
      if (convs.length) this.ctx.progress({ opId, step: 'conv', label: 'Capture conversation link', state: 'done', detail: convs[0].remoteSessionId })
    }
    return current
  }

  async stop(id: string, mode: 'interrupt' | 'terminate' | 'kill'): Promise<StopResult> {
    const pre = this.resolve(id)
    await this.ensureFresh(pre.host.id)
    this.assertReachable(pre.host.id)
    const { runtime, project, host } = this.resolve(id)
    const m = this.currentMatch(host.id, runtime)
    if (!m?.server) return { state: 'not_running', detail: 'Remote Control is not running for this session.' }
    if (!m.pane) throw new DeckError('no_pane', 'This Remote Control process is not in a tmux pane Claude Deck can address. Stop it from its own terminal.')
    const paneId = m.pane.pane_id
    const settings = this.ctx.settings()
    this.monitor.launchedAt.delete(id)
    this.monitor.setStopping(id, true)
    this.ctx.store.runtimes.update(id, { observedStatus: 'stopping', statusDetail: mode === 'interrupt' ? 'Sending Ctrl+C…' : 'Terminating…', updatedAt: nowIso() })
    this.ctx.changed()
    try {
      const res = await this.ctx.hosts
        .helper(host.id)
        .call<RawStop>(
          'stop_runtime',
          { pane_id: paneId, mode, wait_seconds: settings.stopTimeoutSec, server_pid: m.server.pid, server_start: m.server.start },
          (settings.stopTimeoutSec + 30) * 1000,
        )
        .catch(friendlyRemoteError)
      const how = mode === 'interrupt' ? 'Ctrl+C' : mode === 'terminate' ? 'SIGTERM' : 'SIGKILL'
      if (res.state === 'stopped') {
        this.ctx.store.runtimes.update(id, { lastStoppedAt: nowIso() })
        this.ctx.event({ level: 'info', type: 'runtime.stopped', summary: `Stopped Remote Control (${how}). Project files were not touched.`, runtimeId: id, projectId: project.id, hostId: host.id })
      } else if (res.state === 'still_running') {
        this.ctx.event({ level: 'warn', type: 'runtime.stop_timeout', summary: `Remote Control still running after ${how}`, runtimeId: id, projectId: project.id, hostId: host.id })
      }
      return {
        state: res.state,
        detail:
          res.state === 'stopped'
            ? `Stopped in ${((res.elapsed_ms ?? 0) / 1000).toFixed(1)}s`
            : res.state === 'still_running'
              ? `Still running after ${settings.stopTimeoutSec}s.`
              : res.note ?? null,
        remainingSessions: res.remaining_sessions,
      }
    } finally {
      this.monitor.setStopping(id, false)
      await this.monitor.refresh(host.id, Date.now())
    }
  }

  async restart(id: string, opts: { resume?: boolean; acknowledgeImportedShell?: boolean } = {}): Promise<RuntimeActionResult> {
    const { runtime, host } = this.resolve(id)
    const m = this.currentMatch(host.id, runtime)
    if (m?.server) {
      const stopped = await this.stop(id, 'interrupt')
      if (stopped.state === 'still_running') throw new DeckError('stop_timeout', 'Remote Control did not stop after Ctrl+C. Use Stop → Force stop, then start it again.')
      await sleep(600)
    }
    return this.start(id, opts)
  }

  async end(id: string, opts: { force?: boolean; allowUnmanaged?: boolean }): Promise<EndResult> {
    const pre = this.resolve(id)
    await this.ensureFresh(pre.host.id)
    this.assertReachable(pre.host.id)
    const { runtime, project, host } = this.resolve(id)
    if (!runtime.managed && !opts.allowUnmanaged) {
      throw new DeckError('confirm_unmanaged', 'This tmux session was not created by Claude Deck. Confirm explicitly to end it.')
    }
    const m = this.currentMatch(host.id, runtime)
    if (!m?.session) {
      this.ctx.store.runtimes.update(id, { observedStatus: 'missing', statusDetail: 'tmux session not found', tmuxPaneId: null, tmuxSessionId: null, updatedAt: nowIso() })
      this.ctx.changed()
      return { state: 'missing' }
    }
    if (m.server) {
      const stopped = await this.stop(id, 'interrupt')
      if (stopped.state === 'still_running' && !opts.force) return { state: 'busy', busy: [{ paneId: m.pane?.pane_id ?? '', what: 'claude remote-control' }] }
    }
    const res = await this.ctx.hosts
      .helper(host.id)
      .call<RawEnd>('end_session', { session_name: m.session.name, runtime_id: runtime.id, allow_unmanaged: Boolean(opts.allowUnmanaged), force: Boolean(opts.force) }, 30_000)
      .catch(friendlyRemoteError)
    if (res.state === 'busy') return { state: 'busy', busy: (res.busy ?? []).map((b) => ({ paneId: b.pane_id, what: b.what })), managed: res.managed }
    this.monitor.launchedAt.delete(id)
    this.ctx.store.runtimes.update(id, {
      observedStatus: 'missing',
      statusDetail: 'tmux session ended',
      tmuxSessionId: null,
      tmuxPaneId: null,
      serverPid: null,
      lastStoppedAt: nowIso(),
      updatedAt: nowIso(),
    })
    this.monitor.touch(id)
    this.ctx.event({ level: 'info', type: 'runtime.ended', summary: `Ended tmux session ${m.session.name}. Project files were not touched.`, runtimeId: id, projectId: project.id, hostId: host.id })
    await this.monitor.refresh(host.id, Date.now())
    return { state: res.state, managed: res.managed }
  }

  // ------------------------------------------------------------------- new session

  async createSession(req: NewSessionRequest): Promise<NewSessionResult> {
    const { store } = this.ctx
    const opId = req.opId
    const progress = (step: string, label: string, state: 'running' | 'done' | 'error' | 'warn' | 'skipped', detail?: string | null) =>
      this.ctx.progress({ opId, step, label, state, detail: detail ?? null })
    const fail = (step: string, label: string, err: unknown): never => {
      const message = err instanceof Error ? err.message : String(err)
      progress(step, label, 'error', message)
      if (err instanceof DeckError) throw err
      if (err instanceof RemoteOpError) throw new DeckError(err.code, err.message)
      throw new DeckError('failed', message)
    }

    const host = store.hosts.get(req.hostId)
    if (!host) throw new DeckError('not_found', 'Host not found')
    const account = store.accounts.get(req.accountId)
    if (!account) throw new DeckError('not_found', 'Choose a Claude account')
    validateLaunchChoices(host, req.spawnMode, req.permissionMode, req.bypassAcknowledged)
    const helper = this.ctx.hosts.helper(host.id)

    // 1. connect
    const connectLabel = `Connect to ${host.sshAlias}`
    progress('connect', connectLabel, 'running')
    let snap: RawSnapshot
    try {
      snap = await helper.call<RawSnapshot>('snapshot', { capture: false }, 45_000)
    } catch (err) {
      return fail('connect', connectLabel, err)
    }
    progress('connect', connectLabel, 'done', `${host.displayName} reachable`)

    // 2. folder
    let remotePath: string
    let project: Project | null = null
    if (req.location.kind === 'existing-project') {
      project = store.projects.get(req.location.projectId)
      if (!project) throw new DeckError('not_found', 'Project not found')
      remotePath = project.remotePath
      progress('folder', 'Use project folder', 'done', remotePath)
    } else if (req.location.kind === 'new-folder') {
      const nameErr = validateFolderName(req.location.name)
      const parentErr = validateRemotePathInput(req.location.parent)
      if (nameErr || parentErr) throw new DeckError('invalid_path', nameErr ?? parentErr ?? 'Invalid path')
      const target = joinRemote(normalizeRemotePath(req.location.parent), req.location.name.trim())
      const label = `Create folder ${target}`
      progress('folder', label, 'running')
      try {
        const res = await helper.call<{ path: string }>('mkdir', { path: target }, 20_000)
        remotePath = res.path
      } catch (err) {
        if (err instanceof RemoteOpError && err.code === 'exists') {
          return fail('folder', label, new DeckError('exists', `${target} already exists. Choose “Use an existing folder” to start a session there — Claude Deck never overwrites folders.`))
        }
        return fail('folder', label, err)
      }
      progress('folder', label, 'done', remotePath)
    } else {
      const err = validateRemotePathInput(req.location.path)
      if (err) throw new DeckError('invalid_path', err)
      const label = `Check folder ${req.location.path}`
      progress('folder', label, 'running')
      let check: RawPathCheck
      try {
        check = await helper.call<RawPathCheck>('check_path', { path: req.location.path }, 20_000)
      } catch (e) {
        return fail('folder', label, e)
      }
      if (!check.is_dir) return fail('folder', label, new DeckError('not_found', `${check.path} does not exist or is not a folder`))
      remotePath = check.path
      progress('folder', label, 'done', remotePath)
    }

    // 3. project
    const now = nowIso()
    if (!project && req.attachToProjectId) {
      project = store.projects.get(req.attachToProjectId)
      if (project && project.remotePath !== remotePath) project = null
    }
    if (!project) {
      const name = req.projectName.trim() || remotePath.split('/').pop() || 'Project'
      project = {
        id: newId('prj'),
        hostId: host.id,
        displayName: name,
        remotePath,
        repositoryRoot: null,
        isWorktree: false,
        parentProjectId: null,
        taskSummary: req.taskSummary?.trim() || null,
        taskStatus: req.taskSummary?.trim() ? 'in_progress' : null,
        notes: null,
        tags: (req.tags ?? []).map((t) => t.trim()).filter(Boolean),
        pinned: false,
        archived: false,
        lastActiveAt: now,
        git: null,
        pathStatus: 'ok',
        pathCheckedAt: now,
        container: null,
        containerState: null,
        createdAt: now,
        updatedAt: now,
      }
      store.projects.insert(project)
      this.ctx.event({ level: 'info', type: 'project.created', summary: `Project ${project.displayName} registered (${remotePath})`, projectId: project.id, hostId: host.id })
      progress('project', 'Register project', 'done', project.displayName)
    } else {
      progress('project', 'Add session to project', 'done', project.displayName)
    }

    // 4. account
    const accountLabel = `Check ${account.displayName} sign-in`
    let authOk = true
    if (host.capabilities?.authStatusSupported) {
      progress('account', accountLabel, 'running', configDirLabel(account.configDir, host.homePath))
      try {
        const [checked] = (await this.accounts.checkAuth(account.id, host.id)).filter((a) => a.id === account.id)
        if (checked?.authState === 'logged_out' || checked?.authState === 'missing_dir') {
          authOk = false
          progress('account', accountLabel, 'error', checked.authState === 'missing_dir' ? `${configDirLabel(account.configDir, host.homePath)} does not exist on the VM` : `${account.displayName} is not signed in on the VM`)
        } else if (checked?.authState === 'authenticated') {
          progress('account', accountLabel, 'done', checked.authEmail ? `Signed in as ${checked.authEmail}` : 'Signed in')
        } else {
          progress('account', accountLabel, 'warn', 'Could not confirm sign-in; continuing')
        }
      } catch (err) {
        progress('account', accountLabel, 'warn', `Could not check sign-in: ${(err as Error).message}`)
      }
    } else {
      progress('account', accountLabel, 'skipped', 'This Claude Code version has no `auth status`')
    }

    // 5. runtime record (persisted before launching so nothing is lost if the app quits)
    const tmuxName = allocateTmuxName(project.displayName, account.displayName, this.takenNames(host.id, snap))
    const runtime: Runtime = {
      id: newId('rt'),
      projectId: project.id,
      accountId: account.id,
      accountConfirmed: true,
      accountEvidence: 'launched',
      observedConfigDir: null,
      tmuxSessionName: tmuxName,
      tmuxSessionId: null,
      tmuxPaneId: null,
      managed: true,
      importedExisting: false,
      remoteControlName: req.remoteControlName?.trim() || defaultRemoteControlName(project.displayName, account.displayName),
      spawnMode: req.spawnMode,
      permissionMode: req.permissionMode,
      capacity: req.capacity ?? null,
      createSessionInDir: null,
      observedFlags: null,
      taskSummary: null,
      environmentId: null,
      observedStatus: 'stopped',
      statusDetail: req.launch ? 'Not started yet' : 'Created without launching',
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
      createdAt: now,
      updatedAt: now,
    }
    store.runtimes.insert(runtime)
    progress('tmux', 'Allocate tmux session', 'done', tmuxName)

    if (!authOk) {
      store.runtimes.update(runtime.id, { observedStatus: 'auth_required', statusDetail: `${account.displayName} must sign in before launching` })
      this.ctx.changed()
      return { projectId: project.id, runtimeId: runtime.id, status: 'auth_required', detail: `Sign in to ${account.displayName}, then press Start.` }
    }
    if (!req.launch) {
      this.ctx.changed()
      return { projectId: project.id, runtimeId: runtime.id, status: 'stopped', detail: 'Created without launching' }
    }

    // 6. launch
    const launchLabel = `Launch Remote Control in tmux ${tmuxName}`
    progress('launch', launchLabel, 'running')
    try {
      const res = await this.start(runtime.id)
      progress('launch', launchLabel, 'done', res.command ?? null)
    } catch (err) {
      return fail('launch', launchLabel, err)
    }

    // 7. wait for connection
    const final = await this.waitForStartup(runtime.id, opId)
    return { projectId: project.id, runtimeId: runtime.id, status: final.observedStatus, detail: final.statusDetail }
  }

  // ------------------------------------------------------------------------ editing

  update(id: string, patch: RuntimePatch): Runtime {
    const { store } = this.ctx
    const { runtime, host } = this.resolve(id)
    const next: Partial<Runtime> = { updatedAt: nowIso() }
    if (patch.accountId !== undefined) {
      if (patch.accountId && !store.accounts.get(patch.accountId)) throw new DeckError('not_found', 'Account not found')
      next.accountId = patch.accountId
      next.accountEvidence = patch.accountId ? 'user' : null
      next.accountConfirmed = Boolean(patch.accountId)
      if (patch.accountId !== runtime.accountId && STATUS_META[runtime.observedStatus].running) {
        this.ctx.event({ level: 'info', type: 'runtime.account_changed', summary: 'Account mapping changed. The running process is unaffected; the new account applies at the next start.', runtimeId: id })
      }
    }
    if (patch.permissionMode !== undefined || patch.spawnMode !== undefined) {
      validateLaunchChoices(host, patch.spawnMode ?? runtime.spawnMode, patch.permissionMode ?? runtime.permissionMode, Boolean(patch.bypassAcknowledged) || (runtime.permissionMode === 'bypassPermissions' && patch.permissionMode === undefined))
      if (patch.permissionMode !== undefined) next.permissionMode = patch.permissionMode
      if (patch.spawnMode !== undefined) next.spawnMode = patch.spawnMode
    }
    if (patch.taskSummary !== undefined) next.taskSummary = patch.taskSummary?.trim() || null
    if (patch.remoteControlName !== undefined) next.remoteControlName = patch.remoteControlName?.trim() || null
    if (patch.capacity !== undefined) next.capacity = patch.capacity ? Math.max(1, Math.min(256, Math.round(patch.capacity))) : null
    if (patch.createSessionInDir !== undefined) next.createSessionInDir = patch.createSessionInDir
    if (patch.archived !== undefined) next.archived = patch.archived
    if (patch.environmentUrl !== undefined) {
      if (patch.environmentUrl === null || patch.environmentUrl === '') next.environmentId = null
      else {
        const parsed = parseClaudeUrl(patch.environmentUrl)
        if (!parsed || parsed.kind !== 'environment') throw new DeckError('invalid_url', 'Paste a https://claude.ai/code?environment=env_… link')
        next.environmentId = parsed.environmentId
      }
    }
    if (patch.tmuxSessionName !== undefined && patch.tmuxSessionName !== runtime.tmuxSessionName) {
      if (!isValidManagedName(patch.tmuxSessionName)) throw new DeckError('invalid_name', 'tmux names may contain letters, digits, - and _ only')
      if (runtime.tmuxSessionId) throw new DeckError('session_exists', 'End the current tmux session before renaming it')
      next.tmuxSessionName = patch.tmuxSessionName
    }
    if (patch.projectId !== undefined && patch.projectId !== runtime.projectId) {
      const target = store.projects.get(patch.projectId)
      if (!target) throw new DeckError('not_found', 'Project not found')
      next.projectId = patch.projectId
      store.tx(() => {
        for (const c of store.conversationsForRuntime(id)) store.conversations.update(c.id, { projectId: patch.projectId, updatedAt: nowIso() })
      })
    }
    store.runtimes.update(id, next)
    this.ctx.changed()
    return store.runtimes.get(id)!
  }

  remove(id: string): void {
    const runtime = this.ctx.store.runtimes.get(id)
    if (!runtime) return
    this.ctx.store.runtimes.delete(id)
    this.ctx.live.runtimes.delete(id)
    this.monitor.launchedAt.delete(id)
    this.ctx.event({ level: 'info', type: 'runtime.removed', summary: `Removed session ${runtime.tmuxSessionName} from the dashboard (nothing changed on the VM)`, projectId: runtime.projectId })
  }

  async capture(id: string, lines = 200): Promise<{ lines: string[] }> {
    const { runtime, host } = this.resolve(id)
    const m = this.currentMatch(host.id, runtime)
    const paneId = m?.pane?.pane_id ?? runtime.tmuxPaneId
    if (!paneId) return { lines: [] }
    const res = await this.ctx.hosts
      .helper(host.id)
      .call<{ lines: string[] }>('capture', { pane_id: paneId, lines }, 20_000)
      .catch(friendlyRemoteError)
    return { lines: res.lines }
  }
}

export function validateLaunchChoices(host: Host, spawn: SpawnMode | null, permission: PermissionMode | null, bypassAcknowledged: boolean): void {
  if (spawn && !(spawn in SPAWN_MODE_META)) throw new DeckError('invalid_spawn', `Unknown spawn mode ${spawn}`)
  if (permission && !(permission in PERMISSION_MODE_META)) throw new DeckError('invalid_permission', `Unknown permission mode ${permission}`)
  const caps = host.capabilities
  if (caps) {
    if (spawn && caps.spawnModes.length && !caps.spawnModes.includes(spawn)) throw new DeckError('unsupported_flag', `Claude Code ${caps.version ?? ''} does not support --spawn=${spawn}`)
    if (permission && caps.permissionModes.length && !caps.permissionModes.includes(permission)) {
      throw new DeckError('unsupported_flag', `Claude Code ${caps.version ?? ''} does not support --permission-mode ${permission}`)
    }
  }
  if (permission === 'bypassPermissions' && !bypassAcknowledged) {
    throw new DeckError('bypass_not_acknowledged', 'Bypass permissions lets Claude run commands without approval prompts. Confirm the warning to enable it.')
  }
}
