// Regression test: a status refresh that was already in flight (and therefore saw the VM *before*
// an action) must never overwrite the result of Stop / Start / Restart.

import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/db/database'
import { Store } from '../../src/main/db/store'
import { AccountsService } from '../../src/main/services/accounts'
import { LiveStore, type Ctx } from '../../src/main/services/context'
import { LifecycleService } from '../../src/main/services/lifecycle'
import { Monitor } from '../../src/main/services/monitor'
import type { RawSnapshot } from '../../src/main/ssh/helperTypes'
import { DEFAULT_SETTINGS } from '../../src/shared/constants'
import { account, pane, project, runtime, server, session, snapshot } from './fixtures'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class FakeVm {
  running = true
  pid = 500
  latencyMs = 250

  snapshot(): RawSnapshot {
    const marker = { runtime_marker: 'rt_1' }
    return snapshot({
      sessions: [session('$1', 'cd-proj-main-a1b2', { ...marker, managed: true })],
      panes: [
        pane('%1', '$1', 'cd-proj-main-a1b2', this.running ? {} : { dead: true, dead_status: 0, foreground: { kind: 'dead' }, capture: null }),
      ],
      servers: this.running ? [server(this.pid, '%1', null, marker)] : [],
    })
  }

  /** Snapshots reflect the VM when the request is sent and arrive after SSH latency. */
  async call(op: string): Promise<unknown> {
    if (op === 'snapshot') {
      const snap = this.snapshot()
      await sleep(this.latencyMs)
      return snap
    }
    if (op === 'stop_runtime') {
      await sleep(40)
      this.running = false
      return { state: 'stopped', pid: this.pid, elapsed_ms: 40, remaining_sessions: 0 }
    }
    if (op === 'launch_runtime') {
      await sleep(40)
      this.running = true
      this.pid += 1
      return { session_id: '$1', window_id: '@1', pane_id: '%1', respawned: true, command: 'env -u CLAUDE_CONFIG_DIR claude remote-control' }
    }
    throw new Error(`unexpected op ${op}`)
  }
}

function setup() {
  const vm = new FakeVm()
  const store = new Store(openDatabase(':memory:'))
  store.hosts.insert({
    id: 'host_1', displayName: 'vm', sshAlias: 'vm', remoteUser: 'dev', homePath: '/home/dev', hostname: 'vm', claudePath: '/home/dev/claude',
    pythonCommand: 'python3', shellMode: 'direct', defaultParentDir: '~/projects', capabilities: null, probe: null,
    lastConnectionStatus: 'online', lastConnectionError: null, lastConnectedAt: null, createdAt: '', updatedAt: '',
  })
  store.accounts.insert(account('main', null))
  store.projects.insert(project('p1', '/home/dev/proj', { hostId: 'host_1' }))
  store.runtimes.insert(runtime('rt_1', 'p1', 'cd-proj-main-a1b2', { managed: true, importedExisting: false, accountId: 'main', accountConfirmed: true, observedStatus: 'connected', tmuxPaneId: '%1' }))
  const live = new LiveStore()
  const settings = { ...DEFAULT_SETTINGS, startupGraceSec: 60, stopTimeoutSec: 5 }
  const helper = { call: (op: string) => vm.call(op) }
  const ctx = {
    store,
    live,
    hosts: { helper: () => helper, get: () => ({ ssh: { checkMaster: async () => true } }) },
    settings: () => settings,
    chromeProfiles: () => ({ profiles: [], error: null }),
    refreshChromeProfiles: () => ({ profiles: [], error: null }),
    changed: () => {},
    progress: () => {},
    event: (e: Parameters<Ctx['event']>[0]) => store.addEvent({ ...e, hostId: e.hostId ?? null, projectId: e.projectId ?? null, runtimeId: e.runtimeId ?? null }),
    notify: () => {},
  } as unknown as Ctx
  const monitor = new Monitor(ctx)
  const lifecycle = new LifecycleService(ctx, monitor, new AccountsService(ctx))
  return { vm, store, monitor, lifecycle }
}

describe('lifecycle vs. in-flight refresh', () => {
  it('Stop is not overwritten by a refresh that saw the server still running', async () => {
    const { store, monitor, lifecycle } = setup()
    await monitor.refresh('host_1')
    const stale = monitor.refresh('host_1') // in flight: captured "running"
    const res = await lifecycle.stop('rt_1', 'interrupt')
    await stale
    expect(res.state).toBe('stopped')
    expect(store.runtimes.get('rt_1')?.observedStatus).toBe('stopped')
    expect(store.runtimes.get('rt_1')?.serverPid).toBeNull()
  })

  it('Restart does not fail with "already running" because of a stale snapshot', async () => {
    const { vm, store, monitor, lifecycle } = setup()
    await monitor.refresh('host_1')
    void monitor.refresh('host_1')
    const res = await lifecycle.restart('rt_1', {})
    expect(res.status).toBe('starting')
    expect(vm.running).toBe(true)
    expect(vm.pid).toBe(501)
    expect(store.runtimes.get('rt_1')?.observedStatus).toMatch(/starting|connected/)
  })

  it('Start is not marked "failed" by a refresh that still saw the dead pane', async () => {
    const { vm, store, monitor, lifecycle } = setup()
    vm.running = false
    store.runtimes.update('rt_1', { observedStatus: 'stopped' })
    await monitor.refresh('host_1')
    const stale = monitor.refresh('host_1') // captured the dead pane before the launch
    await lifecycle.start('rt_1', {})
    await stale
    expect(store.runtimes.get('rt_1')?.observedStatus).toBe('starting')
    expect(store.listEvents({ runtimeId: 'rt_1' }).some((e) => e.type === 'status.failed')).toBe(false)
    await monitor.refresh('host_1', Date.now())
    expect(store.runtimes.get('rt_1')?.observedStatus).toBe('connected')
  })
})
