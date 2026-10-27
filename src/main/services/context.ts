import type { ProgressEvent } from '../../shared/ipc'
import type { ChromeProfile, DeckEvent, HostLive, RuntimeLive, Settings } from '../../shared/types'
import type { Store } from '../db/store'
import type { RawSnapshot } from '../ssh/helperTypes'
import type { HostRegistry } from './hostRegistry'

/** Error with a stable code that is shown to the user as-is. */
export class DeckError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DeckError'
  }
}

export class LiveStore {
  readonly hosts = new Map<string, HostLive>()
  readonly runtimes = new Map<string, RuntimeLive>()
  readonly snapshots = new Map<string, { snap: RawSnapshot; at: number }>()

  host(hostId: string): HostLive {
    let h = this.hosts.get(hostId)
    if (!h) {
      h = {
        hostId,
        reachable: null,
        refreshing: false,
        lastSnapshotAt: null,
        snapshotMs: null,
        error: null,
        errorKind: null,
        tmuxRunning: null,
        untracked: [],
      }
      this.hosts.set(hostId, h)
    }
    return h
  }
}

export type EventInput = Omit<DeckEvent, 'id' | 'timestamp' | 'hostId' | 'projectId' | 'runtimeId'> & {
  hostId?: string | null
  projectId?: string | null
  runtimeId?: string | null
}

export interface Ctx {
  store: Store
  hosts: HostRegistry
  live: LiveStore
  settings(): Settings
  chromeProfiles(): { profiles: ChromeProfile[]; error: string | null }
  refreshChromeProfiles(): { profiles: ChromeProfile[]; error: string | null }
  changed(): void
  progress(e: ProgressEvent): void
  event(e: EventInput): void
  notify(title: string, body: string, runtimeId?: string | null): void
}
