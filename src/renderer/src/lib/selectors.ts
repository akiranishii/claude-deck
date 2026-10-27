import type { Account, ChromeProfile, Conversation, DeckState, Host, Project, Runtime, RuntimeLive, RuntimeStatus } from '@shared/types'
import { RUNNING_STATUSES, STATUS_FILTER_GROUPS } from '@shared/constants'
import { accountsSharingProfile, defaultConversation } from '@shared/routing'
import { sameConfigDir } from '@shared/naming'
import type { SortKey } from './store'

export type EffectiveStatus = RuntimeStatus | 'host_unreachable'
export type ProfileIssue = 'ok' | 'unassigned' | 'unverified' | 'missing' | 'shared' | 'no-account'

export interface RuntimeVM {
  runtime: Runtime
  project: Project
  host: Host | null
  account: Account | null
  status: EffectiveStatus
  running: boolean
  live: RuntimeLive | null
  conversations: Conversation[]
  defaultConversation: Conversation | null
  liveConversations: number
  profile: ChromeProfile | null
  profileIssue: ProfileIssue
  bypass: boolean
  accountMismatch: boolean
  hasDirectUrl: boolean
  hostReachable: boolean
  /** False until the VM has been observed in this app session (the status is the last known one). */
  checked: boolean
  sharedDirWith: RuntimeVM[]
}

export interface ProjectVM {
  project: Project
  host: Host | null
  runtimes: RuntimeVM[]
  primary: RuntimeVM | null
  conversations: Conversation[]
  orphanConversations: Conversation[]
  liveCount: number
  lastActivity: number
  accounts: Account[]
  anyRunning: boolean
}

const STATUS_RANK: Record<EffectiveStatus, number> = {
  needs_input: 0,
  auth_required: 1,
  failed: 2,
  connected: 3,
  reconnecting: 4,
  running: 5,
  starting: 6,
  stopping: 7,
  stopped: 8,
  missing: 9,
  unknown: 10,
  host_unreachable: 11,
}

export function statusRank(s: EffectiveStatus): number {
  return STATUS_RANK[s] ?? 99
}

function ts(iso: string | null | undefined): number {
  return iso ? Date.parse(iso) || 0 : 0
}

export function profileIssueFor(account: Account | null, accounts: Account[], profiles: ChromeProfile[]): { issue: ProfileIssue; profile: ChromeProfile | null } {
  if (!account) return { issue: 'no-account', profile: null }
  if (!account.chromeProfileDir) return { issue: 'unassigned', profile: null }
  const profile = profiles.find((p) => p.directory === account.chromeProfileDir) ?? null
  if (profiles.length && !profile) return { issue: 'missing', profile: null }
  if (accountsSharingProfile(account, accounts).length) return { issue: 'shared', profile }
  if (!account.chromeProfileConfirmedAt) return { issue: 'unverified', profile }
  return { issue: 'ok', profile }
}

export function buildVMs(state: DeckState): { projects: ProjectVM[]; runtimes: RuntimeVM[]; byRuntime: Map<string, RuntimeVM> } {
  const hosts = new Map(state.hosts.map((h) => [h.id, h]))
  const accounts = new Map(state.accounts.map((a) => [a.id, a]))
  const projects = new Map(state.projects.map((p) => [p.id, p]))
  const convByRuntime = new Map<string, Conversation[]>()
  const convByProject = new Map<string, Conversation[]>()
  for (const c of state.conversations) {
    if (c.archived) continue
    if (c.runtimeId) convByRuntime.set(c.runtimeId, [...(convByRuntime.get(c.runtimeId) ?? []), c])
    convByProject.set(c.projectId, [...(convByProject.get(c.projectId) ?? []), c])
  }
  const sortConvs = (list: Conversation[]) =>
    [...list].sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        Number(b.live) - Number(a.live) ||
        Math.max(ts(b.lastOpenedAt), ts(b.lastSeenAt)) - Math.max(ts(a.lastOpenedAt), ts(a.lastSeenAt)) ||
        ts(b.createdAt) - ts(a.createdAt),
    )

  const runtimes: RuntimeVM[] = []
  for (const r of state.runtimes) {
    const project = projects.get(r.projectId)
    if (!project) continue
    const host = hosts.get(project.hostId) ?? null
    const hostLive = host ? state.live.hosts[host.id] : undefined
    const hostReachable = !(hostLive?.reachable === false || (hostLive?.reachable == null && host?.lastConnectionStatus === 'offline'))
    const account = r.accountId ? accounts.get(r.accountId) ?? null : null
    const conversations = sortConvs(convByRuntime.get(r.id) ?? [])
    const { issue, profile } = profileIssueFor(account, state.accounts, state.chromeProfiles)
    const status: EffectiveStatus = hostReachable ? r.observedStatus : 'host_unreachable'
    const observed = r.observedConfigDir
    const accountMismatch = Boolean(
      account && observed && observed.state !== 'unknown' && !sameConfigDir(observed.state === 'default' ? null : observed.value, account.configDir, host?.homePath),
    )
    runtimes.push({
      runtime: r,
      project,
      host,
      account,
      status,
      running: RUNNING_STATUSES.includes(r.observedStatus) && hostReachable,
      live: state.live.runtimes[r.id] ?? null,
      conversations,
      defaultConversation: defaultConversation(r.id, state.conversations),
      liveConversations: conversations.filter((c) => c.live).length,
      profile,
      profileIssue: issue,
      bypass: r.permissionMode === 'bypassPermissions' || r.observedFlags?.permissionMode === 'bypassPermissions',
      accountMismatch,
      hasDirectUrl: conversations.length > 0,
      hostReachable,
      checked: Boolean(hostLive?.lastSnapshotAt),
      sharedDirWith: [],
    })
  }
  // Parallel sessions working in the same folder (simultaneous edits can conflict).
  for (const vm of runtimes) {
    if (!vm.running) continue
    const spawn = vm.runtime.spawnMode ?? vm.runtime.observedFlags?.spawn ?? 'same-dir'
    if (spawn === 'worktree') continue
    vm.sharedDirWith = runtimes.filter(
      (o) => o !== vm && o.running && o.project.hostId === vm.project.hostId && o.project.remotePath === vm.project.remotePath && (o.runtime.spawnMode ?? o.runtime.observedFlags?.spawn ?? 'same-dir') !== 'worktree',
    )
  }
  const byRuntime = new Map(runtimes.map((r) => [r.runtime.id, r]))

  const projectVMs: ProjectVM[] = state.projects.map((p) => {
    const rts = runtimes
      .filter((r) => r.runtime.projectId === p.id && !r.runtime.archived)
      .sort((a, b) => Number(b.running) - Number(a.running) || statusRank(a.status) - statusRank(b.status) || ts(b.runtime.lastStartedAt) - ts(a.runtime.lastStartedAt))
    const conversations = sortConvs(convByProject.get(p.id) ?? [])
    const accts = [...new Map(rts.filter((r) => r.account).map((r) => [r.account!.id, r.account!])).values()]
    return {
      project: p,
      host: hosts.get(p.hostId) ?? null,
      runtimes: rts,
      primary: rts[0] ?? null,
      conversations,
      orphanConversations: conversations.filter((c) => !c.runtimeId),
      liveCount: conversations.filter((c) => c.live).length,
      lastActivity: Math.max(ts(p.lastActiveAt), ...rts.map((r) => ts(r.runtime.lastStartedAt))) || ts(p.createdAt),
      accounts: accts,
      anyRunning: rts.some((r) => r.running),
    }
  })
  return { projects: projectVMs, runtimes, byRuntime }
}

export interface Filters {
  search: string
  accountFilter: string[]
  statusFilter: string[]
  tagFilter: string[]
  projectFilter: string[]
}

function haystackForRuntime(r: RuntimeVM): string {
  return [
    r.runtime.tmuxSessionName,
    r.runtime.remoteControlName,
    r.runtime.taskSummary,
    r.account?.displayName,
    r.account?.label,
    r.account?.authEmail,
    ...r.conversations.map((c) => `${c.displayTitle ?? ''} ${c.autoTitle ?? ''} ${c.remoteSessionId}`),
  ]
    .filter(Boolean)
    .join(' ')
}

function haystackForProject(p: ProjectVM): string {
  return [
    p.project.displayName,
    p.project.remotePath,
    p.project.taskSummary,
    p.project.notes,
    p.project.git?.branch,
    ...p.project.tags.map((t) => `#${t} ${t}`),
    ...p.runtimes.map(haystackForRuntime),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

export function searchMatches(haystack: string, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  return tokens.every((t) => haystack.includes(t))
}

function statusSet(groupIds: string[]): Set<EffectiveStatus> {
  return new Set(STATUS_FILTER_GROUPS.filter((g) => groupIds.includes(g.id)).flatMap((g) => g.statuses))
}

export function filterProjects(vms: ProjectVM[], f: Filters): ProjectVM[] {
  const statuses = statusSet(f.statusFilter)
  return vms.filter((p) => {
    if (f.search && !searchMatches(haystackForProject(p), f.search)) return false
    if (f.accountFilter.length && !p.runtimes.some((r) => r.account && f.accountFilter.includes(r.account.id))) return false
    if (statuses.size && !p.runtimes.some((r) => statuses.has(r.status))) return false
    if (f.tagFilter.length && !p.project.tags.some((t) => f.tagFilter.includes(t))) return false
    if (f.projectFilter.length && !f.projectFilter.includes(p.project.id)) return false
    return true
  })
}

export function filterRuntimes(vms: RuntimeVM[], f: Filters): RuntimeVM[] {
  const statuses = statusSet(f.statusFilter)
  return vms.filter((r) => {
    if (f.search && !searchMatches(`${haystackForRuntime(r)} ${r.project.displayName} ${r.project.remotePath} ${r.project.taskSummary ?? ''}`.toLowerCase(), f.search)) return false
    if (f.accountFilter.length && !(r.account && f.accountFilter.includes(r.account.id))) return false
    if (statuses.size && !statuses.has(r.status)) return false
    if (f.tagFilter.length && !r.project.tags.some((t) => f.tagFilter.includes(t))) return false
    if (f.projectFilter.length && !f.projectFilter.includes(r.project.id)) return false
    return true
  })
}

export function sortProjects(vms: ProjectVM[], sort: SortKey): ProjectVM[] {
  const list = [...vms]
  if (sort === 'name') return list.sort((a, b) => a.project.displayName.localeCompare(b.project.displayName, undefined, { numeric: true }))
  if (sort === 'status') {
    const best = (p: ProjectVM) => Math.min(99, ...p.runtimes.map((r) => statusRank(r.status)))
    return list.sort((a, b) => best(a) - best(b) || b.lastActivity - a.lastActivity)
  }
  return list.sort((a, b) => b.lastActivity - a.lastActivity)
}

export function allTags(state: DeckState): string[] {
  return [...new Set(state.projects.filter((p) => !p.archived).flatMap((p) => p.tags))].sort()
}

export function profileLabel(p: ChromeProfile | null | undefined, dir?: string | null): string {
  if (!p) return dir ?? 'No profile'
  return p.name === p.directory ? p.directory : `${p.name} (${p.directory})`
}

export function maskEmail(email: string | null | undefined): string {
  if (!email) return ''
  return email
}

export function needsAttention(r: RuntimeVM): boolean {
  return r.status === 'needs_input' || r.status === 'auth_required' || r.status === 'failed' || r.accountMismatch || (!r.account && !r.runtime.archived)
}
