// SSH transport built on the system OpenSSH client, so ~/.ssh/config (ProxyCommand for the
// GCP IAP tunnel, IdentityFile, agent, known_hosts…) is honoured exactly like `ssh my-vm`.
// A private ControlMaster keeps one authenticated tunnel open: each call then costs one round
// trip instead of a full IAP handshake. All arguments are passed as an argv array (no shell).

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { log } from '../log'

export type SshErrorKind =
  | 'unreachable'
  | 'auth'
  | 'host_key'
  | 'proxy'
  | 'gcloud_auth'
  | 'config'
  | 'timeout'
  | 'python_missing'
  | 'protocol'
  /** Another ssh process holds our control socket (this attempt was stopped; the tunnel may be fine). */
  | 'socket_busy'
  /** Claude Deck is quitting; not a connection problem. */
  | 'cancelled'

export class SshError extends Error {
  constructor(
    public kind: SshErrorKind,
    message: string,
    public stderr = '',
  ) {
    super(message)
    this.name = 'SshError'
  }
}

const ALIAS_RE = /^[A-Za-z0-9_.@:-]{1,253}$/

export function validateAlias(alias: string): string {
  if (!ALIAS_RE.test(alias) || alias.startsWith('-')) throw new Error(`Invalid SSH host alias: ${alias}`)
  return alias
}

const NOISE = [
  /To increase the performance of the tunnel, consider installing NumPy/i,
  /please see https:\/\/cloud\.google\.com\/iap\/docs\/using-tcp-forwarding/i,
  /^\s*WARNING:\s*$/,
  /^\s*$/,
]

/** Drop known-harmless warnings (e.g. gcloud's NumPy hint) from ssh stderr. */
export function cleanStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !NOISE.some((rx) => rx.test(line)))
    .join('\n')
    .trim()
}

export function classifySshFailure(stderr: string, alias = 'the VM'): { kind: SshErrorKind; message: string } {
  const s = cleanStderr(stderr)
  const t = s.toLowerCase()
  const tail = s.split('\n').slice(-2).join(' ').slice(0, 300)
  if (/permission denied/.test(t)) {
    return { kind: 'auth', message: `SSH authentication to ${alias} failed (permission denied). Check that \`ssh ${alias}\` works in Terminal and your key is loaded.` }
  }
  if (/host key verification failed|remote host identification has changed/.test(t)) {
    return { kind: 'host_key', message: `SSH host key verification failed for ${alias}. Run \`ssh ${alias}\` once in Terminal to review the host key.` }
  }
  if (/could not resolve hostname|name or service not known|nodename nor servname/.test(t) && !/gcloud/.test(t)) {
    return { kind: 'config', message: `The SSH alias ${alias} could not be resolved. Check ~/.ssh/config.` }
  }
  if (/reauthentication|refreshing your current auth tokens|gcloud auth login|invalid_grant|cannot prompt during non-interactive/.test(t)) {
    return { kind: 'gcloud_auth', message: 'gcloud needs you to sign in again. Run `gcloud auth login` in Terminal, then retry.' }
  }
  if (/(gcloud|proxycommand).*(not found|no such file)|(not found|no such file).*gcloud/.test(t)) {
    return { kind: 'proxy', message: 'The SSH ProxyCommand failed — gcloud was not found on PATH.' }
  }
  if (/4003|failed to connect to backend/.test(t)) {
    return { kind: 'unreachable', message: `${alias} is unreachable through IAP (the VM may be stopped). ${tail}` }
  }
  return { kind: 'unreachable', message: tail ? `Could not reach ${alias}: ${tail}` : `Could not reach ${alias}` }
}

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
  ms: number
}

export interface SshClientOptions {
  alias: string
  controlDir: string
  env: () => Promise<NodeJS.ProcessEnv>
  sshPath?: string
  connectTimeoutSec?: number
  persistSec?: number
}

export class SshClient {
  readonly controlPath: string
  private masterPromise: Promise<void> | null = null
  private masterChild: ChildProcess | null = null
  private masterCheckedAt = 0
  private masterAlive = false
  private closed = false

  constructor(private readonly opts: SshClientOptions) {
    validateAlias(opts.alias)
    this.controlPath = path.join(opts.controlDir, 'cm-%C')
  }

  get alias(): string {
    return this.opts.alias
  }

  private get sshPath(): string {
    return this.opts.sshPath ?? '/usr/bin/ssh'
  }

  baseArgs(): string[] {
    return [
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${this.opts.connectTimeoutSec ?? 25}`,
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', `ControlPath=${this.controlPath}`,
    ]
  }

  async checkMaster(): Promise<boolean> {
    try {
      const r = await this.run([...this.baseArgs(), '-O', 'check', '--', this.alias], { timeoutMs: 5000 })
      this.masterAlive = r.code === 0
      if (!this.masterAlive) this.removeStaleSocket(r.stderr)
    } catch {
      this.masterAlive = false
    }
    this.masterCheckedAt = Date.now()
    return this.masterAlive
  }

  /**
   * A master that died without cleaning up leaves its socket behind; a new master could then not
   * claim it. Only a socket inside our private control directory is ever removed.
   */
  private removeStaleSocket(stderr: string): void {
    const m = /Control socket connect\((.+?)\): Connection refused/.exec(stderr)
    if (!m) return
    const file = path.resolve(m[1])
    if (path.dirname(file) !== path.resolve(this.opts.controlDir)) return
    try {
      if (!fs.lstatSync(file).isSocket()) return
      fs.unlinkSync(file)
      log.info('removed stale SSH control socket', { alias: this.alias })
    } catch {
      /* already gone */
    }
  }

  /** Make sure the multiplexing master is up (one IAP handshake), reusing it when alive. */
  async ensureMaster(): Promise<void> {
    if (this.closed) throw new SshError('cancelled', 'Claude Deck is quitting')
    if (this.masterAlive && Date.now() - this.masterCheckedAt < 20_000) return
    if (await this.checkMaster()) return
    if (!this.masterPromise) {
      this.masterPromise = this.startMaster().finally(() => {
        this.masterPromise = null
      })
    }
    return this.masterPromise
  }

  private async startMaster(): Promise<void> {
    const env = await this.opts.env()
    if (this.closed) throw new SshError('cancelled', 'Claude Deck is quitting')
    // The backgrounded master inherits our stderr; using a file (not a pipe) avoids waiting on it.
    const errFile = path.join(this.opts.controlDir, `master-${process.pid}-${Date.now()}.err`)
    const fd = fs.openSync(errFile, 'w', 0o600)
    const t0 = Date.now()
    try {
      const code = await new Promise<number>((resolve, reject) => {
        // No -f: with ControlPersist, ssh moves itself to the background only once it owns the
        // control socket. If it could not claim the socket it would otherwise detach anyway as an
        // unshared connection that never exits; without -f it stays our child and is stopped below.
        const child = spawn(
          this.sshPath,
          [...this.baseArgs(), '-o', 'ControlMaster=yes', '-o', `ControlPersist=${this.opts.persistSec ?? 900}`, '-N', '--', this.alias],
          { env, stdio: ['ignore', 'ignore', fd] },
        )
        this.masterChild = child
        const done = () => {
          clearTimeout(timer)
          clearInterval(watch)
          if (this.masterChild === child) this.masterChild = null
        }
        const fail = (err: SshError) => {
          done()
          child.kill('SIGTERM')
          setTimeout(() => child.kill('SIGKILL'), 2000).unref()
          reject(err)
        }
        const timer = setTimeout(() => fail(new SshError('timeout', `Timed out connecting to ${this.alias}`)), 60_000)
        const watch = setInterval(() => {
          let stderr = ''
          try {
            stderr = fs.readFileSync(errFile, 'utf8')
          } catch {
            return
          }
          if (/disabling multiplexing/i.test(stderr)) {
            fail(new SshError('socket_busy', `Another SSH connection is holding Claude Deck’s control socket for ${this.alias}; retrying shortly.`))
          }
        }, 250)
        child.on('error', (err) => {
          done()
          reject(new SshError('config', `Could not run ssh: ${err.message}`))
        })
        child.on('exit', (c) => {
          done()
          resolve(c ?? 255)
        })
      })
      const stderr = fs.readFileSync(errFile, 'utf8')
      if (code !== 0 && this.closed) throw new SshError('cancelled', 'Claude Deck is quitting')
      if (code !== 0) {
        this.masterAlive = false
        const { kind, message } = classifySshFailure(stderr, this.alias)
        throw new SshError(kind, message, cleanStderr(stderr))
      }
      this.masterAlive = true
      this.masterCheckedAt = Date.now()
      log.info('SSH control master established', { alias: this.alias, ms: Date.now() - t0 })
    } finally {
      fs.closeSync(fd)
      fs.rmSync(errFile, { force: true })
    }
  }

  /** Run a fixed remote command string. Callers never interpolate user data into it. */
  async exec(remoteCommand: string, opts: { stdin?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
    try {
      await this.ensureMaster()
    } catch (err) {
      // A failed master means the VM/tunnel is unreachable or misconfigured; retrying a direct
      // connection would only stack another full timeout, so report it right away.
      if (err instanceof SshError) throw err
    }
    const args = [...this.baseArgs(), '-o', 'ControlMaster=no', '-T', '--', this.alias, remoteCommand]
    const res = await this.run(args, { stdin: opts.stdin, timeoutMs: opts.timeoutMs ?? 30_000 })
    if (res.code === 255) {
      this.masterAlive = false
      const { kind, message } = classifySshFailure(res.stderr, this.alias)
      throw new SshError(kind, message, cleanStderr(res.stderr))
    }
    return res
  }

  /** Ask the master to stop accepting new sessions; open terminals stay attached. */
  async stopMaster(): Promise<void> {
    try {
      await this.run([...this.baseArgs(), '-O', 'stop', '--', this.alias], { timeoutMs: 4000 })
    } catch {
      /* not running */
    }
    this.masterAlive = false
  }

  /**
   * On quit: never start another master, abort one that is still connecting (it would otherwise
   * finish after we exit and linger in the background), then stop the master. Open terminal
   * windows stay attached and nothing on the VM is touched.
   */
  async close(): Promise<void> {
    this.closed = true
    this.masterChild?.kill('SIGTERM')
    await this.masterPromise?.catch(() => undefined)
    await this.stopMaster()
  }

  /** Tear the master down (used to recover from a stale tunnel, e.g. after sleep). */
  async exitMaster(): Promise<void> {
    try {
      await this.run([...this.baseArgs(), '-O', 'exit', '--', this.alias], { timeoutMs: 4000 })
    } catch {
      /* not running */
    }
    this.masterAlive = false
  }

  private async run(args: string[], o: { stdin?: string; timeoutMs: number }): Promise<ExecResult> {
    const env = await this.opts.env()
    return new Promise<ExecResult>((resolve, reject) => {
      const t0 = Date.now()
      const child = spawn(this.sshPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
      const out: Buffer[] = []
      const err: Buffer[] = []
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 2000).unref()
        reject(new SshError('timeout', `SSH command to ${this.alias} timed out after ${Math.round(o.timeoutMs / 1000)}s`))
      }, o.timeoutMs)
      child.stdout.on('data', (d: Buffer) => out.push(d))
      child.stderr.on('data', (d: Buffer) => err.push(d))
      child.on('error', (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new SshError('config', `Could not run ssh: ${e.message}`))
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          code: code ?? 255,
          ms: Date.now() - t0,
        })
      })
      child.stdin.on('error', () => {
        /* remote closed early (EPIPE); the exit code tells the story */
      })
      child.stdin.end(o.stdin ?? '')
    })
  }
}
