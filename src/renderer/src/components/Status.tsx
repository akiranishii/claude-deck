import { STATUS_META, type StatusTone } from '@shared/constants'
import type { Account, AuthState, ChromeProfile } from '@shared/types'
import { configDirLabel } from '@shared/naming'
import { Globe, KeyRound, TriangleAlert } from 'lucide-react'
import type { EffectiveStatus, ProfileIssue } from '../lib/selectors'
import { initials } from '../lib/format'
import { cx, Tip } from './ui'

export const TONE_VAR: Record<StatusTone, string> = {
  ok: 'var(--ok)',
  info: 'var(--info)',
  progress: 'var(--progress)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  muted: 'var(--muted)',
  offline: 'var(--offline)',
}

export function StatusDot({ status, size = 8 }: { status: EffectiveStatus; size?: number }) {
  const meta = STATUS_META[status]
  const color = TONE_VAR[meta.tone]
  const hollow = status === 'stopped' || status === 'missing' || status === 'unknown'
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size + 4, height: size + 4 }}>
      {status === 'connected' && <span className="absolute inset-0 rounded-full opacity-25" style={{ background: color }} />}
      <span
        className={cx('rounded-full', meta.pulse && 'animate-dot')}
        style={{ width: size, height: size, background: hollow ? 'transparent' : color, border: hollow ? `1.5px solid ${color}` : undefined }}
      />
    </span>
  )
}

export function StatusPill({
  status,
  detail,
  evidence,
  pending,
  className,
}: {
  status: EffectiveStatus
  detail?: string | null
  evidence?: string[]
  /** The status is the last known one; the VM has not been checked yet in this app session. */
  pending?: boolean
  className?: string
}) {
  const meta = STATUS_META[status]
  const label = (
    <div className="space-y-1">
      <div className="font-semibold">{pending ? `Last known: ${meta.label}` : meta.label}</div>
      {pending && <div className="opacity-90">Checking the VM now…</div>}
      {detail && detail !== meta.label && <div className="opacity-90">{detail}</div>}
      <div className="opacity-70">{meta.description}</div>
      {evidence && evidence.length > 0 && (
        <div className="border-t border-white/15 pt-1 opacity-70">
          {evidence.map((e, i) => (
            <div key={i}>• {e}</div>
          ))}
        </div>
      )}
    </div>
  )
  return (
    <Tip label={label}>
      <span className={cx('inline-flex items-center gap-1 text-[12px] font-medium whitespace-nowrap', pending && 'opacity-50', className)} style={{ color: TONE_VAR[meta.tone] }}>
        <StatusDot status={status} />
        {meta.short}
      </span>
    </Tip>
  )
}

export function AccountAvatar({ account, size = 22, className }: { account: Account | null; size?: number; className?: string }) {
  if (!account) {
    return (
      <span
        className={cx('inline-flex shrink-0 items-center justify-center rounded-md border border-dashed border-warn text-warn', className)}
        style={{ width: size, height: size }}
      >
        <TriangleAlert style={{ width: size * 0.55, height: size * 0.55 }} />
      </span>
    )
  }
  return (
    <span
      className={cx('inline-flex shrink-0 items-center justify-center rounded-md font-semibold text-white', className)}
      style={{ width: size, height: size, background: account.color, fontSize: Math.max(9, size * 0.42), boxShadow: 'inset 0 0 0 1px rgb(0 0 0 / 0.08)' }}
    >
      {initials(account.displayName)}
    </span>
  )
}

const AUTH_TEXT: Record<AuthState, string> = {
  unknown: 'Sign-in not checked yet',
  authenticated: 'Signed in',
  logged_out: 'Not signed in on the VM',
  missing_dir: 'Config directory missing on the VM',
  error: 'Sign-in check failed',
}

export function accountTooltip(account: Account, profile: ChromeProfile | null, home?: string | null) {
  return (
    <div className="space-y-0.5">
      <div className="font-semibold">{account.displayName}</div>
      {account.label && <div className="opacity-80">{account.label}</div>}
      <div className="opacity-80">CLAUDE_CONFIG_DIR: {configDirLabel(account.configDir, home)}</div>
      <div className="opacity-80">
        {AUTH_TEXT[account.authState]}
        {account.authEmail ? ` · ${account.authEmail}` : ''}
        {account.authPlan ? ` · ${account.authPlan}` : ''}
      </div>
      <div className="opacity-80">Chrome: {profile ? `${profile.name} (${profile.directory})` : account.chromeProfileDir ?? 'not assigned'}</div>
    </div>
  )
}

export function AccountChip({ account, profile, home, className, onClick }: { account: Account | null; profile?: ChromeProfile | null; home?: string | null; className?: string; onClick?: () => void }) {
  if (!account) {
    return (
      <Tip label="The Claude account for this session could not be determined from the process. Assign it before opening.">
        <button
          type="button"
          onClick={onClick}
          className={cx('inline-flex h-[22px] items-center gap-1.5 rounded-md border border-dashed border-warn/70 px-1.5 text-[11.5px] font-medium text-warn', className)}
        >
          <TriangleAlert className="size-3" />
          Account unconfirmed
        </button>
      </Tip>
    )
  }
  return (
    <Tip label={accountTooltip(account, profile ?? null, home)}>
      <span
        onClick={onClick}
        className={cx('inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-md border border-line bg-panel px-1.5 text-[11.5px] font-medium text-fg', onClick && 'cursor-pointer hover:border-line-strong', className)}
      >
        <span className="size-2 shrink-0 rounded-full" style={{ background: account.color }} />
        <span className="truncate">{account.displayName}</span>
        {account.authState === 'logged_out' && <KeyRound className="size-3 text-danger" />}
      </span>
    </Tip>
  )
}

export function ProfileTag({ issue, profile, dir, className }: { issue: ProfileIssue; profile: ChromeProfile | null; dir?: string | null; className?: string }) {
  if (issue === 'no-account') return null
  const name = profile ? (profile.name === profile.directory ? profile.name : `${profile.name} · ${profile.directory}`) : dir ?? null
  const tone =
    issue === 'ok' ? 'text-fg-3' : issue === 'unverified' ? 'text-warn' : 'text-danger'
  const text =
    issue === 'unassigned'
      ? 'No Chrome profile'
      : issue === 'missing'
        ? 'Profile missing'
        : issue === 'shared'
          ? `${name} · shared!`
          : issue === 'unverified'
            ? `${name} (unverified)`
            : name
  const tip =
    issue === 'ok'
      ? `Opens in Chrome profile “${profile?.name}” (${profile?.directory}), verified for this account`
      : issue === 'unverified'
        ? 'This Chrome profile has not been verified for this account yet (Claude Accounts → Test browser profile)'
        : issue === 'shared'
          ? 'Another account uses the same Chrome profile — one of them will open in the wrong claude.ai login'
          : issue === 'missing'
            ? 'The assigned Chrome profile no longer exists'
            : 'Assign a Chrome profile to this account so Open Claude uses the right login'
  return (
    <Tip label={tip}>
      <span className={cx('inline-flex min-w-0 items-center gap-1 text-[11.5px]', tone, className)}>
        <Globe className="size-3 shrink-0" />
        <span className="truncate">{text}</span>
      </span>
    </Tip>
  )
}
