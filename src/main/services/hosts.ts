import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { HostInput, HostPatch, ProbeResult } from '../../shared/ipc'
import type { Host, ShellMode } from '../../shared/types'
import { DEFAULT_PARENT_DIR } from '../../shared/constants'
import { newId, normalizeRemotePath, validateRemotePathInput } from '../../shared/naming'
import { nowIso } from '../db/store'
import type { RawProbe } from '../ssh/helperTypes'
import { validateAlias } from '../ssh/sshClient'
import { DeckError, type Ctx } from './context'
import { mapCapabilities, mapProbe } from './mappers'
import type { Monitor } from './monitor'

const SHELL_MODES: ShellMode[] = ['interactive-login', 'login', 'direct']

/** Host aliases from ~/.ssh/config (and Include'd files), skipping wildcard patterns. */
export function parseSshConfigAliases(text: string, readInclude: (pattern: string) => string[] = () => [], depth = 0): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim()
    const m = /^([A-Za-z]+)\s*(?:=\s*|\s+)(.+)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === 'host') {
      for (const tok of value.split(/\s+/)) {
        const t = tok.replace(/^"|"$/g, '')
        if (t && !/[*?!]/.test(t) && !out.includes(t)) out.push(t)
      }
    } else if (key === 'include' && depth < 4) {
      for (const pattern of value.split(/\s+/)) {
        for (const content of readInclude(pattern)) {
          for (const a of parseSshConfigAliases(content, readInclude, depth + 1)) if (!out.includes(a)) out.push(a)
        }
      }
    }
  }
  return out
}

function readIncludes(pattern: string): string[] {
  const sshDir = path.join(os.homedir(), '.ssh')
  const expanded = pattern.startsWith('~/') ? path.join(os.homedir(), pattern.slice(2)) : path.isAbsolute(pattern) ? pattern : path.join(sshDir, pattern)
  const dir = path.dirname(expanded)
  const base = path.basename(expanded)
  const rx = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => rx.test(f))
      .map((f) => path.join(dir, f))
      .filter((f) => fs.statSync(f).isFile())
      .map((f) => fs.readFileSync(f, 'utf8'))
  } catch {
    return []
  }
}

export class HostsService {
  constructor(
    private readonly ctx: Ctx,
    private readonly monitor: Monitor,
  ) {}

  listSshAliases(): string[] {
    try {
      return parseSshConfigAliases(fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8'), readIncludes)
    } catch {
      return []
    }
  }

  async probe(alias: string, claudePath?: string | null, pythonCommand = 'python3'): Promise<ProbeResult> {
    validateAlias(alias)
    const t0 = Date.now()
    const helper = this.ctx.hosts.forAlias(alias, pythonCommand).helper
    const raw = await helper.call<RawProbe>('probe', claudePath ? { claude_path: claudePath } : {}, 90_000)
    const at = nowIso()
    return { probe: mapProbe(raw, at), capabilities: raw.capabilities ? mapCapabilities(raw.capabilities, at) : null, elapsedMs: Date.now() - t0 }
  }

  async save(input: HostInput): Promise<Host> {
    const { store } = this.ctx
    const alias = validateAlias(input.sshAlias.trim())
    if (store.listHosts().some((h) => h.sshAlias === alias)) throw new DeckError('duplicate', `${alias} is already registered`)
    const now = nowIso()
    const host: Host = {
      id: newId('host'),
      displayName: input.displayName.trim() || alias,
      sshAlias: alias,
      remoteUser: null,
      homePath: null,
      hostname: null,
      claudePath: input.claudePath ?? null,
      pythonCommand: input.pythonCommand?.trim() || 'python3',
      shellMode: input.shellMode && SHELL_MODES.includes(input.shellMode) ? input.shellMode : 'interactive-login',
      defaultParentDir: input.defaultParentDir?.trim() || DEFAULT_PARENT_DIR,
      capabilities: null,
      probe: null,
      lastConnectionStatus: 'unknown',
      lastConnectionError: null,
      lastConnectedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    store.hosts.insert(host)
    try {
      await this.reprobe(host.id)
    } catch (err) {
      store.hosts.update(host.id, { lastConnectionStatus: 'offline', lastConnectionError: (err as Error).message })
    }
    this.monitor.watchHost(host.id)
    this.ctx.event({ level: 'info', type: 'host.added', summary: `Registered VM ${alias}`, hostId: host.id })
    return store.hosts.get(host.id)!
  }

  async reprobe(id: string): Promise<Host> {
    const { store } = this.ctx
    const host = store.hosts.get(id)
    if (!host) throw new DeckError('not_found', 'Host not found')
    const res = await this.probe(host.sshAlias, host.claudePath, host.pythonCommand)
    const claudePath = host.claudePath ?? res.probe.claudeRecommended
    let capabilities = res.capabilities
    if (claudePath && (!capabilities || capabilities.claudePath !== claudePath)) {
      capabilities = (await this.probe(host.sshAlias, claudePath, host.pythonCommand)).capabilities
    }
    store.hosts.update(id, {
      remoteUser: res.probe.user,
      homePath: res.probe.home,
      hostname: res.probe.hostname,
      claudePath,
      capabilities,
      probe: res.probe,
      lastConnectionStatus: 'online',
      lastConnectionError: null,
      lastConnectedAt: nowIso(),
      updatedAt: nowIso(),
    })
    this.ctx.changed()
    return store.hosts.get(id)!
  }

  async update(id: string, patch: HostPatch): Promise<Host> {
    const { store } = this.ctx
    const host = store.hosts.get(id)
    if (!host) throw new DeckError('not_found', 'Host not found')
    const next: Partial<Host> = { updatedAt: nowIso() }
    if (patch.displayName !== undefined) next.displayName = patch.displayName.trim() || host.sshAlias
    if (patch.shellMode !== undefined) {
      if (!SHELL_MODES.includes(patch.shellMode)) throw new DeckError('invalid', 'Invalid shell mode')
      next.shellMode = patch.shellMode
    }
    if (patch.pythonCommand !== undefined) {
      if (!/^[A-Za-z0-9_./-]{1,200}$/.test(patch.pythonCommand)) throw new DeckError('invalid', 'Invalid python command')
      next.pythonCommand = patch.pythonCommand
    }
    if (patch.defaultParentDir !== undefined) {
      const err = validateRemotePathInput(patch.defaultParentDir)
      if (err) throw new DeckError('invalid_path', err)
      next.defaultParentDir = normalizeRemotePath(patch.defaultParentDir)
    }
    const claudeChanged = patch.claudePath !== undefined && patch.claudePath !== host.claudePath
    if (claudeChanged) {
      if (patch.claudePath && !/^\/[^\x00-\x1f]{1,1000}$/.test(patch.claudePath)) throw new DeckError('invalid_path', 'Use an absolute path to the claude binary')
      next.claudePath = patch.claudePath
      next.capabilities = null
    }
    store.hosts.update(id, next)
    if (claudeChanged) await this.reprobe(id)
    this.ctx.changed()
    return store.hosts.get(id)!
  }

  remove(id: string): void {
    const host = this.ctx.store.hosts.get(id)
    if (!host) return
    this.ctx.store.hosts.delete(id)
    this.ctx.live.hosts.delete(id)
    this.ctx.event({ level: 'warn', type: 'host.removed', summary: `Removed VM ${host.sshAlias} and its dashboard records (nothing changed on the VM)` })
  }

  async reconnect(id: string): Promise<void> {
    await this.ctx.hosts.reset(id)
    await this.monitor.refresh(id)
  }
}
