import { describe, expect, it } from 'vitest'
import {
  allocateTmuxName,
  configDirLabel,
  defaultAccountName,
  isValidManagedName,
  joinRemote,
  normalizeRemotePath,
  sameConfigDir,
  slugify,
  tildify,
  validateFolderName,
  validateRemotePathInput,
} from '../../src/shared/naming'

describe('tmux session names', () => {
  it('are identifiable and valid', () => {
    const name = allocateTmuxName('MYPROJ monorepo!', 'Account 2', [], () => 'a1b2')
    expect(name).toBe('cd-myproj-monorepo-account-2-a1b2')
    expect(isValidManagedName(name)).toBe(true)
  })

  it('avoid collisions with existing sessions', () => {
    const seq = ['aaaa', 'aaaa', 'bbbb']
    const name = allocateTmuxName('myproj', 'main', ['cd-myproj-main-aaaa'], () => seq.shift()!)
    expect(name).toBe('cd-myproj-main-bbbb')
  })

  it('never contain shell or tmux target metacharacters', () => {
    const name = allocateTmuxName(`a:b.c;$(id)'`, 'x y', [])
    expect(name).toMatch(/^[a-z0-9-]+$/)
  })

  it('slugify falls back for empty input', () => {
    expect(slugify('')).toBe('x')
    expect(slugify('Ünïcödé Prøject')).toBe('unicode-pr-ject')
  })
})

describe('remote paths', () => {
  it('normalises lexically, keeping ~', () => {
    expect(normalizeRemotePath('~/projects//new/../x/')).toBe('~/projects/x')
    expect(normalizeRemotePath('/home/a/./b')).toBe('/home/a/b')
    expect(joinRemote('~/projects', 'new-research')).toBe('~/projects/new-research')
    expect(tildify('/home/dev/myproj', '/home/dev')).toBe('~/myproj')
  })

  it('validates folder names and paths', () => {
    expect(validateFolderName('new-research')).toBeNull()
    expect(validateFolderName('a/b')).not.toBeNull()
    expect(validateFolderName('..')).not.toBeNull()
    expect(validateFolderName('-rf')).not.toBeNull()
    expect(validateRemotePathInput('relative/path')).not.toBeNull()
    expect(validateRemotePathInput('~/ok')).toBeNull()
  })
})

describe('config directories', () => {
  it('default (unset) is distinct from an explicit ~/.claude', () => {
    expect(sameConfigDir(null, null)).toBe(true)
    expect(sameConfigDir(null, '/home/dev/.claude', '/home/dev')).toBe(false)
    expect(sameConfigDir('~/.claude-account2', '/home/dev/.claude-account2', '/home/dev')).toBe(true)
    expect(configDirLabel(null)).toBe('~/.claude (default)')
  })

  it('suggests display names (cosmetic only)', () => {
    expect(defaultAccountName(null)).toBe('Main')
    expect(defaultAccountName('/home/dev/.claude-account3')).toBe('Account 3')
    expect(defaultAccountName('/home/dev/.claude-acct2')).toBe('Account 2')
    expect(defaultAccountName('/home/dev/.claude-research')).toBe('Research')
  })
})
