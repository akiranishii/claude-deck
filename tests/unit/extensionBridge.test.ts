// The optional extension bridge must only ever accept claude.ai session URLs from a paired
// extension — never commands, never requests from web pages.

import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/db/database'
import { Store } from '../../src/main/db/store'
import { cleanTabTitle, ExtensionBridge } from '../../src/main/services/extensionBridge'
import type { Ctx } from '../../src/main/services/context'
import { account, conversation, project, runtime } from './fixtures'

const PORT = 47000 + Math.floor(Math.random() * 900)

function request(opts: { method: string; path: string; headers?: Record<string, string>; body?: unknown }): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: opts.method, path: opts.path, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${PORT}`, ...opts.headers } }, (res) => {
      let data = ''
      res.on('data', (d) => (data += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }))
    })
    req.on('error', reject)
    if (opts.body !== undefined) req.write(JSON.stringify(opts.body))
    req.end()
  })
}

describe('extension bridge', () => {
  const store = new Store(openDatabase(':memory:'))
  const events: string[] = []
  const ctx = { store, changed: () => {}, event: (e: { type: string }) => events.push(e.type) } as unknown as Ctx
  const bridge = new ExtensionBridge(ctx)
  let token = ''

  beforeAll(async () => {
    store.hosts.insert({ id: 'host_1', displayName: 'vm', sshAlias: 'vm', remoteUser: null, homePath: null, hostname: null, claudePath: null, pythonCommand: 'python3', shellMode: 'interactive-login', defaultParentDir: '~/projects', capabilities: null, probe: null, lastConnectionStatus: 'online', lastConnectionError: null, lastConnectedAt: null, createdAt: '', updatedAt: '' })
    store.accounts.insert(account('acct2', '/home/dev/.claude-account2', { chromeProfileDir: 'Profile 2' }))
    store.accounts.insert(account('acct3', '/home/dev/.claude-account3', { chromeProfileDir: 'Profile 6' }))
    store.projects.insert(project('p1', '/home/dev/proj'))
    store.runtimes.insert(runtime('rt2', 'p1', 'claude-account2', { accountId: 'acct2', observedStatus: 'connected' }))
    store.runtimes.insert(runtime('rt3a', 'p1', 'claude-account3', { accountId: 'acct3', observedStatus: 'connected' }))
    store.runtimes.insert(runtime('rt3b', 'p1', 'cd-proj-acct3-beef', { accountId: 'acct3', observedStatus: 'connected' }))
    store.conversations.insert(conversation('c_known', 'rt2', 'p1', 'session_01KNOWNKNOWNKNOWNKNOWNKN'))
    await bridge.start(PORT)
  })
  afterAll(() => bridge.stop())

  it('rejects requests whose Host is not loopback (DNS rebinding)', async () => {
    expect((await request({ method: 'GET', path: '/v1/ping', headers: { Host: 'evil.example.com' } })).status).toBe(403)
  })

  it('rejects requests from web pages', async () => {
    expect((await request({ method: 'POST', path: '/v1/pair', headers: { Origin: 'https://evil.example.com' }, body: { code: 'x' } })).status).toBe(403)
  })

  it('requires a valid one-time pairing code', async () => {
    expect((await request({ method: 'POST', path: '/v1/pair', body: { code: 'CDECK-1-0000000000' } })).status).toBe(401)
    const { code } = bridge.pairingCode('acct2')
    const res = await request({ method: 'POST', path: '/v1/pair', headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }, body: { code } })
    expect(res.status).toBe(200)
    token = res.body.token
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect((await request({ method: 'POST', path: '/v1/pair', body: { code } })).status).toBe(401) // single use
    expect(store.getMeta('extension_tokens')).not.toContain(token) // only the hash is stored
  })

  it('requires the bearer token', async () => {
    expect((await request({ method: 'POST', path: '/v1/visit', body: { url: 'https://claude.ai/code/session_01KNOWNKNOWNKNOWNKNOWNKN' } })).status).toBe(401)
    expect((await request({ method: 'GET', path: '/v1/ping', headers: { Authorization: `Bearer ${token}` } })).body).toEqual({ ok: true, account: 'acct2' })
  })

  it('only accepts claude.ai conversation URLs', async () => {
    const auth = { Authorization: `Bearer ${token}` }
    expect((await request({ method: 'POST', path: '/v1/visit', headers: auth, body: { url: 'https://evil.example.com/x' } })).status).toBe(400)
    expect((await request({ method: 'POST', path: '/v1/exec', headers: auth, body: { cmd: 'id' } })).status).toBe(404)
  })

  it('updates known conversations and sends unknown ones to the inbox', async () => {
    const auth = { Authorization: `Bearer ${token}` }
    await request({ method: 'POST', path: '/v1/visit', headers: auth, body: { url: 'https://claude.ai/code/session_01KNOWNKNOWNKNOWNKNOWNKN', title: 'Fix tests - Claude' } })
    expect(store.conversations.get('c_known')).toMatchObject({ autoTitle: 'Fix tests' })
    expect(store.conversations.get('c_known')?.lastOpenedAt).toBeTruthy()
    await request({ method: 'POST', path: '/v1/visit', headers: auth, body: { url: 'https://claude.ai/code/session_01NEWNEWNEWNEWNEWNEWNEWN' } })
    // Could be a cloud/web conversation, so it is never attached to the VM session automatically.
    expect(store.conversationBySessionId('session_01NEWNEWNEWNEWNEWNEWNEWN')).toBeNull()
    expect(bridge.inbox().map((i) => i.remoteSessionId)).toContain('session_01NEWNEWNEWNEWNEWNEWNEWN')
  })

  it('asks the user when the mapping is ambiguous', () => {
    bridge.recordVisit({ accountId: 'acct3', profileDir: 'Profile 6' }, 'session_01AMBIGUOUSAMBIGUOUSAMBIG', 'Q')
    expect(store.conversationBySessionId('session_01AMBIGUOUSAMBIGUOUSAMBIG')).toBeNull()
    expect(bridge.inbox().find((i) => i.remoteSessionId === 'session_01AMBIGUOUSAMBIGUOUSAMBIG')?.accountId).toBe('acct3')
  })

  it('warns when a conversation is opened in another account’s profile', () => {
    bridge.recordVisit({ accountId: 'acct3', profileDir: 'Profile 6' }, 'session_01KNOWNKNOWNKNOWNKNOWNKN', null)
    expect(events).toContain('extension.account_mismatch')
  })

  it('cleans tab titles', () => {
    expect(cleanTabTitle('Database schema review | Claude')).toBe('Database schema review')
    expect(cleanTabTitle('Claude Code')).toBe('Claude Code')
    expect(cleanTabTitle(42)).toBeNull()
  })
})
