// Composition root: owns the store, SSH registry, monitor and services, and implements the
// shared Ctx. Exposes one handler per IPC channel.

import { app, clipboard, dialog, shell, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import type { DeckApi, DeckChannel, DeckEvents, ProgressEvent } from '../shared/ipc'
import type { ChromeProfile, DeckState, Settings } from '../shared/types'
import { parseClaudeUrl, isSafeExternalUrl } from '../shared/urls'
import { readChromeProfiles } from './chrome/chrome'
import type { Db } from './db/database'
import { Store } from './db/store'
import { log } from './log'
import { AccountsService } from './services/accounts'
import { DeckError, LiveStore, type Ctx, type EventInput } from './services/context'
import { applyImport, buildExport } from './services/dataPort'
import { DiscoveryService } from './services/discovery'
import { HostRegistry } from './services/hostRegistry'
import { HostsService } from './services/hosts'
import { LifecycleService } from './services/lifecycle'
import { Monitor } from './services/monitor'
import { OpenerService } from './services/opener'
import { RecordsService } from './services/records'
import { ExtensionBridge } from './services/extensionBridge'
import { mapGit } from './services/mappers'
import type { RawPathCheck } from './ssh/helperTypes'

type Handlers = { [K in DeckChannel]: (req: DeckApi[K]['req']) => Promise<DeckApi[K]['res']> | DeckApi[K]['res'] }

export class Deck implements Ctx {
  readonly store: Store
  readonly hosts: HostRegistry
  readonly live = new LiveStore()
  readonly monitor: Monitor
  readonly accounts: AccountsService
  readonly lifecycle: LifecycleService
  readonly discovery: DiscoveryService
  readonly records: RecordsService
  readonly hostsSvc: HostsService
  readonly opener: OpenerService
  readonly extension: ExtensionBridge
  private settingsCache: Settings | null = null
  private chrome: { profiles: ChromeProfile[]; error: string | null; at: number } = { profiles: [], error: null, at: 0 }
  private emitTimer: NodeJS.Timeout | null = null
  private sink: <E extends keyof DeckEvents>(event: E, payload: DeckEvents[E]) => void = () => {}
  private notifier: (title: string, body: string, runtimeId?: string | null) => void = () => {}
  private stateListeners: ((s: DeckState) => void)[] = []
  getWindow: () => BrowserWindow | null = () => null

  constructor(db: Db, controlDir: string) {
    this.store = new Store(db)
    this.hosts = new HostRegistry(this.store, controlDir)
    this.monitor = new Monitor(this)
    this.accounts = new AccountsService(this)
    this.monitor.onAuthDue = async (hostId) => {
      if (this.store.listAccounts().length) await this.accounts.checkAuth(undefined, hostId)
    }
    this.lifecycle = new LifecycleService(this, this.monitor, this.accounts)
    this.discovery = new DiscoveryService(this, this.accounts, this.monitor)
    this.records = new RecordsService(this)
    this.hostsSvc = new HostsService(this, this.monitor)
    this.opener = new OpenerService(this)
    this.extension = new ExtensionBridge(this)
  }

  // ------------------------------------------------------------------------- Ctx
  settings(): Settings {
    if (!this.settingsCache) this.settingsCache = this.store.getSettings()
    return this.settingsCache
  }

  chromeProfiles(): { profiles: ChromeProfile[]; error: string | null } {
    if (Date.now() - this.chrome.at > 30_000) return this.refreshChromeProfiles()
    return this.chrome
  }

  refreshChromeProfiles(): { profiles: ChromeProfile[]; error: string | null } {
    const res = readChromeProfiles(this.settings().browser)
    this.chrome = { ...res, at: Date.now() }
    // Keep cached display names fresh (profiles can be renamed in Chrome).
    for (const a of this.store.listAccounts()) {
      const p = a.chromeProfileDir ? res.profiles.find((x) => x.directory === a.chromeProfileDir) : null
      if (p && p.name !== a.chromeProfileName) this.store.accounts.update(a.id, { chromeProfileName: p.name })
    }
    return this.chrome
  }

  changed(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      const state = this.buildState()
      this.sink('state', state)
      for (const l of this.stateListeners) l(state)
    }, 120)
  }

  progress(e: ProgressEvent): void {
    this.sink('progress', e)
  }

  event(e: EventInput): void {
    this.store.addEvent({ ...e, hostId: e.hostId ?? null, projectId: e.projectId ?? null, runtimeId: e.runtimeId ?? null })
    this.changed()
  }

  notify(title: string, body: string, runtimeId?: string | null): void {
    this.notifier(title, body, runtimeId)
  }

  // --------------------------------------------------------------------- plumbing
  setSink(sink: <E extends keyof DeckEvents>(event: E, payload: DeckEvents[E]) => void): void {
    this.sink = sink
  }

  setNotifier(fn: (title: string, body: string, runtimeId?: string | null) => void): void {
    this.notifier = fn
  }

  onState(listener: (s: DeckState) => void): void {
    this.stateListeners.push(listener)
  }

  buildState(): DeckState {
    const chrome = this.chromeProfiles()
    return {
      hosts: this.store.listHosts(),
      accounts: this.store.listAccounts(),
      projects: this.store.listProjects(),
      runtimes: this.store.listRuntimes(),
      conversations: this.store.listConversations(),
      settings: this.settings(),
      live: { hosts: Object.fromEntries(this.live.hosts), runtimes: Object.fromEntries(this.live.runtimes) },
      chromeProfiles: chrome.profiles,
      chromeError: chrome.error,
      recentEvents: this.store.listEvents({ limit: 150 }),
      appVersion: app.getVersion(),
      extension: this.extension.status(),
    }
  }

  start(): void {
    this.store.pruneEvents()
    this.refreshChromeProfiles()
    this.monitor.start()
    if (this.settings().extensionEnabled) this.extension.start(this.settings().extensionPort).catch((err) => log.warn('extension bridge failed', { error: String(err) }))
  }

  async shutdown(): Promise<void> {
    this.monitor.stop()
    await this.extension.stop()
    await this.hosts.closeAll()
  }

  private updateSettings(patch: Partial<Settings>): Settings {
    const next = this.store.setSettings(patch)
    this.settingsCache = next
    if (patch.browser) this.refreshChromeProfiles()
    if (patch.extensionEnabled !== undefined || patch.extensionPort !== undefined) {
      if (next.extensionEnabled) void this.extension.start(next.extensionPort).catch((err) => this.event({ level: 'error', type: 'extension.failed', summary: `Extension bridge failed to start: ${String(err)}` }))
      else void this.extension.stop()
    }
    if (patch.refreshIntervalSec !== undefined) this.monitor.start()
    this.changed()
    return next
  }

  private firstHostId(): string {
    const h = this.store.listHosts()[0]
    if (!h) throw new DeckError('no_host', 'Connect a VM first')
    return h.id
  }

  handlers(): Handlers {
    return {
      'state.get': () => this.buildState(),
      'state.refresh': async (req) => {
        this.refreshChromeProfiles()
        if (req && 'hostId' in req && req.hostId) await this.monitor.refresh(req.hostId)
        else await this.monitor.refreshAll()
      },

      'host.listSshAliases': () => this.hostsSvc.listSshAliases(),
      'host.probe': (req) => this.hostsSvc.probe(req.alias, req.claudePath, req.pythonCommand),
      'host.save': (req) => this.hostsSvc.save(req),
      'host.update': (req) => this.hostsSvc.update(req.id, req.patch),
      'host.reprobe': (req) => this.hostsSvc.reprobe(req.id),
      'host.remove': (req) => this.hostsSvc.remove(req.id),
      'host.reconnect': (req) => this.hostsSvc.reconnect(req.id),

      'discovery.scan': (req) => this.discovery.scan(req.hostId, req.checkAuth ?? true),
      'discovery.import': (req) => this.discovery.import(req),

      'account.create': (req) => {
        const a = this.accounts.create(req)
        this.changed()
        return a
      },
      'account.update': (req) => {
        const a = this.accounts.update(req.id, req.patch)
        this.changed()
        return a
      },
      'account.delete': (req) => this.accounts.delete(req.id),
      'account.checkAuth': (req) => this.accounts.checkAuth(req.id),
      'account.listConfigDirs': (req) => this.accounts.listConfigDirs(req.hostId, req.checkAuth ?? true),
      'account.createConfigDir': (req) => this.accounts.createConfigDir(req.hostId, req.path),
      'account.confirmProfile': (req) => {
        const a = this.accounts.confirmProfile(req.id, req.confirmed)
        this.changed()
        return a
      },

      'login.start': (req) =>
        this.accounts.startLogin(req.accountId, req.hostId, req.method, (hostId, sessionName, title) => this.opener.openTmuxTerminal(hostId, sessionName, title)),
      'login.poll': (req) => this.accounts.pollLogin(req.loginId),
      'login.openUrl': (req) => this.accounts.openLoginUrl(req.loginId, req.url, req.profileDir ?? null),
      'login.openTerminal': async (req) => {
        const rec = this.accounts.logins.get(req.loginId)
        if (!rec) throw new DeckError('not_found', 'Login session not found')
        await this.opener.openTmuxTerminal(rec.hostId, rec.sessionName, 'Claude sign-in')
      },
      'login.finish': (req) => this.accounts.finishLogin(req.loginId),

      'chrome.profiles': () => {
        const r = this.refreshChromeProfiles()
        this.changed()
        return { profiles: r.profiles, error: r.error }
      },
      'chrome.test': (req) => this.opener.testProfile(req.profileDir, req.url),
      'chrome.createProfile': () => this.opener.createProfile(),
      'chrome.activeTabUrl': () => this.opener.frontTabUrl(),

      'project.create': (req) => this.records.createProject(req),
      'project.update': (req) => this.records.updateProject(req.id, req.patch),
      'project.archive': (req) => this.records.archiveProject(req.id, req.archived),
      'project.delete': (req) => this.records.deleteProject(req.id),

      'remote.listDir': async (req) => {
        const raw = await this.hosts.helper(req.hostId).call<{
          path: string
          parent: string | null
          home: string
          entries: { name: string; is_git: boolean; is_symlink: boolean }[]
          truncated: boolean
          writable: boolean
          git_root: string | null
        }>('list_dir', { path: req.path, show_hidden: Boolean(req.showHidden) }, 20_000)
        return {
          path: raw.path,
          parent: raw.parent,
          home: raw.home,
          entries: raw.entries.map((e) => ({ name: e.name, isGit: e.is_git, isSymlink: e.is_symlink })),
          truncated: raw.truncated,
          writable: raw.writable,
          gitRoot: raw.git_root,
        }
      },
      'remote.checkPath': async (req) => {
        const raw = await this.hosts.helper(req.hostId).call<RawPathCheck>('check_path', { path: req.path }, 20_000)
        return {
          path: raw.path,
          exists: raw.exists,
          isDir: raw.is_dir,
          writable: raw.writable,
          parent: raw.parent,
          parentExists: raw.parent_exists,
          parentWritable: raw.parent_writable,
          insideHome: raw.inside_home,
          gitRoot: raw.git_root,
          git: raw.git ? mapGit(raw.git, new Date().toISOString()) : null,
        }
      },

      'session.create': (req) => this.lifecycle.createSession(req),

      'runtime.start': (req) => this.lifecycle.start(req.id, { resume: req.resume, acknowledgeImportedShell: req.acknowledgeImportedShell }),
      'runtime.stop': (req) => this.lifecycle.stop(req.id, req.mode),
      'runtime.restart': (req) => this.lifecycle.restart(req.id, { resume: req.resume, acknowledgeImportedShell: req.acknowledgeImportedShell }),
      'runtime.end': (req) => this.lifecycle.end(req.id, { force: req.force, allowUnmanaged: req.allowUnmanaged }),
      'runtime.update': (req) => this.lifecycle.update(req.id, req.patch),
      'runtime.remove': (req) => this.lifecycle.remove(req.id),
      'runtime.capture': (req) => this.lifecycle.capture(req.id, req.lines),
      'runtime.launchPreview': (req) => this.lifecycle.launchPreview(req.id, req.resume, Boolean(req.restart)),

      'conversation.link': (req) => this.records.linkConversation(req),
      'conversation.update': (req) => this.records.updateConversation(req.id, req.patch),
      'conversation.remove': (req) => this.records.removeConversation(req.id),

      'open.plan': (req) => this.opener.plan(req),
      'open.claude': (req) => this.opener.openClaude(req),
      'open.terminal': (req) => this.opener.openRuntimeTerminal(req.runtimeId),
      'open.containerTerminal': (req) => this.opener.openContainerTerminal(req.projectId),
      'open.external': async (req) => {
        if (!isSafeExternalUrl(req.url)) throw new DeckError('invalid_url', 'Refusing to open that link')
        await shell.openExternal(req.url)
      },

      'clipboard.readUrl': async () => {
        const text = (await clipboard.readText()).trim().slice(0, 2000)
        const parsed = parseClaudeUrl(text)
        return { url: parsed?.url ?? null, text: text || null }
      },
      'clipboard.write': async (req) => {
        await clipboard.writeText(req.text)
      },

      'settings.update': (req) => this.updateSettings(req),
      'data.export': async () => {
        const win = this.getWindow()
        const opts = { title: 'Export Claude Deck data', defaultPath: `claude-deck-export-${new Date().toISOString().slice(0, 10)}.json` }
        const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
        if (res.canceled || !res.filePath) return { path: null }
        fs.writeFileSync(res.filePath, JSON.stringify(buildExport(this.store, app.getVersion()), null, 2), { mode: 0o600 })
        return { path: res.filePath }
      },
      'data.import': async () => {
        const win = this.getWindow()
        const opts = { title: 'Import Claude Deck data', properties: ['openFile' as const], filters: [{ name: 'JSON', extensions: ['json'] }] }
        const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        if (res.canceled || !res.filePaths[0]) return { imported: false }
        const st = fs.statSync(res.filePaths[0])
        if (st.size > 50 * 1024 * 1024) throw new DeckError('too_large', 'That file is too large to be a Claude Deck export')
        const counts = applyImport(this.store, JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8')))
        this.event({ level: 'info', type: 'data.imported', summary: `Imported metadata: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}` })
        void this.monitor.refreshAll()
        return { imported: true, counts }
      },
      'events.list': (req) => this.store.listEvents(req),
      'extension.pairing': (req) => this.extension.pairingCode(req.accountId),
      'extension.dismissInbox': (req) => this.extension.dismissInbox(req.remoteSessionId),
    }
  }

  firstHost(): string {
    return this.firstHostId()
  }
}
