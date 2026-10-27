// Browser-profile routing: every conversation must open in its own account's Chrome profile,
// and every ambiguity must surface as a warning instead of silently opening the wrong login.

import { describe, expect, it } from 'vitest'
import { blockingIssues, defaultConversation, needsConfirmation, planOpen, type RoutingState } from '../../src/shared/routing'
import { account, conversation, HOME, ISO, profile, runtime } from './fixtures'

const profiles = [profile('Default', 'Work', 'user@example.com'), profile('Profile 2', 'Alex', 'a@example.com'), profile('Profile 6', 'Alex', 's@example.com')]
const main = account('main', null, { chromeProfileDir: 'Default', chromeProfileConfirmedAt: ISO })
const acct2 = account('acct2', `${HOME}/.claude-account2`, { chromeProfileDir: 'Profile 2', chromeProfileConfirmedAt: ISO })
const acct3 = account('acct3', `${HOME}/.claude-account3`, { chromeProfileDir: 'Profile 6', chromeProfileConfirmedAt: ISO })

function state(patch: Partial<RoutingState> = {}): RoutingState {
  return {
    runtimes: [
      runtime('rt_main', 'p1', 'claude', { accountId: 'main', observedConfigDir: { state: 'default', value: null } }),
      runtime('rt_a2', 'p2', 'claude-account2', { accountId: 'acct2', observedConfigDir: { state: 'env', value: `${HOME}/.claude-account2` }, environmentId: 'env_01AAAAAAAAAAAAAAAAAAAAAA' }),
      runtime('rt_a3', 'p2', 'claude-account3', { accountId: 'acct3', observedConfigDir: { state: 'env', value: `${HOME}/.claude-account3` } }),
    ],
    conversations: [
      conversation('c_main', 'rt_main', 'p1', 'session_01MAINMAINMAINMAINMAINMA', { live: true }),
      conversation('c_a2', 'rt_a2', 'p2', 'session_01Xy3ExampleSess10nIdAbc', { live: true }),
    ],
    accounts: [main, acct2, acct3],
    chromeProfiles: profiles,
    chromeProfilesKnown: true,
    home: HOME,
    ...patch,
  }
}

describe('planOpen — profile routing', () => {
  it("opens Account 2's exact conversation in Account 2's Chrome profile", () => {
    const plan = planOpen(state(), { runtimeId: 'rt_a2' })
    expect(plan.issues.filter((i) => i.severity !== 'info')).toEqual([])
    expect(plan.profileDir).toBe('Profile 2')
    expect(plan.accountId).toBe('acct2')
    expect(plan.url).toBe('https://claude.ai/code/session_01Xy3ExampleSess10nIdAbc')
    expect(plan.urlKind).toBe('conversation')
  })

  it('routes two accounts working in the same folder to their own profiles', () => {
    const s = state({ conversations: [...state().conversations, conversation('c_a3', 'rt_a3', 'p2', 'session_01ACCOUNT3ACCOUNT3ACCOUN', { live: true })] })
    expect(planOpen(s, { runtimeId: 'rt_a2' }).profileDir).toBe('Profile 2')
    expect(planOpen(s, { runtimeId: 'rt_a3' }).profileDir).toBe('Profile 6')
    expect(planOpen(s, { conversationId: 'c_a3' }).profileDir).toBe('Profile 6')
  })

  it("opening Account 1's conversation never touches Account 2's profile", () => {
    const plan = planOpen(state(), { conversationId: 'c_main' })
    expect(plan.profileDir).toBe('Default')
    expect(plan.url).toBe('https://claude.ai/code/session_01MAINMAINMAINMAINMAINMA')
  })

  it('uses the conversation’s own runtime even when another runtime id is passed', () => {
    const plan = planOpen(state(), { conversationId: 'c_a2', runtimeId: 'rt_main' })
    expect(plan.accountId).toBe('acct2')
    expect(plan.profileDir).toBe('Profile 2')
  })

  it('blocks when the session’s account is unconfirmed', () => {
    const s = state({ runtimes: [runtime('rt_x', 'p1', 'claude-account2')] })
    const plan = planOpen(s, { runtimeId: 'rt_x' })
    expect(blockingIssues(plan).map((i) => i.code)).toEqual(['no_account'])
    expect(plan.url).toBeNull()
  })

  it('blocks when the account has no Chrome profile', () => {
    const s = state({ accounts: [main, { ...acct2, chromeProfileDir: null }, acct3] })
    expect(blockingIssues(planOpen(s, { runtimeId: 'rt_a2' })).map((i) => i.code)).toEqual(['no_profile'])
  })

  it('blocks when the assigned Chrome profile no longer exists', () => {
    const s = state({ chromeProfiles: profiles.filter((p) => p.directory !== 'Profile 2') })
    expect(blockingIssues(planOpen(s, { runtimeId: 'rt_a2' })).map((i) => i.code)).toEqual(['profile_missing'])
  })

  it('asks for confirmation when the profile mapping is not verified', () => {
    const s = state({ accounts: [main, { ...acct2, chromeProfileConfirmedAt: null }, acct3] })
    const plan = planOpen(s, { runtimeId: 'rt_a2' })
    expect(needsConfirmation(plan)).toBe(true)
    expect(plan.issues.map((i) => i.code)).toContain('profile_unverified')
  })

  it('warns when two accounts share one Chrome profile', () => {
    const s = state({ accounts: [main, acct2, { ...acct3, chromeProfileDir: 'Profile 2' }] })
    const plan = planOpen(s, { runtimeId: 'rt_a2' })
    expect(plan.issues.find((i) => i.code === 'profile_shared')?.severity).toBe('confirm')
  })

  it('flags an account/process mismatch instead of silently opening the wrong login', () => {
    const s = state({
      runtimes: [runtime('rt_bad', 'p2', 'claude-account2', { accountId: 'acct3', observedConfigDir: { state: 'env', value: `${HOME}/.claude-account2` } })],
    })
    const plan = planOpen(s, { runtimeId: 'rt_bad' })
    const issue = plan.issues.find((i) => i.code === 'account_mismatch')
    expect(issue?.severity).toBe('confirm')
    expect(issue?.message).toMatch(/wrong account/)
  })

  it('treats explicit CLAUDE_CONFIG_DIR=~/.claude as different from the default account', () => {
    const s = state({ runtimes: [runtime('rt_m', 'p1', 'claude', { accountId: 'main', observedConfigDir: { state: 'env', value: `${HOME}/.claude` } })] })
    expect(planOpen(s, { runtimeId: 'rt_m' }).issues.map((i) => i.code)).toContain('account_mismatch')
  })

  it('falls back to the environment page, then to claude.ai/code, with clear labels', () => {
    const s = state({ conversations: [] })
    const env = planOpen(s, { runtimeId: 'rt_a2' })
    expect(env.urlKind).toBe('environment')
    expect(env.url).toBe('https://claude.ai/code?environment=env_01AAAAAAAAAAAAAAAAAAAAAA')
    expect(env.issues.find((i) => i.code === 'env_fallback')?.severity).toBe('info')

    const home = planOpen(s, { runtimeId: 'rt_a3' })
    expect(home.urlKind).toBe('home')
    expect(home.url).toBe('https://claude.ai/code')
    expect(home.issues.find((i) => i.code === 'no_url')?.severity).toBe('confirm')
  })

  it('keeps old links but marks them as possibly expired', () => {
    const s = state({ conversations: [conversation('c_old', 'rt_a2', 'p2', 'session_01OLDOLDOLDOLDOLDOLDOLDO', { live: false })] })
    const plan = planOpen(s, { runtimeId: 'rt_a2' })
    expect(plan.url).toBe('https://claude.ai/code/session_01OLDOLDOLDOLDOLDOLDOLDO')
    expect(plan.issues.find((i) => i.code === 'conversation_not_live')?.severity).toBe('info')
    expect(needsConfirmation(plan)).toBe(false)
  })

  it('requires a runtime for orphaned conversations', () => {
    const s = state({ conversations: [conversation('c_orphan', null, 'p2', 'session_01ORPHANORPHANORPHANORPH')] })
    expect(blockingIssues(planOpen(s, { conversationId: 'c_orphan' })).map((i) => i.code)).toEqual(['no_runtime'])
  })

  it('environment target never falls back silently', () => {
    const plan = planOpen(state(), { runtimeId: 'rt_a3', target: 'environment' })
    expect(blockingIssues(plan).map((i) => i.code)).toEqual(['no_url'])
  })
})

describe('defaultConversation', () => {
  const convs = [
    conversation('a', 'rt', 'p', 'session_01AAAAAAAAAAAAAAAAAAAAAA', { lastSeenAt: '2026-10-22T10:00:00Z', live: true }),
    conversation('b', 'rt', 'p', 'session_01BBBBBBBBBBBBBBBBBBBBBB', { lastOpenedAt: '2026-10-21T10:00:00Z' }),
    conversation('c', 'rt', 'p', 'session_01CCCCCCCCCCCCCCCCCCCCCC', { pinned: true }),
  ]
  it('prefers the pinned conversation', () => expect(defaultConversation('rt', convs)?.id).toBe('c'))
  it('then the most recently opened', () => expect(defaultConversation('rt', convs.slice(0, 2))?.id).toBe('b'))
  it('then a live one', () => expect(defaultConversation('rt', convs.slice(0, 1))?.id).toBe('a'))
  it('ignores archived links and other runtimes', () => {
    expect(defaultConversation('rt', [{ ...convs[2], archived: true }])).toBeNull()
    expect(defaultConversation('other', convs)).toBeNull()
  })
})
