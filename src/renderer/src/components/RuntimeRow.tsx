import { PERMISSION_MODE_META, SPAWN_MODE_META, STATUS_META } from '@shared/constants'
import { configDirLabel } from '@shared/naming'
import { environmentUrl } from '@shared/urls'
import {
  ArrowUpRight,
  ChevronRight,
  Copy,
  Ellipsis,
  FolderOpen,
  Link2,
  Pencil,
  Play,
  Power,
  Radio,
  RotateCw,
  ScrollText,
  ShieldAlert,
  Square,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Users,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { copyText, endSession, openClaude, openTerminal, removeRuntime, startRuntime, stopRuntime } from '../lib/actions'
import { duration, modelLabel, plural, relTime, tildePath } from '../lib/format'
import type { RuntimeVM } from '../lib/selectors'
import { ui, useUi } from '../lib/store'
import { ConversationList } from './ConversationList'
import { AccountAvatar, AccountChip, ProfileTag, StatusPill } from './Status'
import { Badge, Button, cx, IconButton, Menu, Tip } from './ui'

function openTargetTip(vm: RuntimeVM): ReactNode {
  const conv = vm.defaultConversation
  const where = vm.profile ? `Chrome profile “${vm.profile.name}” (${vm.profile.directory})` : vm.account?.chromeProfileDir ? `Chrome profile ${vm.account.chromeProfileDir}` : 'no Chrome profile assigned'
  return (
    <div className="space-y-0.5">
      <div className="font-semibold">Open Claude</div>
      <div>
        {conv ? `Conversation: ${conv.displayTitle ?? conv.autoTitle ?? conv.remoteSessionId}` : vm.runtime.environmentId ? 'Environment page (no conversation link yet)' : 'claude.ai/code (no link known yet)'}
      </div>
      <div className="opacity-80">
        As {vm.account?.displayName ?? 'unconfirmed account'} · {where}
      </div>
      <div className="opacity-60">Enter</div>
    </div>
  )
}

export function OpenClaudeButton({ vm, size = 'sm' }: { vm: RuntimeVM; size?: 'xs' | 'sm' | 'md' }) {
  const busy = useUi((s) => s.busy[`open:${vm.runtime.id}`])
  const color = vm.account?.color
  return (
    <Tip label={openTargetTip(vm)}>
      <Button
        size={size}
        variant="primary"
        loading={Boolean(busy)}
        onClick={(e) => {
          e.stopPropagation()
          void openClaude({ runtimeId: vm.runtime.id })
        }}
        style={color ? { background: color } : undefined}
        className="text-white hover:brightness-[0.93]"
        icon={<ArrowUpRight className="size-3.5" />}
      >
        Open Claude
      </Button>
    </Tip>
  )
}

export function runtimeMenuItems(vm: RuntimeVM) {
  const r = vm.runtime
  const home = vm.host?.homePath
  return [
    { label: 'Open environment page', icon: <Radio className="size-3.5" />, disabled: !r.environmentId, onSelect: () => void openClaude({ runtimeId: r.id, target: 'environment' }) },
    { label: 'Open terminal (tmux)', icon: <SquareTerminal className="size-3.5" />, disabled: r.observedStatus === 'missing', onSelect: () => void openTerminal(r.id) },
    { label: 'Link conversation…', icon: <Link2 className="size-3.5" />, onSelect: () => ui().openDialog({ kind: 'link', projectId: r.projectId, runtimeId: r.id }) },
    { label: 'Activity & output', icon: <ScrollText className="size-3.5" />, onSelect: () => ui().openDialog({ kind: 'activity', runtimeId: r.id }) },
    { label: 'Copy folder path', icon: <FolderOpen className="size-3.5" />, separatorBefore: true, onSelect: () => void copyText(vm.project.remotePath, 'path') },
    vm.defaultConversation && { label: 'Copy conversation URL', icon: <Copy className="size-3.5" />, onSelect: () => void copyText(vm.defaultConversation!.url, 'conversation URL') },
    r.environmentId && { label: 'Copy environment URL', icon: <Copy className="size-3.5" />, onSelect: () => void copyText(environmentUrl(r.environmentId!), 'environment URL') },
    { label: `Copy tmux attach command`, icon: <Copy className="size-3.5" />, onSelect: () => void copyText(`ssh -t ${vm.host?.sshAlias ?? ''} tmux attach -t '=${r.tmuxSessionName}'`, 'attach command') },
    { label: 'Edit session…', icon: <Pencil className="size-3.5" />, separatorBefore: true, onSelect: () => ui().openDialog({ kind: 'runtime', runtimeId: r.id }) },
    vm.running
      ? { label: 'Restart Claude', icon: <RotateCw className="size-3.5" />, onSelect: () => startRuntime(r.id, true) }
      : { label: 'Start Claude', icon: <Play className="size-3.5" />, disabled: !vm.hostReachable, onSelect: () => startRuntime(r.id) },
    vm.running && { label: 'Stop Claude…', icon: <Square className="size-3.5" />, onSelect: () => stopRuntime(r.id) },
    { label: 'End tmux session…', icon: <Power className="size-3.5" />, danger: true, disabled: r.observedStatus === 'missing' || !vm.hostReachable, onSelect: () => endSession(r.id) },
    { label: 'Remove from dashboard', icon: <Trash2 className="size-3.5" />, danger: true, separatorBefore: true, onSelect: () => removeRuntime(vm) },
    { label: `Config: ${configDirLabel(vm.account?.configDir ?? null, home)}`, disabled: true, separatorBefore: true },
  ]
}

function Detail({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase">{label}</div>
      <div className={cx('mt-0.5 truncate text-[12px] text-fg', mono && 'font-mono text-[11.5px]')}>{children}</div>
    </div>
  )
}

export function RuntimeDetails({ vm, wide = false }: { vm: RuntimeVM; wide?: boolean }) {
  const r = vm.runtime
  const home = vm.host?.homePath
  const live = vm.live
  const perm = r.permissionMode ?? (r.observedFlags?.permissionMode as keyof typeof PERMISSION_MODE_META | undefined) ?? null
  const spawn = r.spawnMode ?? (r.observedFlags?.spawn as keyof typeof SPAWN_MODE_META | undefined) ?? null
  return (
    <div className="@container space-y-3 pt-1 pb-2">
      <div className={cx('grid gap-x-5 gap-y-2.5 rounded-xl border border-line bg-panel-2/50 p-3', wide ? 'grid-cols-3' : 'grid-cols-2')}>
        <Detail label="Remote Control name">{r.remoteControlName ?? r.observedFlags?.name ?? '—'}</Detail>
        <Detail label="tmux session" mono>
          {r.tmuxSessionName}
          {r.tmuxPaneId ? ` · ${r.tmuxPaneId}` : ''}
          {!r.managed ? ' · external' : ''}
        </Detail>
        <Detail label="CLAUDE_CONFIG_DIR" mono>
          {configDirLabel(vm.account?.configDir ?? null, home)}
        </Detail>
        <Detail label="Permission mode">{perm ? PERMISSION_MODE_META[perm as keyof typeof PERMISSION_MODE_META]?.label ?? perm : 'Default'}</Detail>
        <Detail label="Spawn mode">
          {spawn ? SPAWN_MODE_META[spawn as keyof typeof SPAWN_MODE_META]?.label ?? spawn : 'Same directory'}
          {r.observedFlags?.liveSpawnNote ? <span className="text-fg-3"> · {r.observedFlags.liveSpawnNote.replace(/^New sessions will be created /, '')}</span> : null}
        </Detail>
        <Detail label="Process">{r.serverPid ? `pid ${r.serverPid} · up ${duration(r.serverStartedAt)}` : '—'}</Detail>
        <Detail label="Connection">
          {r.lastConnectedAt ? `confirmed ${relTime(r.lastConnectedAt)}` : 'never confirmed'}
          {live?.httpsConnections ? ` · ${live.httpsConnections} TLS` : ''}
        </Detail>
        <Detail label="Environment">
          {r.environmentId ? (
            <button className="truncate text-accent hover:underline" onClick={() => void openClaude({ runtimeId: r.id, target: 'environment' })}>
              {r.environmentId}
            </button>
          ) : (
            'not captured yet'
          )}
        </Detail>
        <Detail label="Account evidence">
          {r.accountEvidence === 'process-env' ? 'Process environment' : r.accountEvidence === 'launched' ? 'Launched by Claude Deck' : r.accountEvidence === 'user' ? 'Assigned by you' : 'Unconfirmed'}
        </Detail>
      </div>
      {r.lastLaunchCommand && (
        <div className="rounded-lg border border-line bg-panel px-2.5 py-1.5">
          <div className="text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase">Launch command</div>
          <div className="terminal-text mt-0.5 text-fg-2 select-text">{r.lastLaunchCommand}</div>
        </div>
      )}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <div className="text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase">Conversations</div>
          <Button size="xs" variant="ghost" icon={<Link2 className="size-3" />} onClick={() => ui().openDialog({ kind: 'link', projectId: r.projectId, runtimeId: r.id })}>
            Link conversation
          </Button>
        </div>
        <ConversationList
          conversations={vm.conversations}
          defaultId={vm.defaultConversation?.id ?? null}
          empty={
            <span>
              No conversation link captured yet{vm.runtime.environmentId ? ' — Open Claude will use the environment page' : ''}. Links appear automatically when a conversation runs, or use{' '}
              <button className="text-accent hover:underline" onClick={() => ui().openDialog({ kind: 'link', projectId: r.projectId, runtimeId: r.id })}>
                Link conversation
              </button>
              .
            </span>
          }
        />
      </div>
      {live && live.screenTail.length > 0 && (
        <button
          type="button"
          onClick={() => ui().openDialog({ kind: 'activity', runtimeId: r.id })}
          className="block w-full rounded-lg border border-line bg-[#0f1218] px-3 py-2 text-left text-[#c9d1dc] hover:border-line-strong"
        >
          <div className="mb-1 flex items-center justify-between text-[10.5px] font-semibold tracking-wide text-[#7d8796] uppercase">
            <span>Recent output (sanitized)</span>
            <span className="normal-case">{relTime(live.observedAt)}</span>
          </div>
          <div className="terminal-text max-h-24 overflow-hidden">{live.screenTail.slice(-5).join('\n')}</div>
        </button>
      )}
    </div>
  )
}

export function RuntimeRow({ vm, wide = false, showProject = false }: { vm: RuntimeVM; wide?: boolean; showProject?: boolean }) {
  const r = vm.runtime
  const selected = useUi((s) => s.selectedRuntimeId === r.id)
  const expanded = useUi((s) => Boolean(s.expanded[`rt:${r.id}`]))
  const meta = STATUS_META[vm.status]
  const canStart = !vm.running && vm.status !== 'host_unreachable'
  const name = r.remoteControlName ?? r.observedFlags?.name ?? r.tmuxSessionName

  return (
    <div
      data-runtime-id={r.id}
      className={cx('group/rt relative rounded-xl transition-colors', selected ? 'bg-accent-soft/60 ring-1 ring-accent/40' : 'hover:bg-panel-2/70')}
      onClick={() => ui().select(r.id)}
    >
      <div className="flex items-start gap-2.5 px-2.5 py-2">
        <button
          type="button"
          className="mt-[3px] -ml-1 rounded p-0.5 text-fg-3 hover:bg-panel-3 hover:text-fg"
          aria-label={expanded ? 'Collapse' : 'Expand'}
          onClick={(e) => {
            e.stopPropagation()
            ui().toggleExpanded(`rt:${r.id}`)
          }}
        >
          <ChevronRight className={cx('size-3.5 transition-transform', expanded && 'rotate-90')} />
        </button>
        <AccountAvatar account={vm.account} size={24} className="mt-px" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            {showProject && <span className="truncate text-[13px] font-semibold">{vm.project.displayName}</span>}
            {showProject ? (
              <AccountChip account={vm.account} profile={vm.profile} home={vm.host?.homePath} onClick={!vm.account ? () => ui().openDialog({ kind: 'runtime', runtimeId: r.id }) : undefined} />
            ) : vm.account ? (
              <Tip label={`Account ${vm.account.displayName}${vm.account.authEmail ? ` · ${vm.account.authEmail}` : ''}`}>
                <span className="max-w-[170px] shrink-0 truncate text-[13px] font-semibold">{vm.account.displayName}</span>
              </Tip>
            ) : (
              <AccountChip account={null} onClick={() => ui().openDialog({ kind: 'runtime', runtimeId: r.id })} />
            )}
            <span className="min-w-0 truncate text-[12px] text-fg-3">{name !== vm.account?.displayName ? name : ''}</span>
            <StatusPill status={vm.status} detail={vm.status === 'host_unreachable' ? `Last observed: ${STATUS_META[r.observedStatus].label}` : r.statusDetail} evidence={r.statusEvidence} pending={!vm.checked && vm.status !== 'host_unreachable'} className="ml-auto shrink-0 pl-1" />
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-fg-3">
            <Tip label={`tmux session${r.managed ? ' (created by Claude Deck)' : ' (started outside Claude Deck)'}`}>
              <span className="font-mono text-[11px] text-fg-2">{r.tmuxSessionName}</span>
            </Tip>
            <ProfileTag issue={vm.profileIssue} profile={vm.profile} dir={vm.account?.chromeProfileDir} className="max-w-[240px]" />
            {vm.conversations.length > 0 ? (
              <Tip label={`${plural(vm.conversations.length, 'conversation link')} saved${vm.liveConversations ? `, ${vm.liveConversations} running now` : ''}`}>
                <span className="inline-flex items-center gap-1 text-fg-2">
                  <Link2 className="size-3" />
                  {vm.conversations.length}
                  {vm.liveConversations > 0 && <span className="text-ok">({vm.liveConversations} live)</span>}
                </span>
              </Tip>
            ) : (
              <Tip label={r.environmentId ? 'No direct conversation URL yet; the environment page is known' : 'No conversation or environment URL known yet'}>
                <span className="inline-flex items-center gap-1">
                  <Link2 className="size-3" />
                  {r.environmentId ? 'env only' : 'no link'}
                </span>
              </Tip>
            )}
            {vm.bypass && (
              <Tip label={PERMISSION_MODE_META.bypassPermissions.description}>
                <span>
                  <Badge tone="warn" icon={<ShieldAlert className="size-3" />}>
                    bypass
                  </Badge>
                </span>
              </Tip>
            )}
            {(r.spawnMode === 'worktree' || r.observedFlags?.spawn === 'worktree') && <Badge tone="info">worktree</Badge>}
            {vm.defaultConversation?.model && <span>{modelLabel(vm.defaultConversation.model)}</span>}
            {r.serverStartedAt && vm.running && <span className="tabular">up {duration(r.serverStartedAt)}</span>}
            {!vm.running && r.lastStoppedAt && <span>stopped {relTime(r.lastStoppedAt)}</span>}
            {vm.accountMismatch && (
              <Tip label="The running process uses a different CLAUDE_CONFIG_DIR than the account mapped here. Fix the mapping in Edit session.">
                <span>
                  <Badge tone="danger" icon={<TriangleAlert className="size-3" />}>
                    account conflict
                  </Badge>
                </span>
              </Tip>
            )}
            {vm.sharedDirWith.length > 0 && (
              <Tip label={`${plural(vm.sharedDirWith.length, 'other running session')} work in the same folder (${vm.sharedDirWith.map((o) => o.account?.displayName ?? o.runtime.tmuxSessionName).join(', ')}). Simultaneous edits can conflict — prefer worktree spawn mode for parallel code changes.`}>
                <span className="inline-flex items-center gap-1 text-warn">
                  <Users className="size-3" />
                  shared folder
                </span>
              </Tip>
            )}
          </div>
          {wide && r.taskSummary && <div className="mt-1 truncate text-[12.5px] text-fg-2">{r.taskSummary}</div>}
          {vm.status === 'needs_input' && (
            <div className="mt-1.5 flex items-center gap-2 rounded-lg bg-warn-soft px-2 py-1 text-[12px] text-fg">
              <TriangleAlert className="size-3.5 shrink-0 text-warn" />
              <span className="min-w-0 flex-1 truncate">Claude is asking: “{vm.live?.promptText ?? r.statusDetail}”</span>
              <Button size="xs" variant="secondary" icon={<SquareTerminal className="size-3" />} onClick={(e) => (e.stopPropagation(), void openTerminal(r.id))}>
                Answer in terminal
              </Button>
            </div>
          )}
          {(vm.status === 'failed' || vm.status === 'auth_required') && r.statusDetail && (
            <div className={cx('mt-1.5 truncate rounded-lg px-2 py-1 text-[12px]', 'bg-danger-soft text-danger')}>{r.statusDetail}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 pt-px" onClick={(e) => e.stopPropagation()}>
          <OpenClaudeButton vm={vm} />
          <IconButton
            label={r.environmentId ? 'Open the Remote Control environment page' : 'No environment link captured yet'}
            disabled={!r.environmentId}
            onClick={() => void openClaude({ runtimeId: r.id, target: 'environment' })}
          >
            <Radio className="size-4" />
          </IconButton>
          <IconButton label="Open terminal (tmux attach)" disabled={r.observedStatus === 'missing' || !vm.hostReachable} onClick={() => void openTerminal(r.id)}>
            <SquareTerminal className="size-4" />
          </IconButton>
          {vm.running ? (
            <IconButton label="Stop Claude (Ctrl+C)" onClick={() => stopRuntime(r.id)}>
              <Square className="size-3.5" />
            </IconButton>
          ) : (
            <IconButton label={canStart ? 'Start Claude' : meta.label} disabled={!canStart} onClick={() => startRuntime(r.id)}>
              <Play className="size-3.5" />
            </IconButton>
          )}
          <Menu
            trigger={
              <button className="inline-flex size-7 items-center justify-center rounded-md text-fg-3 hover:bg-panel-3 hover:text-fg" aria-label="More actions">
                <Ellipsis className="size-4" />
              </button>
            }
            items={runtimeMenuItems(vm)}
          />
        </div>
      </div>
      {expanded && (
        <div className="px-3 pb-1 pl-[46px]" onClick={(e) => e.stopPropagation()}>
          <RuntimeDetails vm={vm} wide={wide} />
        </div>
      )}
    </div>
  )
}

export function pathLabel(vm: RuntimeVM): string {
  return tildePath(vm.project.remotePath, vm.host?.homePath)
}
