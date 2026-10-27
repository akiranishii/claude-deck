import type { DiscoveryResult, ImportRequest } from '@shared/ipc'
import type { DeckState, DiscoveryCandidate } from '@shared/types'
import { configDirLabel, defaultAccountName } from '@shared/naming'
import { ChevronDown, ShieldAlert, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { StatusDot } from '../components/Status'
import { tildePath } from '../lib/format'
import { Badge, Checkbox, cx, Input, Select } from '../components/ui'

export const dirKey = (c: DiscoveryCandidate['configDir']) => (c.state === 'default' ? '__default__' : c.state === 'env' ? c.value ?? '' : '')

export interface ImportSelection {
  selected: Set<string>
  projectNames: Record<string, string>
  projectChoice: Record<string, string>
  accountChoice: Record<string, string>
  newAccounts: Record<string, { create: boolean; name: string }>
}

export function initialSelection(scan: DiscoveryResult, state: DeckState): ImportSelection {
  const selected = new Set(scan.candidates.filter((c) => !c.trackedRuntimeId && (c.kind === 'rc-server' || c.kind === 'interactive-rc')).map((c) => c.key))
  const newAccounts: ImportSelection['newAccounts'] = {}
  const usedNames = new Set(state.accounts.map((a) => a.displayName))
  for (const c of scan.candidates) {
    if (c.configDir.state === 'unknown' || c.matchedAccountId) continue
    const key = dirKey(c.configDir)
    if (newAccounts[key]) continue
    let name = defaultAccountName(c.configDir.state === 'default' ? null : c.configDir.value)
    let n = 2
    while (usedNames.has(name)) name = `${defaultAccountName(c.configDir.state === 'default' ? null : c.configDir.value)} (${n++})`
    usedNames.add(name)
    newAccounts[key] = { create: true, name }
  }
  return { selected, projectNames: {}, projectChoice: {}, accountChoice: {}, newAccounts }
}

export function buildImportRequest(scan: DiscoveryResult, sel: ImportSelection): ImportRequest {
  const chosen = scan.candidates.filter((c) => sel.selected.has(c.key))
  const neededDirs = new Set(chosen.filter((c) => !c.matchedAccountId && c.configDir.state !== 'unknown' && !sel.accountChoice[c.key]).map((c) => dirKey(c.configDir)))
  return {
    hostId: scan.hostId,
    items: chosen.map((c) => ({
      key: c.key,
      projectId: sel.projectChoice[c.key] && sel.projectChoice[c.key] !== '__new__' ? sel.projectChoice[c.key] : null,
      newProjectName: sel.projectNames[c.key] ?? c.suggestedProjectName,
      accountId: sel.accountChoice[c.key] === '__none__' ? null : sel.accountChoice[c.key] || undefined,
    })),
    createAccounts: Object.entries(sel.newAccounts)
      .filter(([k, v]) => v.create && neededDirs.has(k))
      .map(([k, v]) => ({ configDir: k === '__default__' ? null : k, displayName: v.name.trim() || 'Account' })),
  }
}

const KIND_LABEL: Record<DiscoveryCandidate['kind'], string> = {
  'rc-server': 'Remote Control',
  'interactive-rc': 'Interactive + Remote Control',
  interactive: 'Interactive Claude (not Remote Control)',
  shell: 'Shell',
  other: 'Other program',
  dead: 'Exited pane',
}

function CandidateRow({ c, state, scan, sel, setSel }: { c: DiscoveryCandidate; state: DeckState; scan: DiscoveryResult; sel: ImportSelection; setSel: (s: ImportSelection) => void }) {
  const on = sel.selected.has(c.key)
  const tracked = Boolean(c.trackedRuntimeId)
  const matched = c.matchedAccountId ? state.accounts.find((a) => a.id === c.matchedAccountId) : null
  const newAcc = c.configDir.state !== 'unknown' && !matched ? sel.newAccounts[dirKey(c.configDir)] : null
  const accountChoice = sel.accountChoice[c.key]
  const projects = state.projects.filter((p) => !p.archived && p.hostId === scan.hostId)
  const toggle = (v: boolean) => {
    const next = new Set(sel.selected)
    if (v) next.add(c.key)
    else next.delete(c.key)
    setSel({ ...sel, selected: next })
  }
  return (
    <div className={cx('rounded-xl border px-3 py-2.5 transition-colors', on ? 'border-accent/50 bg-accent-soft/40' : 'border-line', tracked && 'opacity-60')}>
      <div className="flex items-center gap-2.5">
        <Checkbox checked={on} disabled={tracked} onChange={toggle} />
        <span className="font-mono text-[12.5px] font-semibold">{c.tmuxSessionName}</span>
        {c.paneId && <span className="font-mono text-[11px] text-fg-3">{c.paneId}</span>}
        <Badge tone={c.kind === 'rc-server' || c.kind === 'interactive-rc' ? 'accent' : 'neutral'}>{KIND_LABEL[c.kind]}</Badge>
        {c.flags?.permissionMode === 'bypassPermissions' && (
          <Badge tone="warn" icon={<ShieldAlert className="size-3" />}>
            bypass
          </Badge>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-[12px] text-fg-2">
          {c.kind === 'rc-server' || c.kind === 'interactive-rc' ? (
            <>
              <StatusDot status={c.connected ? 'connected' : 'running'} size={7} />
              {c.connected ? 'Connected' : c.statusWord ?? 'Running'}
            </>
          ) : null}
          {tracked && <Badge>on dashboard</Badge>}
        </span>
      </div>
      <div className="mt-1 ml-[26px] flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-3">
        {c.flags?.name && <span className="text-fg-2">“{c.flags.name}”</span>}
        <span className="font-mono text-[11.5px]">{c.cwd ? tildePath(c.cwd, scan.home) : '—'}</span>
        {c.conversations.length > 0 && <span>{c.conversations.length} live conversation link{c.conversations.length > 1 ? 's' : ''}</span>}
        {c.environmentId && <span>environment link ✓</span>}
      </div>
      {on && (
        <div className="mt-2 ml-[26px] grid grid-cols-2 gap-2">
          <div>
            <div className="mb-1 text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase">Claude account</div>
            {c.configDir.state === 'unknown' ? (
              <div className="space-y-1">
                <div className="flex items-center gap-1 text-[11.5px] text-warn">
                  <TriangleAlert className="size-3" /> Could not read the process environment — choose manually
                </div>
                <Select value={accountChoice ?? '__none__'} onChange={(e) => setSel({ ...sel, accountChoice: { ...sel.accountChoice, [c.key]: e.target.value } })}>
                  <option value="__none__">Account unconfirmed</option>
                  {state.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.displayName}
                    </option>
                  ))}
                </Select>
              </div>
            ) : (
              <div className="rounded-lg bg-panel px-2 py-1.5 text-[12px]">
                <span className="font-mono text-[11.5px] text-fg-2">{c.configDir.state === 'default' ? 'CLAUDE_CONFIG_DIR unset (~/.claude)' : `CLAUDE_CONFIG_DIR=${configDirLabel(c.configDir.value, scan.home)}`}</span>
                <div className="mt-0.5 flex items-center gap-1.5">
                  →{' '}
                  {matched ? (
                    <>
                      <span className="size-2 rounded-full" style={{ background: matched.color }} />
                      <b>{matched.displayName}</b>
                      <span className="text-fg-3">(from the process environment)</span>
                    </>
                  ) : newAcc ? (
                    <span className="flex items-center gap-1.5">
                      <Checkbox
                        checked={newAcc.create}
                        onChange={(v) => setSel({ ...sel, newAccounts: { ...sel.newAccounts, [dirKey(c.configDir)]: { ...newAcc, create: v } } })}
                      />
                      new account
                      <input
                        value={newAcc.name}
                        onChange={(e) => setSel({ ...sel, newAccounts: { ...sel.newAccounts, [dirKey(c.configDir)]: { ...newAcc, name: e.target.value } } })}
                        className="w-28 rounded border border-line bg-panel-2 px-1.5 py-0.5 text-[12px] outline-none focus:border-accent"
                      />
                    </span>
                  ) : null}
                </div>
              </div>
            )}
          </div>
          <div>
            <div className="mb-1 text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase">Project</div>
            <Select
              value={sel.projectChoice[c.key] ?? c.suggestedProjectId ?? '__new__'}
              onChange={(e) => setSel({ ...sel, projectChoice: { ...sel.projectChoice, [c.key]: e.target.value } })}
            >
              <option value="__new__">New project (or the one shared by this folder)</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </Select>
            {(sel.projectChoice[c.key] ?? c.suggestedProjectId ?? '__new__') === '__new__' && (
              <Input
                className="mt-1"
                value={sel.projectNames[c.key] ?? c.suggestedProjectName}
                onChange={(e) => setSel({ ...sel, projectNames: { ...sel.projectNames, [c.key]: e.target.value } })}
                placeholder="Project name"
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function CandidateList({ scan, state, sel, setSel }: { scan: DiscoveryResult; state: DeckState; sel: ImportSelection; setSel: (s: ImportSelection) => void }) {
  const [showOthers, setShowOthers] = useState(false)
  const claude = useMemo(() => scan.candidates.filter((c) => c.kind === 'rc-server' || c.kind === 'interactive-rc'), [scan])
  const others = useMemo(() => scan.candidates.filter((c) => !(c.kind === 'rc-server' || c.kind === 'interactive-rc')), [scan])
  return (
    <div className="space-y-2">
      {claude.map((c) => (
        <CandidateRow key={c.key} c={c} state={state} scan={scan} sel={sel} setSel={setSel} />
      ))}
      {!claude.length && <div className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[12.5px] text-fg-3">No Claude Remote Control servers found in tmux.</div>}
      {others.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowOthers(!showOthers)} className="flex items-center gap-1 py-1 text-[12px] text-fg-3 hover:text-fg-2">
            <ChevronDown className={cx('size-3.5 transition-transform', !showOthers && '-rotate-90')} />
            {others.length} other tmux pane{others.length > 1 ? 's' : ''} (shells, interactive Claude, other programs)
          </button>
          {showOthers && (
            <div className="mt-1 space-y-2">
              {others.map((c) => (
                <CandidateRow key={c.key} c={c} state={state} scan={scan} sel={sel} setSel={setSel} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
