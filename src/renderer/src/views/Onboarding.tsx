import type { ConfigDirWithAuth, DiscoveryResult, ProbeResult } from '@shared/ipc'
import type { DeckState } from '@shared/types'
import { configDirLabel, defaultAccountName, sameConfigDir } from '@shared/naming'
import { ArrowRight, Check, CircleCheck, Globe, LayoutDashboard, Radar, Server, Users } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Badge, Button, Callout, Checkbox, cx, Field, Input, Select, Spinner } from '../components/ui'
import { call, errorMessage } from '../lib/api'
import { ui } from '../lib/store'
import { buildImportRequest, CandidateList, dirKey, initialSelection, type ImportSelection } from '../dialogs/ImportPanel'
import { ProfileMapper, suggestProfile } from './AccountsView'

const STEPS: { title: string; icon: ReactNode }[] = [
  { title: 'Connect VM', icon: <Server className="size-4" /> },
  { title: 'Discover sessions', icon: <Radar className="size-4" /> },
  { title: 'Map accounts', icon: <Users className="size-4" /> },
  { title: 'Map Chrome profiles', icon: <Globe className="size-4" /> },
  { title: 'Review', icon: <LayoutDashboard className="size-4" /> },
]

function Shell({ step, children, footer }: { step: number; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex h-screen bg-bg text-fg">
      <aside className="flex w-[260px] shrink-0 flex-col bg-sidebar">
        <div className="drag h-[52px]" />
        <div className="flex items-center gap-2 px-6 pb-6">
          <img src={new URL('../assets/logo.svg', import.meta.url).href} className="size-7 rounded-lg" alt="" />
          <div>
            <div className="text-[15px] font-semibold">Claude Deck</div>
            <div className="text-[11.5px] text-fg-3">First-run setup</div>
          </div>
        </div>
        <ol className="space-y-1 px-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className={cx('flex items-center gap-3 rounded-lg px-2.5 py-2 text-[13px]', i + 1 === step ? 'bg-black/[0.06] font-semibold dark:bg-white/[0.07]' : i + 1 < step ? 'text-fg-2' : 'text-fg-3')}>
              <span className={cx('flex size-6 items-center justify-center rounded-full border text-[11.5px]', i + 1 < step ? 'border-ok bg-ok text-white' : i + 1 === step ? 'border-accent text-accent' : 'border-line-strong')}>
                {i + 1 < step ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
              </span>
              {s.title}
            </li>
          ))}
        </ol>
        <div className="mt-auto p-5 text-[11.5px] leading-relaxed text-fg-3">
          Read-only until you confirm. Nothing on the VM is restarted, killed or reconfigured during setup.
          <button className="mt-2 block text-accent hover:underline" onClick={() => void call('settings.update', { onboardingComplete: true })}>
            Skip setup
          </button>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col border-l border-line">
        <div className="drag h-[40px] shrink-0" />
        <div className="min-h-0 flex-1 overflow-y-auto px-10 pb-8">
          <div className="mx-auto max-w-[860px]">{children}</div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-panel/70 px-10 py-3">{footer}</div>
      </main>
    </div>
  )
}

function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{title}</h1>
      {children && <p className="mt-1.5 max-w-[680px] text-[13.5px] leading-relaxed text-fg-2">{children}</p>}
    </div>
  )
}

export function Onboarding({ state }: { state: DeckState }) {
  const [step, setStep] = useState(state.hosts.length ? 2 : 1)
  const hostId = state.hosts[0]?.id ?? null

  // step 1
  const [aliases, setAliases] = useState<string[]>([])
  const [alias, setAlias] = useState('')
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [claudePath, setClaudePath] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // step 2-5
  const [scan, setScan] = useState<DiscoveryResult | null>(null)
  const [sel, setSel] = useState<ImportSelection | null>(null)
  const [extraDirs, setExtraDirs] = useState<Record<string, { create: boolean; name: string }>>({})

  useEffect(() => {
    void call('host.listSshAliases', undefined).then((a) => {
      setAliases(a)
      setAlias((cur) => cur || (a[0] ?? ''))
    })
  }, [])

  const runScan = async (hid: string) => {
    setBusy('scan')
    setError(null)
    try {
      const s = await call('discovery.scan', { hostId: hid, checkAuth: true })
      setScan(s)
      setSel(initialSelection(s, state))
      const extra: Record<string, { create: boolean; name: string }> = {}
      for (const d of s.configDirs) {
        if (d.accountId) continue
        extra[d.configDir ?? '__default__'] = { create: Boolean(d.auth?.loggedIn) || d.inUseByServers > 0, name: defaultAccountName(d.configDir) }
      }
      setExtraDirs(extra)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    if (step === 2 && hostId && !scan && busy !== 'scan') void runScan(hostId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, hostId])

  const testConnection = async () => {
    setBusy('probe')
    setError(null)
    setProbe(null)
    try {
      const p = await call('host.probe', { alias: alias.trim() })
      setProbe(p)
      setClaudePath(p.probe.claudeRecommended ?? '')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const saveHost = async () => {
    setBusy('save')
    setError(null)
    try {
      await call('host.save', { displayName: alias.trim(), sshAlias: alias.trim(), claudePath: claudePath || null })
      setStep(2)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  // Accounts to create in step 3: union of dirs used by selected sessions + other dirs the user ticks.
  const dirRows = useMemo(() => {
    if (!scan) return [] as (ConfigDirWithAuth & { key: string; usedBy: string[] })[]
    return scan.configDirs.map((d) => {
      const key = d.configDir ?? '__default__'
      const usedBy = scan.candidates.filter((c) => sel?.selected.has(c.key) && c.configDir.state !== 'unknown' && dirKey(c.configDir) === key).map((c) => c.tmuxSessionName)
      return { ...d, key, usedBy }
    })
  }, [scan, sel])

  const createAccounts = async () => {
    if (!scan) return
    setBusy('accounts')
    setError(null)
    try {
      for (const d of dirRows) {
        if (d.accountId || state.accounts.some((a) => sameConfigDir(a.configDir, d.configDir, scan.home))) continue
        const plan = extraDirs[d.key]
        const needed = d.usedBy.length > 0
        if (!(plan?.create || needed)) continue
        await call('account.create', { displayName: plan?.name?.trim() || defaultAccountName(d.configDir), configDir: d.configDir, label: d.auth?.email ?? null })
      }
      void call('account.checkAuth', {}).catch(() => undefined)
      setStep(4)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const finish = async () => {
    if (!scan || !sel) {
      await call('settings.update', { onboardingComplete: true })
      return
    }
    setBusy('import')
    setError(null)
    try {
      const req = buildImportRequest(scan, sel)
      if (req.items.length) {
        const res = await call('discovery.import', { ...req, createAccounts: [] })
        ui().toast('success', `Imported ${res.runtimes} session(s) and ${res.conversations} conversation link(s). Nothing was restarted.`)
      }
      await call('settings.update', { onboardingComplete: true })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  // ------------------------------------------------------------------------ render
  if (step === 1) {
    return (
      <Shell
        step={1}
        footer={
          <>
            <Button loading={busy === 'probe'} disabled={!alias.trim()} onClick={() => void testConnection()}>
              Test connection
            </Button>
            <Button variant="primary" loading={busy === 'save'} disabled={!probe || !claudePath} icon={<ArrowRight className="size-4" />} onClick={() => void saveHost()}>
              Continue
            </Button>
          </>
        }
      >
        <Heading title="Connect your VM">Claude Deck uses your existing SSH setup (including the gcloud IAP ProxyCommand) — nothing to re-enter and nothing installed on the VM.</Heading>
        <div className="grid max-w-[560px] gap-4">
          <Field label="SSH host alias from ~/.ssh/config">
            <Select value={aliases.includes(alias) ? alias : ''} onChange={(e) => setAlias(e.target.value)}>
              <option value="">— choose —</option>
              {aliases.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="…or type it">
            <Input mono value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="my-vm" />
          </Field>
        </div>
        {busy === 'probe' && (
          <div className="mt-5 flex items-center gap-2 text-[13px] text-fg-2">
            <Spinner /> Connecting to {alias} (the first connection through IAP takes a few seconds)…
          </div>
        )}
        {probe && (
          <div className="mt-6 space-y-4 rounded-card border border-line bg-panel p-5 shadow-card">
            <div className="flex items-center gap-2 text-[14px] font-semibold">
              <CircleCheck className="size-5 text-ok" /> Connected to {probe.probe.user}@{probe.probe.hostname}
              <span className="text-[12px] font-normal text-fg-3">in {(probe.elapsedMs / 1000).toFixed(1)}s</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge>{probe.probe.os ?? probe.probe.kernel}</Badge>
              <Badge>{probe.probe.tmuxVersion ?? 'tmux missing!'}</Badge>
              <Badge>Python {probe.probe.python}</Badge>
              <Badge>{probe.probe.gitVersion ?? 'no git'}</Badge>
              <Badge>{probe.probe.docker.path ? (probe.probe.docker.accessible ? 'docker' : 'docker (no access)') : 'no docker'}</Badge>
            </div>
            <Field label="Claude Code installation to use" hint="Recommended: the one your running Remote Control servers use.">
              <div className="space-y-1.5">
                {probe.probe.claudeCandidates.map((c) => (
                  <label key={c.path} className={cx('flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2', claudePath === c.path ? 'border-accent bg-accent-soft/60' : 'border-line hover:bg-panel-2')}>
                    <input type="radio" className="accent-[var(--accent)]" checked={claudePath === c.path} onChange={() => setClaudePath(c.path)} />
                    <span className="font-mono text-[12px]">{c.path}</span>
                    <Badge tone={c.version ? 'neutral' : 'danger'}>{c.version ?? 'not runnable'}</Badge>
                    <span className="ml-auto text-[11.5px] text-fg-3">{c.sources.join(', ')}</span>
                    {probe.probe.claudeRecommended === c.path && <Badge tone="ok">recommended</Badge>}
                  </label>
                ))}
                {!probe.probe.claudeCandidates.length && <Callout tone="danger">Claude Code was not found on the VM.</Callout>}
              </div>
            </Field>
            {probe.capabilities && (
              <div className="grid grid-cols-2 gap-4 text-[12px]">
                <div>
                  <div className="mb-1 font-medium text-fg-2">Remote Control</div>
                  {probe.capabilities.rcSupported ? <Badge tone="ok">supported (Claude Code {probe.capabilities.version})</Badge> : <Badge tone="danger">not supported</Badge>}
                </div>
                <div>
                  <div className="mb-1 font-medium text-fg-2">Permission modes</div>
                  <div className="flex flex-wrap gap-1">{probe.capabilities.permissionModes.map((m) => <Badge key={m}>{m}</Badge>)}</div>
                </div>
              </div>
            )}
          </div>
        )}
        {error && (
          <Callout tone="danger" className="mt-5" title="Connection failed">
            {error}
          </Callout>
        )}
      </Shell>
    )
  }

  if (step === 2) {
    const count = sel?.selected.size ?? 0
    return (
      <Shell
        step={2}
        footer={
          <>
            <Button variant="ghost" onClick={() => hostId && void runScan(hostId)} loading={busy === 'scan'}>
              Rescan
            </Button>
            <Button variant="primary" disabled={!scan} icon={<ArrowRight className="size-4" />} onClick={() => setStep(3)}>
              Continue with {count} session{count === 1 ? '' : 's'}
            </Button>
          </>
        }
      >
        <Heading title="Discover your running sessions">
          Claude Deck looked at every tmux session on {state.hosts[0]?.displayName} — read-only. Pick the Remote Control servers to show on your dashboard. Accounts are identified from each process’s own <span className="font-mono">CLAUDE_CONFIG_DIR</span>, never from names.
        </Heading>
        {busy === 'scan' && (
          <div className="flex items-center gap-2 text-[13px] text-fg-2">
            <Spinner /> Scanning tmux sessions, processes and Claude’s session records…
          </div>
        )}
        {scan && sel && <CandidateList scan={scan} state={state} sel={sel} setSel={setSel} />}
        {error && <Callout tone="danger">{error}</Callout>}
      </Shell>
    )
  }

  if (step === 3) {
    return (
      <Shell
        step={3}
        footer={
          <>
            <Button variant="ghost" onClick={() => setStep(2)}>
              Back
            </Button>
            <Button variant="primary" loading={busy === 'accounts'} icon={<ArrowRight className="size-4" />} onClick={() => void createAccounts()}>
              Create accounts & continue
            </Button>
          </>
        }
      >
        <Heading title="Name your Claude accounts">
          Each Claude login lives in its own configuration directory on the VM. Directories used by the sessions you selected are registered automatically; tick any others you want available for new sessions.
        </Heading>
        <div className="overflow-hidden rounded-card border border-line bg-panel shadow-card">
          {dirRows.map((d) => {
            const existing = state.accounts.find((a) => sameConfigDir(a.configDir, d.configDir, scan?.home))
            const plan = extraDirs[d.key] ?? { create: false, name: defaultAccountName(d.configDir) }
            const forced = d.usedBy.length > 0
            const fromSel = sel?.newAccounts[d.key]
            return (
              <div key={d.key} className="grid grid-cols-[28px_200px_1fr_190px] items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
                <Checkbox checked={Boolean(existing) || forced || plan.create} disabled={Boolean(existing) || forced} onChange={(v) => setExtraDirs({ ...extraDirs, [d.key]: { ...plan, create: v } })} />
                <div className="min-w-0">
                  <div className="truncate font-mono text-[12px]">{configDirLabel(d.configDir, scan?.home)}</div>
                  <div className="truncate text-[11px] text-fg-3">{d.usedBy.length ? `used by ${d.usedBy.join(', ')}` : d.inUseByServers ? `${d.inUseByServers} running server(s)` : 'not in use'}</div>
                </div>
                <div className="truncate text-[12px] text-fg-2">
                  {d.auth?.state === 'ok' ? (d.auth.loggedIn ? `${d.auth.email ?? 'signed in'} · ${d.auth.subscription ?? ''}` : <span className="text-danger">not signed in</span>) : d.auth ? d.auth.state : 'not checked'}
                </div>
                {existing ? (
                  <Badge tone="ok">{existing.displayName}</Badge>
                ) : (
                  <Input
                    value={fromSel?.name ?? plan.name}
                    onChange={(e) => {
                      setExtraDirs({ ...extraDirs, [d.key]: { ...plan, name: e.target.value } })
                      if (fromSel && sel) setSel({ ...sel, newAccounts: { ...sel.newAccounts, [d.key]: { ...fromSel, name: e.target.value } } })
                    }}
                  />
                )}
              </div>
            )
          })}
        </div>
        {scan?.candidates.some((c) => sel?.selected.has(c.key) && c.configDir.state === 'unknown') && (
          <Callout tone="warn" className="mt-4" title="Some sessions’ accounts could not be read">
            They will be imported as “Account unconfirmed”, and Open Claude stays blocked until you assign the right account.
          </Callout>
        )}
        {error && (
          <Callout tone="danger" className="mt-4">
            {error}
          </Callout>
        )}
      </Shell>
    )
  }

  if (step === 4) {
    const accounts = state.accounts.filter((a) => !a.archived)
    return (
      <Shell
        step={4}
        footer={
          <>
            <Button variant="ghost" onClick={() => setStep(3)}>
              Back
            </Button>
            <Button variant="primary" icon={<ArrowRight className="size-4" />} onClick={() => setStep(5)}>
              Continue
            </Button>
          </>
        }
      >
        <Heading title="Pick the Chrome profile for each account">
          Open Claude launches each account’s conversations in its own Chrome profile, so every login stays signed in — no incognito windows. Use <b>Test</b> to open claude.ai/code in a profile and check which Claude account it shows, then confirm.
        </Heading>
        {state.chromeError && <Callout tone="warn">{state.chromeError}</Callout>}
        {accounts.some((a) => !a.chromeProfileDir && suggestProfile(a, state.chromeProfiles, state.accounts)) && (
          <div className="mb-3 flex justify-end">
            <Button
              size="sm"
              onClick={() =>
                void (async () => {
                  for (const a of accounts) {
                    const s = !a.chromeProfileDir ? suggestProfile(a, state.chromeProfiles, state.accounts) : null
                    if (s) await call('account.update', { id: a.id, patch: { chromeProfileDir: s.directory } }).catch(() => undefined)
                  }
                })()
              }
            >
              Apply all suggestions
            </Button>
          </div>
        )}
        <div className="space-y-3">
          {accounts.map((a) => (
            <div key={a.id} className="rounded-card border border-line bg-panel p-4 shadow-card">
              <div className="mb-2.5 flex items-center gap-2">
                <span className="size-3 rounded-full" style={{ background: a.color }} />
                <span className="text-[14px] font-semibold">{a.displayName}</span>
                <span className="font-mono text-[11.5px] text-fg-3">{configDirLabel(a.configDir, state.hosts[0]?.homePath)}</span>
                <span className="ml-auto text-[12px] text-fg-2">{a.authEmail ?? ''}</span>
              </div>
              <ProfileMapper account={a} state={state} compact />
            </div>
          ))}
          {!accounts.length && <div className="text-[13px] text-fg-3">No accounts yet — you can add them later in Claude Accounts.</div>}
        </div>
      </Shell>
    )
  }

  // step 5
  const selected = scan?.candidates.filter((c) => sel?.selected.has(c.key)) ?? []
  const unmapped = state.accounts.filter((a) => !a.archived && !a.chromeProfileDir)
  const unverified = state.accounts.filter((a) => !a.archived && a.chromeProfileDir && !a.chromeProfileConfirmedAt)
  return (
    <Shell
      step={5}
      footer={
        <>
          <Button variant="ghost" onClick={() => setStep(4)}>
            Back
          </Button>
          <Button variant="primary" loading={busy === 'import'} icon={<LayoutDashboard className="size-4" />} onClick={() => void finish()}>
            {selected.length ? `Import ${selected.length} session${selected.length > 1 ? 's' : ''} & open dashboard` : 'Open dashboard'}
          </Button>
        </>
      }
    >
      <Heading title="Review">These sessions will appear on your dashboard exactly as they are running now — nothing is restarted.</Heading>
      <div className="overflow-hidden rounded-card border border-line bg-panel shadow-card">
        {selected.map((c) => {
          const acct = state.accounts.find((a) => c.configDir.state !== 'unknown' && sameConfigDir(a.configDir, c.configDir.state === 'default' ? null : c.configDir.value, scan?.home))
          return (
            <div key={c.key} className="grid grid-cols-[170px_1fr_170px_120px] items-center gap-3 border-b border-line px-4 py-2.5 text-[12.5px] last:border-b-0">
              <span className="truncate font-mono">{c.tmuxSessionName}</span>
              <span className="truncate text-fg-2">
                {sel?.projectNames[c.key] ?? c.suggestedProjectName} · {c.conversations.length} link(s)
              </span>
              {acct ? (
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ background: acct.color }} />
                  {acct.displayName}
                </span>
              ) : (
                <span className="text-warn">Account unconfirmed</span>
              )}
              <span className="truncate text-fg-3">{acct?.chromeProfileDir ? `${acct.chromeProfileName ?? acct.chromeProfileDir}${acct.chromeProfileName && acct.chromeProfileName !== acct.chromeProfileDir ? ` · ${acct.chromeProfileDir}` : ''}` : <span className="text-warn">no profile</span>}</span>
            </div>
          )
        })}
        {!selected.length && <div className="px-4 py-6 text-center text-[12.5px] text-fg-3">No sessions selected — you can import them later from the dashboard.</div>}
      </div>
      <div className="mt-4 space-y-2">
        {unmapped.length > 0 && <Callout tone="warn">{unmapped.map((a) => a.displayName).join(', ')} still {unmapped.length > 1 ? 'need' : 'needs'} a Chrome profile. Open Claude will ask you to map one first.</Callout>}
        {unverified.length > 0 && <Callout tone="info">{unverified.map((a) => a.displayName).join(', ')}: profile assigned but not verified yet — the first Open Claude will ask you to confirm.</Callout>}
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    </Shell>
  )
}
