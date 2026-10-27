import type {
  ClaudeCapabilities,
  ContainerState,
  GitInfo,
  HostProbe,
  ObservedConfigDir,
  ObservedFlags,
  Project,
} from '../../shared/types'
import type { RawCapabilities, RawCapture, RawConfigDir, RawContainers, RawFlags, RawGit, RawProbe } from '../ssh/helperTypes'

export function mapConfigDir(raw: RawConfigDir | null | undefined): ObservedConfigDir {
  if (!raw) return { state: 'unknown', value: null }
  return { state: raw.state, value: raw.state === 'env' ? raw.value : null }
}

/** null = default config, string = explicit dir, undefined = unknown */
export function observedDirValue(cfg: ObservedConfigDir | null | undefined): string | null | undefined {
  if (!cfg || cfg.state === 'unknown') return undefined
  return cfg.state === 'default' ? null : cfg.value
}

export function mapFlags(raw: RawFlags | null | undefined, capture?: RawCapture | null): ObservedFlags | null {
  if (!raw) return null
  return {
    name: raw.name ?? null,
    spawn: raw.spawn ?? null,
    permissionMode: raw.permission_mode ?? null,
    capacity: raw.capacity ?? null,
    continue: raw.continue ?? false,
    liveSpawnNote: capture?.capacity?.note ?? null,
  }
}

export function mapGit(raw: RawGit, checkedAt: string): GitInfo {
  return {
    isRepo: Boolean(raw.is_repo),
    root: raw.root ?? null,
    branch: raw.branch ?? null,
    detached: raw.detached ?? false,
    head: raw.head ?? null,
    isWorktree: raw.is_worktree ?? false,
    dirtyCount: raw.dirty_count ?? null,
    ahead: raw.ahead,
    behind: raw.behind,
    lastCommit: raw.last_commit ? { hash: raw.last_commit.hash, subject: raw.last_commit.subject, time: raw.last_commit.time } : null,
    checkedAt,
  }
}

export function mapCapabilities(raw: RawCapabilities, detectedAt: string): ClaudeCapabilities {
  return {
    claudePath: raw.claude_path,
    version: raw.version,
    rcSupported: raw.rc_supported,
    flags: raw.flags ?? [],
    spawnModes: raw.spawn_modes ?? [],
    permissionModes: raw.permission_modes ?? [],
    supportsName: raw.supports_name,
    supportsSpawn: raw.supports_spawn,
    supportsPermissionMode: raw.supports_permission_mode,
    supportsContinue: raw.supports_continue,
    supportsSessionId: raw.supports_session_id,
    supportsCapacity: raw.supports_capacity,
    supportsCreateSessionInDir: raw.supports_create_session_in_dir,
    supportsChrome: raw.supports_chrome,
    authStatusSupported: raw.auth_status_supported,
    authLoginSupported: raw.auth_login_supported,
    detectedAt,
  }
}

export function mapProbe(raw: RawProbe, probedAt: string): HostProbe {
  return {
    hostname: raw.hostname,
    user: raw.user,
    uid: raw.uid,
    home: raw.home,
    loginShell: raw.login_shell,
    os: raw.os,
    kernel: raw.kernel,
    arch: raw.arch,
    python: raw.python,
    helperVersion: raw.helper_version,
    tmuxVersion: raw.tmux?.version ?? null,
    gitVersion: raw.git?.version ?? null,
    docker: raw.docker ?? { path: null },
    projectsDirExists: raw.projects_dir_exists,
    claudeCandidates: (raw.claude_candidates ?? []).map((c) => ({ path: c.path, realpath: c.realpath, version: c.version, sources: c.sources, error: c.error })),
    claudeRecommended: raw.claude_recommended ?? null,
    configDirs: (raw.config_dirs ?? []).map((d) => ({
      path: d.path,
      name: d.name,
      isDefaultDir: d.is_default_dir,
      hasCredentials: d.has_credentials,
      hasProjects: d.has_projects,
      mtime: d.mtime,
    })),
    probedAt,
  }
}

/** Find the dev container for a project: by devcontainer label (survives recreation) or by name. */
export function matchContainer(project: Project, raw: RawContainers, checkedAt: string): ContainerState {
  if (!raw.available) return { found: false, checkedAt, error: raw.reason ?? 'docker unavailable' }
  const cfg = project.container
  const hostPath = cfg?.hostPath || project.repositoryRoot || project.remotePath
  const list = raw.containers ?? []
  const hit =
    cfg?.matchBy === 'name' && cfg.name
      ? list.find((c) => c.name === cfg.name || c.id.startsWith(cfg.name ?? '\0'))
      : list
          .filter((c) => c.local_folder && (c.local_folder === hostPath || project.remotePath.startsWith(`${c.local_folder}/`) || c.local_folder === project.remotePath))
          .sort((a, b) => (a.state === 'running' ? -1 : 1) - (b.state === 'running' ? -1 : 1))[0]
  if (!hit) return { found: false, checkedAt, error: null }
  const mount = hit.mounts?.find((m) => m.source === hostPath) ?? hit.mounts?.find((m) => hostPath.startsWith(`${m.source}/`)) ?? null
  return {
    found: true,
    id: hit.id,
    name: hit.name,
    state: hit.state,
    status: hit.status,
    image: hit.image,
    remoteUser: hit.remote_user ?? null,
    workspaceMount: mount ? { source: mount.source, destination: mount.destination } : null,
    checkedAt,
    error: null,
  }
}
