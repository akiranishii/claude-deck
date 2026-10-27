import type { EndResult, LaunchPreview, StopResult } from '@shared/ipc'
import type { DeckState } from '@shared/types'
import { Play, Power, RotateCw, Square, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AccountAvatar, ProfileTag } from '../components/Status'
import { Button, Callout, Checkbox, Input, Modal, Spinner } from '../components/ui'
import { call, errorMessage } from '../lib/api'
import { buildVMs } from '../lib/selectors'
import { ui } from '../lib/store'

function useRuntime(state: DeckState, runtimeId: string) {
  return buildVMs(state).byRuntime.get(runtimeId) ?? null
}

export function StartDialog({ state, runtimeId, restart, onClose }: { state: DeckState; runtimeId: string; restart: boolean; onClose: () => void }) {
  const vm = useRuntime(state, runtimeId)
  const [preview, setPreview] = useState<LaunchPreview | null>(null)
  const [resume, setResume] = useState<boolean | null>(null)
  const [ack, setAck] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    call('runtime.launchPreview', { id: runtimeId, resume: resume ?? undefined, restart })
      .then((p) => {
        if (!alive) return
        setPreview(p)
        if (resume === null) setResume(p.resumeRecommended)
      })
      .catch((e) => alive && setError(errorMessage(e)))
    return () => {
      alive = false
    }
  }, [runtimeId, resume, restart])

  if (!vm) return null
  const r = vm.runtime
  const typing = preview?.mode === 'type-in-shell'
  const blocked = !preview || preview.errors.length > 0 || (typing && !ack)

  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      const args = { id: runtimeId, resume: Boolean(resume), acknowledgeImportedShell: typing ? ack : undefined }
      const res = restart ? await call('runtime.restart', args) : await call('runtime.start', args)
      ui().toast('info', `${restart ? 'Restarting' : 'Starting'} ${r.remoteControlName ?? r.tmuxSessionName}…`)
      void res
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
      width={600}
      icon={restart ? <RotateCw className="size-4" /> : <Play className="size-4" />}
      title={restart ? 'Restart Claude Remote Control' : 'Start Claude Remote Control'}
      description={`${vm.project.displayName} · tmux ${r.tmuxSessionName}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button data-autofocus variant="primary" disabled={blocked} loading={busy} icon={restart ? <RotateCw className="size-4" /> : <Play className="size-4" />} onClick={() => void go()}>
            {restart ? 'Restart' : 'Start'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5">
          <AccountAvatar account={vm.account} size={30} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold">{vm.account?.displayName ?? 'No account assigned'}</div>
            <div className="truncate font-mono text-[11.5px] text-fg-3">CLAUDE_CONFIG_DIR: {preview?.configDirLabel ?? '…'}</div>
          </div>
          <ProfileTag issue={vm.profileIssue} profile={vm.profile} dir={vm.account?.chromeProfileDir} />
        </div>
        {preview?.note && <div className="text-[12.5px] text-fg-2">{preview.note}</div>}
        <div>
          <div className="mb-1 text-[11px] font-semibold tracking-wide text-fg-3 uppercase">Command (runs on {vm.host?.displayName} in {vm.project.remotePath})</div>
          <div className="terminal-text rounded-lg bg-[#0f1218] px-3 py-2 text-[#d6dde7] select-text">{preview ? preview.command || '—' : <Spinner />}</div>
        </div>
        {preview?.resumeSupported && (
          <label className="flex items-start gap-2.5 text-[12.5px]">
            <Checkbox checked={Boolean(resume)} onChange={(v) => setResume(v)} />
            <span>
              <b>Reattach to the previous conversation</b> (<span className="font-mono">--continue</span>)
              <div className="text-fg-3">{preview.resumeNote}</div>
            </span>
          </label>
        )}
        {typing && preview && preview.errors.length === 0 && (
          <label className="flex items-start gap-2.5 rounded-xl border border-warn/40 bg-warn-soft px-3 py-2.5 text-[12.5px]">
            <Checkbox checked={ack} onChange={setAck} />
            <span>Type this command at the idle shell prompt of tmux session “{r.tmuxSessionName}” (a session you started outside Claude Deck).</span>
          </label>
        )}
        {vm.bypass && (
          <Callout tone="warn" title="Bypass permissions is enabled for this session">
            Claude will run commands without approval prompts. Change it in Edit session if that is no longer wanted.
          </Callout>
        )}
        {preview?.warnings.map((w, i) => (
          <Callout key={i} tone="warn">
            {w}
          </Callout>
        ))}
        {preview?.errors.map((e, i) => (
          <Callout key={i} tone="danger">
            {e}
          </Callout>
        ))}
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    </Modal>
  )
}

export function StopDialog({ state, runtimeId, onClose }: { state: DeckState; runtimeId: string; onClose: () => void }) {
  const vm = useRuntime(state, runtimeId)
  const [phase, setPhase] = useState<'confirm' | 'stopping' | 'timeout' | 'done'>('confirm')
  const [result, setResult] = useState<StopResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [forceAck, setForceAck] = useState(false)
  const [forceLevel, setForceLevel] = useState<'terminate' | 'kill'>('terminate')
  if (!vm) return null
  const r = vm.runtime
  const timeout = state.settings.stopTimeoutSec

  const stop = async (mode: 'interrupt' | 'terminate' | 'kill') => {
    setPhase('stopping')
    setError(null)
    try {
      const res = await call('runtime.stop', { id: runtimeId, mode })
      setResult(res)
      if (res.state === 'still_running') {
        setPhase('timeout')
        setForceAck(false)
        if (mode !== 'interrupt') setForceLevel('kill')
      } else {
        setPhase('done')
        ui().toast('success', res.state === 'stopped' ? `Stopped Claude in ${r.tmuxSessionName}. Files and conversation links are kept.` : res.detail ?? 'Not running')
        onClose()
      }
    } catch (err) {
      setError(errorMessage(err))
      setPhase('confirm')
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={540}
      icon={<Square className="size-4" />}
      title={phase === 'timeout' ? 'Remote Control is still running' : 'Stop Claude Remote Control?'}
      description={`${vm.project.displayName} · ${vm.account?.displayName ?? 'account?'} · tmux ${r.tmuxSessionName}`}
      footer={
        phase === 'timeout' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Leave it running
            </Button>
            <Button variant="danger" disabled={!forceAck} onClick={() => void stop(forceLevel)}>
              {forceLevel === 'kill' ? 'Kill (SIGKILL)' : 'Force stop (SIGTERM)'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={phase === 'stopping'}>
              Cancel
            </Button>
            <Button data-autofocus variant="primary" loading={phase === 'stopping'} icon={<Square className="size-3.5" />} onClick={() => void stop('interrupt')}>
              Stop (Ctrl+C)
            </Button>
          </>
        )
      }
    >
      {phase === 'timeout' ? (
        <div className="space-y-3 text-[12.5px] text-fg-2">
          <p>
            {forceLevel === 'kill'
              ? 'Claude is still running after SIGTERM. As a last resort it can be killed with SIGKILL.'
              : `Claude did not exit within ${timeout}s after Ctrl+C. You can leave it running, or force-terminate the verified Remote Control process.`}
          </p>
          <label className="flex items-start gap-2.5 rounded-xl border border-danger/35 bg-danger-soft px-3 py-2.5">
            <Checkbox checked={forceAck} onChange={setForceAck} />
            <span>Force-terminate pid {r.serverPid ?? '?'} and its conversation processes. Unsaved work in active conversations may be lost; project files are not touched.</span>
          </label>
        </div>
      ) : (
        <div className="space-y-3 text-[12.5px] leading-relaxed text-fg-2">
          <p>
            Claude Deck sends <b>Ctrl+C</b> to the Remote Control process in tmux pane <span className="font-mono">{r.tmuxPaneId ?? '?'}</span> and waits up to {timeout}s for it to exit.
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>{vm.liveConversations ? `${vm.liveConversations} running conversation(s) will disconnect.` : 'No conversation is running right now.'}</li>
            <li>The tmux session stays open; project files, git worktrees and conversation links are kept.</li>
            <li>Restart later with the same folder, account and options.</li>
          </ul>
          {phase === 'stopping' && (
            <div className="flex items-center gap-2 text-fg">
              <Spinner /> Waiting for Claude to exit…
            </div>
          )}
          {error && <Callout tone="danger">{error}</Callout>}
        </div>
      )}
    </Modal>
  )
}

export function EndDialog({ state, runtimeId, onClose }: { state: DeckState; runtimeId: string; onClose: () => void }) {
  const vm = useRuntime(state, runtimeId)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyPanes, setBusyPanes] = useState<EndResult['busy'] | null>(null)
  if (!vm) return null
  const r = vm.runtime
  const external = !r.managed
  const typedOk = !external || typed.trim() === r.tmuxSessionName

  const end = async (force = false) => {
    setBusy(true)
    setError(null)
    try {
      const res = await call('runtime.end', { id: runtimeId, force, allowUnmanaged: external })
      if (res.state === 'busy') setBusyPanes(res.busy ?? [])
      else {
        ui().toast('success', res.state === 'ended' ? `Ended tmux session ${r.tmuxSessionName}` : 'The tmux session was already gone')
        onClose()
      }
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
      width={560}
      icon={<Power className="size-4" />}
      title={`End tmux session “${r.tmuxSessionName}”?`}
      description={`${vm.project.displayName} · ${vm.account?.displayName ?? 'account?'}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {busyPanes ? (
            <Button variant="danger" loading={busy} onClick={() => void end(true)}>
              End anyway
            </Button>
          ) : (
            <Button variant="danger" disabled={!typedOk} loading={busy} onClick={() => void end(false)}>
              End session
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3 text-[12.5px] leading-relaxed text-fg-2">
        <p>Claude is stopped first (Ctrl+C, if running), then this one tmux session is closed. Other tmux sessions are never touched.</p>
        <p>Project files, repositories, git worktrees, notes and conversation links are kept. The session stays on the dashboard so you can start it again.</p>
        {external && (
          <div className="space-y-2 rounded-xl border border-danger/35 bg-danger-soft px-3 py-2.5 text-fg">
            <div className="flex items-start gap-2">
              <TriangleAlert className="mt-px size-4 shrink-0 text-danger" />
              <span>This tmux session was started outside Claude Deck. Ending it closes every window and process in it, not just Claude.</span>
            </div>
            <Input mono value={typed} placeholder={`Type ${r.tmuxSessionName} to confirm`} onChange={(e) => setTyped(e.target.value)} />
          </div>
        )}
        {busyPanes && (
          <Callout tone="warn" title="Other programs are still running in this session">
            {busyPanes.map((b) => `${b.paneId}: ${b.what}`).join(', ')}. End anyway to close them too.
          </Callout>
        )}
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    </Modal>
  )
}
