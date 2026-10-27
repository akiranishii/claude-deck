// SSH multiplexer lifecycle, driven by a fake `ssh` binary: quitting must never leave a background
// ssh process behind, and a dead control socket must not turn into an unshared, never-ending connection.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SshClient, SshError } from '../../src/main/ssh/sshClient'

const FAKE_SSH = `#!/bin/bash
LOG="$(dirname "$0")/calls.log"
case " $* " in
  *" -O check "*)
    echo check >> "$LOG"
    echo "Control socket connect($FAKE_SOCKET): \${FAKE_CHECK_ERROR:-No such file or directory}" >&2
    exit 255 ;;
  *" -O stop "*)
    echo stop >> "$LOG"
    exit 255 ;;
  *"ControlMaster=yes"*)
    echo "start $$" >> "$LOG"
    [ -n "$FAKE_MUX_DISABLED" ] && echo "ControlSocket $FAKE_SOCKET already exists, disabling multiplexing" >&2
    exec sleep 30 ;;
esac
exit 0
`

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** A unix socket file nobody listens on, like the one a killed master leaves behind. */
function staleSocket(file: string): void {
  execFileSync('python3', ['-c', 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])', file])
}

describe('SshClient multiplexer', () => {
  let dir = ''
  let fake = ''
  const calls = () => (fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n') : [])
  const startedPid = () => Number(calls().find((l) => l.startsWith('start '))?.split(' ')[1])
  const client = (env: Record<string, string> = {}) =>
    new SshClient({ alias: 'vm', controlDir: dir, sshPath: fake, env: async () => ({ ...process.env, FAKE_SOCKET: path.join(dir, 'cm-test'), ...env }) })

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdeck-ssh-'))
    fake = path.join(dir, 'ssh')
    fs.writeFileSync(fake, FAKE_SSH, { mode: 0o755 })
  })
  afterEach(() => {
    const pid = startedPid()
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('quitting while the tunnel is still connecting aborts it instead of leaving it behind', async () => {
    const ssh = client()
    const pending = ssh.ensureMaster().catch((e: unknown) => e)
    await until(() => Boolean(startedPid()))
    const pid = startedPid()
    expect(alive(pid)).toBe(true)

    const t0 = Date.now()
    await ssh.close()
    expect(Date.now() - t0).toBeLessThan(3000)
    await until(() => !alive(pid))
    expect(await pending).toMatchObject({ kind: 'cancelled' })
    expect(calls()).toContain('stop')
    // Nothing new is started after quitting.
    await expect(ssh.exec('true')).rejects.toMatchObject({ kind: 'cancelled' })
    expect(calls().filter((l) => l.startsWith('start')).length).toBe(1)
  })

  it('removes a dead control socket in its own directory before connecting', async () => {
    const sock = path.join(dir, 'cm-test')
    staleSocket(sock)
    expect(fs.lstatSync(sock).isSocket()).toBe(true)
    const ssh = client({ FAKE_CHECK_ERROR: 'Connection refused' })
    expect(await ssh.checkMaster()).toBe(false)
    expect(fs.existsSync(sock)).toBe(false)
  })

  it('never removes anything outside its control directory', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cdeck-other-'))
    const sock = path.join(other, 'cm-test')
    staleSocket(sock)
    try {
      const ssh = client({ FAKE_SOCKET: sock, FAKE_CHECK_ERROR: 'Connection refused' })
      expect(await ssh.checkMaster()).toBe(false)
      expect(fs.existsSync(sock)).toBe(true)
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  it('stops an ssh that could not claim the socket instead of letting it run unshared', async () => {
    const ssh = client({ FAKE_MUX_DISABLED: '1' })
    const t0 = Date.now()
    const err = await ssh.ensureMaster().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SshError)
    expect(err).toMatchObject({ kind: 'socket_busy' })
    expect(Date.now() - t0).toBeLessThan(5000)
    await until(() => !alive(startedPid()))
  })
})
