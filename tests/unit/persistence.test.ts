// SQLite persistence, migrations, export/import and IPC validation.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrate, openDatabase, schemaVersion } from '../../src/main/db/database'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../../src/main/db/migrations'
import { Store } from '../../src/main/db/store'
import { applyImport, buildExport } from '../../src/main/services/dataPort'
import { SCHEMAS } from '../../src/main/ipcSchemas'
import { account, conversation, project, runtime } from './fixtures'

function tmpDb(): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdeck-test-'))
  return { file: path.join(dir, 'deck.sqlite'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

function seed(store: Store) {
  store.hosts.insert({
    id: 'host_1',
    displayName: 'my-vm',
    sshAlias: 'my-vm',
    remoteUser: 'dev',
    homePath: '/home/dev',
    hostname: 'my-vm',
    claudePath: '/home/dev/.npm-global/bin/claude',
    pythonCommand: 'python3',
    shellMode: 'interactive-login',
    defaultParentDir: '~/projects',
    capabilities: null,
    probe: null,
    lastConnectionStatus: 'online',
    lastConnectionError: null,
    lastConnectedAt: null,
    createdAt: '2026-10-22T00:00:00Z',
    updatedAt: '2026-10-22T00:00:00Z',
  })
  store.accounts.insert(account('main', null, { chromeProfileDir: 'Default' }))
  store.accounts.insert(account('acct2', '/home/dev/.claude-account2', { chromeProfileDir: 'Profile 2' }))
  store.projects.insert(project('p1', '/home/dev/proj', { tags: ['data', 'myproj'], pinned: true }))
  store.runtimes.insert(runtime('rt1', 'p1', 'claude-account2', { accountId: 'acct2', environmentId: 'env_01AAAAAAAAAAAAAAAAAAAAAA', permissionMode: 'bypassPermissions', createSessionInDir: false }))
  store.conversations.insert(conversation('c1', 'rt1', 'p1', 'session_01Xy3ExampleSess10nIdAbc', { pinned: true }))
}

describe('database', () => {
  it('applies migrations once and records them', () => {
    const { file, cleanup } = tmpDb()
    const db = openDatabase(file)
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION)
    expect(migrate(db)).toEqual([])
    const rows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]
    expect(rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version))
    db.close()
    cleanup()
  })

  it('rolls back a failing migration', () => {
    const { file, cleanup } = tmpDb()
    const db = openDatabase(file)
    expect(() => migrate(db, [...MIGRATIONS, { version: 99, name: 'broken', sql: 'CREATE TABLE x (a); SELECT nope FROM missing;' }])).toThrow(/Migration 99/)
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'x'").get()).toBeUndefined()
    db.close()
    cleanup()
  })

  it('round-trips records across restarts (mappings survive)', () => {
    const { file, cleanup } = tmpDb()
    let db = openDatabase(file)
    seed(new Store(db))
    db.close()
    db = openDatabase(file)
    const store = new Store(db)
    expect(store.accounts.get('acct2')).toMatchObject({ configDir: '/home/dev/.claude-account2', chromeProfileDir: 'Profile 2', archived: false })
    expect(store.projects.get('p1')).toMatchObject({ tags: ['data', 'myproj'], pinned: true })
    expect(store.runtimes.get('rt1')).toMatchObject({ accountId: 'acct2', permissionMode: 'bypassPermissions', createSessionInDir: false, environmentId: 'env_01AAAAAAAAAAAAAAAAAAAAAA' })
    expect(store.conversationBySessionId('session_01Xy3ExampleSess10nIdAbc')?.pinned).toBe(true)
    expect((db.prepare('SELECT environment_url FROM runtimes').get() as { environment_url: string }).environment_url).toBe('https://claude.ai/code?environment=env_01AAAAAAAAAAAAAAAAAAAAAA')
    db.close()
    cleanup()
  })

  it('enforces one account per config directory (including the default)', () => {
    const db = openDatabase(':memory:')
    const store = new Store(db)
    store.accounts.insert(account('a', null))
    expect(() => store.accounts.insert(account('b', null))).toThrow()
    store.accounts.insert(account('c', '/x'))
    expect(() => store.accounts.insert(account('d', '/x'))).toThrow()
  })

  it('deleting a project removes only its metadata; removing a runtime keeps its links', () => {
    const db = openDatabase(':memory:')
    const store = new Store(db)
    seed(store)
    store.runtimes.delete('rt1')
    expect(store.conversations.get('c1')?.runtimeId).toBeNull()
    store.projects.delete('p1')
    expect(store.listConversations()).toEqual([])
    expect(store.listAccounts()).toHaveLength(2)
  })

  it('merges settings with defaults', () => {
    const store = new Store(openDatabase(':memory:'))
    store.setSettings({ refreshIntervalSec: 30, theme: 'dark' })
    const s = store.getSettings()
    expect(s.refreshIntervalSec).toBe(30)
    expect(s.theme).toBe('dark')
    expect(s.statusPatterns.connected.length).toBeGreaterThan(0)
    store.setMeta('extension_tokens', '[]')
    expect(Object.keys(store.getSettings())).not.toContain('meta:extension_tokens')
  })
})

describe('export / import', () => {
  it('exports metadata without credentials and re-imports idempotently', () => {
    const a = new Store(openDatabase(':memory:'))
    seed(a)
    const doc = buildExport(a, '0.1.0')
    const json = JSON.stringify(doc)
    expect(json).not.toMatch(/accessToken|refreshToken|credentials|sk-ant/i)
    const b = new Store(openDatabase(':memory:'))
    expect(applyImport(b, JSON.parse(json))).toEqual({ hosts: 1, accounts: 2, projects: 1, runtimes: 1, conversations: 1 })
    expect(applyImport(b, JSON.parse(json))).toEqual({ hosts: 0, accounts: 0, projects: 0, runtimes: 0, conversations: 0 })
    expect(b.runtimes.get('rt1')?.accountId).toBe('acct2')
  })

  it('rejects foreign files', () => {
    const b = new Store(openDatabase(':memory:'))
    expect(() => applyImport(b, { hello: 'world' })).toThrow()
  })
})

describe('IPC request validation', () => {
  it('accepts well-formed requests', () => {
    expect(SCHEMAS['runtime.stop'].safeParse({ id: 'rt_1', mode: 'interrupt' }).success).toBe(true)
    expect(
      SCHEMAS['session.create'].safeParse({
        opId: 'op1',
        hostId: 'host_1',
        location: { kind: 'new-folder', parent: '~/projects', name: 'new-research' },
        projectName: 'new-research',
        accountId: 'acc_1',
        spawnMode: 'same-dir',
        permissionMode: 'default',
        bypassAcknowledged: false,
        launch: true,
      }).success,
    ).toBe(true)
  })

  it('rejects unexpected values', () => {
    expect(SCHEMAS['runtime.stop'].safeParse({ id: 'rt_1', mode: 'rm -rf' }).success).toBe(false)
    expect(SCHEMAS['runtime.stop'].safeParse({ id: '../../x', mode: 'interrupt' }).success).toBe(false)
    expect(SCHEMAS['account.update'].safeParse({ id: 'a', patch: { color: 'red; x' } }).success).toBe(false)
    expect(SCHEMAS['settings.update'].safeParse({ refreshIntervalSec: 1 }).success).toBe(false)
    expect(SCHEMAS['settings.update'].safeParse({ browser: { kind: 'chrome', appPath: '/bin/sh', userDataDir: '/x' } }).success).toBe(false)
    expect(SCHEMAS['session.create'].safeParse({ location: { kind: 'shell', cmd: 'id' } }).success).toBe(false)
  })
})
