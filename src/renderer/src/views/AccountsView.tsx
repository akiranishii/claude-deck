import type { Account, ChromeProfile, DeckState } from '@shared/types'
import { ACCOUNT_COLORS } from '@shared/constants'
import { configDirLabel } from '@shared/naming'
import { accountsSharingProfile } from '@shared/routing'
import { BadgeCheck, Ellipsis, Globe, KeyRound, Pencil, Plus, RefreshCw, Trash2, Archive, ArchiveRestore, TriangleAlert, Sparkles, ArrowUpRight } from 'lucide-react'
import { AccountAvatar } from '../components/Status'
import { Badge, Button, Callout, cx, IconButton, Menu, Select, Tip } from '../components/ui'
import { call, errorMessage } from '../lib/api'
import { checkAuth, confirmAction, openClaude } from '../lib/actions'
import { relTime } from '../lib/format'
import type { RuntimeVM } from '../lib/selectors'
import { ui, useUi } from '../lib/store'

export function profileOptionLabel(p: ChromeProfile): string {
  const parts = [p.name]
  if (p.name !== p.directory) parts.push(`— ${p.directory}`)
  if (p.email) parts.push(`(${p.email})`)
  return parts.join(' ')
}

export function suggestProfile(account: Account, profiles: ChromeProfile[], accounts: Account[]): ChromeProfile | null {
  if (!account.authEmail) return null
  const taken = new Set(accounts.filter((a) => a.id !== account.id && a.chromeProfileDir).map((a) => a.chromeProfileDir))
  const hits = profiles.filter((p) => p.email && p.email.toLowerCase() === account.authEmail!.toLowerCase() && !taken.has(p.directory))
  return hits.length === 1 ? hits[0] : null
}

async function update(id: string, patch: Parameters<typeof call<'account.update'>>[1]['patch']) {
  try {
    await call('account.update', { id, patch })
  } catch (err) {
    ui().toast('error', errorMessage(err))
  }
}

export function ProfileMapper({ account, state, compact = false }: { account: Account; state: DeckState; compact?: boolean }) {
  const profiles = state.chromeProfiles
  const current = profiles.find((p) => p.directory === account.chromeProfileDir) ?? null
  const sharing = accountsSharingProfile(account, state.accounts)
  const suggestion = !account.chromeProfileDir ? suggestProfile(account, profiles, state.accounts) : null
  const testing = useUi((s) => s.busy[`test:${account.id}`])

  const test = async () => {
    if (!account.chromeProfileDir) return
    ui().setBusy(`test:${account.id}`, 'Testing')
    try {
      await call('chrome.test', { profileDir: account.chromeProfileDir })
      ui().toast('info', `Opened claude.ai/code in “${current?.name ?? account.chromeProfileDir}”. Check which Claude account is signed in there, then confirm.`)
    } catch (err) {
      ui().toast('error', errorMessage(err))
    } finally {
      ui().setBusy(`test:${account.id}`, null)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Select
          value={account.chromeProfileDir ?? ''}
          onChange={(e) => void update(account.id, { chromeProfileDir: e.target.value || null })}
          className="min-w-0 flex-1"
        >
          <option value="">— Choose a Chrome profile —</option>
          {profiles.map((p) => (
            <option key={p.directory} value={p.directory}>
              {profileOptionLabel(p)}
            </option>
          ))}
          {account.chromeProfileDir && !current && <option value={account.chromeProfileDir}>{account.chromeProfileDir} (not found)</option>}
        </Select>
        <Tip label="Open claude.ai/code in this profile so you can see which Claude account it is signed in to">
          <Button size="md" disabled={!account.chromeProfileDir} loading={Boolean(testing)} onClick={() => void test()} icon={<ArrowUpRight className="size-3.5" />}>
            Test
          </Button>
        </Tip>
      </div>
      {suggestion && (
        <div className="flex items-center gap-2 rounded-lg bg-accent-soft px-2.5 py-1.5 text-[12px]">
          <Sparkles className="size-3.5 text-accent" />
          <span className="min-w-0 flex-1">
            Suggested: <b>{suggestion.name}</b> ({suggestion.directory}) — its Google account matches {account.authEmail}.
          </span>
          <Button size="xs" variant="primary" onClick={() => void update(account.id, { chromeProfileDir: suggestion.directory })}>
            Use
          </Button>
        </div>
      )}
      {account.chromeProfileDir && (
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          {sharing.length > 0 ? (
            <Badge tone="danger" icon={<TriangleAlert className="size-3" />}>
              Also assigned to {sharing.map((a) => a.displayName).join(', ')}
            </Badge>
          ) : account.chromeProfileConfirmedAt ? (
            <Badge tone="ok" icon={<BadgeCheck className="size-3" />}>
              Verified {relTime(account.chromeProfileConfirmedAt)}
            </Badge>
          ) : (
            <Badge tone="warn">Not verified yet</Badge>
          )}
          {!account.chromeProfileConfirmedAt && sharing.length === 0 && (
            <Button
              size="xs"
              variant="secondary"
              onClick={() =>
                void call('account.confirmProfile', { id: account.id, confirmed: true })
                  .then(() => ui().toast('success', `Verified: ${account.displayName} opens in “${current?.name ?? account.chromeProfileDir}”`))
                  .catch((e) => ui().toast('error', errorMessage(e)))
              }
            >
              I checked — it’s signed in as {account.authEmail ?? account.displayName}
            </Button>
          )}
          {account.chromeProfileConfirmedAt && !compact && (
            <button className="text-[11.5px] text-fg-3 hover:text-fg-2" onClick={() => void call('account.confirmProfile', { id: account.id, confirmed: false })}>
              Reset verification
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function AuthLine({ account, hostId }: { account: Account; hostId: string | null }) {
  const checking = useUi((s) => Boolean(s.busy[`auth:${account.id}`]))
  const state = account.authState
  return (
    <div className="flex flex-wrap items-center gap-2">
      {state === 'authenticated' ? (
        <Badge tone="ok" icon={<KeyRound className="size-3" />}>
          Signed in
        </Badge>
      ) : state === 'logged_out' ? (
        <Badge tone="danger" icon={<KeyRound className="size-3" />}>
          Not signed in
        </Badge>
      ) : state === 'missing_dir' ? (
        <Badge tone="danger">Config dir missing</Badge>
      ) : state === 'error' ? (
        <Badge tone="warn" title={account.authError ?? undefined}>
          Check failed
        </Badge>
      ) : (
        <Badge>Not checked</Badge>
      )}
      {account.authEmail && <span className="truncate text-[12px] text-fg-2 select-text">{account.authEmail}</span>}
      {account.authPlan && <span className="text-[11.5px] text-fg-3 capitalize">{account.authPlan}</span>}
      <span className="ml-auto flex items-center gap-1 text-[11px] text-fg-3">
        {account.authCheckedAt ? `checked ${relTime(account.authCheckedAt)}` : ''}
        <IconButton size="xs" label="Check sign-in now" loading={checking} onClick={() => void checkAuth(account.id)}>
          <RefreshCw className="size-3" />
        </IconButton>
      </span>
      {(state === 'logged_out' || state === 'missing_dir' || state === 'error') && hostId && (
        <Button size="xs" variant="primary" icon={<KeyRound className="size-3" />} onClick={() => ui().openDialog({ kind: 'login', accountId: account.id, hostId })}>
          Sign in…
        </Button>
      )}
    </div>
  )
}

function AccountCard({ account, state, runtimes, index }: { account: Account; state: DeckState; runtimes: RuntimeVM[]; index: number }) {
  const host = state.hosts[0] ?? null
  const mine = runtimes.filter((r) => r.account?.id === account.id && !r.runtime.archived)
  const running = mine.filter((r) => r.running).length
  return (
    <article className={cx('flex flex-col rounded-card border border-line bg-panel shadow-card', account.archived && 'opacity-60')}>
      <div className="h-[3px] rounded-t-card" style={{ background: account.color }} />
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <AccountAvatar account={account} size={34} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold">{account.displayName}</h2>
            {index < 5 && <span className="text-[11px] text-fg-3">⌘{index + 1}</span>}
            {account.archived && <Badge>archived</Badge>}
          </div>
          <div className="truncate text-[12px] text-fg-3">{account.label ?? account.authEmail ?? 'No label'}</div>
        </div>
        <Menu
          trigger={
            <button className="inline-flex size-7 items-center justify-center rounded-md text-fg-3 hover:bg-panel-2 hover:text-fg" aria-label="Account actions">
              <Ellipsis className="size-4" />
            </button>
          }
          items={[
            { label: 'Edit account…', icon: <Pencil className="size-3.5" />, onSelect: () => ui().openDialog({ kind: 'account', accountId: account.id }) },
            host && { label: 'Sign in again…', icon: <KeyRound className="size-3.5" />, onSelect: () => ui().openDialog({ kind: 'login', accountId: account.id, hostId: host.id }) },
            account.chromeProfileDir && { label: 'Open claude.ai/code in this profile', icon: <Globe className="size-3.5" />, onSelect: () => void openClaude({ accountId: account.id, target: 'home' }) },
            account.archived
              ? { label: 'Unarchive', icon: <ArchiveRestore className="size-3.5" />, separatorBefore: true, onSelect: () => void update(account.id, { archived: false }) }
              : { label: 'Archive', icon: <Archive className="size-3.5" />, separatorBefore: true, onSelect: () => void update(account.id, { archived: true }) },
            {
              label: 'Remove account…',
              icon: <Trash2 className="size-3.5" />,
              danger: true,
              onSelect: () =>
                confirmAction({
                  title: `Remove ${account.displayName}?`,
                  body: `${account.displayName} is removed from Claude Deck only. Its config directory and login on the VM are untouched, and running sessions keep running (they will show “Account unconfirmed” until you assign another account).`,
                  confirmLabel: 'Remove account',
                  danger: true,
                  onConfirm: async () => {
                    await call('account.delete', { id: account.id })
                  },
                }),
            },
          ]}
        />
      </div>
      <div className="space-y-3.5 px-4 pt-3 pb-4">
        <div>
          <div className="mb-1 text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase">Remote config (CLAUDE_CONFIG_DIR)</div>
          <div className="font-mono text-[12px] text-fg select-text">{configDirLabel(account.configDir, host?.homePath)}</div>
        </div>
        <div>
          <div className="mb-1 text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase">Claude sign-in on the VM</div>
          <AuthLine account={account} hostId={host?.id ?? null} />
        </div>
        <div>
          <div className="mb-1 text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase">Chrome profile</div>
          <ProfileMapper account={account} state={state} />
        </div>
        {mine.length > 0 && (
          <div>
            <div className="mb-1 text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase">Sessions</div>
            <div className="flex flex-wrap gap-1.5">
              {mine.map((r) => (
                <button
                  key={r.runtime.id}
                  type="button"
                  onClick={() => {
                    ui().setView('dashboard')
                    ui().select(r.runtime.id)
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md border border-line bg-panel-2/60 px-2 py-0.5 text-[11.5px] text-fg-2 hover:border-line-strong"
                >
                  <span className={cx('size-1.5 rounded-full', r.running ? 'bg-ok' : 'bg-line-strong')} />
                  {r.project.displayName}
                  <span className="font-mono text-[10.5px] text-fg-3">{r.runtime.tmuxSessionName}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
          <span className="text-[12px] text-fg-3">
            {running} running · {mine.length} session{mine.length === 1 ? '' : 's'}
          </span>
          <div className="flex items-center gap-1">
            {ACCOUNT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Color ${c}`}
                onClick={() => void update(account.id, { color: c })}
                className={cx('size-4 rounded-full transition-transform hover:scale-110', account.color === c && 'ring-2 ring-offset-2 ring-offset-panel')}
                style={{ background: c, ['--tw-ring-color' as string]: c }}
              />
            ))}
          </div>
        </div>
      </div>
    </article>
  )
}

export function AccountsView({ state, runtimes }: { state: DeckState; runtimes: RuntimeVM[] }) {
  const accounts = [...state.accounts].sort((a, b) => Number(a.archived) - Number(b.archived) || a.sortOrder - b.sortOrder)
  const active = accounts.filter((a) => !a.archived)
  return (
    <div className="space-y-5">
      <Callout tone="info" title="Every Claude account = one remote config directory + one Chrome profile">
        Sessions are launched with the account’s <span className="font-mono">CLAUDE_CONFIG_DIR</span> set for that process only, and Open Claude always uses the account’s Chrome profile — so each login stays signed in independently, no incognito windows. Claude Deck never reads cookies, passwords or tokens.
      </Callout>
      {state.chromeError && (
        <Callout tone="warn" title="Chrome profiles could not be read">
          {state.chromeError}. Check the browser settings.
        </Callout>
      )}
      {active.length > 0 && (
        <div className="overflow-hidden rounded-card border border-line bg-panel shadow-card">
          <div className="grid grid-cols-[1.1fr_1.3fr_1.6fr_0.9fr] gap-3 border-b border-line bg-panel-2/60 px-4 py-2 text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase">
            <span>Claude account</span>
            <span>Remote config</span>
            <span>Chrome profile</span>
            <span>Status</span>
          </div>
          {active.map((a) => {
            const p = state.chromeProfiles.find((x) => x.directory === a.chromeProfileDir)
            return (
              <div key={a.id} className="grid grid-cols-[1.1fr_1.3fr_1.6fr_0.9fr] items-center gap-3 border-b border-line px-4 py-2 text-[12.5px] last:border-b-0">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: a.color }} />
                  <span className="truncate font-medium">{a.displayName}</span>
                </span>
                <span className="truncate font-mono text-[11.5px] text-fg-2">{configDirLabel(a.configDir, state.hosts[0]?.homePath)}</span>
                <span className="truncate text-fg-2">{p ? `${p.name} · ${p.directory}` : a.chromeProfileDir ? `${a.chromeProfileDir} (missing)` : <span className="text-warn">not assigned</span>}</span>
                <span className="flex items-center gap-1.5">
                  {a.authState === 'authenticated' ? <span className="text-ok">signed in</span> : a.authState === 'logged_out' ? <span className="text-danger">signed out</span> : <span className="text-fg-3">{a.authState.replace('_', ' ')}</span>}
                  {a.chromeProfileConfirmedAt && <BadgeCheck className="size-3.5 text-ok" />}
                </span>
              </div>
            )
          })}
        </div>
      )}
      <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr))]">
        {accounts.map((a, i) => (
          <AccountCard key={a.id} account={a} state={state} runtimes={runtimes} index={i} />
        ))}
        <button
          type="button"
          onClick={() => ui().openDialog({ kind: 'account' })}
          className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-card border border-dashed border-line-strong text-fg-3 hover:border-accent hover:text-accent"
        >
          <Plus className="size-5" />
          <span className="text-[13px] font-medium">Add Claude account</span>
        </button>
      </div>
    </div>
  )
}
