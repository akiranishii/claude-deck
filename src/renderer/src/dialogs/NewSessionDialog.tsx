import type { PathCheck, ProgressEvent } from '@shared/ipc'
import type { Account, DeckState, PermissionMode, SpawnMode } from '@shared/types'
import { PERMISSION_MODE_META, SPAWN_MODE_META, STATUS_META } from '@shared/constants'
import { basename, configDirLabel, defaultRemoteControlName, joinRemote, normalizeRemotePath, validateFolderName, validateRemotePathInput } from '@shared/naming'
import { ArrowUpRight, Check, CircleAlert, FolderOpen, FolderPlus, KeyRound, Layers, LoaderCircle, Rocket, ShieldAlert, SquareTerminal, TriangleAlert, Users } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AccountAvatar } from '../components/Status'
import { Badge, Button, Callout, Checkbox, cx, Field, Input, Modal, NeedTag, Segmented, Select } from '../components/ui'
import { call, errorMessage } from '../lib/api'
import { openClaude, openTerminal } from '../lib/actions'
import { buildVMs } from '../lib/selectors'
import { ui, useUi } from '../lib/store'
import { FolderBrowser } from './FolderBrowser'

type Mode = 'new-folder' | 'existing-folder' | 'existing-project'

const NO_PROGRESS: ProgressEvent[] = []

function AccountOption({ account, selected, onSelect, home, profileName }: { account: Account; selected: boolean; onSelect: () => void; home?: string | null; profileName?: string | null }) {
  const signedOut = account.authState === 'logged_out' || account.authState === 'missing_dir'
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cx(
        'flex items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors',
        selected ? 'border-accent bg-accent-soft/70 ring-1 ring-accent/30' : 'border-line hover:border-line-strong hover:bg-panel-2/60',
      )}
    >
      <AccountAvatar account={account} size={26} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold">{account.displayName}</span>
          {signedOut && <KeyRound className="size-3 text-danger" />}
        </div>
        <div className="truncate font-mono text-[10.5px] text-fg-3">{configDirLabel(account.configDir, home)}</div>
        <div className="truncate text-[11px] text-fg-3">
          {account.authState === 'authenticated' ? account.authEmail ?? 'signed in' : signedOut ? 'not signed in' : 'sign-in not checked'}
          {profileName ? ` · ${profileName}` : account.chromeProfileDir ? '' : ' · no Chrome profile'}
        </div>
      </div>
      {selected && <Check className="size-4 shrink-0 text-accent" />}
    </button>
  )
}

function ProgressList({ events }: { events: ProgressEvent[] }) {
  return (
    <ol className="space-y-1.5">
      {events.map((e) => (
        <li key={e.step} className="flex items-start gap-2.5 rounded-lg px-1 py-1">
          <span className="mt-[1px] flex size-5 shrink-0 items-center justify-center">
            {e.state === 'running' ? (
              <LoaderCircle className="size-4 animate-spin-slow text-accent" />
            ) : e.state === 'done' ? (
              <span className="flex size-4 items-center justify-center rounded-full bg-ok text-white">
                <Check className="size-3" strokeWidth={3} />
              </span>
            ) : e.state === 'error' ? (
              <CircleAlert className="size-4 text-danger" />
            ) : e.state === 'warn' ? (
              <TriangleAlert className="size-4 text-warn" />
            ) : (
              <span className="size-2 rounded-full bg-line-strong" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className={cx('text-[13px] font-medium', e.state === 'error' && 'text-danger')}>{e.label}</div>
            {e.detail && <div className="mt-0.5 font-mono text-[11.5px] break-all text-fg-3 select-text">{e.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  )
}

export function NewSessionDialog({ state, projectId, hostId: initialHost, onClose }: { state: DeckState; projectId?: string; hostId?: string; onClose: () => void }) {
  const hosts = state.hosts
  const [hostId, setHostId] = useState(initialHost ?? hosts[0]?.id ?? '')
  const host = hosts.find((h) => h.id === hostId) ?? null
  const presetProject = projectId ? state.projects.find((p) => p.id === projectId) ?? null : null
  const [mode, setMode] = useState<Mode>(presetProject ? 'existing-project' : 'new-folder')
  const [parent, setParent] = useState(host?.defaultParentDir ?? '~/projects')
  const [folderName, setFolderName] = useState('')
  const [existingPath, setExistingPath] = useState('')
  const [pickedProjectId, setPickedProjectId] = useState(presetProject?.id ?? state.projects.find((p) => !p.archived)?.id ?? '')
  const [projectName, setProjectName] = useState('')
  const [task, setTask] = useState('')
  const [tags, setTags] = useState('')
  const accounts = state.accounts.filter((a) => !a.archived)
  const [accountId, setAccountId] = useState(() => accounts.find((a) => a.authState === 'authenticated')?.id ?? accounts[0]?.id ?? '')
  const caps = host?.capabilities ?? null
  const spawnModes = (caps?.spawnModes.length ? caps.spawnModes : ['same-dir', 'worktree', 'session']) as SpawnMode[]
  const permModes = (caps?.permissionModes.length ? caps.permissionModes.filter((m) => m in PERMISSION_MODE_META) : Object.keys(PERMISSION_MODE_META)) as PermissionMode[]
  const [spawn, setSpawn] = useState<SpawnMode>('same-dir')
  const [perm, setPerm] = useState<PermissionMode>('default')
  const [bypassAck, setBypassAck] = useState(false)
  const [rcName, setRcName] = useState('')
  const [attachMode, setAttachMode] = useState<'attach' | 'separate'>('attach')
  const [browsing, setBrowsing] = useState(false)
  const [check, setCheck] = useState<PathCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [opId, setOpId] = useState<string | null>(null)
  const [result, setResult] = useState<{ runtimeId: string; projectId: string; status: string; detail: string | null } | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const progress = useUi((s) => (opId ? s.progress[opId] ?? NO_PROGRESS : NO_PROGRESS))

  const project = mode === 'existing-project' ? state.projects.find((p) => p.id === pickedProjectId) ?? null : null
  const account = accounts.find((a) => a.id === accountId) ?? null
  const targetPath =
    mode === 'new-folder' ? (folderName.trim() ? joinRemote(normalizeRemotePath(parent), folderName.trim()) : '') : mode === 'existing-folder' ? normalizeRemotePath(existingPath) : project?.remotePath ?? ''

  // Optional names: left blank, they are generated (shown as the placeholder).
  const autoProjectName = mode === 'existing-project' ? project?.displayName ?? '' : targetPath ? basename(targetPath) : ''
  const effectiveProjectName = projectName.trim() || autoProjectName
  const autoRcName = effectiveProjectName && account ? defaultRemoteControlName(effectiveProjectName, account.displayName) : ''
  const effectiveRcName = rcName.trim() || autoRcName

  // Live path check (debounced)
  const seq = useRef(0)
  useEffect(() => {
    setCheck(null)
    setCheckError(null)
    if (!hostId || !targetPath || mode === 'existing-project') return
    const err = mode === 'new-folder' ? validateFolderName(folderName) ?? validateRemotePathInput(parent) : validateRemotePathInput(existingPath)
    if (err) {
      setCheckError(err)
      return
    }
    const id = ++seq.current
    setChecking(true)
    const t = setTimeout(() => {
      call('remote.checkPath', { hostId, path: targetPath })
        .then((r) => id === seq.current && setCheck(r))
        .catch((e) => id === seq.current && setCheckError(errorMessage(e)))
        .finally(() => id === seq.current && setChecking(false))
    }, 450)
    return () => clearTimeout(t)
  }, [hostId, targetPath, mode, folderName, parent, existingPath])

  const vms = useMemo(() => buildVMs(state), [state])
  const resolvedPath = check?.path ?? targetPath
  const existingProjectsHere = mode === 'existing-project' ? [] : state.projects.filter((p) => !p.archived && p.hostId === hostId && (p.remotePath === resolvedPath || p.remotePath === targetPath))
  const runningHere = vms.runtimes.filter((r) => r.running && r.project.hostId === hostId && (r.project.remotePath === resolvedPath || r.project.remotePath === targetPath))
  const isGit = Boolean(check?.git?.isRepo ?? project?.git?.isRepo)
  // Claude allows one Remote Control server per account per folder ("This folder is already served by a terminal
  // `claude remote-control` on this device"). Different accounts may share a folder.
  const sameAccountServer = account ? runningHere.find((r) => r.account?.id === account.id) ?? null : null

  const pathProblem: string | null =
    mode === 'new-folder'
      ? checkError ?? (check?.exists ? 'This folder already exists — Claude Deck never overwrites folders.' : check && !check.parentExists && !check.insideHome ? 'The parent folder does not exist.' : null)
      : mode === 'existing-folder'
        ? checkError ?? (check && !check.isDir ? 'Folder not found on the VM.' : null)
        : !project
          ? 'Choose a project'
          : null

  const spawnBlocked = spawn === 'worktree' && check !== null && !isGit
  const missing = !targetPath
    ? mode === 'new-folder'
      ? 'Enter a name for the new folder'
      : mode === 'existing-folder'
        ? 'Enter or browse to a folder on the VM'
        : 'Choose a project'
    : !account
      ? 'Choose a Claude account'
      : pathProblem
        ? pathProblem
        : mode !== 'existing-project' && !check
          ? 'Checking the folder…'
          : sameAccountServer
            ? `${account?.displayName} already runs Remote Control in this folder`
          : perm === 'bypassPermissions' && !bypassAck
            ? 'Confirm bypass permissions below'
            : spawn === 'worktree' && check !== null && !isGit
              ? 'Worktree mode needs a git repository'
              : null
  const canSubmit =
    Boolean(host && account && targetPath && effectiveProjectName) &&
    !pathProblem &&
    !(mode !== 'existing-project' && !check) &&
    !(perm === 'bypassPermissions' && !bypassAck) &&
    !sameAccountServer &&
    !spawnBlocked &&
    !submitting

  const submit = async (launch: boolean) => {
    if (!host || !account) return
    const id = `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
    setOpId(id)
    setSubmitting(true)
    setSubmitError(null)
    try {
      const res = await call('session.create', {
        opId: id,
        hostId: host.id,
        location: mode === 'new-folder' ? { kind: 'new-folder', parent: normalizeRemotePath(parent), name: folderName.trim() } : mode === 'existing-folder' ? { kind: 'existing-folder', path: targetPath } : { kind: 'existing-project', projectId: pickedProjectId },
        attachToProjectId: mode !== 'existing-project' && existingProjectsHere.length && attachMode === 'attach' ? existingProjectsHere[0].id : null,
        projectName: effectiveProjectName,
        taskSummary: task.trim() || null,
        tags: tags.split(/[,\s]+/).map((t) => t.replace(/^#/, '')).filter(Boolean),
        accountId: account.id,
        spawnMode: spawn,
        permissionMode: perm,
        bypassAcknowledged: perm === 'bypassPermissions' && bypassAck,
        remoteControlName: effectiveRcName || null,
        launch,
      })
      setResult(res)
    } catch (err) {
      setSubmitError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  const close = () => {
    if (opId) ui().clearProgress(opId)
    onClose()
  }

  if (!host) {
    return (
      <Modal open onClose={close} title="New session">
        <Callout tone="warn" title="No VM connected">
          Connect your VM in Settings first.
        </Callout>
      </Modal>
    )
  }

  // ---------------------------------------------------------------- progress/result
  if (opId) {
    const status = result?.status as keyof typeof STATUS_META | undefined
    const meta = status ? STATUS_META[status] : null
    return (
      <Modal
        open
        onClose={close}
        width={620}
        icon={<Rocket className="size-4" />}
        title={result ? (status === 'connected' ? 'Remote Control is connected' : status === 'needs_input' ? 'Claude needs your input' : meta?.label ?? 'Done') : 'Creating & launching…'}
        description={`${effectiveProjectName} · ${account?.displayName} · ${host.displayName}`}
        footer={
          result ? (
            <>
              {status === 'needs_input' && (
                <Button variant="primary" icon={<SquareTerminal className="size-4" />} onClick={() => void openTerminal(result.runtimeId)}>
                  Open terminal to answer
                </Button>
              )}
              {status === 'auth_required' && (
                <Button variant="primary" icon={<KeyRound className="size-4" />} onClick={() => ui().openDialog({ kind: 'login', accountId: account!.id, hostId: host.id })}>
                  Sign in {account?.displayName}
                </Button>
              )}
              <Button variant="ghost" icon={<SquareTerminal className="size-4" />} onClick={() => void openTerminal(result.runtimeId)} disabled={status === 'auth_required'}>
                Terminal
              </Button>
              <Button variant={status === 'connected' ? 'primary' : 'secondary'} icon={<ArrowUpRight className="size-4" />} disabled={status === 'auth_required' || status === 'failed'} onClick={() => void openClaude({ runtimeId: result.runtimeId })}>
                Open Claude
              </Button>
              <Button onClick={close}>Done</Button>
            </>
          ) : submitError ? (
            <>
              <Button variant="ghost" onClick={() => setOpId(null)}>
                Back to form
              </Button>
              <Button onClick={close}>Close</Button>
            </>
          ) : (
            <span className="text-[12px] text-fg-3">You can close this window — the session keeps starting on the VM.</span>
          )
        }
      >
        <ProgressList events={progress} />
        {submitError && (
          <Callout tone="danger" title="Could not complete" className="mt-3">
            {submitError}
          </Callout>
        )}
        {result && status === 'connected' && (
          <Callout tone="ok" className="mt-3" title="Ready">
            The tmux session keeps running on the VM even when Claude Deck is closed. Open Claude opens it in {account?.displayName}’s Chrome profile.
          </Callout>
        )}
        {result && status === 'needs_input' && (
          <Callout tone="warn" className="mt-3" title="Claude is asking a question in the terminal">
            {result.detail} — for a new folder this is usually the one-time “trust this folder” prompt. Answer it in the terminal; the dashboard updates automatically.
          </Callout>
        )}
      </Modal>
    )
  }

  // --------------------------------------------------------------------------- form
  return (
    <Modal
      open
      onClose={close}
      width={760}
      icon={<FolderPlus className="size-4" />}
      title="New project / session"
      description={`Creates the tmux session and launches Claude Remote Control on ${host.displayName} with the account you pick.`}
      footer={
        <>
          <span className="mr-auto text-[12px] text-fg-3">
            {missing && !submitting ? (
              <span className="text-warn">{missing}</span>
            ) : account ? (
              <>
                Runs as <b className="text-fg-2">{account.displayName}</b> · <span className="font-mono">{configDirLabel(account.configDir, host.homePath)}</span>
              </>
            ) : (
              'Choose an account'
            )}
          </span>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit(false)}>
            Create only
          </Button>
          <Button variant="primary" disabled={!canSubmit} loading={submitting} icon={<Rocket className="size-4" />} onClick={() => void submit(true)}>
            Create & Launch
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <p className="-mt-1 text-[12px] text-fg-3">
          Only the <b className="text-fg-2">folder</b> and the <b className="text-fg-2">Claude account</b> are required. Fields marked Optional can be left blank:
          names are generated and settings use their defaults.
        </p>
        {hosts.length > 1 && (
          <Field label="VM">
            <Select value={hostId} onChange={(e) => setHostId(e.target.value)}>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.displayName} ({h.sshAlias})
                </option>
              ))}
            </Select>
          </Field>
        )}

        <section className="space-y-3">
          <Segmented
            size="md"
            value={mode}
            onChange={(m) => {
              setMode(m)
              setBrowsing(false)
            }}
            options={[
              { value: 'new-folder', label: <><FolderPlus className="size-3.5" /> New folder</> },
              { value: 'existing-folder', label: <><FolderOpen className="size-3.5" /> Existing folder</> },
              { value: 'existing-project', label: <><Layers className="size-3.5" /> Another session in a project</> },
            ]}
          />
          {mode === 'new-folder' && (
            <div className="grid grid-cols-[1fr_1fr] gap-3">
              <Field label="Parent folder" need="required" right={<button className="text-[11.5px] text-accent hover:underline" onClick={() => setBrowsing(!browsing)}>Browse…</button>}>
                <Input mono value={parent} onChange={(e) => setParent(e.target.value)} />
              </Field>
              <Field label="New folder name" need="required">
                <Input data-autofocus mono value={folderName} placeholder="new-research" onChange={(e) => setFolderName(e.target.value)} />
              </Field>
            </div>
          )}
          {mode === 'existing-folder' && (
            <Field label="Folder on the VM" need="required" right={<button className="text-[11.5px] text-accent hover:underline" onClick={() => setBrowsing(!browsing)}>Browse…</button>}>
              <Input data-autofocus mono value={existingPath} placeholder="~/myproj" onChange={(e) => setExistingPath(e.target.value)} />
            </Field>
          )}
          {mode === 'existing-project' && (
            <Field label="Project" need="required">
              <Select value={pickedProjectId} onChange={(e) => setPickedProjectId(e.target.value)}>
                {state.projects
                  .filter((p) => !p.archived && p.hostId === hostId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName} — {p.remotePath}
                    </option>
                  ))}
              </Select>
            </Field>
          )}
          {browsing && (
            <FolderBrowser
              hostId={hostId}
              initialPath={mode === 'new-folder' ? parent : existingPath || host.homePath || '~'}
              pickLabel={mode === 'new-folder' ? 'Use as parent' : 'Use this folder'}
              onCancel={() => setBrowsing(false)}
              onPick={(p) => {
                if (mode === 'new-folder') setParent(p)
                else setExistingPath(p)
                setBrowsing(false)
              }}
            />
          )}
          {targetPath && (
            <div className="flex items-center gap-2 rounded-lg bg-panel-2 px-3 py-2 text-[12px]">
              <span className="text-fg-3">{mode === 'new-folder' ? 'Will create' : 'Folder'}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-fg select-text">{resolvedPath}</span>
              {checking ? (
                <LoaderCircle className="size-3.5 animate-spin-slow text-fg-3" />
              ) : pathProblem ? (
                <span className="text-danger">{pathProblem}</span>
              ) : mode === 'new-folder' && check ? (
                <span className="text-ok">{check.parentExists ? 'Available' : 'Available · parent will be created'}</span>
              ) : check?.isDir ? (
                <span className="flex items-center gap-1.5 text-ok">
                  Exists{check.git?.isRepo ? ` · git${check.git.branch ? ` (${check.git.branch})` : ''}` : ''}
                </span>
              ) : null}
            </div>
          )}
          {mode === 'new-folder' && check?.exists && (
            <Button
              size="sm"
              onClick={() => {
                setExistingPath(resolvedPath)
                setMode('existing-folder')
              }}
            >
              Use the existing folder instead
            </Button>
          )}
          {existingProjectsHere.length > 0 && (
            <div className="rounded-lg border border-line px-3 py-2 text-[12.5px]">
              <div className="mb-1.5 text-fg-2">
                This folder already belongs to <b>{existingProjectsHere[0].displayName}</b>.
              </div>
              <Segmented
                value={attachMode}
                onChange={setAttachMode}
                options={[
                  { value: 'attach', label: `Add the session to ${existingProjectsHere[0].displayName}` },
                  { value: 'separate', label: 'Create a separate project' },
                ]}
              />
            </div>
          )}
        </section>

        {!(existingProjectsHere.length && attachMode === 'attach') && mode !== 'existing-project' && (
          <section className="grid grid-cols-2 gap-3">
            <Field label="Project name" need="optional" hint={autoProjectName ? `Blank uses “${autoProjectName}”` : 'Blank uses the folder name'}>
              <Input value={projectName} placeholder={autoProjectName || 'folder name'} onChange={(e) => setProjectName(e.target.value)} />
            </Field>
            <Field label="Tags" need="optional" hint="Comma separated">
              <Input value={tags} placeholder="research, data" onChange={(e) => setTags(e.target.value)} />
            </Field>
            <Field label="What is this session for?" need="optional" className="col-span-2" hint="Shown prominently on the dashboard so you remember what each session was doing.">
              <Input value={task} placeholder="e.g. Refactoring the billing service" onChange={(e) => setTask(e.target.value)} />
            </Field>
          </section>
        )}

        <section>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12px] font-medium text-fg-2">
              Claude account
              <NeedTag need="required" />
            </span>
            <button className="text-[11.5px] text-accent hover:underline" onClick={() => ui().openDialog({ kind: 'account' })}>
              + Add account
            </button>
          </div>
          {accounts.length ? (
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
              {accounts.map((a) => (
                <AccountOption
                  key={a.id}
                  account={a}
                  selected={a.id === accountId}
                  onSelect={() => setAccountId(a.id)}
                  home={host.homePath}
                  profileName={state.chromeProfiles.find((p) => p.directory === a.chromeProfileDir)?.name ?? null}
                />
              ))}
            </div>
          ) : (
            <Callout tone="warn" title="No accounts yet">
              Add a Claude account first.
            </Callout>
          )}
          {account && (account.authState === 'logged_out' || account.authState === 'missing_dir') && (
            <Callout
              tone="danger"
              className="mt-2"
              title={`${account.displayName} is not signed in on the VM`}
              action={
                <Button size="sm" variant="secondary" onClick={() => ui().openDialog({ kind: 'login', accountId: account.id, hostId: host.id })}>
                  Sign in…
                </Button>
              }
            >
              Remote Control needs a signed-in account. Claude Deck will check again before launching.
            </Callout>
          )}
        </section>

        <section className="grid grid-cols-2 gap-3">
          <Field label="Spawn mode" need="optional" hint={SPAWN_MODE_META[spawn]?.description}>
            <Select value={spawn} onChange={(e) => setSpawn(e.target.value as SpawnMode)}>
              {spawnModes.map((m) => (
                <option key={m} value={m} disabled={m === 'worktree' && check !== null && !isGit && mode !== 'existing-project'}>
                  {SPAWN_MODE_META[m]?.label ?? m}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Permission mode" need="optional" hint={PERMISSION_MODE_META[perm]?.description}>
            <Select
              value={perm}
              onChange={(e) => {
                setPerm(e.target.value as PermissionMode)
                setBypassAck(false)
              }}
            >
              {permModes.map((m) => (
                <option key={m} value={m}>
                  {PERMISSION_MODE_META[m].label}
                </option>
              ))}
            </Select>
          </Field>
          {spawnBlocked && (
            <Callout tone="warn" className="col-span-2">
              Worktree mode needs a git repository. This folder is not one.
            </Callout>
          )}
          {perm === 'bypassPermissions' && (
            <div className="col-span-2 rounded-xl border border-danger/35 bg-danger-soft px-3 py-2.5">
              <div className="flex items-start gap-2.5">
                <ShieldAlert className="mt-px size-4 shrink-0 text-danger" />
                <div className="text-[12.5px] leading-relaxed">
                  <b>Bypass permissions</b> lets Claude run shell commands, edit and delete files, and access the network on the VM <b>without asking for approval</b> — for every conversation started from this server, from any device. Use it only on machines and folders where that is acceptable, and never to get around policies set by your organization.
                  <label className="mt-2 flex items-center gap-2 font-medium">
                    <Checkbox checked={bypassAck} onChange={setBypassAck} />I understand and want to enable bypass permissions for this session
                  </label>
                </div>
              </div>
            </div>
          )}
          <Field
            label="Name on claude.ai"
            need="optional"
            hint={autoRcName ? `Shown in claude.ai/code. Blank uses “${autoRcName}”` : 'Shown in claude.ai/code. Blank uses “<project> · <account>”'}
            className="col-span-2"
          >
            <Input value={rcName} placeholder={autoRcName || 'project · account'} onChange={(e) => setRcName(e.target.value)} />
          </Field>
        </section>

        {sameAccountServer && (
          <Callout
            tone="warn"
            title={`${account?.displayName} already runs Remote Control in this folder (tmux “${sameAccountServer.runtime.tmuxSessionName}”)`}
            action={
              <Button size="sm" variant="primary" icon={<ArrowUpRight className="size-4" />} onClick={() => void openClaude({ runtimeId: sameAccountServer.runtime.id })}>
                Open that session
              </Button>
            }
          >
            Claude allows one Remote Control server per account per folder, so a second one would exit at startup. Open the existing
            one and start a new conversation there (one server handles many conversations), or pick a different account or folder.
          </Callout>
        )}
        {runningHere.length > 0 && !sameAccountServer && (
          <Callout tone="warn" title={`${runningHere.length} other session${runningHere.length > 1 ? 's are' : ' is'} already working in this folder`}>
            <span className="inline-flex items-center gap-1">
              <Users className="size-3.5" />
              {runningHere.map((r) => `${r.account?.displayName ?? '?'} (${r.runtime.tmuxSessionName})`).join(', ')}
            </span>
            . Simultaneous edits to the same files can conflict.{isGit ? ' Consider “Worktree per conversation” for parallel code changes.' : ''}
          </Callout>
        )}
        {account && !account.chromeProfileDir && (
          <Callout tone="info">
            {account.displayName} has no Chrome profile yet — you can still launch, but map a profile in Claude Accounts before using Open Claude.
          </Callout>
        )}
        {caps && !caps.rcSupported && (
          <Callout tone="danger" title="Remote Control not supported">
            Claude Code {caps.version} on this VM does not support <span className="font-mono">claude remote-control</span>.
          </Callout>
        )}
        <div className="flex items-center gap-2 text-[11.5px] text-fg-3">
          <Badge>{mode === 'new-folder' ? 'creates folder' : 'uses existing folder'}</Badge>
          <Badge>new tmux session</Badge>
          <Badge>CLAUDE_CONFIG_DIR for this process only</Badge>
          <Badge>no git init / clone</Badge>
        </div>
      </div>
    </Modal>
  )
}
