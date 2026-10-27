import type { Store } from '../db/store'
import { HelperClient } from '../ssh/helper'
import { shellEnv } from '../ssh/shellEnv'
import { SshClient } from '../ssh/sshClient'
import { DeckError } from './context'

interface Entry {
  alias: string
  python: string
  ssh: SshClient
  helper: HelperClient
}

/** One SSH client (with its ControlMaster) and helper client per SSH alias. */
export class HostRegistry {
  private byAlias = new Map<string, Entry>()

  constructor(
    private readonly store: Store,
    private readonly controlDir: string,
  ) {}

  forAlias(alias: string, python = 'python3'): Entry {
    let entry = this.byAlias.get(alias)
    if (!entry || entry.python !== python) {
      const ssh = new SshClient({ alias, controlDir: this.controlDir, env: shellEnv })
      entry = { alias, python, ssh, helper: new HelperClient(ssh, () => python) }
      this.byAlias.set(alias, entry)
    }
    return entry
  }

  get(hostId: string): Entry {
    const host = this.store.hosts.get(hostId)
    if (!host) throw new DeckError('host_not_found', 'Host not found')
    return this.forAlias(host.sshAlias, host.pythonCommand || 'python3')
  }

  helper(hostId: string): HelperClient {
    return this.get(hostId).helper
  }

  controlPath(hostId: string): string {
    return this.get(hostId).ssh.controlPath
  }

  /** Start over with a fresh tunnel. `-O stop` keeps terminal windows that share the old one alive. */
  async resetAll(): Promise<void> {
    await Promise.all([...this.byAlias.values()].map((e) => e.ssh.stopMaster()))
  }

  async reset(hostId: string): Promise<void> {
    await this.get(hostId).ssh.stopMaster()
  }

  /** On quit: stop accepting new sessions but leave open terminal windows attached. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.byAlias.values()].map((e) => e.ssh.close()))
  }
}
