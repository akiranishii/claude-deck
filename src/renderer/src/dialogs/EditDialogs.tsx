import type { ContainerConfig, DeckState, PermissionMode, SpawnMode, TaskStatus } from '@shared/types'
import { PERMISSION_MODE_META, SPAWN_MODE_META, TASK_STATUS_META } from '@shared/constants'
import { configDirLabel, sameConfigDir } from '@shared/naming'
import { environmentUrl } from '@shared/urls'
import { Container, Pencil, ShieldAlert, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Callout, Checkbox, Field, Input, Modal, Segmented, Select, Switch, Textarea } from '../components/ui'
import { call, errorMessage } from '../lib/api'
import { relTime } from '../lib/format'
import { ui } from '../lib/store'
import { FolderBrowser } from './FolderBrowser'

export function ProjectDialog({ state, projectId, tab: initialTab = 'general', onClose }: { state: DeckState; projectId: string; tab?: 'general' | 'container'; onClose: () => void }) {
  const project = state.projects.find((p) => p.id === projectId)
  const [tab, setTab] = useState(initialTab)
  const [name, setName] = useState(project?.displayName ?? '')
  const [path, setPath] = useState(project?.remotePath ?? '')
  const [task, setTask] = useState(project?.taskSummary ?? '')
  const [taskStatus, setTaskStatus] = useState<TaskStatus | ''>(project?.taskStatus ?? '')
  const [notes, setNotes] = useState(project?.notes ?? '')
  const [tags, setTags] = useState((project?.tags ?? []).join(', '))
  const [pinned, setPinned] = useState(project?.pinned ?? false)
  const [parentId, setParentId] = useState(project?.parentProjectId ?? '')
  const [browsing, setBrowsing] = useState(false)
  const [container, setContainer] = useState<ContainerConfig>(
    project?.container ?? { enabled: false, matchBy: 'devcontainer', name: null, hostPath: null, containerPath: null, user: null, shell: null, commandRunner: null },
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!project) return null
  const cs = project.containerState

  const saveAll = async () => {
    setBusy(true)
    setError(null)
    try {
      await call('project.update', {
        id: project.id,
        patch: {
          displayName: name,
          remotePath: path,
          taskSummary: task || null,
          taskStatus: taskStatus || null,
          notes: notes || null,
          tags: tags.split(/[,\s]+/).map((t) => t.replace(/^#/, '')).filter(Boolean),
          pinned,
          parentProjectId: parentId || null,
          container,
        },
      })
      ui().toast('success', 'Project saved')
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={680}
      icon={<Pencil className="size-4" />}
      title={`Edit ${project.displayName}`}
      description="Project metadata lives only in Claude Deck — nothing on the VM changes."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void saveAll()}>
            Save
          </Button>
        </>
      }
    >
      <div className="mb-4">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'general', label: 'General' },
            { value: 'container', label: <><Container className="size-3.5" /> Dev container</> },
          ]}
        />
      </div>
      {tab === 'general' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Project name">
              <Input data-autofocus value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Task status">
              <Select value={taskStatus} onChange={(e) => setTaskStatus(e.target.value as TaskStatus | '')}>
                <option value="">—</option>
                {Object.entries(TASK_STATUS_META).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Current task" hint="A short description shown prominently on the dashboard.">
            <Input value={task} placeholder="e.g. Fixing backend tests" onChange={(e) => setTask(e.target.value)} />
          </Field>
          <Field label="Folder on the VM" right={<button className="text-[11.5px] text-accent hover:underline" onClick={() => setBrowsing(!browsing)}>Browse…</button>} hint={project.pathStatus === 'missing' ? 'The current path was not found on the VM — update it if the folder was renamed.' : undefined}>
            <Input mono value={path} onChange={(e) => setPath(e.target.value)} />
          </Field>
          {browsing && (
            <FolderBrowser
              hostId={project.hostId}
              initialPath={path}
              onCancel={() => setBrowsing(false)}
              onPick={(p) => {
                setPath(p)
                setBrowsing(false)
              }}
            />
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Tags" hint="Comma separated">
              <Input value={tags} onChange={(e) => setTags(e.target.value)} />
            </Field>
            <Field label="Parent project" hint="Group subprojects of a monorepo">
              <Select value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="">None</option>
                {state.projects
                  .filter((p) => p.id !== project.id && !p.archived)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          <Field label="Notes">
            <Textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything worth remembering about this project…" />
          </Field>
          <label className="flex items-center gap-2 text-[12.5px]">
            <Switch checked={pinned} onChange={setPinned} /> Pin to the top of the dashboard
          </label>
          {project.git?.isRepo && (
            <div className="rounded-lg bg-panel-2 px-3 py-2 text-[12px] text-fg-2">
              Git: <b>{project.git.branch ?? 'detached'}</b> · {project.git.dirtyCount ? `${project.git.dirtyCount} modified` : 'clean'}
              {project.git.isWorktree ? ' · worktree' : ''} · root <span className="font-mono">{project.repositoryRoot}</span>
              {project.git.lastCommit && (
                <div className="mt-0.5 truncate text-fg-3">
                  {project.git.lastCommit.hash} {project.git.lastCommit.subject}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-[13px] font-medium">
            <Switch checked={container.enabled} onChange={(v) => setContainer({ ...container, enabled: v })} /> This project uses a Docker dev container
          </label>
          <Callout tone="info">
            Claude Code keeps running on the VM host; the dev container shares the same checkout. Claude Deck only shows the container’s status and can open a shell in it — it never starts, stops or rebuilds containers.
          </Callout>
          {container.enabled && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Find the container by">
                  <Select value={container.matchBy} onChange={(e) => setContainer({ ...container, matchBy: e.target.value as 'devcontainer' | 'name' })}>
                    <option value="devcontainer">Dev container label (survives rebuilds)</option>
                    <option value="name">Container name</option>
                  </Select>
                </Field>
                <Field label="Container name">
                  <Input mono disabled={container.matchBy !== 'name'} value={container.name ?? ''} onChange={(e) => setContainer({ ...container, name: e.target.value || null })} />
                </Field>
                <Field label="Host path" hint={`Default: ${project.repositoryRoot ?? project.remotePath}`}>
                  <Input mono value={container.hostPath ?? ''} placeholder={project.repositoryRoot ?? project.remotePath} onChange={(e) => setContainer({ ...container, hostPath: e.target.value || null })} />
                </Field>
                <Field label="Container path" hint={cs?.workspaceMount ? `Detected: ${cs.workspaceMount.destination}` : 'e.g. /workspaces/my-project'}>
                  <Input mono value={container.containerPath ?? ''} placeholder={cs?.workspaceMount?.destination ?? '/workspaces/…'} onChange={(e) => setContainer({ ...container, containerPath: e.target.value || null })} />
                </Field>
                <Field label="Shell user" hint={cs?.remoteUser ? `Detected devcontainer user: ${cs.remoteUser} (non-root is preferred)` : 'Prefer a non-root user so new files keep sane ownership'}>
                  <Input mono value={container.user ?? ''} placeholder={cs?.remoteUser ?? 'vscode'} onChange={(e) => setContainer({ ...container, user: e.target.value || null })} />
                </Field>
                <Field label="Shell">
                  <Input mono value={container.shell ?? ''} placeholder="bash" onChange={(e) => setContainer({ ...container, shell: e.target.value || null })} />
                </Field>
              </div>
              <Field label="Preferred command runner (reference)" hint="e.g. `uv run`, `make`, `just` — shown for reference">
                <Input mono value={container.commandRunner ?? ''} onChange={(e) => setContainer({ ...container, commandRunner: e.target.value || null })} />
              </Field>
              {cs && (
                <div className="rounded-lg bg-panel-2 px-3 py-2 text-[12px] text-fg-2">
                  {cs.found ? (
                    <>
                      Detected <b>{cs.name}</b> · {cs.status} · <span className="font-mono">{cs.image?.slice(0, 48)}</span> · checked {relTime(cs.checkedAt)}
                    </>
                  ) : (
                    <>No matching container found{cs.error ? ` (${cs.error})` : ''} · checked {relTime(cs.checkedAt)}</>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {error && (
        <Callout tone="danger" className="mt-3">
          {error}
        </Callout>
      )}
    </Modal>
  )
}

export function RuntimeDialog({ state, runtimeId, onClose }: { state: DeckState; runtimeId: string; onClose: () => void }) {
  const runtime = state.runtimes.find((r) => r.id === runtimeId)
  const project = runtime ? state.projects.find((p) => p.id === runtime.projectId) : null
  const host = project ? state.hosts.find((h) => h.id === project.hostId) : null
  const [accountId, setAccountId] = useState(runtime?.accountId ?? '')
  const [task, setTask] = useState(runtime?.taskSummary ?? '')
  const [rcName, setRcName] = useState(runtime?.remoteControlName ?? '')
  const [spawn, setSpawn] = useState<SpawnMode | ''>(runtime?.spawnMode ?? '')
  const [perm, setPerm] = useState<PermissionMode | ''>(runtime?.permissionMode ?? '')
  const [bypassAck, setBypassAck] = useState(runtime?.permissionMode === 'bypassPermissions')
  const [capacity, setCapacity] = useState(runtime?.capacity ? String(runtime.capacity) : '')
  const [envUrl, setEnvUrl] = useState(runtime?.environmentId ? environmentUrl(runtime.environmentId) : '')
  const [tmuxName, setTmuxName] = useState(runtime?.tmuxSessionName ?? '')
  const [projectId, setProjectId] = useState(runtime?.projectId ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!runtime || !project) return null
  const caps = host?.capabilities
  const observed = runtime.observedConfigDir
  const observedDir = observed && observed.state !== 'unknown' ? (observed.state === 'default' ? null : observed.value) : undefined
  const evidenceAccount = observedDir !== undefined ? state.accounts.find((a) => sameConfigDir(a.configDir, observedDir, host?.homePath)) : null
  const chosen = state.accounts.find((a) => a.id === accountId) ?? null
  const conflict = Boolean(chosen && observedDir !== undefined && !sameConfigDir(chosen.configDir, observedDir, host?.homePath))
  const permModes = (caps?.permissionModes.length ? caps.permissionModes.filter((m) => m in PERMISSION_MODE_META) : Object.keys(PERMISSION_MODE_META)) as PermissionMode[]
  const spawnModes = (caps?.spawnModes.length ? caps.spawnModes : Object.keys(SPAWN_MODE_META)) as SpawnMode[]

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await call('runtime.update', {
        id: runtime.id,
        patch: {
          accountId: accountId || null,
          taskSummary: task || null,
          remoteControlName: rcName || null,
          spawnMode: spawn || null,
          permissionMode: perm || null,
          bypassAcknowledged: perm === 'bypassPermissions' ? bypassAck : undefined,
          capacity: capacity ? Number(capacity) : null,
          environmentUrl: envUrl.trim() ? envUrl.trim() : runtime.environmentId ? null : undefined,
          tmuxSessionName: tmuxName !== runtime.tmuxSessionName ? tmuxName : undefined,
          projectId: projectId !== runtime.projectId ? projectId : undefined,
        },
      })
      ui().toast('success', 'Session saved')
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={640}
      icon={<SlidersHorizontal className="size-4" />}
      title="Edit session"
      description={`${project.displayName} · tmux ${runtime.tmuxSessionName}${runtime.managed ? '' : ' (started outside Claude Deck)'}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={perm === 'bypassPermissions' && !bypassAck} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Claude account" hint="Changing the account never changes a running process — it applies the next time Claude Deck starts this session.">
          <Select data-autofocus value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">— Unconfirmed —</option>
            {state.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName} · {configDirLabel(a.configDir, host?.homePath)}
                {a.authEmail ? ` · ${a.authEmail}` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <div className="rounded-lg bg-panel-2 px-3 py-2 text-[12px] text-fg-2">
          {observedDir === undefined ? (
            <>The account used by the running process could not be read. Choose it manually — Claude Deck never guesses from session or folder names.</>
          ) : (
            <>
              The running process uses <span className="font-mono">{configDirLabel(observedDir, host?.homePath)}</span>
              {evidenceAccount ? (
                <>
                  {' '}
                  → <b>{evidenceAccount.displayName}</b>
                  {evidenceAccount.id !== accountId && (
                    <button className="ml-2 text-accent hover:underline" onClick={() => setAccountId(evidenceAccount.id)}>
                      Use this account
                    </button>
                  )}
                </>
              ) : (
                ' (no registered account uses this directory yet)'
              )}
              .
            </>
          )}
        </div>
        {conflict && (
          <Callout tone="danger" title="This choice contradicts the running process">
            The process was started with a different config directory, so Open Claude would open it in the wrong browser login. Keep this only if you are about to restart the session with the chosen account.
          </Callout>
        )}
        <Field label="What is this session doing?" hint="Optional, shown on the session row">
          <Input value={task} onChange={(e) => setTask(e.target.value)} placeholder="e.g. Payments API migration" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Spawn mode">
            <Select value={spawn} onChange={(e) => setSpawn(e.target.value as SpawnMode | '')}>
              <option value="">Claude default</option>
              {spawnModes.map((m) => (
                <option key={m} value={m}>
                  {SPAWN_MODE_META[m]?.label ?? m}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Permission mode">
            <Select
              value={perm}
              onChange={(e) => {
                setPerm(e.target.value as PermissionMode | '')
                if (e.target.value !== 'bypassPermissions') setBypassAck(false)
              }}
            >
              <option value="">Claude default</option>
              {permModes.map((m) => (
                <option key={m} value={m}>
                  {PERMISSION_MODE_META[m].label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {perm === 'bypassPermissions' && runtime.permissionMode !== 'bypassPermissions' && (
          <label className="flex items-start gap-2.5 rounded-xl border border-danger/35 bg-danger-soft px-3 py-2.5 text-[12.5px]">
            <ShieldAlert className="mt-px size-4 shrink-0 text-danger" />
            <span className="flex-1">
              Bypass permissions lets Claude run commands and edit files without approval prompts.
              <span className="mt-1.5 flex items-center gap-2 font-medium">
                <Checkbox checked={bypassAck} onChange={setBypassAck} /> I understand and want to enable it for this session
              </span>
            </span>
          </label>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name on claude.ai">
            <Input value={rcName} onChange={(e) => setRcName(e.target.value)} />
          </Field>
          <Field label="Max concurrent conversations" hint="Blank = Claude default (32)">
            <Input type="number" min={1} max={256} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
          </Field>
        </div>
        <Field label="Environment link" hint="Captured automatically; paste https://claude.ai/code?environment=env_… to set it manually.">
          <Input mono value={envUrl} onChange={(e) => setEnvUrl(e.target.value)} placeholder="https://claude.ai/code?environment=env_…" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="tmux session name" hint={runtime.tmuxSessionId ? 'End the session to rename it' : 'Used the next time it starts'}>
            <Input mono disabled={Boolean(runtime.tmuxSessionId)} value={tmuxName} onChange={(e) => setTmuxName(e.target.value)} />
          </Field>
          <Field label="Project">
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {state.projects
                .filter((p) => !p.archived && p.hostId === project.hostId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge>{runtime.managed ? 'tmux created by Claude Deck' : 'imported tmux session'}</Badge>
          {runtime.accountEvidence && <Badge>account from {runtime.accountEvidence === 'process-env' ? 'process environment' : runtime.accountEvidence}</Badge>}
        </div>
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    </Modal>
  )
}
