// JSON export/import of Claude Deck metadata. There are no credentials in the database to
// begin with; the export contains hosts, accounts (labels/config paths/profile mapping),
// projects, sessions, conversation links and settings.

import type { Account, Conversation, Host, Project, Runtime, Settings } from '../../shared/types'
import type { Store } from '../db/store'
import { nowIso } from '../db/store'
import { isSessionId } from '../../shared/urls'

export const EXPORT_FORMAT = 'claude-deck-export'
export const EXPORT_VERSION = 1

export interface ExportDoc {
  format: typeof EXPORT_FORMAT
  version: number
  exportedAt: string
  appVersion: string
  hosts: Host[]
  accounts: Account[]
  projects: Project[]
  runtimes: Runtime[]
  conversations: Conversation[]
  settings: Partial<Settings>
}

export function buildExport(store: Store, appVersion: string): ExportDoc {
  const settings = store.getSettings()
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: nowIso(),
    appVersion,
    hosts: store.listHosts(),
    accounts: store.listAccounts(),
    projects: store.listProjects(),
    runtimes: store.listRuntimes(),
    conversations: store.listConversations(),
    settings: { ...settings, onboardingComplete: settings.onboardingComplete },
  }
}

/** Merge an export into the database. Existing rows win on unique conflicts (alias, config dir, session id). */
export function applyImport(store: Store, doc: unknown): Record<string, number> {
  const d = doc as Partial<ExportDoc>
  if (!d || d.format !== EXPORT_FORMAT || typeof d.version !== 'number' || d.version > EXPORT_VERSION) {
    throw new Error('This file is not a Claude Deck export (or was made by a newer version)')
  }
  const counts = { hosts: 0, accounts: 0, projects: 0, runtimes: 0, conversations: 0 }
  const hostMap = new Map<string, string>()
  const accountMap = new Map<string, string>()
  const projectMap = new Map<string, string>()
  const runtimeMap = new Map<string, string>()
  store.tx(() => {
    for (const h of d.hosts ?? []) {
      const existing = store.hosts.get(h.id) ?? store.listHosts().find((x) => x.sshAlias === h.sshAlias)
      if (existing) hostMap.set(h.id, existing.id)
      else {
        store.hosts.insert({ ...h, lastConnectionStatus: 'unknown' })
        hostMap.set(h.id, h.id)
        counts.hosts++
      }
    }
    for (const a of d.accounts ?? []) {
      const existing = store.accounts.get(a.id) ?? store.accountByConfigDir(a.configDir)
      if (existing) accountMap.set(a.id, existing.id)
      else {
        store.accounts.insert({ ...a, authState: 'unknown' })
        accountMap.set(a.id, a.id)
        counts.accounts++
      }
    }
    for (const p of d.projects ?? []) {
      const hostId = hostMap.get(p.hostId)
      if (!hostId) continue
      if (store.projects.get(p.id)) {
        projectMap.set(p.id, p.id)
        continue
      }
      store.projects.insert({ ...p, hostId, parentProjectId: null })
      projectMap.set(p.id, p.id)
      counts.projects++
    }
    for (const r of d.runtimes ?? []) {
      const projectId = projectMap.get(r.projectId)
      if (!projectId) continue
      if (store.runtimes.get(r.id)) {
        runtimeMap.set(r.id, r.id)
        continue
      }
      store.runtimes.insert({ ...r, projectId, accountId: r.accountId ? accountMap.get(r.accountId) ?? null : null, observedStatus: 'unknown' })
      runtimeMap.set(r.id, r.id)
      counts.runtimes++
    }
    for (const c of d.conversations ?? []) {
      const projectId = projectMap.get(c.projectId)
      if (!projectId || !isSessionId(c.remoteSessionId) || store.conversationBySessionId(c.remoteSessionId)) continue
      store.conversations.insert({ ...c, projectId, runtimeId: c.runtimeId ? runtimeMap.get(c.runtimeId) ?? null : null, live: false })
      counts.conversations++
    }
  })
  return counts
}
