import { describe, expect, it } from 'vitest'
import { environmentUrl, isLoginUrl, isOpenableClaudeUrl, parseClaudeUrl, sessionUrl } from '../../src/shared/urls'

describe('parseClaudeUrl', () => {
  it('accepts exact conversation URLs and canonicalises them', () => {
    expect(parseClaudeUrl('https://claude.ai/code/session_01Xy3ExampleSess10nIdAbc')).toEqual({
      kind: 'session',
      sessionId: 'session_01Xy3ExampleSess10nIdAbc',
      url: 'https://claude.ai/code/session_01Xy3ExampleSess10nIdAbc',
    })
    expect(parseClaudeUrl('  https://claude.ai/code/session_01Xy3ExampleSess10nIdAbc/?foo=1#x ')?.url).toBe('https://claude.ai/code/session_01Xy3ExampleSess10nIdAbc')
    expect(parseClaudeUrl('session_01Xy3ExampleSess10nIdAbc')?.kind).toBe('session')
  })

  it('distinguishes Remote Control environment links from conversations', () => {
    const p = parseClaudeUrl('https://claude.ai/code?environment=env_01Ex4mpleEnvironmentIdAa')
    expect(p).toEqual({ kind: 'environment', environmentId: 'env_01Ex4mpleEnvironmentIdAa', url: 'https://claude.ai/code?environment=env_01Ex4mpleEnvironmentIdAa' })
    expect(parseClaudeUrl('https://claude.ai/code')?.kind).toBe('home')
  })

  it.each([
    'http://claude.ai/code/session_01Xy3ExampleSess10nIdAbc',
    'https://claude.ai.evil.com/code/session_01Xy3ExampleSess10nIdAbc',
    'https://evil.com/claude.ai/code/session_01Xy3ExampleSess10nIdAbc',
    'https://user:pw@claude.ai/code/session_01Xy3ExampleSess10nIdAbc',
    'https://claude.ai:8443/code/session_01Xy3ExampleSess10nIdAbc',
    'https://claude.ai/chat/abc',
    'https://claude.ai/code/session_abc;rm',
    'javascript:alert(1)',
    'cse_01Xy3ExampleSess10nIdAbc',
    '',
  ])('rejects %s', (u) => {
    const p = parseClaudeUrl(u)
    expect(p === null || p.kind === 'home').toBe(true)
    if (p) expect(p.kind).not.toBe('session')
  })

  it('never builds URLs from malformed ids', () => {
    expect(() => sessionUrl('cse_01Xy3ExampleSess10nIdAbc')).toThrow()
    expect(() => sessionUrl('session_../../x')).toThrow()
    expect(() => environmentUrl('env_x&y=z')).toThrow()
  })
})

describe('open allow-lists', () => {
  it('only claude.ai pages can be opened in a profile', () => {
    expect(isOpenableClaudeUrl('https://claude.ai/code/session_01Xy3ExampleSess10nIdAbc')).toBe(true)
    expect(isOpenableClaudeUrl('https://example.com')).toBe(false)
    expect(isOpenableClaudeUrl('file:///etc/passwd')).toBe(false)
  })
  it('sign-in links are limited to Anthropic hosts and auth paths', () => {
    expect(isLoginUrl('https://claude.ai/oauth/authorize?code=true&client_id=x')).toBe(true)
    expect(isLoginUrl('https://platform.claude.com/oauth/authorize?x=1')).toBe(true)
    expect(isLoginUrl('https://claude.ai/code')).toBe(false)
    expect(isLoginUrl('https://evil.com/oauth/authorize')).toBe(false)
  })
})
