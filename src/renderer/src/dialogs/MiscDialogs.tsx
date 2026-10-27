import type { DiscoveryResult, ProbeResult } from '@shared/ipc'
import type { OpenPlan, OpenRequest } from '@shared/routing'
import type { DeckEvent, DeckState } from '@shared/types'
import { ArrowUpRight, CircleAlert, Download, Info, Link2, RefreshCw, ScrollText, Server, TriangleAlert, Inbox } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Badge, Button, Callout, cx, Field, Input, Modal, Select, Spinner } from '../components/ui'
import { call, errorMessage } from '../lib/api'
import { openClaude } from '../lib/actions'
import { absTime, relTime } from '../lib/format'
import { ui } from '../lib/store'
import { buildImportRequest, CandidateList, initialSelection, type ImportSelection } from './ImportPanel'

export function ConfirmDialog({ title, body, confirmLabel, danger, typed, onConfirm, onClose }: { title: string; body: string; confirmLabel: string; danger?: boolean; typed?: string; onConfirm: () => Promise<void> | void; onClose: () => void }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ok = !typed || value.trim() === typed
  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      width={500}
      icon={danger ? <TriangleAlert className="size-4 text-danger" /> : <Info className="size-4" />}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button data-autofocus={!typed || undefined} variant={danger ? 'danger' : 'primary'} disabled={!ok} loading={busy} onClick={() => void go()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-relaxed text-fg-2">{body}</p>
      {typed && (
        <Field label={`Type “${typed}” to confirm`} className="mt-3">
          <Input data-autofocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ok && void go()} />
        </Field>
      )}
      {error && (
        <Callout tone="danger" className="mt-3">
          {error}
        </Callout>
      )}
    </Modal>
  )
}

export function OpenIssuesDialog({ state, plan, request, onClose }: { state: DeckState; plan: OpenPlan; request: OpenRequest; onClose: () => void }) {
  const blocks = plan.issues.filter((i) => i.severity === 'block')
  const confirms = plan.issues.filter((i) => i.severity === 'confirm')
  const infos = plan.issues.filter((i) => i.severity === 'info')
  const runtime = plan.runtimeId ? state.runtimes.find((r) => r.id === plan.runtimeId) : null
  const fix = (code: string) => {
    onClose()
    if (code === 'no_account' && runtime) ui().openDialog({ kind: 'runtime', runtimeId: runtime.id })
    else if (code === 'account_mismatch' && runtime) ui().openDialog({ kind: 'runtime', runtimeId: runtime.id })
    else if (['no_profile', 'profile_missing', 'profile_unverified', 'profile_shared'].includes(code)) ui().setView('accounts')
    else if (code === 'no_runtime' || code === 'no_url') ui().openDialog({ kind: 'link', projectId: runtime?.projectId, runtimeId: runtime?.id ?? null })
  }
  const what = plan.urlKind === 'conversation' ? 'the conversation' : plan.urlKind === 'environment' ? 'the environment page' : 'claude.ai/code'
  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      icon={blocks.length ? <CircleAlert className="size-4 text-danger" /> : <TriangleAlert className="size-4 text-warn" />}
      title={blocks.length ? 'Can’t open this session safely yet' : 'Check before opening'}
      description={plan.accountName ? `${plan.accountName}${plan.profileName ? ` · Chrome profile “${plan.profileName}”` : ''}` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {blocks.length === 0 && (
            <Button
              data-autofocus
              variant="primary"
              icon={<ArrowUpRight className="size-4" />}
              onClick={() => {
                onClose()
                void openClaude(request, true)
              }}
            >
              Open {what} anyway
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-2">
        {[...blocks, ...confirms, ...infos].map((i, idx) => (
          <Callout
            key={idx}
            tone={i.severity === 'block' ? 'danger' : i.severity === 'confirm' ? 'warn' : 'info'}
            action={
              i.severity !== 'info' ? (
                <Button size="xs" variant="secondary" onClick={() => fix(i.code)}>
                  {i.code === 'no_account' || i.code === 'account_mismatch' ? 'Fix mapping' : i.code.startsWith('profile') || i.code === 'no_profile' ? 'Map profiles' : 'Link URL'}
                </Button>
              ) : undefined
            }
          >
            {i.message}
          </Callout>
        ))}
      </div>
    </Modal>
  )
}

export function ActivityDialog({ state, runtimeId, onClose }: { state: DeckState; runtimeId: string; onClose: () => void }) {
  const runtime = state.runtimes.find((r) => r.id === runtimeId)
  const [lines, setLines] = useState<string[] | null>(null)
  const [events, setEvents] = useState<DeckEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const load = async () => {
    setError(null)
    try {
      const [cap, ev] = await Promise.all([call('runtime.capture', { id: runtimeId, lines: 300 }), call('events.list', { runtimeId, limit: 100 })])
      setLines(cap.lines)
      setEvents(ev)
    } catch (err) {
      setError(errorMessage(err))
      setLines([])
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeId])
  if (!runtime) return null
  return (
    <Modal
      open
      onClose={onClose}
      width={880}
      icon={<ScrollText className="size-4" />}
      title={`Activity · ${runtime.remoteControlName ?? runtime.tmuxSessionName}`}
      description="Recent terminal output is sanitized (escape codes stripped, token-like strings redacted) and is never stored."
      footer={
        <Button icon={<RefreshCw className="size-3.5" />} onClick={() => void load()}>
          Refresh
        </Button>
      }
    >
      <div className="grid grid-cols-[1.6fr_1fr] gap-4">
        <div className="terminal-text h-[52vh] overflow-y-auto rounded-xl bg-[#0f1218] px-3 py-2.5 text-[#c9d1dc]">
          {lines === null ? <Spinner /> : lines.length ? lines.join('\n') : 'No output (the tmux pane may not exist).'}
        </div>
        <div className="h-[52vh] space-y-1 overflow-y-auto">
          <div className="text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase">Events</div>
          {events.map((e) => (
            <div key={e.id} className="rounded-lg px-2 py-1.5 hover:bg-panel-2">
              <div className="flex items-center gap-1.5 text-[11px] text-fg-3">
                <span className={cx('size-1.5 rounded-full', e.level === 'error' ? 'bg-danger' : e.level === 'warn' ? 'bg-warn' : 'bg-info')} />
                {absTime(e.timestamp)}
              </div>
              <div className="text-[12px] text-fg">{e.summary}</div>
            </div>
          ))}
          {!events.length && <div className="text-[12px] text-fg-3">No events yet.</div>}
        </div>
      </div>
      {error && (
        <Callout tone="danger" className="mt-3">
          {error}
        </Callout>
      )}
    </Modal>
  )
}

export function ImportDialog({ state, hostId, onClose }: { state: DeckState; hostId: string; onClose: () => void }) {
  const [scan, setScan] = useState<DiscoveryResult | null>(null)
  const [sel, setSel] = useState<ImportSelection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const host = state.hosts.find((h) => h.id === hostId)
  const load = async () => {
    setError(null)
    setScan(null)
    try {
      const s = await call('discovery.scan', { hostId, checkAuth: false })
      setScan(s)
      setSel(initialSelection(s, state))
    } catch (err) {
      setError(errorMessage(err))
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId])
  const go = async () => {
    if (!scan || !sel) return
    setBusy(true)
    setError(null)
    try {
      const res = await call('discovery.import', buildImportRequest(scan, sel))
      ui().toast('success', `Imported ${res.runtimes} session(s), ${res.conversations} conversation link(s)${res.accountsCreated ? `, ${res.accountsCreated} account(s)` : ''} — nothing was restarted.`)
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const count = sel?.selected.size ?? 0
  return (
    <Modal
      open
      onClose={onClose}
      width={820}
      icon={<Download className="size-4" />}
      title={`Import existing sessions from ${host?.displayName ?? 'the VM'}`}
      description="Read-only scan of tmux and running processes. Importing never kills, detaches, restarts or modifies anything on the VM."
      footer={
        <>
          <Button variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => void load()}>
            Rescan
          </Button>
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!count} loading={busy} onClick={() => void go()}>
            Import {count} session{count === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      {!scan && !error && (
        <div className="flex items-center gap-2 py-8 text-[13px] text-fg-3">
          <Spinner /> Scanning tmux sessions on {host?.displayName}…
        </div>
      )}
      {scan && sel && <CandidateList scan={scan} state={state} sel={sel} setSel={setSel} />}
      {error && <Callout tone="danger">{error}</Callout>}
    </Modal>
  )
}

export function HostDialog({ onClose }: { onClose: () => void }) {
  const [aliases, setAliases] = useState<string[]>([])
  const [alias, setAlias] = useState('')
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void call('host.listSshAliases', undefined).then(setAliases).catch(() => undefined)
  }, [])
  const test = async () => {
    setBusy('test')
    setError(null)
    setProbe(null)
    try {
      setProbe(await call('host.probe', { alias: alias.trim() }))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }
  const save = async () => {
    setBusy('save')
    try {
      await call('host.save', { displayName: alias.trim(), sshAlias: alias.trim(), claudePath: probe?.probe.claudeRecommended ?? null })
      ui().toast('success', `Added ${alias}`)
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      icon={<Server className="size-4" />}
      title="Add a VM"
      description="Uses your existing ~/.ssh/config, keys and ProxyCommand — no credentials are entered here."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy === 'test'} disabled={!alias.trim()} onClick={() => void test()}>
            Test connection
          </Button>
          <Button variant="primary" loading={busy === 'save'} disabled={!probe} onClick={() => void save()}>
            Add VM
          </Button>
        </>
      }
    >
      <Field label="SSH host alias">
        <Select value={aliases.includes(alias) ? alias : ''} onChange={(e) => setAlias(e.target.value)}>
          <option value="">— choose from ~/.ssh/config —</option>
          {aliases.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
        <Input className="mt-2" mono value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="or type an alias" />
      </Field>
      {probe && (
        <Callout tone="ok" className="mt-3" title={`Connected to ${probe.probe.user}@${probe.probe.hostname}`}>
          {probe.probe.os} · {probe.probe.tmuxVersion} · Python {probe.probe.python} · Claude Code {probe.capabilities?.version ?? 'not found'}
        </Callout>
      )}
      {error && (
        <Callout tone="danger" className="mt-3">
          {error}
        </Callout>
      )}
    </Modal>
  )
}

export function InboxDialog({ state, onClose }: { state: DeckState; onClose: () => void }) {
  const inbox = state.extension.inbox ?? []
  const [choice, setChoice] = useState<Record<string, string>>({})
  const assign = async (sid: string, url: string, title: string | null) => {
    const runtimeId = choice[sid]
    const rt = state.runtimes.find((r) => r.id === runtimeId)
    if (!rt) return
    try {
      await call('conversation.link', { url, projectId: rt.projectId, runtimeId: rt.id, title, source: 'chrome-tab' })
      await call('extension.dismissInbox', { remoteSessionId: sid })
      ui().toast('success', 'Conversation linked')
    } catch (err) {
      ui().toast('error', errorMessage(err))
    }
  }
  return (
    <Modal open onClose={onClose} width={680} icon={<Inbox className="size-4" />} title="Conversations captured from Chrome" description="Choose which session each conversation belongs to.">
      <div className="space-y-2">
        {inbox.map((i) => {
          const account = state.accounts.find((a) => a.id === i.accountId)
          const options = state.runtimes.filter((r) => !r.archived && r.accountId === i.accountId)
          return (
            <div key={i.remoteSessionId} className="rounded-xl border border-line px-3 py-2.5">
              <div className="flex items-center gap-2">
                <Link2 className="size-3.5 text-fg-3" />
                <span className="truncate text-[13px] font-medium">{i.title ?? i.remoteSessionId}</span>
                <Badge>{account?.displayName ?? 'account?'}</Badge>
                <span className="ml-auto text-[11px] text-fg-3">{relTime(i.seenAt)}</span>
              </div>
              <div className="mt-2 flex gap-2">
                <Select value={choice[i.remoteSessionId] ?? ''} onChange={(e) => setChoice({ ...choice, [i.remoteSessionId]: e.target.value })} className="flex-1">
                  <option value="">— Choose a session —</option>
                  {options.map((r) => (
                    <option key={r.id} value={r.id}>
                      {state.projects.find((p) => p.id === r.projectId)?.displayName} · {r.remoteControlName ?? r.tmuxSessionName}
                    </option>
                  ))}
                </Select>
                <Button size="md" variant="primary" disabled={!choice[i.remoteSessionId]} onClick={() => void assign(i.remoteSessionId, i.url, i.title)}>
                  Link
                </Button>
                <Button size="md" variant="ghost" onClick={() => void call('extension.dismissInbox', { remoteSessionId: i.remoteSessionId })}>
                  Dismiss
                </Button>
              </div>
            </div>
          )
        })}
        {!inbox.length && <div className="py-6 text-center text-[12.5px] text-fg-3">Nothing to assign.</div>}
      </div>
    </Modal>
  )
}
