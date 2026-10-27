// "Open Claude" routing: conversation → runtime → Claude account → Chrome profile → URL.
// Pure and side-effect free so the exact decision (including every warning) is unit-testable.

import type { Account, ChromeProfile, Conversation, Runtime } from './types'
import { CLAUDE_CODE_HOME, environmentUrl, isEnvironmentId, isOpenableClaudeUrl } from './urls'
import { configDirLabel, sameConfigDir } from './naming'

export type OpenTarget = 'conversation' | 'environment' | 'home'

export interface OpenRequest {
  runtimeId?: string | null
  conversationId?: string | null
  accountId?: string | null
  target?: OpenTarget
}

export type OpenIssueCode =
  | 'no_runtime'
  | 'no_account'
  | 'account_archived'
  | 'account_mismatch'
  | 'no_profile'
  | 'profile_missing'
  | 'profile_unverified'
  | 'profile_shared'
  | 'no_url'
  | 'env_fallback'
  | 'conversation_not_live'

export interface OpenIssue {
  code: OpenIssueCode
  /** block: cannot open; confirm: needs explicit acknowledgement; info: shown but never blocks */
  severity: 'block' | 'confirm' | 'info'
  message: string
}

export interface OpenPlan {
  runtimeId: string | null
  conversationId: string | null
  accountId: string | null
  accountName: string | null
  profileDir: string | null
  profileName: string | null
  url: string | null
  urlKind: OpenTarget | null
  issues: OpenIssue[]
}

export interface RoutingState {
  runtimes: Runtime[]
  conversations: Conversation[]
  accounts: Account[]
  chromeProfiles: ChromeProfile[]
  /** false when Chrome's Local State could not be read (profiles then cannot be validated) */
  chromeProfilesKnown: boolean
  home?: string | null
}

/** The conversation "Open Claude" uses for a runtime: pinned, else last opened, else live/last seen. */
export function defaultConversation(runtimeId: string, conversations: Conversation[]): Conversation | null {
  const mine = conversations.filter((c) => c.runtimeId === runtimeId && !c.archived)
  if (!mine.length) return null
  const pinned = mine.find((c) => c.pinned)
  if (pinned) return pinned
  const ts = (v: string | null) => (v ? Date.parse(v) || 0 : 0)
  const opened = mine.filter((c) => c.lastOpenedAt).sort((a, b) => ts(b.lastOpenedAt) - ts(a.lastOpenedAt))
  if (opened.length) return opened[0]
  const live = mine.filter((c) => c.live).sort((a, b) => ts(b.lastSeenAt) - ts(a.lastSeenAt))
  if (live.length) return live[0]
  return [...mine].sort((a, b) => ts(b.lastSeenAt ?? b.createdAt) - ts(a.lastSeenAt ?? a.createdAt))[0]
}

export function accountsSharingProfile(account: Account, accounts: Account[]): Account[] {
  if (!account.chromeProfileDir) return []
  return accounts.filter((a) => a.id !== account.id && !a.archived && a.chromeProfileDir === account.chromeProfileDir)
}

export function planOpen(state: RoutingState, req: OpenRequest): OpenPlan {
  const issues: OpenIssue[] = []
  const plan: OpenPlan = {
    runtimeId: null,
    conversationId: null,
    accountId: null,
    accountName: null,
    profileDir: null,
    profileName: null,
    url: null,
    urlKind: null,
    issues,
  }
  const target: OpenTarget = req.target ?? 'conversation'

  let conversation: Conversation | null = null
  let runtime: Runtime | null = null
  let account: Account | null = null

  if (req.conversationId) {
    conversation = state.conversations.find((c) => c.id === req.conversationId) ?? null
    if (conversation?.runtimeId) runtime = state.runtimes.find((r) => r.id === conversation!.runtimeId) ?? null
  }
  if (!runtime && req.runtimeId) runtime = state.runtimes.find((r) => r.id === req.runtimeId) ?? null

  if (req.accountId && !runtime) {
    account = state.accounts.find((a) => a.id === req.accountId) ?? null
  } else if (!runtime) {
    issues.push({
      code: 'no_runtime',
      severity: 'block',
      message: conversation
        ? 'This conversation is not attached to a Claude session, so its account is unknown. Attach it to a session first.'
        : 'Session not found.',
    })
    return plan
  } else {
    plan.runtimeId = runtime.id
    account = runtime.accountId ? state.accounts.find((a) => a.id === runtime!.accountId) ?? null : null
  }

  if (!account) {
    issues.push({
      code: 'no_account',
      severity: 'block',
      message: 'This session’s Claude account is unconfirmed. Assign the correct account before opening it, so it cannot open in the wrong login.',
    })
    return plan
  }
  plan.accountId = account.id
  plan.accountName = account.displayName
  if (account.archived) {
    issues.push({ code: 'account_archived', severity: 'confirm', message: `${account.displayName} is archived.` })
  }

  if (runtime?.observedConfigDir && runtime.observedConfigDir.state !== 'unknown') {
    const observed = runtime.observedConfigDir.state === 'default' ? null : runtime.observedConfigDir.value
    if (!sameConfigDir(observed, account.configDir, state.home)) {
      issues.push({
        code: 'account_mismatch',
        severity: 'confirm',
        message: `Mapping conflict: the running process uses ${configDirLabel(observed, state.home)}, but this session is mapped to ${account.displayName} (${configDirLabel(account.configDir, state.home)}). It may open in the wrong account.`,
      })
    }
  }

  if (!account.chromeProfileDir) {
    issues.push({
      code: 'no_profile',
      severity: 'block',
      message: `No Chrome profile is assigned to ${account.displayName}. Assign one in Claude Accounts so this account always opens in the right browser login.`,
    })
    return plan
  }
  plan.profileDir = account.chromeProfileDir
  const profile = state.chromeProfiles.find((p) => p.directory === account!.chromeProfileDir) ?? null
  const baseName = profile?.name ?? account.chromeProfileName ?? account.chromeProfileDir
  plan.profileName = baseName && baseName !== account.chromeProfileDir ? `${baseName} (${account.chromeProfileDir})` : account.chromeProfileDir
  if (state.chromeProfilesKnown && !profile) {
    issues.push({
      code: 'profile_missing',
      severity: 'block',
      message: `Chrome profile “${account.chromeProfileName ?? account.chromeProfileDir}” (${account.chromeProfileDir}) no longer exists. Choose another profile for ${account.displayName}.`,
    })
    return plan
  }
  if (!account.chromeProfileConfirmedAt) {
    issues.push({
      code: 'profile_unverified',
      severity: 'confirm',
      message: `The Chrome profile “${plan.profileName}” has not been verified as signed in to ${account.displayName}${account.authEmail ? ` (${account.authEmail})` : ''}. Use “Test browser profile” in Claude Accounts to confirm it.`,
    })
  }
  const sharing = accountsSharingProfile(account, state.accounts)
  if (sharing.length) {
    issues.push({
      code: 'profile_shared',
      severity: 'confirm',
      message: `Chrome profile “${plan.profileName}” is also assigned to ${sharing.map((a) => a.displayName).join(', ')}. claude.ai keeps one login per profile, so one of these accounts will open in the wrong login.`,
    })
  }

  // ---- URL
  if (target === 'home') {
    plan.url = CLAUDE_CODE_HOME
    plan.urlKind = 'home'
  } else if (target === 'environment') {
    if (runtime && isEnvironmentId(runtime.environmentId)) {
      plan.url = environmentUrl(runtime.environmentId)
      plan.urlKind = 'environment'
    } else {
      issues.push({ code: 'no_url', severity: 'block', message: 'No Remote Control environment link is known for this session yet.' })
    }
  } else {
    const conv = conversation ?? (runtime ? defaultConversation(runtime.id, state.conversations) : null)
    if (conv && isOpenableClaudeUrl(conv.url)) {
      plan.url = conv.url
      plan.urlKind = 'conversation'
      plan.conversationId = conv.id
      if (!conv.live) {
        issues.push({
          code: 'conversation_not_live',
          severity: 'info',
          message: 'This conversation was not running at the last check. The saved link is kept, but it may have been archived or expired.',
        })
      }
    } else if (runtime && isEnvironmentId(runtime.environmentId)) {
      plan.url = environmentUrl(runtime.environmentId)
      plan.urlKind = 'environment'
      issues.push({
        code: 'env_fallback',
        severity: 'info',
        message: 'No exact conversation link is known yet — opening the Remote Control environment page instead.',
      })
    } else {
      plan.url = CLAUDE_CODE_HOME
      plan.urlKind = 'home'
      issues.push({
        code: 'no_url',
        severity: 'confirm',
        message: `No conversation or environment link is known. Claude Deck can open claude.ai/code in ${account.displayName}’s profile; then use “Link conversation” to save the exact URL.`,
      })
    }
  }
  return plan
}

export function blockingIssues(plan: OpenPlan): OpenIssue[] {
  return plan.issues.filter((i) => i.severity === 'block')
}

export function needsConfirmation(plan: OpenPlan): boolean {
  return plan.issues.some((i) => i.severity === 'confirm')
}
