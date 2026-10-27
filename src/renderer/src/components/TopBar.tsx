import { STATUS_FILTER_GROUPS } from '@shared/constants'
import type { DeckState } from '@shared/types'
import { ArrowUpDown, LayoutGrid, List, ListFilter, Plus, RefreshCw, Search, X } from 'lucide-react'
import { forwardRef, type ReactNode } from 'react'
import { call } from '../lib/api'
import { refreshAll } from '../lib/actions'
import { allTags } from '../lib/selectors'
import { ui, useUi, type SortKey } from '../lib/store'
import { Button, cx, IconButton, Kbd, Menu, Segmented } from './ui'

function FilterButton({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  return (
    <span className={cx('inline-flex', count > 0 && 'text-accent')}>
      {children}
      <span className="sr-only">
        {label} {count}
      </span>
    </span>
  )
}

export const TopBar = forwardRef<HTMLInputElement, { state: DeckState; title: string; subtitle?: string; showViewToggle?: boolean; actions?: ReactNode }>(function TopBar(
  { state, title, subtitle, showViewToggle = true, actions },
  searchRef,
) {
  const search = useUi((s) => s.search)
  const accountFilter = useUi((s) => s.accountFilter)
  const statusFilter = useUi((s) => s.statusFilter)
  const tagFilter = useUi((s) => s.tagFilter)
  const projectFilter = useUi((s) => s.projectFilter)
  const sort = useUi((s) => s.sort)
  const refreshing = useUi((s) => Boolean(s.busy.refresh)) || Object.values(state.live.hosts).some((h) => h.refreshing)
  const tags = allTags(state)
  const accounts = state.accounts.filter((a) => !a.archived)
  const projects = state.projects.filter((p) => !p.archived)
  const activeFilters = accountFilter.length + statusFilter.length + tagFilter.length + projectFilter.length

  const setViewMode = (mode: 'cards' | 'list') => void call('settings.update', { viewMode: mode })

  const chips: { key: string; label: string; clear: () => void }[] = [
    ...accountFilter.map((id) => ({ key: `a${id}`, label: `Account: ${state.accounts.find((a) => a.id === id)?.displayName ?? '?'}`, clear: () => ui().toggleFilter('accountFilter', id) })),
    ...statusFilter.map((id) => ({ key: `s${id}`, label: `Status: ${STATUS_FILTER_GROUPS.find((g) => g.id === id)?.label ?? id}`, clear: () => ui().toggleFilter('statusFilter', id) })),
    ...tagFilter.map((t) => ({ key: `t${t}`, label: `#${t}`, clear: () => ui().toggleFilter('tagFilter', t) })),
    ...projectFilter.map((id) => ({ key: `p${id}`, label: `Project: ${state.projects.find((p) => p.id === id)?.displayName ?? '?'}`, clear: () => ui().toggleFilter('projectFilter', id) })),
  ]

  return (
    <div className="shrink-0 border-b border-line bg-bg/95 backdrop-blur">
      <div className="drag flex h-[56px] items-center gap-3 px-5">
        <div className="min-w-0">
          <h1 className="truncate text-[16px] font-semibold tracking-[-0.015em]">{title}</h1>
          {subtitle && <div className="-mt-0.5 truncate text-[11.5px] text-fg-3">{subtitle}</div>}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="relative w-[240px] lg:w-[300px]" data-no-drag>
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => ui().setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  ui().setSearch('')
                  e.currentTarget.blur()
                }
              }}
              placeholder="Filter projects, sessions, tasks…"
              spellCheck={false}
              className="h-8 w-full rounded-lg border border-line bg-panel pr-12 pl-8 text-[12.5px] outline-none placeholder:text-fg-3 hover:border-line-strong focus:border-accent focus:ring-3 focus:ring-accent/15"
            />
            {search ? (
              <button className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-fg-3 hover:text-fg" onClick={() => ui().setSearch('')} aria-label="Clear search">
                <X className="size-3.5" />
              </button>
            ) : (
              <button className="absolute top-1/2 right-2 -translate-y-1/2" onClick={() => ui().setPalette(true)} aria-label="Command palette">
                <Kbd>⌘K</Kbd>
              </button>
            )}
          </div>
          <Menu
            header="Filter"
            trigger={
              <Button size="md" variant={activeFilters ? 'subtle' : 'ghost'} className={cx('!px-2', activeFilters > 0 && 'text-accent')} icon={<ListFilter className="size-4" />}>
                <FilterButton label="filters" count={activeFilters}>
                  {activeFilters ? activeFilters : null}
                </FilterButton>
              </Button>
            }
            items={[
              ...accounts.map((a, i) => ({
                label: (
                  <span className="flex items-center gap-2">
                    <span className="size-2 rounded-full" style={{ background: a.color }} />
                    {a.displayName}
                  </span>
                ),
                checked: accountFilter.includes(a.id),
                hint: i < 5 ? `⌘${i + 1}` : undefined,
                onSelect: () => ui().toggleFilter('accountFilter', a.id),
              })),
              ...STATUS_FILTER_GROUPS.map((g, i) => ({
                label: g.label,
                checked: statusFilter.includes(g.id),
                separatorBefore: i === 0,
                onSelect: () => ui().toggleFilter('statusFilter', g.id),
              })),
              ...tags.map((t, i) => ({ label: `#${t}`, checked: tagFilter.includes(t), separatorBefore: i === 0, onSelect: () => ui().toggleFilter('tagFilter', t) })),
              ...projects.slice(0, 25).map((p, i) => ({
                label: p.displayName,
                checked: projectFilter.includes(p.id),
                separatorBefore: i === 0,
                onSelect: () => ui().toggleFilter('projectFilter', p.id),
              })),
              activeFilters > 0 && { label: 'Clear all filters', separatorBefore: true, onSelect: () => ui().clearFilters() },
            ]}
          />
          <Menu
            header="Sort by"
            trigger={
              <IconButton label="Sort" size="md">
                <ArrowUpDown className="size-4" />
              </IconButton>
            }
            items={(
              [
                ['activity', 'Last activity'],
                ['status', 'Status (attention first)'],
                ['name', 'Name'],
              ] as [SortKey, string][]
            ).map(([k, l]) => ({ label: l, checked: sort === k, onSelect: () => ui().setSort(k) }))}
          />
          {showViewToggle && (
            <Segmented
              value={state.settings.viewMode}
              onChange={setViewMode}
              options={[
                { value: 'cards', label: <LayoutGrid className="size-3.5" />, title: 'Cards (⌘⇧L)' },
                { value: 'list', label: <List className="size-3.5" />, title: 'Compact list (⌘⇧L)' },
              ]}
            />
          )}
          <IconButton label="Refresh status (⌘R)" size="md" onClick={() => void refreshAll()}>
            <RefreshCw className={cx('size-4', refreshing && 'animate-spin-slow')} />
          </IconButton>
          {actions}
          <Button variant="primary" size="md" icon={<Plus className="size-4" />} onClick={() => ui().openDialog({ kind: 'new-session' })}>
            New Session
          </Button>
        </div>
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-5 pb-2.5">
          {chips.map((c) => (
            <span key={c.key} className="inline-flex h-6 items-center gap-1 rounded-md border border-line bg-panel pr-1 pl-2 text-[11.5px] text-fg-2">
              {c.label}
              <button onClick={c.clear} className="rounded p-0.5 text-fg-3 hover:bg-panel-2 hover:text-fg" aria-label={`Remove ${c.label}`}>
                <X className="size-3" />
              </button>
            </span>
          ))}
          <button className="ml-1 text-[11.5px] text-accent hover:underline" onClick={() => ui().clearFilters()}>
            Clear all
          </button>
        </div>
      )}
    </div>
  )
})
