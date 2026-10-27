import type { ConfigDirWithAuth, LoginStatus } from '@shared/ipc'
import type { DeckState } from '@shared/types'
import { ACCOUNT_COLORS } from '@shared/constants'
import { configDirLabel, defaultAccountName } from '@shared/naming'
import { ArrowUpRight, Check, Copy, KeyRound, LoaderCircle, SquareTerminal, UserPlus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Callout, Checkbox, cx, Field, Input, Modal, Select, Spinner } from '../components/ui'
import { call, errorMessage } from '../lib/api'
import { copyText } from '../lib/actions'
import { ui } from '../lib/store'
import { profileOptionLabel } from '../views/AccountsView'

type DirChoice = { kind: 'existing'; configDir: string | null } | { kind: 'new' } | { kind: 'custom' }

export function AccountDialog({ state, accountId, onClose }: { state: DeckState; accountId?: string; onClose: () => void }) {
  const existing = accountId ? state.accounts.find((a) => a.id === accountId) ?? null : null
  const host = state.hosts[0] ?? null
  const [name, setName] = useState(existing?.displayName ?? '')
  const [label, setLabel] = useState(existing?.label ?? '')
  const [color, setColor] = useState(existing?.color ?? ACCOUNT_COLORS.find((c) => !state.accounts.some((a) => a.color === c)) ?? ACCOUNT_COLORS[0])
  const [dirs, setDirs] = useState<ConfigDirWithAuth[] | null>(null)
  const [dirsError, setDirsError] = useState<string | null>(null)
  const [choice, setChoice] = useState<DirChoice>(existing ? { kind: 'existing', configDir: existing.configDir } : { kind: 'existing', configDir: '__none__' })
  const [newSuffix, setNewSuffix] = useState('')
  const [custom, setCustom] = useState('')
  const [profileDir, setProfileDir] = useState(existing?.chromeProfileDir ?? '')
  const [verified, setVerified] = useState(Boolean(existing?.chromeProfileConfirmedAt))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!host) return
    call('account.listConfigDirs', { hostId: host.id, checkAuth: true })
      .then((d) => {
        setDirs(d)
        if (!existing) {
          const first = d.find((x) => !x.accountId && x.auth?.loggedIn) ?? d.find((x) => !x.accountId)
          if (first) setChoice({ kind: 'existing', configDir: first.configDir })
          else setChoice({ kind: 'new' })
        }
      })
      .catch((e) => setDirsError(errorMessage(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.id])

  const selectedDir = choice.kind === 'existing' && choice.configDir !== '__none__' ? dirs?.find((d) => d.configDir === choice.configDir) ?? null : null
  const resolvedConfigDir: string | null | undefined =
    choice.kind === 'existing' ? (choice.configDir === '__none__' ? undefined : choice.configDir) : choice.kind === 'new' ? (newSuffix.trim() ? `~/.claude-${newSuffix.trim()}` : undefined) : custom.trim() || undefined

  useEffect(() => {
    if (existing || name) return
    if (resolvedConfigDir !== undefined) setName(defaultAccountName(resolvedConfigDir))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedConfigDir])

  const email = selectedDir?.auth?.email ?? existing?.authEmail ?? null
  const suggested = email ? state.chromeProfiles.find((p) => p.email?.toLowerCase() === email.toLowerCase()) : null
  useEffect(() => {
    if (!existing && !profileDir && suggested) setProfileDir(suggested.directory)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggested?.directory])

  const sharedWith = profileDir ? state.accounts.filter((a) => a.id !== existing?.id && a.chromeProfileDir === profileDir) : []

  const test = async () => {
    try {
      await call('chrome.test', { profileDir })
      ui().toast('info', 'Opened claude.ai/code in that profile — check which Claude account is signed in.')
    } catch (err) {
      ui().toast('error', errorMessage(err))
    }
  }

  const save = async (thenLogin = false) => {
    if (!host || resolvedConfigDir === undefined) return
    setBusy(true)
    setError(null)
    try {
      let configDir = resolvedConfigDir
      if (choice.kind === 'new') configDir = (await call('account.createConfigDir', { hostId: host.id, path: resolvedConfigDir as string })).path
      let id: string
      if (existing) {
        await call('account.update', { id: existing.id, patch: { displayName: name, label: label || null, color, configDir, chromeProfileDir: profileDir || null } })
        id = existing.id
      } else {
        id = (await call('account.create', { displayName: name, label: label || null, configDir, color, chromeProfileDir: profileDir || null })).id
      }
      if (profileDir && verified) await call('account.confirmProfile', { id, confirmed: true })
      void call('account.checkAuth', { id }).catch(() => undefined)
      ui().toast('success', existing ? 'Account saved' : `Account ${name} added`)
      onClose()
      if (thenLogin) ui().openDialog({ kind: 'login', accountId: id, hostId: host.id })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const needsLogin = choice.kind === 'new' || (selectedDir?.auth && selectedDir.auth.loggedIn === false)

  return (
    <Modal
      open
      onClose={onClose}
      width={680}
      icon={<UserPlus className="size-4" />}
      title={existing ? `Edit ${existing.displayName}` : 'Add Claude account'}
      description="An account is a remote Claude configuration directory plus the Chrome profile signed in to the same Claude login."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {needsLogin && (
            <Button disabled={!name.trim() || resolvedConfigDir === undefined} loading={busy} icon={<KeyRound className="size-4" />} onClick={() => void save(true)}>
              Save & sign in
            </Button>
          )}
          <Button variant="primary" disabled={!name.trim() || resolvedConfigDir === undefined} loading={busy} onClick={() => void save(false)}>
            {existing ? 'Save' : 'Add account'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Display name">
            <Input data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Account 3" />
          </Field>
          <Field label="Label or e-mail (optional)">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Research · me@example.com" />
          </Field>
        </div>

        <section>
          <div className="mb-2 text-[12px] font-medium text-fg-2">Remote configuration on {host?.displayName ?? 'the VM'}</div>
          {dirsError && <Callout tone="danger">{dirsError}</Callout>}
          {!dirs && !dirsError && (
            <div className="flex items-center gap-2 py-3 text-[12.5px] text-fg-3">
              <Spinner /> Looking for Claude config directories and checking their sign-in…
            </div>
          )}
          {dirs && (
            <div className="max-h-[230px] space-y-1 overflow-y-auto rounded-xl border border-line p-1">
              {dirs.map((d) => {
                const owner = d.accountId && d.accountId !== existing?.id ? state.accounts.find((a) => a.id === d.accountId) : null
                const on = choice.kind === 'existing' && choice.configDir === d.configDir
                return (
                  <button
                    key={d.path}
                    type="button"
                    disabled={Boolean(owner)}
                    onClick={() => setChoice({ kind: 'existing', configDir: d.configDir })}
                    className={cx('flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left disabled:opacity-50', on ? 'bg-accent-soft' : 'hover:bg-panel-2')}
                  >
                    <span className={cx('flex size-4 items-center justify-center rounded-full border', on ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong')}>{on && <Check className="size-2.5" strokeWidth={3} />}</span>
                    <span className="w-[190px] shrink-0 truncate font-mono text-[12px]">{configDirLabel(d.configDir, host?.homePath)}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-fg-2">
                      {d.auth?.state === 'ok' ? (d.auth.loggedIn ? `${d.auth.email ?? 'signed in'}${d.auth.subscription ? ` · ${d.auth.subscription}` : ''}` : 'not signed in') : d.auth ? d.auth.state : d.hasCredentials ? 'has credentials file' : 'no login yet'}
                    </span>
                    {d.inUseByServers > 0 && <Badge tone="ok">{d.inUseByServers} running</Badge>}
                    {owner && <Badge>{owner.displayName}</Badge>}
                  </button>
                )
              })}
            </div>
          )}
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setChoice({ kind: 'new' })} className={cx('rounded-xl border px-3 py-2 text-left text-[12.5px]', choice.kind === 'new' ? 'border-accent bg-accent-soft' : 'border-line hover:bg-panel-2')}>
              <div className="font-medium">Create a new config directory</div>
              <div className="mt-1 flex items-center gap-1 font-mono text-[12px]">
                ~/.claude-
                <input
                  value={newSuffix}
                  onFocus={() => setChoice({ kind: 'new' })}
                  onChange={(e) => setNewSuffix(e.target.value.replace(/[^A-Za-z0-9._-]/g, ''))}
                  placeholder="account6"
                  className="w-28 rounded border border-line bg-panel px-1.5 py-0.5 outline-none focus:border-accent"
                />
              </div>
            </button>
            <button type="button" onClick={() => setChoice({ kind: 'custom' })} className={cx('rounded-xl border px-3 py-2 text-left text-[12.5px]', choice.kind === 'custom' ? 'border-accent bg-accent-soft' : 'border-line hover:bg-panel-2')}>
              <div className="font-medium">Other path</div>
              <input
                value={custom}
                onFocus={() => setChoice({ kind: 'custom' })}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="/home/me/.config/claude-x"
                className="mt-1 w-full rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[12px] outline-none focus:border-accent"
              />
            </button>
          </div>
          <div className="mt-1.5 text-[11.5px] text-fg-3">The default account uses <span className="font-mono">~/.claude</span> with CLAUDE_CONFIG_DIR unset. Other accounts get CLAUDE_CONFIG_DIR set for their own processes only — global shell settings are never changed.</div>
        </section>

        <section className="space-y-2">
          <div className="text-[12px] font-medium text-fg-2">Chrome profile signed in to this Claude account</div>
          <div className="flex gap-2">
            <Select
              value={profileDir}
              onChange={(e) => {
                setProfileDir(e.target.value)
                setVerified(false)
              }}
              className="flex-1"
            >
              <option value="">— Choose later —</option>
              {state.chromeProfiles.map((p) => (
                <option key={p.directory} value={p.directory}>
                  {profileOptionLabel(p)}
                  {suggested?.directory === p.directory ? '  ★ suggested' : ''}
                </option>
              ))}
            </Select>
            <Button disabled={!profileDir} icon={<ArrowUpRight className="size-3.5" />} onClick={() => void test()}>
              Test browser profile
            </Button>
          </div>
          {suggested && <div className="text-[11.5px] text-fg-3">Suggested because the profile’s Google account matches {email}. Claude logins can differ from Google accounts — use Test to be sure.</div>}
          {profileDir && (
            <label className="flex items-center gap-2 text-[12.5px]">
              <Checkbox checked={verified} onChange={setVerified} /> I tested it: this profile is signed in to claude.ai as {email ?? (name || 'this account')}
            </label>
          )}
          {sharedWith.length > 0 && <Callout tone="danger">This profile is already assigned to {sharedWith.map((a) => a.displayName).join(', ')}. claude.ai keeps one login per profile, so they would open in the same login.</Callout>}
        </section>

        <section>
          <div className="mb-2 text-[12px] font-medium text-fg-2">Color</div>
          <div className="flex gap-2">
            {ACCOUNT_COLORS.map((c) => (
              <button key={c} type="button" onClick={() => setColor(c)} className={cx('size-6 rounded-full transition-transform hover:scale-110', color === c && 'ring-2 ring-offset-2 ring-offset-panel')} style={{ background: c, ['--tw-ring-color' as string]: c }} aria-label={c} />
            ))}
          </div>
        </section>
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    </Modal>
  )
}

export function LoginDialog({ state, accountId, hostId, onClose }: { state: DeckState; accountId: string; hostId: string; onClose: () => void }) {
  const account = state.accounts.find((a) => a.id === accountId)
  const [loginId, setLoginId] = useState<string | null>(null)
  const [status, setStatus] = useState<LoginStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [profileDir, setProfileDir] = useState(account?.chromeProfileDir ?? '')
  const [method, setMethod] = useState<'claudeai' | 'console' | 'sso'>('claudeai')
  const [started, setStarted] = useState(false)
  const finished = useRef(false)

  const start = async () => {
    setStarted(true)
    setError(null)
    try {
      const res = await call('login.start', { accountId, hostId, method })
      setLoginId(res.loginId)
    } catch (err) {
      setError(errorMessage(err))
      setStarted(false)
    }
  }

  useEffect(() => {
    if (!loginId) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    // One poll at a time; stop once the login has finished (each final poll re-checks auth over SSH).
    const tick = async () => {
      let done = false
      try {
        const s = await call('login.poll', { loginId })
        if (!alive) return
        setStatus(s)
        done = s.loggedIn === true || s.state === 'gone' || (s.state === 'exited' && s.loggedIn !== null)
      } catch (err) {
        if (alive) setError(errorMessage(err))
      }
      if (alive && !done) timer = setTimeout(() => void tick(), 2000)
    }
    void tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [loginId])

  const close = () => {
    if (loginId && !finished.current) {
      finished.current = true
      void call('login.finish', { loginId }).catch(() => undefined)
    }
    onClose()
  }

  if (!account) return null
  const done = status?.loggedIn === true

  return (
    <Modal
      open
      onClose={close}
      width={600}
      icon={<KeyRound className="size-4" />}
      title={`Sign in · ${account.displayName}`}
      description={`Runs Claude’s own \`claude auth login\` on the VM with ${configDirLabel(account.configDir, state.hosts.find((h) => h.id === hostId)?.homePath)}. Claude Deck never sees your password, code or tokens.`}
      footer={
        done ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : started ? (
          <>
            {loginId && (
              <Button variant="ghost" icon={<SquareTerminal className="size-4" />} onClick={() => void call('login.openTerminal', { loginId })}>
                Reopen terminal
              </Button>
            )}
            <Button onClick={close}>Cancel</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" icon={<KeyRound className="size-4" />} onClick={() => void start()}>
              Start sign-in
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {!started && (
          <>
            <Field label="Sign-in method">
              <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                <option value="claudeai">Claude subscription (Pro / Max / Team)</option>
                <option value="console">Anthropic Console (API billing)</option>
                <option value="sso">Organization SSO</option>
              </Select>
            </Field>
            <ol className="list-decimal space-y-1 pl-5 text-[12.5px] text-fg-2">
              <li>A Terminal window opens and runs the sign-in command inside a temporary tmux session on the VM.</li>
              <li>Claude Deck opens the sign-in page in the Chrome profile you choose below.</li>
              <li>Approve access in the browser, then paste the code shown there into the Terminal window.</li>
            </ol>
          </>
        )}
        <Field label="Open the sign-in page in Chrome profile" hint="Use the profile that should stay signed in to this Claude account.">
          <Select value={profileDir} onChange={(e) => setProfileDir(e.target.value)}>
            <option value="">— Choose a profile —</option>
            {state.chromeProfiles.map((p) => (
              <option key={p.directory} value={p.directory}>
                {profileOptionLabel(p)}
              </option>
            ))}
          </Select>
        </Field>
        {started && !done && (
          <div className="space-y-2.5 rounded-xl border border-line p-3">
            {!status?.authUrl ? (
              <div className="flex items-center gap-2 text-[12.5px] text-fg-2">
                <LoaderCircle className="size-4 animate-spin-slow text-accent" /> Waiting for Claude to print the sign-in link…
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 text-[12.5px] font-medium">
                  <Check className="size-4 text-ok" /> Sign-in link ready
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    disabled={!profileDir}
                    icon={<ArrowUpRight className="size-4" />}
                    onClick={() => loginId && status.authUrl && void call('login.openUrl', { loginId, url: status.authUrl, profileDir }).catch((e) => ui().toast('error', errorMessage(e)))}
                  >
                    Open sign-in page in “{state.chromeProfiles.find((p) => p.directory === profileDir)?.name ?? 'profile'}”
                  </Button>
                  <Button icon={<Copy className="size-3.5" />} onClick={() => status.authUrl && void copyText(status.authUrl, 'sign-in link')}>
                    Copy link
                  </Button>
                </div>
              </>
            )}
            {status?.awaitingCode && <Callout tone="info">After approving, claude.ai shows a code. Paste it into the Terminal window and press Enter.</Callout>}
            {status?.state === 'exited' && status.loggedIn === false && <Callout tone="danger">The sign-in command exited but the account is still not signed in. Check the Terminal window, then try again.</Callout>}
            {status?.screenTail?.length ? <div className="terminal-text max-h-28 overflow-y-auto rounded-lg bg-[#0f1218] px-2.5 py-2 text-[#c9d1dc]">{status.screenTail.slice(-6).join('\n')}</div> : null}
          </div>
        )}
        {done && (
          <Callout tone="ok" title={`${account.displayName} is signed in`}>
            {account.authEmail ? `Signed in as ${account.authEmail}.` : 'Claude reports this account is signed in.'} Existing sessions of other accounts were not affected.
          </Callout>
        )}
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    </Modal>
  )
}
