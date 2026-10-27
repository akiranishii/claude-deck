// Periodic status refresh over SSH. One snapshot call per host per tick (~1s over the
// multiplexed tunnel). Polls faster while a runtime is starting or stopping, backs off while the
// VM is unreachable, and pauses while the Mac sleeps. Transient failures never delete records.

import type { RawSnapshot } from '../ssh/helperTypes'
import { SshError } from '../ssh/sshClient'
import { RemoteOpError } from '../ssh/helper'
import { nowIso } from '../db/store'
import { log } from '../log'
import type { Ctx } from './context'
import { reconcile } from './reconcile'

export class Monitor {
  private timers = new Map<string, NodeJS.Timeout>()
  private inflight = new Map<string, { promise: Promise<void>; startedAt: number }>()
  /** runtimeId → when a lifecycle action last changed it (snapshots requested earlier must not overwrite it). */
  private touched = new Map<string, number>()
  private lastGit = new Map<string, number>()
  private lastContainers = new Map<string, number>()
  private lastContainerDiscovery = new Map<string, number>()
  private lastAuth = new Map<string, number>()
  readonly launchedAt = new Map<string, number>()
  readonly stopping = new Set<string>()
  private paused = false
  private stopped = false
  onAuthDue: (hostId: string) => Promise<void> = async () => {}

  constructor(private readonly ctx: Ctx) {}

  start(): void {
    this.stopped = false
    for (const h of this.ctx.store.listHosts()) this.schedule(h.id, 300)
  }

  stop(): void {
    this.stopped = true
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    for (const h of this.ctx.store.listHosts()) this.schedule(h.id, 1500)
  }

  watchHost(hostId: string): void {
    this.schedule(hostId, 100)
  }

  markLaunched(runtimeId: string, hostId: string): void {
    this.launchedAt.set(runtimeId, Date.now())
    this.touch(runtimeId)
    this.schedule(hostId, 1200)
  }

  setStopping(runtimeId: string, on: boolean): void {
    if (on) this.stopping.add(runtimeId)
    else this.stopping.delete(runtimeId)
    this.touch(runtimeId)
  }

  /** Record that an action changed this runtime now; older in-flight snapshots will skip it. */
  touch(runtimeId: string): void {
    this.touched.set(runtimeId, Date.now())
  }

  private schedule(hostId: string, delayMs: number): void {
    if (this.stopped) return
    const existing = this.timers.get(hostId)
    if (existing) clearTimeout(existing)
    this.timers.set(
      hostId,
      setTimeout(() => void this.tick(hostId), delayMs),
    )
  }

  private hostRuntimeIds(hostId: string): Set<string> {
    return new Set(this.ctx.store.runtimesForHost(hostId).map((r) => r.id))
  }

  private async tick(hostId: string): Promise<void> {
    if (this.paused || this.stopped) return
    if (!this.ctx.store.hosts.get(hostId)) return
    await this.refresh(hostId)
    const live = this.ctx.live.host(hostId)
    const settings = this.ctx.settings()
    const ids = this.hostRuntimeIds(hostId)
    const graceMs = settings.startupGraceSec * 1000
    const busy =
      [...this.launchedAt.entries()].some(([rid, t]) => ids.has(rid) && Date.now() - t < graceMs + 10_000) ||
      [...this.stopping].some((rid) => ids.has(rid))
    const base = Math.max(5, settings.refreshIntervalSec) * 1000
    const delay = live.reachable === false ? Math.max(base, 30_000) : busy ? 2000 : base
    this.schedule(hostId, delay)
  }

  /**
   * Refresh now, deduplicated per host. With `after` (ms epoch), the caller is guaranteed a
   * snapshot that was *requested* at or after that time — an older in-flight refresh is awaited
   * and then followed by a new one, so actions never read pre-action state.
   */
  refresh(hostId: string, after?: number): Promise<void> {
    const current = this.inflight.get(hostId)
    if (current) {
      if (after === undefined || current.startedAt >= after) return current.promise
      return current.promise.then(() => this.refresh(hostId, after))
    }
    const startedAt = Date.now()
    const promise: Promise<void> = this.doRefresh(hostId, startedAt).finally(() => {
      if (this.inflight.get(hostId)?.promise === promise) this.inflight.delete(hostId)
    })
    this.inflight.set(hostId, { promise, startedAt })
    return promise
  }

  /** User-requested refresh: always returns state requested after this call. */
  async refreshAll(): Promise<void> {
    const now = Date.now()
    await Promise.all(this.ctx.store.listHosts().map((h) => this.refresh(h.id, now)))
  }

  private async doRefresh(hostId: string, startedAt: number): Promise<void> {
    const { store } = this.ctx
    const host = store.hosts.get(hostId)
    if (!host) return
    const live = this.ctx.live.host(hostId)
    live.refreshing = true
    this.ctx.changed()
    const settings = this.ctx.settings()
    const now = startedAt
    const runtimes = store.runtimesForHost(hostId)
    const projects = store.projectsForHost(hostId)
    const activeProjects = projects.filter((p) => !p.archived)
    const wantGit = now - (this.lastGit.get(hostId) ?? 0) > settings.gitRefreshIntervalSec * 1000
    const containerProjects = activeProjects.filter((p) => p.container?.enabled)
    // Also look for dev containers every 10 minutes so new projects get linked automatically.
    const discoverContainers = activeProjects.some((p) => p.container === null) && now - (this.lastContainerDiscovery.get(hostId) ?? 0) > 600_000
    const wantContainers = discoverContainers || (containerProjects.length > 0 && now - (this.lastContainers.get(hostId) ?? 0) > 60_000)
    const recentlyLaunched = runtimes.filter((r) => r.tmuxPaneId && now - (this.launchedAt.get(r.id) ?? 0) < 180_000)
    const unique = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))]
    const args = {
      capture: true,
      capture_panes: unique(runtimes.filter((r) => !r.archived).map((r) => r.tmuxPaneId)),
      history_panes: unique(recentlyLaunched.map((r) => r.tmuxPaneId)),
      history_lines: 400,
      check_paths: unique(activeProjects.map((p) => p.remotePath)),
      // Least recently checked first, so a slow repository cannot starve the others.
      git_paths: wantGit ? unique([...activeProjects].sort((a, b) => (Date.parse(a.git?.checkedAt ?? '') || 0) - (Date.parse(b.git?.checkedAt ?? '') || 0)).map((p) => p.remotePath)) : [],
      containers: wantContainers,
      container_details: unique(containerProjects.map((p) => p.containerState?.id ?? p.container?.name)),
    }
    // Back off optional checks even if this refresh fails (a slow git must not retry every tick).
    if (wantGit) this.lastGit.set(hostId, now)
    if (wantContainers) this.lastContainers.set(hostId, now)
    if (discoverContainers) this.lastContainerDiscovery.set(hostId, now)
    try {
      const helper = this.ctx.hosts.helper(hostId)
      const snap = await helper.call<RawSnapshot>('snapshot', args, 45_000)
      const fresh = store.hosts.get(hostId)
      if (!fresh) return
      if (fresh.lastConnectionStatus !== 'online') {
        if (fresh.lastConnectionStatus === 'offline' || fresh.lastConnectionStatus === 'auth_failed') {
          this.ctx.event({ level: 'info', type: 'host.online', summary: `${host.displayName} is reachable again`, hostId })
        }
      }
      store.hosts.update(hostId, { lastConnectionStatus: 'online', lastConnectionError: null, lastConnectedAt: nowIso(), updatedAt: nowIso() })

      // Re-read records now: lifecycle actions may have changed them while we waited on SSH.
      const currentRuntimes = store.runtimesForHost(hostId)
      const frozen = new Set(currentRuntimes.filter((r) => (this.touched.get(r.id) ?? 0) > startedAt).map((r) => r.id))
      const out = reconcile({
        now: Date.now(),
        hostId,
        home: host.homePath,
        projects: store.projectsForHost(hostId),
        runtimes: currentRuntimes,
        frozen,
        accounts: store.listAccounts(),
        conversations: store.listConversations(),
        snapshot: snap,
        settings,
        launchedAt: this.launchedAt,
        stopping: this.stopping,
      })
      store.tx(() => {
        for (const [id, patch] of out.runtimePatches) store.runtimes.update(id, patch)
        for (const conv of out.newConversations) store.conversations.insert(conv)
        for (const [id, patch] of out.conversationPatches) store.conversations.update(id, patch)
        for (const [id, patch] of out.projectPatches) store.projects.update(id, patch)
        for (const e of out.events) store.addEvent({ ...e, hostId })
      })
      for (const [rid, rl] of out.live) this.ctx.live.runtimes.set(rid, rl)
      live.reachable = true
      live.error = null
      live.errorKind = null
      live.tmuxRunning = snap.tmux_running
      live.lastSnapshotAt = nowIso()
      live.snapshotMs = snap.elapsed_ms
      live.untracked = out.untracked
      // Timestamp by request time: the data reflects the VM no earlier than that.
      this.ctx.live.snapshots.set(hostId, { snap, at: startedAt })
      if (settings.notifications) for (const n of out.notifications) this.ctx.notify(n.title, n.body, n.runtimeId)

      const lastAuth = this.lastAuth.get(hostId) ?? 0
      if (now - lastAuth > settings.authCheckIntervalMin * 60_000) {
        this.lastAuth.set(hostId, now)
        this.onAuthDue(hostId).catch((err) => log.warn('auth check failed', { error: String(err) }))
      }
    } catch (err) {
      // Quitting aborts in-flight connections; that says nothing about the VM.
      if (this.stopped || (err instanceof SshError && err.kind === 'cancelled')) return
      const message = err instanceof Error ? err.message : String(err)
      const transient = err instanceof SshError && (err.kind === 'timeout' || err.kind === 'socket_busy')
      const tunnelAlive = transient ? await this.ctx.hosts.get(hostId).ssh.checkMaster() : false
      if (tunnelAlive) {
        // The VM answered the multiplexer but this refresh failed (slow, or socket contention): not an outage.
        live.errorKind = (err as SshError).kind
      } else if (err instanceof SshError) {
        const status = ['auth', 'host_key', 'gcloud_auth', 'proxy', 'config'].includes(err.kind) ? 'auth_failed' : 'offline'
        const before = store.hosts.get(hostId)?.lastConnectionStatus
        if (before !== status) {
          this.ctx.event({
            level: 'warn',
            type: status === 'offline' ? 'host.offline' : 'host.auth_failed',
            summary: status === 'offline' ? `${host.displayName} is unreachable — ${message}` : message,
            hostId,
          })
        }
        store.hosts.update(hostId, { lastConnectionStatus: status, lastConnectionError: message, updatedAt: nowIso() })
        live.reachable = false
        live.errorKind = err.kind
      } else {
        live.errorKind = err instanceof RemoteOpError ? err.code : 'error'
      }
      live.error = message
      log.warn('snapshot failed', { host: host.sshAlias, error: message })
    } finally {
      live.refreshing = false
      this.ctx.changed()
    }
  }
}
