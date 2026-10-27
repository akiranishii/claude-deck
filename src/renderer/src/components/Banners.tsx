import type { DeckState } from '@shared/types'
import { Globe, Inbox, KeyRound, Radar, TriangleAlert, WifiOff } from 'lucide-react'
import type { ReactNode } from 'react'
import { call, errorMessage } from '../lib/api'
import type { RuntimeVM } from '../lib/selectors'
import { ui } from '../lib/store'
import { Button, cx } from './ui'

function Banner({ tone, icon, children, action }: { tone: 'warn' | 'danger' | 'info' | 'offline'; icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  const styles = {
    warn: 'border-warn/30 bg-warn-soft',
    danger: 'border-danger/30 bg-danger-soft',
    info: 'border-info/25 bg-info-soft',
    offline: 'border-offline/30 bg-offline-soft',
  }[tone]
  const iconColor = { warn: 'text-warn', danger: 'text-danger', info: 'text-info', offline: 'text-offline' }[tone]
  return (
    <div className={cx('flex items-center gap-3 rounded-xl border px-3.5 py-2.5 text-[12.5px]', styles)}>
      <span className={cx('shrink-0', iconColor)}>{icon}</span>
      <div className="min-w-0 flex-1 text-fg">{children}</div>
      {action && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
    </div>
  )
}

export function Banners({ state, runtimes }: { state: DeckState; runtimes: RuntimeVM[] }) {
  const items: ReactNode[] = []
  for (const h of state.hosts) {
    const live = state.live.hosts[h.id]
    if (live?.reachable === false) {
      items.push(
        <Banner
          key={`off-${h.id}`}
          tone="offline"
          icon={<WifiOff className="size-4" />}
          action={
            <Button size="sm" variant="secondary" onClick={() => void call('host.reconnect', { id: h.id }).catch((e) => ui().toast('error', errorMessage(e)))}>
              Reconnect
            </Button>
          }
        >
          <b>{h.displayName} is unreachable.</b> Showing the last known state — sessions on the VM keep running. <span className="text-fg-2">{live.error}</span>
        </Banner>,
      )
    }
    if (live?.untracked.length) {
      items.push(
        <Banner
          key={`untracked-${h.id}`}
          tone="info"
          icon={<Radar className="size-4" />}
          action={
            <Button size="sm" variant="secondary" onClick={() => ui().openDialog({ kind: 'import', hostId: h.id })}>
              Review & import
            </Button>
          }
        >
          <b>
            {live.untracked.length} Claude Remote Control server{live.untracked.length > 1 ? 's' : ''} on {h.displayName}
          </b>{' '}
          {live.untracked.length > 1 ? 'are' : 'is'} not on your dashboard ({live.untracked.map((c) => c.tmuxSessionName).join(', ')}). Importing never restarts them.
        </Banner>,
      )
    }
  }
  const unconfirmed = runtimes.filter((r) => !r.runtime.archived && !r.project.archived && !r.account)
  if (unconfirmed.length) {
    items.push(
      <Banner
        key="unconfirmed"
        tone="warn"
        icon={<TriangleAlert className="size-4" />}
        action={
          <Button size="sm" variant="secondary" onClick={() => ui().openDialog({ kind: 'runtime', runtimeId: unconfirmed[0].runtime.id })}>
            Assign account
          </Button>
        }
      >
        <b>{unconfirmed.length} session{unconfirmed.length > 1 ? 's have' : ' has'} an unconfirmed Claude account</b> ({unconfirmed.map((r) => r.runtime.tmuxSessionName).join(', ')}). Open Claude is blocked until you choose the account.
      </Banner>,
    )
  }
  const conflicts = runtimes.filter((r) => r.accountMismatch && !r.runtime.archived)
  if (conflicts.length) {
    items.push(
      <Banner
        key="conflicts"
        tone="danger"
        icon={<TriangleAlert className="size-4" />}
        action={
          <Button size="sm" variant="secondary" onClick={() => ui().openDialog({ kind: 'runtime', runtimeId: conflicts[0].runtime.id })}>
            Review mapping
          </Button>
        }
      >
        <b>Account mapping conflict</b> on {conflicts.map((r) => r.runtime.tmuxSessionName).join(', ')}: the running process uses a different CLAUDE_CONFIG_DIR than the mapped account.
      </Banner>,
    )
  }
  const accounts = state.accounts.filter((a) => !a.archived)
  const noProfile = accounts.filter((a) => !a.chromeProfileDir)
  if (noProfile.length) {
    items.push(
      <Banner
        key="noprofile"
        tone="warn"
        icon={<Globe className="size-4" />}
        action={
          <Button size="sm" variant="secondary" onClick={() => ui().setView('accounts')}>
            Map profiles
          </Button>
        }
      >
        <b>{noProfile.map((a) => a.displayName).join(', ')}</b> {noProfile.length > 1 ? 'have' : 'has'} no Chrome profile — Open Claude can’t route {noProfile.length > 1 ? 'them' : 'it'} to the right login yet.
      </Banner>,
    )
  }
  const loggedOut = accounts.filter((a) => a.authState === 'logged_out' || a.authState === 'missing_dir')
  if (loggedOut.length) {
    const hostId = state.hosts[0]?.id
    items.push(
      <Banner
        key="loggedout"
        tone="danger"
        icon={<KeyRound className="size-4" />}
        action={
          hostId ? (
            <Button size="sm" variant="secondary" onClick={() => ui().openDialog({ kind: 'login', accountId: loggedOut[0].id, hostId })}>
              Sign in
            </Button>
          ) : undefined
        }
      >
        <b>{loggedOut.map((a) => a.displayName).join(', ')}</b> {loggedOut.length > 1 ? 'are' : 'is'} not signed in to Claude on the VM.
      </Banner>,
    )
  }
  const inbox = state.extension.inbox ?? []
  if (inbox.length) {
    items.push(
      <Banner
        key="inbox"
        tone="info"
        icon={<Inbox className="size-4" />}
        action={
          <Button size="sm" variant="secondary" onClick={() => ui().openDialog({ kind: 'inbox' })}>
            Assign
          </Button>
        }
      >
        <b>{inbox.length} conversation{inbox.length > 1 ? 's' : ''} captured from Chrome</b> need{inbox.length > 1 ? '' : 's'} a project.
      </Banner>,
    )
  }
  if (!items.length) return null
  return (
    <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
      {items}
    </div>
  )
}
