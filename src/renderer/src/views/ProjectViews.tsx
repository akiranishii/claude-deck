import type { DeckState } from '@shared/types'
import { Activity, Archive, ArchiveRestore, ChevronDown, Download, Layers, Plus, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Banners } from '../components/Banners'
import { ProjectCard } from '../components/ProjectCard'
import { RuntimeRow } from '../components/RuntimeRow'
import { SessionTable } from '../components/SessionTable'
import { Button, cx, EmptyState, SectionTitle } from '../components/ui'
import { deleteProject, setArchived } from '../lib/actions'
import { relTime, tildePath } from '../lib/format'
import { filterProjects, filterRuntimes, needsAttention, sortProjects, statusRank, type ProjectVM, type RuntimeVM } from '../lib/selectors'
import { ui, useUi } from '../lib/store'

function useFilters() {
  const search = useUi((s) => s.search)
  const accountFilter = useUi((s) => s.accountFilter)
  const statusFilter = useUi((s) => s.statusFilter)
  const tagFilter = useUi((s) => s.tagFilter)
  const projectFilter = useUi((s) => s.projectFilter)
  const sort = useUi((s) => s.sort)
  return { filters: { search, accountFilter, statusFilter, tagFilter, projectFilter }, sort }
}

function ProjectGrid({ projects, mode }: { projects: ProjectVM[]; mode: 'cards' | 'list' }) {
  if (mode === 'list') return <SessionTable projects={projects} />
  return (
    <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,500px),1fr))]">
      {projects.map((p) => (
        <ProjectCard key={p.project.id} vm={p} />
      ))}
    </div>
  )
}

function Collapsible({ title, count, children, defaultOpen = true }: { title: string; count: number; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section>
      <button type="button" className="mb-2.5 flex items-center gap-1.5" onClick={() => setOpen(!open)}>
        <ChevronDown className={cx('size-3.5 text-fg-3 transition-transform', !open && '-rotate-90')} />
        <span className="text-[11px] font-semibold tracking-[0.06em] text-fg-3 uppercase">{title}</span>
        <span className="text-[11px] text-fg-3 tabular">{count}</span>
      </button>
      {open && children}
    </section>
  )
}

function NoMatches() {
  return (
    <EmptyState title="Nothing matches these filters" icon={<Layers className="size-5" />} action={<Button onClick={() => ui().clearFilters()}>Clear filters</Button>}>
      Try a different search or remove a filter.
    </EmptyState>
  )
}

export function DashboardView({ state, projects, runtimes }: { state: DeckState; projects: ProjectVM[]; runtimes: RuntimeVM[] }) {
  const { filters, sort } = useFilters()
  const active = projects.filter((p) => !p.project.archived)
  const filtered = sortProjects(filterProjects(active, filters), sort)
  const mode = state.settings.viewMode
  const pinned = filtered.filter((p) => p.project.pinned)
  const cutoff = Date.now() - 3 * 86_400_000
  const recent = filtered.filter((p) => !p.project.pinned && (p.anyRunning || p.lastActivity > cutoff))
  const rest = filtered.filter((p) => !p.project.pinned && !recent.includes(p))
  const attention = filterRuntimes(
    runtimes.filter((r) => !r.runtime.archived && !r.project.archived && (r.status === 'needs_input' || r.status === 'auth_required' || r.status === 'failed')),
    filters,
  )

  if (!active.length) {
    return (
      <div className="space-y-4">
        <Banners state={state} runtimes={runtimes} />
        <EmptyState
          title="No projects yet"
          icon={<Layers className="size-5" />}
          action={
            <div className="flex gap-2">
              {state.hosts[0] && (
                <Button icon={<Download className="size-4" />} onClick={() => ui().openDialog({ kind: 'import', hostId: state.hosts[0].id })}>
                  Import existing sessions
                </Button>
              )}
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => ui().openDialog({ kind: 'new-session' })}>
                New Session
              </Button>
            </div>
          }
        >
          Import the Claude Remote Control sessions already running on your VM, or create a new project and launch one.
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Banners state={state} runtimes={runtimes} />
      {attention.length > 0 && (
        <section>
          <SectionTitle>Needs attention</SectionTitle>
          <div className="rounded-card border border-warn/30 bg-panel p-1.5 shadow-card">
            {attention.map((r) => (
              <RuntimeRow key={r.runtime.id} vm={r} showProject wide />
            ))}
          </div>
        </section>
      )}
      {!filtered.length && <NoMatches />}
      {pinned.length > 0 && (
        <Collapsible title="Pinned" count={pinned.length}>
          <ProjectGrid projects={pinned} mode={mode} />
        </Collapsible>
      )}
      {recent.length > 0 && (
        <Collapsible title="Recently active" count={recent.length}>
          <ProjectGrid projects={recent} mode={mode} />
        </Collapsible>
      )}
      {rest.length > 0 && (
        <Collapsible title="Other projects" count={rest.length} defaultOpen={!pinned.length && !recent.length}>
          <ProjectGrid projects={rest} mode={mode} />
        </Collapsible>
      )}
    </div>
  )
}

export function RunningView({ state, runtimes }: { state: DeckState; runtimes: RuntimeVM[] }) {
  const { filters } = useFilters()
  const running = filterRuntimes(
    runtimes.filter((r) => !r.runtime.archived && !r.project.archived && (r.running || r.status === 'needs_input')),
    filters,
  ).sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.project.displayName.localeCompare(b.project.displayName))
  const accounts = state.accounts.filter((a) => running.some((r) => r.account?.id === a.id))
  const unassigned = running.filter((r) => !r.account)
  if (!running.length) {
    return (
      <EmptyState title="No running sessions" icon={<Activity className="size-5" />} action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => ui().openDialog({ kind: 'new-session' })}>New Session</Button>}>
        {filters.search || filters.accountFilter.length || filters.statusFilter.length ? 'Nothing running matches the current filters.' : 'Start a Claude Remote Control session to see it here.'}
      </EmptyState>
    )
  }
  return (
    <div className="space-y-5">
      {[...accounts.map((a) => ({ key: a.id, title: a.displayName, color: a.color, items: running.filter((r) => r.account?.id === a.id) })), ...(unassigned.length ? [{ key: 'none', title: 'Account unconfirmed', color: 'var(--warn)', items: unassigned }] : [])].map((group) => (
        <section key={group.key}>
          <div className="mb-2 flex items-center gap-2">
            <span className="size-2.5 rounded-full" style={{ background: group.color }} />
            <span className="text-[12.5px] font-semibold">{group.title}</span>
            <span className="text-[11.5px] text-fg-3">{group.items.length} running</span>
          </div>
          <div className="space-y-0.5 rounded-card border border-line bg-panel p-1.5 shadow-card">
            {group.items.map((r) => (
              <RuntimeRow key={r.runtime.id} vm={r} showProject wide />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export function ProjectsView({ state, projects }: { state: DeckState; projects: ProjectVM[] }) {
  const { filters, sort } = useFilters()
  const filtered = sortProjects(filterProjects(projects.filter((p) => !p.project.archived), filters), sort)
  if (!projects.some((p) => !p.project.archived)) {
    return (
      <EmptyState title="No projects" icon={<Layers className="size-5" />} action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => ui().openDialog({ kind: 'new-session' })}>New Session</Button>}>
        Projects are folders on your VM with one or more Claude sessions.
      </EmptyState>
    )
  }
  if (!filtered.length) return <NoMatches />
  return <ProjectGrid projects={filtered} mode={state.settings.viewMode} />
}

export function ArchivedView({ projects }: { projects: ProjectVM[] }) {
  const archived = projects.filter((p) => p.project.archived)
  if (!archived.length) {
    return (
      <EmptyState title="No archived projects" icon={<Archive className="size-5" />}>
        Archive projects you are done with to keep the dashboard focused. Archiving never touches the VM.
      </EmptyState>
    )
  }
  return (
    <div className="overflow-hidden rounded-card border border-line bg-panel shadow-card">
      {archived.map((p) => (
        <div key={p.project.id} className="flex items-center gap-4 border-b border-line px-4 py-3 last:border-b-0">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-semibold">{p.project.displayName}</div>
            <div className="truncate text-[12px] text-fg-3">
              {p.project.taskSummary ? `${p.project.taskSummary} · ` : ''}
              <span className="font-mono text-[11.5px]">{tildePath(p.project.remotePath, p.host?.homePath)}</span> · {p.runtimes.length} session(s) · {p.conversations.length} link(s) · last active {relTime(p.lastActivity)}
            </div>
          </div>
          <Button size="sm" icon={<ArchiveRestore className="size-3.5" />} onClick={() => void setArchived(p.project, false)}>
            Restore
          </Button>
          <Button size="sm" variant="ghost" className="text-danger" icon={<Trash2 className="size-3.5" />} onClick={() => deleteProject(p)}>
            Delete metadata
          </Button>
        </div>
      ))}
    </div>
  )
}

export function ViewNeedsAttentionCount({ runtimes }: { runtimes: RuntimeVM[] }) {
  return <>{runtimes.filter(needsAttention).length}</>
}
