// JSON-over-SSH RPC to the agentless remote helper.
//
//   ssh <alias> python3 -      ← stdin: helper source + `entry("<base64 JSON request>")`
//
// The remote command string is constant. The request travels as base64 inside the program
// text, so paths, names and other user input are never parsed by a remote shell.

import helperSource from '../../../resources/remote/cdeck_helper.py?raw'
import { SshClient, SshError, cleanStderr } from './sshClient'

export const RESULT_MARKER = '__CDECK_RESULT__'
const PYTHON_RE = /^[A-Za-z0-9_./-]{1,200}$/

export class RemoteOpError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message)
    this.name = 'RemoteOpError'
  }
}

export function helperProgram(request: object, source: string = helperSource): string {
  const b64 = Buffer.from(JSON.stringify(request), 'utf8').toString('base64')
  return `${source}\nentry(${JSON.stringify(b64)})\n`
}

export function parseHelperOutput<T>(stdout: string, stderr: string, code: number, python: string): T {
  const line = stdout
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(RESULT_MARKER))
  if (!line) {
    const err = cleanStderr(stderr)
    if (code === 127 || /python3?: (?:command )?not found|No such file or directory/.test(err)) {
      throw new SshError('python_missing', `${python} was not found on the VM; Claude Deck needs Python 3 there.`)
    }
    throw new RemoteOpError('protocol', `Unexpected response from the VM (exit ${code}): ${(err || stdout).slice(-300)}`)
  }
  let payload: { ok: boolean; result?: T; error?: { code?: string; message?: string; details?: unknown } }
  try {
    payload = JSON.parse(line.slice(RESULT_MARKER.length))
  } catch {
    throw new RemoteOpError('protocol', 'Malformed response from the remote helper')
  }
  if (!payload.ok) {
    throw new RemoteOpError(payload.error?.code ?? 'remote', payload.error?.message ?? 'Remote operation failed', payload.error?.details)
  }
  return payload.result as T
}

export class HelperClient {
  constructor(
    private readonly ssh: SshClient,
    private readonly python: () => string = () => 'python3',
    private readonly tmuxSocket?: string,
  ) {}

  get alias(): string {
    return this.ssh.alias
  }

  async call<T>(op: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const python = this.python()
    if (!PYTHON_RE.test(python)) throw new Error(`Invalid python command: ${python}`)
    const request: Record<string, unknown> = { op, protocol: 1, args }
    if (this.tmuxSocket) request.tmux_socket = this.tmuxSocket
    const res = await this.ssh.exec(`${python} -`, { stdin: helperProgram(request), timeoutMs })
    return parseHelperOutput<T>(res.stdout, res.stderr, res.code, python)
  }
}
