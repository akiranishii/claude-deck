// Opening things on the Mac: Claude conversations in the right Chrome profile, and terminals
// attached to tmux sessions or dev containers.

import type { OpenResult } from '../../shared/ipc'
import { blockingIssues, needsConfirmation, planOpen, type OpenPlan, type OpenRequest } from '../../shared/routing'
import { CLAUDE_CODE_HOME } from '../../shared/urls'
import { nowIso } from '../db/store'
import { frontTabUrl, isValidProfileDir, nextProfileDir, openInProfile } from '../chrome/chrome'
import { shellEnv } from '../ssh/shellEnv'
import { containerShellArgs, openTerminal, tmuxAttachArgs } from '../terminal/terminal'
import { log } from '../log'
import { DeckError, type Ctx } from './context'

export class OpenerService {
  constructor(private readonly ctx: Ctx) {}

  plan(req: OpenRequest): OpenPlan {
    const { store } = this.ctx
    const chrome = this.ctx.refreshChromeProfiles()
    return planOpen(
      {
        runtimes: store.listRuntimes(),
        conversations: store.listConversations(),
        accounts: store.listAccounts(),
        chromeProfiles: chrome.profiles,
        chromeProfilesKnown: chrome.profiles.length > 0,
        home: store.listHosts()[0]?.homePath ?? null,
      },
      req,
    )
  }

  async openClaude(req: OpenRequest & { acknowledge?: boolean }): Promise<OpenResult> {
    const plan = this.plan(req)
    if (blockingIssues(plan).length || !plan.url || !plan.profileDir) return { opened: false, plan }
    if (needsConfirmation(plan) && !req.acknowledge) return { opened: false, plan }
    await openInProfile(this.ctx.settings().browser, plan.profileDir, plan.url)
    if (plan.conversationId) this.ctx.store.conversations.update(plan.conversationId, { lastOpenedAt: nowIso() })
    log.info('opened claude', { kind: plan.urlKind, profile: plan.profileDir, account: plan.accountName })
    this.ctx.changed()
    return { opened: true, plan }
  }

  async openTmuxTerminal(hostId: string, sessionName: string, title: string, windowTarget?: string | null): Promise<void> {
    const host = this.ctx.store.hosts.get(hostId)
    if (!host) throw new DeckError('not_found', 'Host not found')
    const env = await shellEnv()
    await openTerminal(
      {
        title,
        alias: host.sshAlias,
        controlPath: this.ctx.hosts.controlPath(hostId),
        remoteArgs: tmuxAttachArgs(sessionName, windowTarget),
        pathEnv: env.PATH ?? '/usr/bin:/bin',
      },
      this.ctx.settings().terminalApp,
    )
  }

  async openRuntimeTerminal(runtimeId: string): Promise<void> {
    const { store } = this.ctx
    const runtime = store.runtimes.get(runtimeId)
    if (!runtime) throw new DeckError('not_found', 'Session not found')
    const project = store.projects.get(runtime.projectId)
    if (!project) throw new DeckError('not_found', 'Project not found')
    const snap = this.ctx.live.snapshots.get(project.hostId)?.snap
    const exists = snap ? snap.sessions.some((s) => s.name === runtime.tmuxSessionName) : true
    if (!exists) throw new DeckError('missing', `tmux session “${runtime.tmuxSessionName}” does not exist on the VM. Start the session first.`)
    const pane = snap?.panes.find((p) => p.pane_id === runtime.tmuxPaneId)
    const host = store.hosts.get(project.hostId)!
    await this.openTmuxTerminal(project.hostId, runtime.tmuxSessionName, `${runtime.tmuxSessionName} · ${host.sshAlias}`, pane && pane.session_name === runtime.tmuxSessionName ? pane.window_id : null)
  }

  async openContainerTerminal(projectId: string): Promise<void> {
    const { store } = this.ctx
    const project = store.projects.get(projectId)
    if (!project) throw new DeckError('not_found', 'Project not found')
    const cfg = project.container
    const state = project.containerState
    if (!cfg?.enabled) throw new DeckError('no_container', 'Dev container integration is not enabled for this project')
    if (!state?.found || !state.name) throw new DeckError('no_container', 'The dev container was not found on the VM')
    if (state.state !== 'running') throw new DeckError('container_stopped', `The dev container ${state.name} is ${state.state}. Claude Deck does not start or rebuild containers.`)
    let workdir = cfg.containerPath
    if (!workdir && state.workspaceMount) {
      const { source, destination } = state.workspaceMount
      workdir = project.remotePath === source ? destination : project.remotePath.startsWith(`${source}/`) ? destination + project.remotePath.slice(source.length) : destination
    }
    const host = store.hosts.get(project.hostId)!
    const env = await shellEnv()
    await openTerminal(
      {
        title: `${project.displayName} · container ${state.name}`,
        alias: host.sshAlias,
        controlPath: this.ctx.hosts.controlPath(project.hostId),
        // Prefer the devcontainer's non-root user so files created in the shared checkout keep sane ownership.
        remoteArgs: containerShellArgs(state.name, { user: cfg.user || state.remoteUser || null, workdir, shell: cfg.shell || 'bash' }),
        pathEnv: env.PATH ?? '/usr/bin:/bin',
      },
      this.ctx.settings().terminalApp,
    )
  }

  async testProfile(profileDir: string, url?: string): Promise<void> {
    if (!isValidProfileDir(profileDir)) throw new DeckError('invalid_profile', 'Invalid Chrome profile')
    await openInProfile(this.ctx.settings().browser, profileDir, url ?? CLAUDE_CODE_HOME)
  }

  async createProfile(): Promise<{ profileDir: string }> {
    const browser = this.ctx.settings().browser
    const dir = nextProfileDir(browser, this.ctx.chromeProfiles().profiles)
    await openInProfile(browser, dir, 'https://claude.ai/login')
    setTimeout(() => {
      this.ctx.refreshChromeProfiles()
      this.ctx.changed()
    }, 4000).unref()
    return { profileDir: dir }
  }

  async frontTabUrl(): Promise<{ url: string | null; error: string | null }> {
    try {
      return { url: await frontTabUrl(this.ctx.settings().browser), error: null }
    } catch (err) {
      const msg = (err as Error).message
      return {
        url: null,
        error: /not allowed|-1743|authoriz/i.test(msg)
          ? 'macOS blocked access. Allow Claude Deck to control Chrome in System Settings → Privacy & Security → Automation.'
          : 'Could not read the current Chrome tab',
      }
    }
  }
}
