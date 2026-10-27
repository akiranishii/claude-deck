import { Ellipsis, Link2, Play, ShieldAlert, Square, SquareTerminal } from 'lucide-react'
import { openClaude, openTerminal, startRuntime, stopRuntime } from '../lib/actions'
import { relTime, tildePath } from '../lib/format'
import type { ProjectVM, RuntimeVM } from '../lib/selectors'
import { ui, useUi } from '../lib/store'
import { projectMenuItems } from './ProjectCard'
import { OpenClaudeButton, runtimeMenuItems } from './RuntimeRow'
import { AccountChip, ProfileTag, StatusPill } from './Status'
import { Button, cx, IconButton, Menu, Tip } from './ui'

function Row({ vm }: { vm: RuntimeVM }) {
  const r = vm.runtime
  const selected = useUi((s) => s.selectedRuntimeId === r.id)
  return (
    <div
      data-runtime-id={r.id}
      onClick={() => ui().select(r.id)}
      onDoubleClick={() => void openClaude({ runtimeId: r.id })}
      className={cx(
        'grid h-10 grid-cols-[minmax(130px,1.1fr)_minmax(110px,0.8fr)_104px_minmax(120px,0.9fr)_minmax(130px,1fr)_56px_auto] items-center gap-3 border-b border-line px-3 text-[12.5px] last:border-b-0',
        selected ? 'bg-accent-soft/60' : 'hover:bg-panel-2/70',
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-fg-2">{r.remoteControlName ?? r.tmuxSessionName}</span>
        {vm.bypass && (
          <Tip label="Bypass permissions">
            <ShieldAlert className="size-3.5 shrink-0 text-warn" />
          </Tip>
        )}
      </div>
      <div className="flex min-w-0 flex-col justify-center">
        <AccountChip account={vm.account} profile={vm.profile} home={vm.host?.homePath} className="self-start" />
      </div>
      <StatusPill status={vm.status} detail={r.statusDetail} evidence={r.statusEvidence} pending={!vm.checked && vm.status !== 'host_unreachable'} />
      <span className="truncate font-mono text-[11px] text-fg-2" title={r.tmuxSessionName}>
        {r.tmuxSessionName}
      </span>
      <ProfileTag issue={vm.profileIssue} profile={vm.profile} dir={vm.account?.chromeProfileDir} />
      <Tip label={vm.conversations.length ? `${vm.conversations.length} conversation link(s)` : r.environmentId ? 'Environment link only' : 'No link yet'}>
        <span className="inline-flex items-center gap-1 text-[11.5px] text-fg-3">
          <Link2 className="size-3" />
          {vm.conversations.length || (r.environmentId ? 'env' : '–')}
          {vm.liveConversations > 0 && <span className="text-ok">({vm.liveConversations})</span>}
        </span>
      </Tip>
      <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
        <OpenClaudeButton vm={vm} size="xs" />
        <IconButton size="xs" label="Open terminal" disabled={r.observedStatus === 'missing'} onClick={() => void openTerminal(r.id)}>
          <SquareTerminal className="size-3.5" />
        </IconButton>
        {vm.running ? (
          <IconButton size="xs" label="Stop Claude" onClick={() => stopRuntime(r.id)}>
            <Square className="size-3" />
          </IconButton>
        ) : (
          <IconButton size="xs" label="Start Claude" disabled={vm.status === 'host_unreachable'} onClick={() => startRuntime(r.id)}>
            <Play className="size-3" />
          </IconButton>
        )}
        <Menu
          trigger={
            <button className="inline-flex size-6 items-center justify-center rounded-md text-fg-3 hover:bg-panel-3 hover:text-fg" aria-label="More">
              <Ellipsis className="size-3.5" />
            </button>
          }
          items={runtimeMenuItems(vm)}
        />
      </div>
    </div>
  )
}

export function SessionTable({ projects }: { projects: ProjectVM[] }) {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-panel shadow-card">
      {projects.map((p) => (
        <div key={p.project.id} className="border-b border-line last:border-b-0">
          <div className="flex items-center gap-3 bg-panel-2/60 px-3 py-1.5">
            <span className="h-3.5 w-1 rounded-full" style={{ background: p.accounts[0]?.color ?? 'var(--line-strong)' }} />
            <span className="truncate text-[13px] font-semibold">{p.project.displayName}</span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-2">{p.project.taskSummary ?? ''}</span>
            <span className="hidden font-mono text-[11px] text-fg-3 lg:inline">{tildePath(p.project.remotePath, p.host?.homePath)}</span>
            {p.project.git?.branch && <span className="text-[11.5px] text-fg-3">⎇ {p.project.git.branch}</span>}
            <span className="w-16 text-right text-[11.5px] text-fg-3">{relTime(p.lastActivity)}</span>
            <Menu
              trigger={
                <button className="inline-flex size-6 items-center justify-center rounded-md text-fg-3 hover:bg-panel-3 hover:text-fg" aria-label="Project actions">
                  <Ellipsis className="size-3.5" />
                </button>
              }
              items={projectMenuItems(p)}
            />
          </div>
          {p.runtimes.map((r) => (
            <Row key={r.runtime.id} vm={r} />
          ))}
          {p.runtimes.length === 0 && (
            <div className="flex h-10 items-center justify-between px-3 text-[12px] text-fg-3">
              No session yet
              <Button size="xs" variant="ghost" onClick={() => ui().openDialog({ kind: 'new-session', projectId: p.project.id })}>
                Start a session
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
