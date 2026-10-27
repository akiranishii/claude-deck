// Status classification: "Connected" needs real evidence; tmux merely existing is never enough.

import { describe, expect, it } from 'vitest'
import { classifyRuntime, detectPrompt, type StatusFacts } from '../../src/shared/status'
import { DEFAULT_STATUS_PATTERNS } from '../../src/shared/constants'
import { CONNECTED_SCREEN, NOW } from './fixtures'

const P = DEFAULT_STATUS_PATTERNS

function facts(patch: Partial<StatusFacts>): StatusFacts {
  return {
    now: NOW,
    sessionExists: true,
    pane: { dead: false, deadStatus: null, foregroundKind: 'claude', claudeKind: 'rc-server' },
    server: { pid: 10, httpsConnections: 0 },
    screen: { statusLine: null, stateWord: null, lastLog: null, tail: [] },
    launchedAt: null,
    graceSec: 60,
    stopping: false,
    ...patch,
  }
}

describe('classifyRuntime', () => {
  it('is connected when Claude’s status line says Connected', () => {
    const r = classifyRuntime(facts({ screen: { statusLine: '·✔︎· Connected · myproj · main', stateWord: 'Connected', lastLog: null, tail: CONNECTED_SCREEN } }), P)
    expect(r.status).toBe('connected')
  })

  it('is connected when the server holds a live TLS connection (status line scrolled away)', () => {
    const r = classifyRuntime(facts({ server: { pid: 10, httpsConnections: 1 }, screen: { statusLine: null, stateWord: null, lastLog: 'Reconnected after 2s', tail: ['[08:22:33] Reconnected after 2s'] } }), P)
    expect(r.status).toBe('connected')
    expect(r.evidence.join(' ')).toMatch(/HTTPS/)
  })

  it('is NOT connected just because tmux and the process exist', () => {
    const r = classifyRuntime(facts({ server: { pid: 10, httpsConnections: 0 } }), P)
    expect(r.status).toBe('running')
  })

  it('reports reconnecting from the status line', () => {
    const r = classifyRuntime(facts({ server: { pid: 10, httpsConnections: 1 }, screen: { statusLine: '·⚠· Reconnecting… · myproj', stateWord: 'Reconnecting…', lastLog: null, tail: [] } }), P)
    expect(r.status).toBe('reconnecting')
  })

  it('reports reconnecting from a disconnect log without a live socket', () => {
    const r = classifyRuntime(facts({ screen: { statusLine: null, stateWord: null, lastLog: 'Disconnected; retrying', tail: [] } }), P)
    expect(r.status).toBe('reconnecting')
  })

  it('detects an unanswered trust prompt, but not an answered one', () => {
    const asking = classifyRuntime(facts({ screen: { statusLine: null, stateWord: null, lastLog: null, tail: ['Security guide: https://code.claude.com/docs/en/security', 'Trust /home/dev/projects/new-research? [y/N]'] } }), P)
    expect(asking.status).toBe('needs_input')
    expect(asking.promptText).toMatch(/Trust/)
    const answered = classifyRuntime(facts({ server: { pid: 1, httpsConnections: 1 }, screen: { statusLine: null, stateWord: null, lastLog: null, tail: ['Trust /home/dev/proj? [y/N] y', 'Enable Remote Control? (y/n) y', '[11:38:28] Reconnected after 2s'] } }), P)
    expect(answered.status).toBe('connected')
  })

  it('detects Ink-style menus', () => {
    const tail = ['Do you trust the files in this folder?', '', '❯ 1. Yes, proceed', '  2. No, exit', '', 'Enter to confirm · Esc to exit']
    expect(detectPrompt(tail, P)).toBe('Do you trust the files in this folder?')
  })

  it('reports authentication problems', () => {
    const r = classifyRuntime(facts({ server: null, pane: { dead: true, deadStatus: 1, foregroundKind: 'dead' }, screen: { statusLine: null, stateWord: null, lastLog: null, tail: ['Error: Not logged in. Please run /login'] } }), P)
    expect(r.status).toBe('auth_required')
  })

  it('a pane that dies during startup is a failure; after a stop it is stopped', () => {
    const dead = { server: null, pane: { dead: true, deadStatus: 1, foregroundKind: 'dead' as const } }
    expect(classifyRuntime(facts({ ...dead, launchedAt: NOW - 5000 }), P).status).toBe('failed')
    expect(classifyRuntime(facts({ ...dead, launchedAt: null }), P).status).toBe('stopped')
    expect(classifyRuntime(facts({ ...dead, launchedAt: NOW - 5000, stopping: true }), P).status).toBe('stopped')
  })

  it('an idle shell after Ctrl+C is stopped (imported sessions)', () => {
    const r = classifyRuntime(facts({ server: null, pane: { dead: false, deadStatus: null, foregroundKind: 'shell-idle', foregroundComm: 'bash' } }), P)
    expect(r.status).toBe('stopped')
  })

  it('an interactive Claude (not Remote Control) is not counted as running Remote Control', () => {
    const r = classifyRuntime(facts({ server: null, pane: { dead: false, deadStatus: null, foregroundKind: 'claude', claudeKind: 'interactive' } }), P)
    expect(r.status).toBe('stopped')
    expect(r.detail).toMatch(/not Remote Control/)
  })

  it('missing tmux session is reported, never treated as deletion', () => {
    expect(classifyRuntime(facts({ sessionExists: false, pane: null, server: null }), P).status).toBe('missing')
  })

  it('starting within the grace period, stopping while a stop is in flight', () => {
    expect(classifyRuntime(facts({ server: null, pane: { dead: false, deadStatus: null, foregroundKind: 'other', foregroundComm: 'bash' }, launchedAt: NOW - 2000 }), P).status).toBe('starting')
    expect(classifyRuntime(facts({ launchedAt: NOW - 2000 }), P).status).toBe('starting')
    expect(classifyRuntime(facts({ stopping: true }), P).status).toBe('stopping')
  })

  it('tolerates broken user patterns', () => {
    const bad = { ...P, connected: ['(unclosed'] }
    expect(() => classifyRuntime(facts({ screen: { statusLine: 'x', stateWord: 'Connected', lastLog: null, tail: [] } }), bad)).not.toThrow()
  })
})
