import { describe, expect, it } from 'vitest'
import { chromeOpenArgs, isValidProfileDir, parseLocalState } from '../../src/main/chrome/chrome'

const APP = '/Applications/Google Chrome.app'
const URL = 'https://claude.ai/code/session_01Xy3ExampleSess10nIdAbc'

describe('chromeOpenArgs', () => {
  it('builds an argv (no shell) that opens the URL in the requested profile of a running Chrome', () => {
    expect(chromeOpenArgs(APP, 'Profile 2', URL)).toEqual(['-n', '-a', APP, '--args', '--profile-directory=Profile 2', URL])
  })

  it.each(['../Default', '-flag', 'Profile 2; rm -rf ~', 'a/b', '', 'x'.repeat(80), 'Profile\n2'])('rejects profile directory %j', (dir) => {
    expect(() => chromeOpenArgs(APP, dir, URL)).toThrow()
  })

  it('refuses non-Claude URLs', () => {
    expect(() => chromeOpenArgs(APP, 'Default', 'https://evil.example.com')).toThrow()
    expect(() => chromeOpenArgs(APP, 'Default', 'file:///etc/passwd')).toThrow()
  })

  it('allows Anthropic sign-in pages (for the guided login)', () => {
    expect(chromeOpenArgs(APP, 'Default', 'https://claude.ai/oauth/authorize?code=true')).toHaveLength(6)
  })

  it('validates the application path', () => {
    expect(() => chromeOpenArgs('/Applications/Evil', 'Default', URL)).toThrow()
  })

  it('accepts real directory names', () => {
    for (const d of ['Default', 'Profile 1', 'Profile 12', 'Claude-Account_3']) expect(isValidProfileDir(d)).toBe(true)
  })
})

describe('parseLocalState', () => {
  const doc = {
    os_crypt: { encrypted_key: 'SECRET-KEY-MATERIAL' },
    profile: {
      last_used: 'Profile 6',
      profiles_order: ['Default', 'Profile 6', 'Profile 2'],
      info_cache: {
        Default: { name: 'Work', user_name: 'user@example.com', gaia_name: 'Alex', is_managed: 1, default_avatar_fill_color: -12345, gaia_id: 'secret-gaia-id', active_time: 1.5 },
        'Profile 2': { name: 'Alex', user_name: 'a@example.com' },
        'Profile 6': { name: 'Alex', user_name: 's@example.com' },
        'System Profile': { name: 'System' },
        '../escape': { name: 'bad' },
      },
    },
  }
  const profiles = parseLocalState(doc)

  it('extracts display metadata only, in Chrome’s order', () => {
    expect(profiles.map((p) => p.directory)).toEqual(['Default', 'Profile 6', 'Profile 2'])
    expect(profiles[0]).toEqual({
      directory: 'Default',
      name: 'Work',
      email: 'user@example.com',
      gaiaName: 'Alex',
      isManaged: true,
      avatarColor: expect.stringMatching(/^#[0-9a-f]{6}$/),
      lastActive: 1.5,
      isLastUsed: false,
    })
    expect(profiles[1].isLastUsed).toBe(true)
  })

  it('never carries over other Local State fields', () => {
    const json = JSON.stringify(profiles)
    expect(json).not.toContain('SECRET-KEY-MATERIAL')
    expect(json).not.toContain('secret-gaia-id')
  })

  it('handles empty or malformed documents', () => {
    expect(parseLocalState(null)).toEqual([])
    expect(parseLocalState({ profile: { info_cache: 'nope' } })).toEqual([])
  })
})
