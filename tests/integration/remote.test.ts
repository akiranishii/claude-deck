// Real-VM integration tests (opt-in). They use the same SSH + helper code as the app.
// Everything that starts or stops processes runs on a private tmux server (`tmux -L <name>`)
// with a fake `claude`, so your real tmux sessions and Claude accounts are never touched.
//
//   CDECK_REMOTE_TESTS=1 CDECK_TEST_HOST=my-vm npm run test:remote

import fs from 'node:fs'
import os from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HelperClient } from '../../src/main/ssh/helper'
import type { RawLaunch, RawProbe, RawSnapshot, RawStop, RawEnd } from '../../src/main/ssh/helperTypes'
import { shellEnv } from '../../src/main/ssh/shellEnv'
import { SshClient } from '../../src/main/ssh/sshClient'

const enabled = process.env.CDECK_REMOTE_TESTS === '1' && Boolean(process.env.CDECK_TEST_HOST)
const HOST = process.env.CDECK_TEST_HOST ?? ''
const controlDir = `/tmp/cdeck-${os.userInfo().uid}`

const FAKE_SERVER = `import os, sys, time, signal
print("Remote Control (fake, Claude Deck integration test)")
print("\\u00b7\\u2714\\ufe0e\\u00b7 Connected \\u00b7 fake \\u00b7 main")
print("    Capacity: 0/32 \\u00b7 New sessions will be created in the current directory")
print("Continue coding in the Claude mobile app or https://claude.ai/code?environment=env_01IntegrationTestEnvId01")
print("CFG=" + os.environ.get("CLAUDE_CONFIG_DIR", "<unset>"))
sys.stdout.flush()
signal.signal(signal.SIGINT, lambda *a: sys.exit(0))
while True:
    time.sleep(1)
`

describe.skipIf(!enabled)(`remote helper on ${HOST}`, () => {
  let ssh: SshClient
  let helper: HelperClient
  let isolated: HelperClient
  let dir = ''
  const socket = `cdeck-it-${process.pid}`
  const rid = `rt_it_${process.pid}`
  const name = `cd-it-${process.pid}`

  beforeAll(async () => {
    fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 })
    ssh = new SshClient({ alias: HOST, controlDir, env: shellEnv })
    helper = new HelperClient(ssh)
    isolated = new HelperClient(ssh, () => 'python3', socket)
    // Fake claude: a python3 symlink named `claude`; `claude remote-control` runs ./remote-control.
    const res = await ssh.exec('D=$(mktemp -d /tmp/cdeck-it-XXXXXX) && ln -s "$(command -v python3)" "$D/claude" && mkdir "$D/cfg" && cat > "$D/remote-control" && echo "$D"', {
      stdin: FAKE_SERVER,
      timeoutMs: 60_000,
    })
    dir = res.stdout.trim().split('\n').pop()!
    expect(dir).toMatch(/^\/tmp\/cdeck-it-/)
  })

  afterAll(async () => {
    if (!ssh) return
    if (dir) await ssh.exec(`tmux -L ${socket} kill-server 2>/dev/null; rm -rf ${dir}`, { timeoutMs: 30_000 }).catch(() => undefined)
    await ssh.stopMaster()
  })

  it('probes tools and Claude Code capabilities', async () => {
    const probe = await helper.call<RawProbe>('probe', {}, 120_000)
    expect(probe.tmux.version).toMatch(/tmux/)
    expect(probe.python).toMatch(/^3\./)
    expect(probe.claude_recommended).toBeTruthy()
    expect(probe.capabilities?.rc_supported).toBe(true)
  })

  it('snapshot of the real tmux server is read-only', async () => {
    const before = await helper.call<RawSnapshot>('snapshot', { capture: true })
    const after = await helper.call<RawSnapshot>('snapshot', { capture: true })
    expect(after.sessions.map((s) => s.session_id).sort()).toEqual(before.sessions.map((s) => s.session_id).sort())
    expect(after.servers.map((s) => s.pid).sort()).toEqual(before.servers.map((s) => s.pid).sort())
  })

  it('create → connect → stop → restart → end on an isolated tmux server', async () => {
    const args = {
      mode: 'new',
      session_name: name,
      runtime_id: rid,
      cwd: dir,
      claude_path: `${dir}/claude`,
      config_dir: `${dir}/cfg`,
      options: { name: `it $(id); 'x'`, spawn: 'same-dir', permission_mode: 'default' },
      shell_mode: 'interactive-login',
    }
    const launched = await isolated.call<RawLaunch>('launch_runtime', args)
    expect(launched.pane_id).toMatch(/^%\d+$/)
    await expect(isolated.call('launch_runtime', args)).rejects.toMatchObject({ code: 'name_taken' })

    let snap: RawSnapshot | null = null
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500))
      snap = await isolated.call<RawSnapshot>('snapshot', { capture: true, history_panes: [launched.pane_id] })
      if (snap.servers.some((s) => s.runtime_marker === rid)) break
    }
    const server = snap!.servers.find((s) => s.runtime_marker === rid)!
    expect(server.config_dir).toEqual({ state: 'env', value: `${dir}/cfg` })
    expect(server.flags.name).toBe(`it $(id); 'x'`)
    const pane = snap!.panes.find((p) => p.pane_id === launched.pane_id)!
    expect(pane.capture?.state_word).toBe('Connected')
    expect(pane.capture?.env_ids).toContain('env_01IntegrationTestEnvId01')
    expect(snap!.sessions.find((s) => s.name === name)?.runtime_marker).toBe(rid)

    const stopped = await isolated.call<RawStop>('stop_runtime', { pane_id: launched.pane_id, wait_seconds: 10 })
    expect(stopped.state).toBe('stopped')

    const restarted = await isolated.call<RawLaunch>('launch_runtime', { ...args, mode: 'restart', config_dir: null })
    expect(restarted.respawned).toBe(true)
    await new Promise((r) => setTimeout(r, 1500))
    snap = await isolated.call<RawSnapshot>('snapshot', { capture: true })
    expect(snap.servers.find((s) => s.runtime_marker === rid)?.config_dir).toEqual({ state: 'default', value: null })

    await expect(isolated.call('end_session', { session_name: name, runtime_id: 'rt_someone_else' })).rejects.toMatchObject({ code: 'not_managed' })
    const busy = await isolated.call<RawEnd>('end_session', { session_name: name, runtime_id: rid })
    expect(busy.state).toBe('busy')
    expect((await isolated.call<RawStop>('stop_runtime', { pane_id: launched.pane_id, wait_seconds: 10 })).state).toBe('stopped')
    expect((await isolated.call<RawEnd>('end_session', { session_name: name, runtime_id: rid })).state).toBe('ended')
  })

  it('handles # in folder names and ; at the end of arguments (tmux parsing quirks)', async () => {
    await ssh.exec(`mkdir -p "${dir}/C#Tools"`, { timeoutMs: 30_000 })
    await ssh.exec(`ln -sf "$(command -v python3)" "${dir}/C#Tools/claude" && cp "${dir}/remote-control" "${dir}/C#Tools/"`, { timeoutMs: 30_000 })
    const launched = await isolated.call<RawLaunch>('launch_runtime', {
      mode: 'new', session_name: `${name}-hash`, runtime_id: `${rid}h`, cwd: `${dir}/C#Tools`, claude_path: `${dir}/C#Tools/claude`,
      config_dir: null, options: { name: 'proj;' }, shell_mode: 'direct',
    })
    let server
    for (let i = 0; i < 20 && !server; i++) {
      await new Promise((r) => setTimeout(r, 500))
      const snap = await isolated.call<RawSnapshot>('snapshot', { capture: false })
      server = snap.servers.find((s) => s.runtime_marker === `${rid}h`)
    }
    expect(server?.cwd).toBe(`${dir}/C#Tools`)
    expect(server?.flags.name).toBe('proj;')
    await expect(isolated.call('stop_runtime', { pane_id: launched.pane_id, server_pid: server!.pid + 1, wait_seconds: 5 })).rejects.toMatchObject({ code: 'server_changed' })
    expect((await isolated.call<RawStop>('stop_runtime', { pane_id: launched.pane_id, server_pid: server!.pid, server_start: server!.start, wait_seconds: 10 })).state).toBe('stopped')
    expect((await isolated.call<RawEnd>('end_session', { session_name: `${name}-hash`, runtime_id: `${rid}h` })).state).toBe('ended')
  })

  it('types into an idle imported shell only after clearing the prompt', async () => {
    // An "imported" session: a plain interactive shell the user started themselves.
    await ssh.exec(`tmux -L ${socket} new-session -d -s ${name}-shell -c "${dir}" bash`, { timeoutMs: 30_000 })
    await new Promise((r) => setTimeout(r, 1500))
    const snap0 = await isolated.call<RawSnapshot>('snapshot', { capture: false })
    const pane = snap0.panes.find((p) => p.session_name === `${name}-shell`)!
    // Leave a half-typed command at the prompt; it must be discarded, not executed.
    await ssh.exec(`tmux -L ${socket} send-keys -t ${pane.pane_id} -l 'echo SHOULD-NOT-RUN && '`, { timeoutMs: 30_000 })
    const res = await isolated.call<{ command: string }>('restart_in_shell', { pane_id: pane.pane_id, claude_path: `${dir}/claude`, config_dir: `${dir}/cfg`, options: { name: 'typed' } })
    expect(res.command.startsWith('command env CLAUDE_CONFIG_DIR=')).toBe(true)
    let server
    for (let i = 0; i < 20 && !server; i++) {
      await new Promise((r) => setTimeout(r, 500))
      const snap = await isolated.call<RawSnapshot>('snapshot', { capture: true, capture_panes: [pane.pane_id] })
      server = snap.servers.find((s) => s.pane_id === pane.pane_id)
    }
    expect(server?.config_dir).toEqual({ state: 'env', value: `${dir}/cfg` })
    const screen = await isolated.call<{ lines: string[] }>('capture', { pane_id: pane.pane_id, lines: 50 })
    expect(screen.lines.join('\n')).not.toContain('SHOULD-NOT-RUN\n')
    expect((await isolated.call<RawStop>('stop_runtime', { pane_id: pane.pane_id, wait_seconds: 10 })).state).toBe('stopped')
    await isolated.call('end_session', { session_name: `${name}-shell`, allow_unmanaged: true, force: true })
  })

  it('never creates over an existing folder', async () => {
    await expect(helper.call('mkdir', { path: dir })).rejects.toMatchObject({ code: 'exists' })
  })
})
