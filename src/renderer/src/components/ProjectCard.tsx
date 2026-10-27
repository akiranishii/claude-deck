import { TASK_STATUS_META } from '@shared/constants'
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Container,
  Copy,
  Ellipsis,
  FolderOpen,
  FolderX,
  GitBranch,
  Link2,
  MessagesSquare,
  Pencil,
  Pin,
  PinOff,
  Plus,
  SquareTerminal,
  Star,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { call, errorMessage } from '../lib/api'
import { copyText, deleteProject, setArchived, togglePin } from '../lib/actions'
import { relTime, tildePath } from '../lib/format'
import type { ProjectVM } from '../lib/selectors'
import { ui, useUi } from '../lib/store'
import { ConversationList } from './ConversationList'
import { RuntimeRow } from './RuntimeRow'
import { Badge, Button, cx, IconButton, Menu, Tip } from './ui'

export function projectMenuItems(vm: ProjectVM) {
  const p = vm.project
  return [
    { label: 'New session in this project…', icon: <Plus className="size-3.5" />, onSelect: () => ui().openDialog({ kind: 'new-session', projectId: p.id }) },
    { label: 'Edit project…', icon: <Pencil className="size-3.5" />, onSelect: () => ui().openDialog({ kind: 'project', projectId: p.id }) },
    { label: 'Link conversation…', icon: <Link2 className="size-3.5" />, onSelect: () => ui().openDialog({ kind: 'link', projectId: p.id }) },
    p.container?.enabled && {
      label: 'Open container terminal',
      icon: <SquareTerminal className="size-3.5" />,
      disabled: p.containerState?.state !== 'running',
      onSelect: () =>
        void call('open.containerTerminal', { projectId: p.id }).catch((err) => ui().toast('error', errorMessage(err))),
    },
    { label: 'Copy folder path', icon: <Copy className="size-3.5" />, separatorBefore: true, onSelect: () => void copyText(p.remotePath, 'path') },
    p.pinned
      ? { label: 'Unpin', icon: <PinOff className="size-3.5" />, onSelect: () => void togglePin(p) }
      : { label: 'Pin to dashboard', icon: <Pin className="size-3.5" />, onSelect: () => void togglePin(p) },
    p.archived
      ? { label: 'Restore from archive', icon: <ArchiveRestore className="size-3.5" />, onSelect: () => void setArchived(p, false) }
      : { label: 'Archive project', icon: <Archive className="size-3.5" />, onSelect: () => void setArchived(p, true) },
    { label: 'Delete project metadata…', icon: <Trash2 className="size-3.5" />, danger: true, separatorBefore: true, onSelect: () => deleteProject(vm) },
  ]
}

export function GitLabel({ vm }: { vm: ProjectVM }) {
  const g = vm.project.git
  if (!g?.isRepo) return null
  const dirty = (g.dirtyCount ?? 0) > 0
  const tip = (
    <div className="space-y-0.5">
      <div className="font-semibold">{g.branch ?? `detached at ${g.head ?? '?'}`}</div>
      <div className="opacity-80">{dirty ? `${g.dirtyCount} modified file(s)` : 'Working tree clean'}{g.isWorktree ? ' · git worktree' : ''}</div>
      {(g.ahead || g.behind) && (
        <div className="opacity-80">
          {g.ahead ? `${g.ahead} ahead` : ''} {g.behind ? `${g.behind} behind upstream` : ''}
        </div>
      )}
      {g.lastCommit && (
        <div className="opacity-70">
          {g.lastCommit.hash} {g.lastCommit.subject}
        </div>
      )}
    </div>
  )
  return (
    <Tip label={tip}>
      <span className="inline-flex min-w-0 items-center gap-1">
        <GitBranch className="size-3 shrink-0" />
        <span className="truncate">{g.branch ?? g.head ?? 'detached'}</span>
        {dirty && <span className="size-1.5 shrink-0 rounded-full bg-warn" />}
        {g.isWorktree && <span className="text-fg-3">(worktree)</span>}
      </span>
    </Tip>
  )
}

export function ContainerLabel({ vm }: { vm: ProjectVM }) {
  const c = vm.project.container
  if (!c?.enabled) return null
  const s = vm.project.containerState
  const running = s?.state === 'running'
  return (
    <Tip label={s?.found ? `Dev container ${s.name} · ${s.status ?? s.state}${s.workspaceMount ? ` · ${s.workspaceMount.destination}` : ''}` : s?.error ? `Container check failed: ${s.error}` : 'Dev container not found'}>
      <span className={cx('inline-flex items-center gap-1', running ? 'text-ok' : 'text-fg-3')}>
        <Container className="size-3" />
        {s?.found ? (running ? 'container' : s.state ?? 'container') : 'no container'}
      </span>
    </Tip>
  )
}

export function ProjectCard({ vm }: { vm: ProjectVM }) {
  const p = vm.project
  const expanded = useUi((s) => Boolean(s.expanded[`prj:${p.id}`]))
  const showAll = useUi((s) => Boolean(s.expanded[`prj-all:${p.id}`]))
  const home = vm.host?.homePath
  const visible = showAll ? vm.runtimes : vm.runtimes.slice(0, 4)
  const task = p.taskStatus ? TASK_STATUS_META[p.taskStatus] : null

  return (
    <article className="group/card flex flex-col overflow-hidden rounded-card border border-line bg-panel shadow-card">
      <div className="flex h-[3px] shrink-0">
        {vm.accounts.length ? vm.accounts.map((a) => <span key={a.id} className="flex-1" style={{ background: a.color }} />) : <span className="flex-1 bg-line" />}
      </div>
      <header className="px-4 pt-3 pb-2">
        <div className="flex items-center gap-1.5">
          <h2 className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em]">{p.displayName}</h2>
          {task && (
            <Badge tone={task.tone === 'muted' ? 'neutral' : (task.tone as 'ok' | 'info' | 'danger')} className="ml-0.5">
              {task.label}
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            <IconButton label={p.pinned ? 'Pinned — click to unpin' : 'Pin to the top of the dashboard'} onClick={() => void togglePin(p)} className={cx(p.pinned ? 'text-warn' : 'opacity-0 group-hover/card:opacity-100')}>
              <Star className="size-3.5" fill={p.pinned ? 'currentColor' : 'none'} />
            </IconButton>
            <IconButton label="New session in this project" onClick={() => ui().openDialog({ kind: 'new-session', projectId: p.id })}>
              <Plus className="size-4" />
            </IconButton>
            <Menu
              trigger={
                <button className="inline-flex size-7 items-center justify-center rounded-md text-fg-3 hover:bg-panel-2 hover:text-fg" aria-label="Project actions">
                  <Ellipsis className="size-4" />
                </button>
              }
              items={projectMenuItems(vm)}
            />
          </div>
        </div>
        <button
          type="button"
          onClick={() => ui().openDialog({ kind: 'project', projectId: p.id })}
          className={cx('mt-1 block w-full text-left text-[13.5px] leading-snug', p.taskSummary ? 'text-fg' : 'text-fg-3 italic hover:text-fg-2')}
        >
          {p.taskSummary ?? 'What is this project working on? Click to add a task…'}
        </button>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-fg-3">
          <Tip label={p.remotePath}>
            <span className={cx('inline-flex min-w-0 items-center gap-1 font-mono text-[11px]', p.pathStatus === 'missing' ? 'text-danger' : 'text-fg-2')}>
              {p.pathStatus === 'missing' ? <FolderX className="size-3 shrink-0" /> : <FolderOpen className="size-3 shrink-0" />}
              <span className="truncate">{tildePath(p.remotePath, home)}</span>
            </span>
          </Tip>
          <GitLabel vm={vm} />
          <Tip label={`${vm.conversations.length} conversation link(s) saved for this project`}>
            <span className="inline-flex items-center gap-1">
              <MessagesSquare className="size-3" />
              {vm.conversations.length}
              {vm.liveCount > 0 && <span className="text-ok">({vm.liveCount} live)</span>}
            </span>
          </Tip>
          <span>{vm.lastActivity ? relTime(vm.lastActivity) : ''}</span>
          <ContainerLabel vm={vm} />
          {p.tags.map((t) => (
            <button key={t} type="button" onClick={() => ui().toggleFilter('tagFilter', t)} className="rounded bg-panel-2 px-1.5 py-px text-[11px] text-fg-2 hover:bg-panel-3">
              #{t}
            </button>
          ))}
        </div>
        {p.pathStatus === 'missing' && (
          <div className="mt-2 flex items-center gap-1.5 text-[12px] text-danger">
            <TriangleAlert className="size-3.5" /> The folder was not found on the VM (renamed or removed?). Nothing was deleted — edit the project to update its path.
          </div>
        )}
      </header>

      <div className="space-y-0.5 border-t border-line px-1.5 py-1.5">
        {visible.map((r) => (
          <RuntimeRow key={r.runtime.id} vm={r} />
        ))}
        {vm.runtimes.length === 0 && (
          <div className="flex items-center justify-between gap-3 px-2.5 py-2 text-[12.5px] text-fg-3">
            No Claude session for this project yet.
            <Button size="sm" variant="subtle" icon={<Plus className="size-3.5" />} onClick={() => ui().openDialog({ kind: 'new-session', projectId: p.id })}>
              Start a session
            </Button>
          </div>
        )}
        {vm.runtimes.length > 4 && (
          <button type="button" onClick={() => ui().toggleExpanded(`prj-all:${p.id}`)} className="w-full rounded-lg px-2.5 py-1 text-left text-[12px] text-fg-3 hover:bg-panel-2 hover:text-fg-2">
            {showAll ? 'Show fewer sessions' : `Show ${vm.runtimes.length - 4} more session(s)`}
          </button>
        )}
      </div>

      {(p.notes || vm.orphanConversations.length > 0 || expanded) && (
        <div className="border-t border-line px-4 py-2">
          <button type="button" onClick={() => ui().toggleExpanded(`prj:${p.id}`)} className="flex w-full items-center gap-1 text-[11.5px] font-medium text-fg-3 hover:text-fg-2">
            <ChevronDown className={cx('size-3.5 transition-transform', !expanded && '-rotate-90')} />
            Notes{vm.orphanConversations.length ? ` & ${vm.orphanConversations.length} unattached link(s)` : ''}
          </button>
          {expanded && (
            <div className="mt-2 space-y-3 pb-1">
              {p.notes ? (
                <div className="text-[12.5px] whitespace-pre-wrap text-fg-2 select-text">{p.notes}</div>
              ) : (
                <button className="text-[12.5px] text-fg-3 italic" onClick={() => ui().openDialog({ kind: 'project', projectId: p.id })}>
                  Add notes…
                </button>
              )}
              {vm.orphanConversations.length > 0 && (
                <div>
                  <div className="mb-1 text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase">Links not attached to a session</div>
                  <ConversationList conversations={vm.orphanConversations} defaultId={null} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  )
}
