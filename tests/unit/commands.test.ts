// SSH / terminal / launch command construction. Strings that must survive shell parsing are
// actually run through /bin/sh here, including injection attempts.

import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { shJoin, shq } from '../../src/main/terminal/quote'
import { buildLauncherScript, containerShellArgs, tmuxAttachArgs } from '../../src/main/terminal/terminal'
import { buildRcArgs, displayLaunchCommand, envPrefix, rcOptionsFor } from '../../src/main/services/launchSpec'
import { SshClient, classifySshFailure, cleanStderr, validateAlias } from '../../src/main/ssh/sshClient'
import { helperProgram, parseHelperOutput, RemoteOpError, RESULT_MARKER } from '../../src/main/ssh/helper'
import type { ClaudeCapabilities } from '../../src/shared/types'
import { runtime } from './fixtures'

const EVIL = [`'; rm -rf ~; echo '`, '$(touch /tmp/pwned)', '`id`', 'a b\tc', '"double"', "it's", '=claude', '~/x', '-rf', 'a\\b', '*', 'line1\nline2']

/** Parse `cmd` with /bin/sh and return the argv a program would receive. */
function shArgs(cmdline: string): string[] {
  const out = execFileSync('/bin/sh', ['-c', `f() { for a in "$@"; do printf '%s\\0' "$a"; done; }; f ${cmdline}`], { encoding: 'utf8' })
  return out.split('\0').slice(0, -1)
}

describe('shell quoting', () => {
  it.each(EVIL)('round-trips %j through /bin/sh unchanged', (s) => {
    expect(shArgs(shq(s))).toEqual([s])
  })
  it('joins argv safely', () => {
    expect(shArgs(shJoin(EVIL))).toEqual(EVIL)
  })
  it('rejects NUL bytes', () => {
    expect(() => shq('a\0b')).toThrow()
  })
})

describe('terminal launcher', () => {
  it('produces a script whose ssh argv and remote command both parse exactly', () => {
    const evilSession = `x'; touch /tmp/pwned; '`
    const script = buildLauncherScript({
      title: 'evil',
      alias: 'my-vm',
      controlPath: '/tmp/cdeck-501/cm-%C',
      remoteArgs: tmuxAttachArgs(evilSession),
      pathEnv: '/opt/homebrew/bin:/usr/bin:/bin',
    })
    const execLine = script.split('\n').find((l) => l.startsWith('exec '))!
    const local = shArgs(execLine.replace(/^exec /, ''))
    expect(local.slice(0, 2)).toEqual(['/usr/bin/ssh', '-t'])
    expect(local).toContain('ControlPath=/tmp/cdeck-501/cm-%C')
    expect(local.at(-2)).toBe('my-vm')
    // The remote shell receives a single string; parsing it must give tmux's exact argv.
    expect(shArgs(local.at(-1)!)).toEqual(['tmux', 'attach-session', '-t', `=${evilSession}`])
  })

  it('selects a window only for safe window ids', () => {
    expect(tmuxAttachArgs('s', '@3')).toEqual(['tmux', 'attach-session', '-t', '=s', ';', 'select-window', '-t', '@3'])
    expect(tmuxAttachArgs('s', '@3; rm')).toEqual(['tmux', 'attach-session', '-t', '=s'])
  })

  it('opens dev-container shells as the configured non-root user', () => {
    expect(containerShellArgs('agitated_keldysh', { user: 'vscode', workdir: '/workspaces/my-project', shell: 'bash' })).toEqual([
      'docker', 'exec', '-it', '-u', 'vscode', '-w', '/workspaces/my-project', 'agitated_keldysh', 'bash',
    ])
  })
})

const CAPS: ClaudeCapabilities = {
  claudePath: '/home/dev/.npm-global/bin/claude',
  version: '2.1.308',
  rcSupported: true,
  flags: [],
  spawnModes: ['same-dir', 'worktree', 'session'],
  permissionModes: ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'],
  supportsName: true,
  supportsSpawn: true,
  supportsPermissionMode: true,
  supportsContinue: true,
  supportsSessionId: true,
  supportsCapacity: true,
  supportsCreateSessionInDir: true,
  supportsChrome: true,
  authStatusSupported: true,
  authLoginSupported: true,
  detectedAt: '2026-10-22T00:00:00Z',
}

describe('account isolation in launch commands', () => {
  it('default account unsets CLAUDE_CONFIG_DIR for the process', () => {
    expect(envPrefix(null)).toEqual(['env', '-u', 'CLAUDE_CONFIG_DIR'])
  })
  it('other accounts set CLAUDE_CONFIG_DIR only via env(1) for that process', () => {
    expect(envPrefix('/home/dev/.claude-account3')).toEqual(['env', 'CLAUDE_CONFIG_DIR=/home/dev/.claude-account3'])
    const cmd = displayLaunchCommand('/home/dev/.claude-account3', '/home/dev/.npm-global/bin/claude', { spawn: 'same-dir', permission_mode: 'bypassPermissions' })
    expect(cmd).toBe('env CLAUDE_CONFIG_DIR=/home/dev/.claude-account3 /home/dev/.npm-global/bin/claude remote-control --spawn same-dir --permission-mode bypassPermissions')
    expect(cmd).not.toMatch(/export|\.bashrc|;|&&/)
  })
  it('the displayed command parses to the exact argv', () => {
    const cmd = displayLaunchCommand('/home/dev/.claude-account2', '/usr/bin/claude', { name: `MYPROJ · "x" $(id)` })
    expect(shArgs(cmd)).toEqual(['env', 'CLAUDE_CONFIG_DIR=/home/dev/.claude-account2', '/usr/bin/claude', 'remote-control', '--name', 'MYPROJ · "x" $(id)'])
  })
})

describe('Remote Control options vs. CLI capabilities', () => {
  const rt = runtime('rt', 'p', 'cd-x', { remoteControlName: 'MYPROJ · Account 3', spawnMode: 'worktree', permissionMode: 'bypassPermissions', capacity: 8 })
  it('builds flags supported by the installed CLI', () => {
    const r = rcOptionsFor(rt, CAPS, false)
    expect(r.errors).toEqual([])
    expect(buildRcArgs(r.options)).toEqual(['--name', 'MYPROJ · Account 3', '--spawn', 'worktree', '--permission-mode', 'bypassPermissions', '--capacity', '8'])
  })
  it('reattaches with --continue only without --spawn/--capacity (Claude rejects the combination)', () => {
    const simple = runtime('rt', 'p', 'cd-x', { remoteControlName: 'n', spawnMode: 'same-dir', permissionMode: 'default' })
    expect(buildRcArgs(rcOptionsFor(simple, CAPS, true).options)).toEqual(['--name', 'n', '--permission-mode', 'default', '--continue'])
    const r = rcOptionsFor(rt, CAPS, true)
    expect(r.options.continue).toBeUndefined()
    expect(r.warnings.join(' ')).toMatch(/cannot reattach/)
  })
  it('refuses unsupported spawn / permission modes instead of silently dropping them', () => {
    const old = { ...CAPS, version: '2.0.1', spawnModes: ['same-dir'], permissionModes: ['default', 'plan'] }
    const r = rcOptionsFor(rt, old, false)
    expect(r.errors.join(' ')).toMatch(/--spawn=worktree/)
    expect(r.errors.join(' ')).toMatch(/bypassPermissions/)
  })
  it('degrades optional flags to warnings', () => {
    const r = rcOptionsFor(rt, { ...CAPS, supportsCapacity: false }, false)
    expect(r.errors).toEqual([])
    expect(r.options.capacity).toBeUndefined()
    expect(r.warnings).toHaveLength(1)
    const r2 = rcOptionsFor(runtime('rt', 'p', 'cd-x'), { ...CAPS, supportsContinue: false }, true)
    expect(r2.options.continue).toBeUndefined()
    expect(r2.warnings).toHaveLength(1)
  })
  it('matches the Python helper’s build_rc_args exactly', () => {
    const opts = { name: 'n; $(id)', spawn: 'session' as const, permission_mode: 'plan' as const, capacity: 3, create_session_in_dir: false }
    const py = execFileSync('python3', ['-c', `import json,sys,importlib.util as u
s=u.spec_from_file_location('h','resources/remote/cdeck_helper.py'); m=u.module_from_spec(s); s.loader.exec_module(m)
print(json.dumps(m.build_rc_args(json.loads(sys.argv[1]))))`, JSON.stringify(opts)], { encoding: 'utf8' })
    expect(JSON.parse(py)).toEqual(buildRcArgs(opts))
  })
})

describe('SSH client', () => {
  it.each(['-oProxyCommand=evil', 'a b', 'x;y', '$(id)', '', 'host\nname'])('rejects alias %j', (a) => {
    expect(() => validateAlias(a)).toThrow()
  })
  it('accepts normal aliases', () => {
    expect(validateAlias('my-vm')).toBe('my-vm')
    expect(validateAlias('me@host.example.com')).toBe('me@host.example.com')
  })
  it('uses BatchMode, keep-alives and a private control socket', () => {
    const c = new SshClient({ alias: 'my-vm', controlDir: '/tmp/cdeck-501', env: async () => ({}) })
    const args = c.baseArgs()
    expect(args).toContain('BatchMode=yes')
    expect(args).toContain('ControlPath=/tmp/cdeck-501/cm-%C')
    expect(args.join(' ')).toMatch(/ServerAliveInterval=15/)
  })
  it('classifies failures and ignores gcloud noise', () => {
    const noise = 'WARNING:\n\nTo increase the performance of the tunnel, consider installing NumPy. For instructions,\nplease see https://cloud.google.com/iap/docs/using-tcp-forwarding#increasing_the_tcp_upload_bandwidth\n'
    expect(cleanStderr(noise)).toBe('')
    expect(classifySshFailure(noise + 'dev@my-vm: Permission denied (publickey).').kind).toBe('auth')
    expect(classifySshFailure("ERROR: (gcloud.compute.start-iap-tunnel) Error while connecting [4003: 'failed to connect to backend']").kind).toBe('unreachable')
    expect(classifySshFailure('ERROR: There was a problem refreshing your current auth tokens: Reauthentication failed. cannot prompt during non-interactive execution.').kind).toBe('gcloud_auth')
    expect(classifySshFailure('Host key verification failed.').kind).toBe('host_key')
    expect(classifySshFailure('/bin/sh: gcloud: command not found').kind).toBe('proxy')
  })
})

describe('helper protocol', () => {
  it('embeds requests as base64 so user text never reaches a remote shell', () => {
    const evilPath = `~/x'; rm -rf / #`
    const program = helperProgram({ op: 'mkdir', args: { path: evilPath } }, 'def entry(b):\n    pass\n')
    expect(program).not.toContain(evilPath)
    expect(program).not.toContain('rm -rf')
    const b64 = /entry\("([A-Za-z0-9+/=]+)"\)/.exec(program)![1]
    expect(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')).args.path).toBe(evilPath)
  })
  it('finds the result line among login-shell noise', () => {
    const out = `Welcome!\n${RESULT_MARKER}{"ok":true,"result":{"x":1}}\n`
    expect(parseHelperOutput<{ x: number }>(out, '', 0, 'python3')).toEqual({ x: 1 })
  })
  it('maps helper errors to RemoteOpError with their code', () => {
    const out = `${RESULT_MARKER}{"ok":false,"error":{"code":"not_managed","message":"nope"}}`
    expect(() => parseHelperOutput(out, '', 0, 'python3')).toThrow(RemoteOpError)
    try {
      parseHelperOutput(out, '', 0, 'python3')
    } catch (e) {
      expect((e as RemoteOpError).code).toBe('not_managed')
    }
  })
  it('reports a missing python clearly', () => {
    expect(() => parseHelperOutput('', 'bash: python3: command not found', 127, 'python3')).toThrow(/python3 was not found/)
  })
})
