import type { BrowserKind, DeckState, Host, Settings, ShellMode, StatusPatterns } from '@shared/types'
import { BROWSER_PRESETS, DEFAULT_STATUS_PATTERNS } from '@shared/constants'
import { Download, Plus, RefreshCw, Server, Trash2, Upload, Copy } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Badge, Button, Callout, cx, Field, Input, Segmented, Select, Switch, Textarea } from '../components/ui'
import { call, errorMessage } from '../lib/api'
import { confirmAction, copyText } from '../lib/actions'
import { relTime } from '../lib/format'
import { ui } from '../lib/store'

async function save(patch: Partial<Settings>) {
  try {
    await call('settings.update', patch)
  } catch (err) {
    ui().toast('error', errorMessage(err))
  }
}

function Section({ title, description, children, right }: { title: string; description?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-panel shadow-card">
      <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
        <div>
          <h2 className="text-[14px] font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-[12px] text-fg-3">{description}</p>}
        </div>
        {right}
      </div>
      <div className="space-y-4 px-5 py-4">{children}</div>
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{label}</div>
        {hint && <div className="text-[12px] text-fg-3">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function NumberSetting({ value, min, max, suffix, onSave }: { value: number; min: number; max: number; suffix: string; onSave: (n: number) => void }) {
  const [v, setV] = useState(String(value))
  useEffect(() => setV(String(value)), [value])
  const commit = () => {
    const n = Math.round(Number(v))
    if (Number.isFinite(n) && n >= min && n <= max && n !== value) onSave(n)
    else setV(String(value))
  }
  return (
    <div className="flex items-center gap-2">
      <Input type="number" value={v} min={min} max={max} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} className="w-20 text-right tabular" />
      <span className="w-14 text-[12px] text-fg-3">{suffix}</span>
    </div>
  )
}

function HostSection({ host, state }: { host: Host; state: DeckState }) {
  const live = state.live.hosts[host.id]
  const caps = host.capabilities
  const probe = host.probe
  const [parent, setParent] = useState(host.defaultParentDir)
  const [python, setPython] = useState(host.pythonCommand)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => setParent(host.defaultParentDir), [host.defaultParentDir])
  useEffect(() => setPython(host.pythonCommand), [host.pythonCommand])
  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key)
    try {
      await fn()
      if (ok) ui().toast('success', ok)
    } catch (err) {
      ui().toast('error', errorMessage(err))
    } finally {
      setBusy(null)
    }
  }
  const updateHost = (patch: Parameters<typeof call<'host.update'>>[1]['patch']) => run('update', () => call('host.update', { id: host.id, patch }))
  const offline = live?.reachable === false

  return (
    <Section
      title={`${host.displayName}`}
      description={
        <span>
          <span className="font-mono">ssh {host.sshAlias}</span> · {probe ? `${probe.user}@${probe.hostname} · ${probe.os ?? probe.kernel}` : 'not probed yet'}
        </span>
      }
      right={
        <div className="flex items-center gap-1.5">
          <Badge tone={offline ? 'danger' : host.lastConnectionStatus === 'online' ? 'ok' : 'neutral'}>{offline ? 'unreachable' : host.lastConnectionStatus}</Badge>
          <Button size="sm" loading={busy === 'reconnect'} onClick={() => void run('reconnect', () => call('host.reconnect', { id: host.id }), 'Reconnected')}>
            Reconnect
          </Button>
          <Button size="sm" loading={busy === 'probe'} icon={<RefreshCw className="size-3.5" />} onClick={() => void run('probe', () => call('host.reprobe', { id: host.id }), 'Re-detected tools and Claude Code capabilities')}>
            Re-detect
          </Button>
        </div>
      }
    >
      {(live?.error || host.lastConnectionError) && offline && <Callout tone="danger" title="Connection problem">{live?.error ?? host.lastConnectionError}</Callout>}
      <div className="grid grid-cols-2 gap-4">
        <Field label="Claude Code binary on the VM" hint={caps ? `Claude Code ${caps.version ?? '?'} · Remote Control ${caps.rcSupported ? 'supported' : 'NOT supported'}` : 'Capabilities not detected yet'}>
          <Select value={host.claudePath ?? ''} onChange={(e) => void updateHost({ claudePath: e.target.value || null })}>
            {!host.claudePath && <option value="">— not found —</option>}
            {(probe?.claudeCandidates ?? []).map((c) => (
              <option key={c.path} value={c.path}>
                {c.path} — {c.version ?? 'unknown'} ({c.sources.join(', ')})
              </option>
            ))}
            {host.claudePath && !(probe?.claudeCandidates ?? []).some((c) => c.path === host.claudePath) && <option value={host.claudePath}>{host.claudePath}</option>}
          </Select>
        </Field>
        <Field label="Launch shell" hint="How tmux starts Claude. Interactive login matches what you get by typing in a terminal (loads ~/.bashrc).">
          <Select value={host.shellMode} onChange={(e) => void updateHost({ shellMode: e.target.value as ShellMode })}>
            <option value="interactive-login">Interactive login shell (recommended)</option>
            <option value="login">Login shell</option>
            <option value="direct">Direct (no shell)</option>
          </Select>
        </Field>
        <Field label="Default parent folder for new projects">
          <Input mono value={parent} onChange={(e) => setParent(e.target.value)} onBlur={() => parent !== host.defaultParentDir && void updateHost({ defaultParentDir: parent })} />
        </Field>
        <Field label="Python on the VM" hint="Runs the agentless helper (python3 -).">
          <Input mono value={python} onChange={(e) => setPython(e.target.value)} onBlur={() => python !== host.pythonCommand && void updateHost({ pythonCommand: python })} />
        </Field>
        <Field label="Detected tools">
          <div className="flex h-8 flex-wrap items-center gap-1.5 text-[12px] text-fg-2">
            <Badge>{probe?.tmuxVersion ?? 'tmux ?'}</Badge>
            <Badge>Python {probe?.python ?? '?'}</Badge>
            <Badge>{probe?.gitVersion?.replace('git version ', 'git ') ?? 'git ?'}</Badge>
            <Badge tone={probe?.docker.accessible ? 'neutral' : 'warn'}>{probe?.docker.path ? (probe.docker.accessible ? `docker ${probe.docker.version ?? ''}` : 'docker (no access)') : 'no docker'}</Badge>
          </div>
        </Field>
      </div>
      {caps && (
        <div className="grid grid-cols-2 gap-4 text-[12px]">
          <div>
            <div className="mb-1 font-medium text-fg-2">Permission modes supported</div>
            <div className="flex flex-wrap gap-1">{caps.permissionModes.map((m) => <Badge key={m} tone={m === 'bypassPermissions' ? 'warn' : 'neutral'}>{m}</Badge>)}</div>
          </div>
          <div>
            <div className="mb-1 font-medium text-fg-2">Spawn modes supported</div>
            <div className="flex flex-wrap gap-1">{caps.spawnModes.map((m) => <Badge key={m}>{m}</Badge>)}</div>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between border-t border-line pt-3 text-[12px] text-fg-3">
        <span>
          {live?.lastSnapshotAt ? `Last refresh ${relTime(live.lastSnapshotAt)} (${live.snapshotMs ?? '?'} ms on the VM)` : 'Not refreshed yet'} · helper {probe?.helperVersion ?? '?'} (streamed over SSH, nothing installed)
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="text-danger"
          icon={<Trash2 className="size-3.5" />}
          onClick={() =>
            confirmAction({
              title: `Remove ${host.displayName}?`,
              body: 'Removes the VM and all of its projects, sessions and conversation links from Claude Deck. Nothing on the VM is changed or stopped.',
              confirmLabel: 'Remove VM',
              danger: true,
              typed: host.sshAlias,
              onConfirm: async () => {
                await call('host.remove', { id: host.id })
              },
            })
          }
        >
          Remove VM
        </Button>
      </div>
    </Section>
  )
}

function PatternsEditor({ patterns }: { patterns: StatusPatterns }) {
  const [draft, setDraft] = useState(patterns)
  useEffect(() => setDraft(patterns), [patterns])
  const groups: { key: keyof StatusPatterns; label: string }[] = [
    { key: 'connected', label: 'Connected' },
    { key: 'disconnected', label: 'Disconnected / reconnecting' },
    { key: 'authRequired', label: 'Authentication required' },
    { key: 'needsInput', label: 'Waiting for input' },
    { key: 'error', label: 'Error' },
  ]
  const valid = (lines: string[]) =>
    lines.every((l) => {
      try {
        new RegExp(l, 'i')
        return true
      } catch {
        return false
      }
    })
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {groups.map((g) => (
          <Field key={g.key} label={g.label} error={valid(draft[g.key]) ? null : 'Contains an invalid regular expression'}>
            <Textarea
              mono
              rows={4}
              value={draft[g.key].join('\n')}
              onChange={(e) => setDraft({ ...draft, [g.key]: e.target.value.split('\n').filter((l) => l.trim()) })}
            />
          </Field>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => void save({ statusPatterns: DEFAULT_STATUS_PATTERNS })}>
          Reset to defaults
        </Button>
        <Button size="sm" variant="primary" disabled={!groups.every((g) => valid(draft[g.key]))} onClick={() => void save({ statusPatterns: draft }).then(() => ui().toast('success', 'Status patterns saved'))}>
          Save patterns
        </Button>
      </div>
    </div>
  )
}

function ExtensionSection({ state }: { state: DeckState }) {
  const s = state.settings
  const [code, setCode] = useState<Record<string, string>>({})
  return (
    <Section
      title="Chrome extension (optional)"
      description="Automatically records the exact claude.ai/code/session_… URL whenever you open a conversation in a paired Chrome profile."
      right={<Switch checked={s.extensionEnabled} onChange={(v) => void save({ extensionEnabled: v })} label="Enable extension bridge" />}
    >
      <div className="text-[12.5px] leading-relaxed text-fg-2">
        The extension only sees claude.ai/code URLs and tab titles (never page content, cookies or tokens) and sends them to Claude Deck over <span className="font-mono">127.0.0.1:{s.extensionPort}</span> with a per-profile token. Install it once per Chrome profile: <b>chrome://extensions</b> → Developer mode → <b>Load unpacked</b> → choose the <span className="font-mono">extension/</span> folder of this project, then paste the pairing code below into the extension’s popup.
      </div>
      <Row label="Local port" hint={state.extension.running ? `Listening on 127.0.0.1:${state.extension.port}` : 'Not running'}>
        <NumberSetting value={s.extensionPort} min={1024} max={65535} suffix="" onSave={(n) => void save({ extensionPort: n })} />
      </Row>
      {s.extensionEnabled && (
        <div className="space-y-2">
          {state.accounts
            .filter((a) => !a.archived)
            .map((a) => (
              <div key={a.id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
                <span className="size-2.5 rounded-full" style={{ background: a.color }} />
                <span className="w-32 truncate text-[12.5px] font-medium">{a.displayName}</span>
                <span className="flex-1 truncate text-[12px] text-fg-3">{a.chromeProfileName ? `${a.chromeProfileName} (${a.chromeProfileDir})` : 'no Chrome profile'}</span>
                {code[a.id] ? (
                  <>
                    <span className="font-mono text-[12px] select-text">{code[a.id]}</span>
                    <Button size="xs" icon={<Copy className="size-3" />} onClick={() => void copyText(code[a.id], 'pairing code')}>
                      Copy
                    </Button>
                  </>
                ) : (
                  <Button
                    size="xs"
                    disabled={!state.extension.running}
                    onClick={() =>
                      void call('extension.pairing', { accountId: a.id })
                        .then((r) => setCode((c) => ({ ...c, [a.id]: r.code })))
                        .catch((e) => ui().toast('error', errorMessage(e)))
                    }
                  >
                    Pairing code
                  </Button>
                )}
              </div>
            ))}
          <div className="text-[11.5px] text-fg-3">Codes expire after 10 minutes. Paired profiles: {state.extension.pairedProfiles.length ? state.extension.pairedProfiles.join(', ') : 'none yet'}.</div>
        </div>
      )}
    </Section>
  )
}

export function SettingsView({ state }: { state: DeckState }) {
  const s = state.settings
  const [browser, setBrowser] = useState(s.browser)
  useEffect(() => setBrowser(s.browser), [s.browser])

  return (
    <div className="mx-auto max-w-[980px] space-y-5 pb-10">
      {state.hosts.map((h) => (
        <HostSection key={h.id} host={h} state={state} />
      ))}
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => ui().openDialog({ kind: 'host' })}>
          Add another VM
        </Button>
      </div>

      <Section title="Browser" description="Claude conversations open in the Chrome profile assigned to each account.">
        <div className="grid grid-cols-3 gap-4">
          <Field label="Browser">
            <Select
              value={browser.kind}
              onChange={(e) => {
                const kind = e.target.value as BrowserKind
                const next = { kind, appPath: BROWSER_PRESETS[kind].appPath, userDataDir: BROWSER_PRESETS[kind].userDataDir }
                setBrowser(next)
                void save({ browser: next })
              }}
            >
              {Object.entries(BROWSER_PRESETS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Application">
            <Input mono value={browser.appPath} onChange={(e) => setBrowser({ ...browser, appPath: e.target.value })} onBlur={() => browser.appPath !== s.browser.appPath && void save({ browser })} />
          </Field>
          <Field label="Profile data folder">
            <Input mono value={browser.userDataDir} onChange={(e) => setBrowser({ ...browser, userDataDir: e.target.value })} onBlur={() => browser.userDataDir !== s.browser.userDataDir && void save({ browser })} />
          </Field>
        </div>
        <div className="flex items-center justify-between text-[12px] text-fg-3">
          <span>{state.chromeError ?? `${state.chromeProfiles.length} profiles found: ${state.chromeProfiles.map((p) => `${p.name} (${p.directory})`).join(', ')}`}</span>
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => void call('chrome.profiles', undefined)}>
              Reload profiles
            </Button>
            <Button
              size="sm"
              icon={<Plus className="size-3.5" />}
              onClick={() =>
                void call('chrome.createProfile', undefined)
                  .then((r) => ui().toast('success', `Chrome is creating “${r.profileDir}”. Sign in to Claude there, rename the profile in Chrome if you like, then assign it to an account.`))
                  .catch((e) => ui().toast('error', errorMessage(e)))
              }
            >
              Create dedicated profile
            </Button>
          </div>
        </div>
      </Section>

      <Section title="Terminal & appearance">
        <Row label="Terminal app" hint="Used by Open Terminal (SSH + tmux attach) and the sign-in flow.">
          <Segmented
            value={s.terminalApp}
            onChange={(v) => void save({ terminalApp: v })}
            options={[
              { value: 'terminal', label: 'Terminal' },
              { value: 'iterm', label: 'iTerm2' },
            ]}
          />
        </Row>
        <Row label="Theme">
          <Segmented
            value={s.theme}
            onChange={(v) => void save({ theme: v })}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </Row>
        <Row label="Menu bar launcher" hint="Quick “Open Claude” for running sessions from the macOS menu bar.">
          <Switch checked={s.trayEnabled} onChange={(v) => void save({ trayEnabled: v })} />
        </Row>
        <Row label="Notifications" hint="When a session needs input, fails, loses its login, or stops unexpectedly.">
          <Switch checked={s.notifications} onChange={(v) => void save({ notifications: v })} />
        </Row>
      </Section>

      <Section title="Monitoring" description="Status refreshes over one multiplexed SSH connection; nothing runs on the VM between refreshes.">
        <Row label="Refresh interval">
          <NumberSetting value={s.refreshIntervalSec} min={5} max={600} suffix="seconds" onSave={(n) => void save({ refreshIntervalSec: n })} />
        </Row>
        <Row label="Git status refresh">
          <NumberSetting value={s.gitRefreshIntervalSec} min={15} max={3600} suffix="seconds" onSave={(n) => void save({ gitRefreshIntervalSec: n })} />
        </Row>
        <Row label="Sign-in check" hint="Runs `claude auth status` for each account.">
          <NumberSetting value={s.authCheckIntervalMin} min={5} max={1440} suffix="minutes" onSave={(n) => void save({ authCheckIntervalMin: n })} />
        </Row>
        <Row label="Startup timeout" hint="How long a new session may take to connect before it is reported as not confirmed.">
          <NumberSetting value={s.startupGraceSec} min={15} max={300} suffix="seconds" onSave={(n) => void save({ startupGraceSec: n })} />
        </Row>
        <Row label="Graceful stop timeout" hint="Wait after Ctrl+C before offering a force stop.">
          <NumberSetting value={s.stopTimeoutSec} min={3} max={60} suffix="seconds" onSave={(n) => void save({ stopTimeoutSec: n })} />
        </Row>
      </Section>

      <Section title="Status detection (advanced)" description="Regular expressions matched against sanitized terminal output. Adjust them if a Claude Code update changes its wording. “Connected” also uses live-connection evidence from the process itself.">
        <PatternsEditor patterns={s.statusPatterns} />
      </Section>

      <ExtensionSection state={state} />

      <Section title="Data" description="Projects, accounts, sessions and links are stored locally in SQLite. No credentials are stored.">
        <div className="flex flex-wrap gap-2">
          <Button
            icon={<Download className="size-4" />}
            onClick={() =>
              void call('data.export', undefined)
                .then((r) => r.path && ui().toast('success', `Exported to ${r.path}`))
                .catch((e) => ui().toast('error', errorMessage(e)))
            }
          >
            Export JSON
          </Button>
          <Button
            icon={<Upload className="size-4" />}
            onClick={() =>
              void call('data.import', undefined)
                .then((r) => r.imported && ui().toast('success', `Imported ${Object.entries(r.counts ?? {}).map(([k, v]) => `${v} ${k}`).join(', ')}`))
                .catch((e) => ui().toast('error', errorMessage(e)))
            }
          >
            Import JSON
          </Button>
          <Button variant="ghost" icon={<Server className="size-4" />} onClick={() => void save({ onboardingComplete: false })}>
            Run setup again
          </Button>
        </div>
        <div className={cx('text-[12px] text-fg-3')}>Claude Deck {state.appVersion} · data in ~/Library/Application Support/Claude Deck · logs in ~/Library/Logs/Claude Deck</div>
      </Section>
    </div>
  )
}
