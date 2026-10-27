import type { MenuCommand } from '@shared/ipc'
import { useEffect, useMemo, useRef } from 'react'
import { CommandPalette } from './components/CommandPalette'
import { Sidebar } from './components/Sidebar'
import { Toasts } from './components/Toasts'
import { TopBar } from './components/TopBar'
import { Spinner } from './components/ui'
import { DialogHost } from './dialogs/DialogHost'
import { call, errorMessage, on } from './lib/api'
import { openClaude, refreshAll } from './lib/actions'
import { buildVMs } from './lib/selectors'
import { ui, useUi, type View } from './lib/store'
import { AccountsView } from './views/AccountsView'
import { Onboarding } from './views/Onboarding'
import { ArchivedView, DashboardView, ProjectsView, RunningView } from './views/ProjectViews'
import { SettingsView } from './views/SettingsView'

const TITLES: Record<View, string> = {
  dashboard: 'Dashboard',
  running: 'Running Sessions',
  projects: 'All Projects',
  accounts: 'Claude Accounts',
  archived: 'Archived Projects',
  settings: 'Settings',
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
}

function moveSelection(delta: number): void {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('main [data-runtime-id]'))
  if (!rows.length) return
  const current = ui().selectedRuntimeId
  const idx = rows.findIndex((r) => r.dataset.runtimeId === current)
  const next = rows[Math.max(0, Math.min(rows.length - 1, idx < 0 ? (delta > 0 ? 0 : rows.length - 1) : idx + delta))]
  ui().select(next.dataset.runtimeId ?? null)
  next.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

export function App() {
  const state = useUi((s) => s.state)
  const view = useUi((s) => s.view)
  const searchRef = useRef<HTMLInputElement>(null)

  // State sync with the main process
  useEffect(() => {
    void call('state.get', undefined)
      .then((s) => ui().setState(s))
      .catch((err) => ui().toast('error', errorMessage(err)))
    const offs = [
      on('state', (s) => ui().setState(s)),
      on('progress', (e) => ui().pushProgress(e)),
      on('toast', (t) => ui().toast(t.level, t.message)),
      on('open-request', ({ runtimeId }) => void openClaude({ runtimeId })),
      on('focus-runtime', ({ runtimeId }) => {
        ui().setView('dashboard')
        ui().select(runtimeId)
        ui().toggleExpanded(`rt:${runtimeId}`, true)
      }),
      on('menu', ({ command }) => handleMenu(command)),
    ]
    return () => offs.forEach((off) => off())
  }, [])

  const handleMenu = (command: MenuCommand) => {
    const s = ui().state
    if (!s?.settings.onboardingComplete && command !== 'refresh') return
    switch (command) {
      case 'new-session':
        ui().openDialog({ kind: 'new-session' })
        break
      case 'refresh':
        void refreshAll()
        break
      case 'command-palette':
        ui().setPalette(true)
        break
      case 'settings':
        ui().setView('settings')
        break
      case 'import-sessions':
        if (s?.hosts[0]) ui().openDialog({ kind: 'import', hostId: s.hosts[0].id })
        break
      case 'toggle-view':
        void call('settings.update', { viewMode: s?.settings.viewMode === 'cards' ? 'list' : 'cards' })
        break
      case 'link-conversation':
        ui().openDialog({ kind: 'link' })
        break
      case 'focus-search':
        if (['settings', 'accounts'].includes(ui().view)) ui().setView('dashboard')
        setTimeout(() => searchRef.current?.focus(), 0)
        break
    }
  }

  // Theme
  const theme = state?.settings.theme ?? 'system'
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && media.matches))
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  // Keyboard shortcuts that are not menu accelerators
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = ui()
      if (!s.state?.settings.onboardingComplete) return
      if (s.dialogs.length || s.paletteOpen) return
      if (e.metaKey && !e.shiftKey && !e.altKey && /^[1-5]$/.test(e.key)) {
        const account = s.state.accounts.filter((a) => !a.archived)[Number(e.key) - 1]
        if (account) {
          e.preventDefault()
          s.toggleFilter('accountFilter', account.id)
        }
        return
      }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        moveSelection(1)
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        moveSelection(-1)
      } else if (e.key === 'Enter' && s.selectedRuntimeId) {
        e.preventDefault()
        void openClaude({ runtimeId: s.selectedRuntimeId })
      } else if (e.key === 'ArrowRight' && s.selectedRuntimeId) {
        s.toggleExpanded(`rt:${s.selectedRuntimeId}`, true)
      } else if (e.key === 'ArrowLeft' && s.selectedRuntimeId) {
        s.toggleExpanded(`rt:${s.selectedRuntimeId}`, false)
      } else if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'Escape') {
        s.select(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const vms = useMemo(() => (state ? buildVMs(state) : null), [state])

  if (!state || !vms) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg">
        <Spinner className="size-5" />
      </div>
    )
  }

  if (!state.settings.onboardingComplete) {
    return (
      <>
        <Onboarding state={state} />
        <DialogHost state={state} />
        <Toasts />
      </>
    )
  }

  const running = vms.runtimes.filter((r) => r.running && !r.runtime.archived).length
  const subtitle =
    view === 'dashboard' || view === 'projects'
      ? `${state.projects.filter((p) => !p.archived).length} projects · ${running} running session${running === 1 ? '' : 's'} · ${state.accounts.filter((a) => !a.archived).length} accounts`
      : view === 'running'
        ? `${running} running across ${new Set(vms.runtimes.filter((r) => r.running).map((r) => r.account?.id)).size} accounts`
        : undefined

  return (
    <div className="flex h-screen text-fg">
      <Sidebar state={state} projects={vms.projects} runtimes={vms.runtimes} />
      <main className="flex min-w-0 flex-1 flex-col border-l border-line bg-bg" onClick={(e) => e.target === e.currentTarget && ui().select(null)}>
        <TopBar ref={searchRef} state={state} title={TITLES[view]} subtitle={subtitle} showViewToggle={['dashboard', 'projects'].includes(view)} />
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-5 pb-10">
          {view === 'dashboard' && <DashboardView state={state} projects={vms.projects} runtimes={vms.runtimes} />}
          {view === 'running' && <RunningView state={state} runtimes={vms.runtimes} />}
          {view === 'projects' && <ProjectsView state={state} projects={vms.projects} />}
          {view === 'accounts' && <AccountsView state={state} runtimes={vms.runtimes} />}
          {view === 'archived' && <ArchivedView projects={vms.projects} />}
          {view === 'settings' && <SettingsView state={state} />}
        </div>
      </main>
      <DialogHost state={state} />
      <CommandPalette state={state} projects={vms.projects} runtimes={vms.runtimes} />
      <Toasts />
    </div>
  )
}
