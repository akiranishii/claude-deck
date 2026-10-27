import type { DeckState } from '@shared/types'
import { Activity, Archive, KeyRound, LayoutDashboard, Layers, RefreshCw, Settings, Users, Globe } from 'lucide-react'
import type { ReactNode } from 'react'
import { refreshAll } from '../lib/actions'
import { relTime } from '../lib/format'
import { needsAttention, type ProjectVM, type RuntimeVM } from '../lib/selectors'
import { ui, useUi, type View } from '../lib/store'
import { cx, Kbd, Tip } from './ui'

function NavItem({ id, icon, label, count, alert }: { id: View; icon: ReactNode; label: string; count?: number; alert?: number }) {
  const active = useUi((s) => s.view === id)
  return (
    <button
      type="button"
      onClick={() => ui().setView(id)}
      className={cx(
        'flex h-[30px] w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors',
        active ? 'bg-black/[0.07] font-semibold text-fg dark:bg-white/[0.08]' : 'text-fg-2 hover:bg-black/[0.04] hover:text-fg dark:hover:bg-white/[0.04]',
      )}
    >
      <span className={cx('flex size-4 items-center justify-center', active ? 'text-accent' : 'text-fg-3')}>{icon}</span>
      <span className="flex-1 truncate text-left">{label}</span>
      {alert ? (
        <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-warn px-1 text-[10.5px] font-semibold text-white">{alert}</span>
      ) : count !== undefined && count > 0 ? (
        <span className="text-[11.5px] text-fg-3 tabular">{count}</span>
      ) : null}
    </button>
  )
}

export function Sidebar({ state, projects, runtimes }: { state: DeckState; projects: ProjectVM[]; runtimes: RuntimeVM[] }) {
  const accountFilter = useUi((s) => s.accountFilter)
  const refreshing = useUi((s) => Boolean(s.busy.refresh)) || Object.values(state.live.hosts).some((h) => h.refreshing)
  const active = runtimes.filter((r) => !r.runtime.archived && !r.project.archived)
  const running = active.filter((r) => r.running).length
  const attention = active.filter(needsAttention).length
  const accounts = state.accounts.filter((a) => !a.archived)
  const accountIssues = accounts.filter((a) => !a.chromeProfileDir || a.authState === 'logged_out').length

  return (
    <aside className="flex w-[236px] shrink-0 flex-col bg-sidebar">
      <div className="drag h-[52px] shrink-0" />
      <div className="flex items-center gap-2 px-4 pb-3">
        <img src={new URL('../assets/logo.svg', import.meta.url).href} className="size-6 rounded-[7px]" alt="" draggable={false} />
        <div className="text-[14px] font-semibold tracking-[-0.01em]">Claude Deck</div>
      </div>
      <nav className="space-y-px px-2.5">
        <NavItem id="dashboard" icon={<LayoutDashboard className="size-4" />} label="Dashboard" alert={attention || undefined} />
        <NavItem id="running" icon={<Activity className="size-4" />} label="Running Sessions" count={running} />
        <NavItem id="projects" icon={<Layers className="size-4" />} label="All Projects" count={projects.filter((p) => !p.project.archived).length} />
        <NavItem id="accounts" icon={<Users className="size-4" />} label="Claude Accounts" count={accounts.length} alert={accountIssues || undefined} />
        <NavItem id="archived" icon={<Archive className="size-4" />} label="Archived" count={projects.filter((p) => p.project.archived).length} />
        <NavItem id="settings" icon={<Settings className="size-4" />} label="Settings" />
      </nav>

      <div className="mt-5 flex items-center justify-between px-5 pb-1.5">
        <span className="text-[11px] font-semibold tracking-[0.06em] text-fg-3 uppercase">Accounts</span>
        {accountFilter.length > 0 && (
          <button className="text-[11px] text-accent hover:underline" onClick={() => ui().setFilter('accountFilter', [])}>
            Clear
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-px overflow-y-auto px-2.5">
        {accounts.map((a, i) => {
          const on = accountFilter.includes(a.id)
          const count = active.filter((r) => r.account?.id === a.id && r.running).length
          return (
            <Tip
              key={a.id}
              side="right"
              label={
                <div>
                  <div className="font-semibold">{a.displayName}</div>
                  <div className="opacity-80">{a.authEmail ?? a.label ?? 'not checked'}</div>
                  <div className="opacity-80">{a.chromeProfileName ? `Chrome: ${a.chromeProfileName} (${a.chromeProfileDir})` : 'No Chrome profile assigned'}</div>
                  <div className="opacity-60">Click or ⌘{i + 1} to filter</div>
                </div>
              }
            >
              <button
                type="button"
                onClick={() => ui().toggleFilter('accountFilter', a.id)}
                className={cx(
                  'flex h-[28px] w-full items-center gap-2.5 rounded-lg px-2.5 text-[12.5px]',
                  on ? 'bg-black/[0.07] font-medium text-fg dark:bg-white/[0.08]' : 'text-fg-2 hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
                )}
              >
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: a.color, boxShadow: on ? `0 0 0 3px color-mix(in srgb, ${a.color} 30%, transparent)` : undefined }} />
                <span className="flex-1 truncate text-left">{a.displayName}</span>
                {a.authState === 'logged_out' && <KeyRound className="size-3 text-danger" />}
                {!a.chromeProfileDir && <Globe className="size-3 text-warn" />}
                {count > 0 && <span className="text-[11px] text-fg-3 tabular">{count}</span>}
                {i < 5 && <Kbd className="opacity-60">⌘{i + 1}</Kbd>}
              </button>
            </Tip>
          )
        })}
        {accounts.length === 0 && (
          <button className="w-full rounded-lg px-2.5 py-1.5 text-left text-[12px] text-fg-3 hover:text-fg-2" onClick={() => ui().openDialog({ kind: 'account' })}>
            + Add a Claude account
          </button>
        )}
      </div>

      <div className="space-y-1.5 p-2.5">
        {state.hosts.map((h) => {
          const live = state.live.hosts[h.id]
          const offline = live?.reachable === false || h.lastConnectionStatus === 'offline' || h.lastConnectionStatus === 'auth_failed'
          // "Connected" only once the VM has answered in this app session, not from last time's record.
          const online = !offline && live?.reachable === true
          return (
            <div key={h.id} className="rounded-xl border border-line/70 bg-panel/60 px-3 py-2 dark:bg-panel/40">
              <div className="flex items-center gap-2">
                <span className={cx('size-2 rounded-full', online ? 'bg-ok' : offline ? 'bg-danger' : 'bg-muted')} />
                <span className="flex-1 truncate text-[12.5px] font-semibold">{h.displayName}</span>
                <Tip label="Refresh now (⌘R)">
                  <button className="rounded p-0.5 text-fg-3 hover:bg-panel-2 hover:text-fg" onClick={() => void refreshAll()} aria-label="Refresh">
                    <RefreshCw className={cx('size-3.5', refreshing && 'animate-spin-slow')} />
                  </button>
                </Tip>
              </div>
              <div className={cx('mt-0.5 truncate text-[11px]', offline ? 'text-danger' : 'text-fg-3')} title={live?.error ?? h.lastConnectionError ?? undefined}>
                {offline
                  ? live?.error ?? h.lastConnectionError ?? 'Unreachable'
                  : online
                    ? `Connected · updated ${live?.lastSnapshotAt ? relTime(live.lastSnapshotAt) : 'just now'}`
                    : 'Checking connection…'}
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
