import type { DeckState } from '@shared/types'
import { parseClaudeUrl } from '@shared/urls'
import { ClipboardPaste, Globe, Link2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button, Callout, Checkbox, Field, Input, Modal, Select } from '../components/ui'
import { call, errorMessage } from '../lib/api'
import { ui } from '../lib/store'

export function LinkDialog({ state, projectId: initialProject, runtimeId: initialRuntime, url: initialUrl, title: initialTitle, onClose }: { state: DeckState; projectId?: string; runtimeId?: string | null; url?: string; title?: string; onClose: () => void }) {
  const projects = state.projects.filter((p) => !p.archived)
  const fromRuntime = initialRuntime ? state.runtimes.find((r) => r.id === initialRuntime) : null
  const [projectId, setProjectId] = useState(initialProject ?? fromRuntime?.projectId ?? projects[0]?.id ?? '')
  const runtimes = state.runtimes.filter((r) => r.projectId === projectId && !r.archived)
  const [runtimeId, setRuntimeId] = useState<string>(initialRuntime ?? (runtimes.length === 1 ? runtimes[0].id : ''))
  const [url, setUrl] = useState(initialUrl ?? '')
  const [title, setTitle] = useState(initialTitle ?? '')
  const [makeDefault, setMakeDefault] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const parsed = useMemo(() => parseClaudeUrl(url), [url])
  const accountName = (rid: string) => state.accounts.find((a) => a.id === state.runtimes.find((r) => r.id === rid)?.accountId)?.displayName ?? 'account?'

  const paste = async () => {
    try {
      const res = await call('clipboard.readUrl', undefined)
      if (res.url) setUrl(res.url)
      else ui().toast('warn', 'The clipboard does not contain a claude.ai/code link')
    } catch (err) {
      ui().toast('error', errorMessage(err))
    }
  }
  const grab = async () => {
    const res = await call('chrome.activeTabUrl', undefined).catch((e) => ({ url: null, error: errorMessage(e) }))
    if (res.url && parseClaudeUrl(res.url)) setUrl(res.url)
    else ui().toast('warn', res.error ?? 'The front Chrome tab is not a claude.ai/code conversation')
  }

  const save = async () => {
    if (!parsed) return
    setBusy(true)
    setError(null)
    try {
      if (parsed.kind === 'environment') {
        if (!runtimeId) throw new Error('Choose the session this environment belongs to')
        await call('runtime.update', { id: runtimeId, patch: { environmentUrl: parsed.url } })
        ui().toast('success', 'Environment link saved')
      } else {
        await call('conversation.link', { url: parsed.url, projectId, runtimeId: runtimeId || null, title: title || null, pinned: makeDefault && Boolean(runtimeId), source: 'user' })
        ui().toast('success', 'Conversation linked')
      }
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
      icon={<Link2 className="size-4" />}
      title="Link a conversation"
      description="Save the exact claude.ai/code/session_… URL so Open Claude lands in that conversation."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!parsed || parsed.kind === 'home' || !projectId} loading={busy} onClick={() => void save()}>
            {parsed?.kind === 'environment' ? 'Save environment link' : 'Link conversation'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Claude URL"
          error={url && !parsed ? 'Not a claude.ai/code link' : parsed?.kind === 'home' ? 'This is the claude.ai/code home page — open the conversation and copy its URL' : null}
          hint={parsed?.kind === 'session' ? `Conversation ${parsed.sessionId}` : parsed?.kind === 'environment' ? `Remote Control environment ${parsed.environmentId} (not a single conversation)` : 'Paste from Chrome’s address bar'}
        >
          <div className="flex gap-2">
            <Input data-autofocus mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://claude.ai/code/session_…" />
            <Button icon={<ClipboardPaste className="size-3.5" />} onClick={() => void paste()}>
              Paste
            </Button>
            <Button icon={<Globe className="size-3.5" />} onClick={() => void grab()} title="Read the URL of the front Chrome tab (macOS asks for permission once)">
              From Chrome
            </Button>
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Project">
            <Select
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value)
                const rts = state.runtimes.filter((r) => r.projectId === e.target.value && !r.archived)
                setRuntimeId(rts.length === 1 ? rts[0].id : '')
              }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Session (Remote Control server)" hint="Determines which account & Chrome profile open it">
            <Select value={runtimeId} onChange={(e) => setRuntimeId(e.target.value)}>
              <option value="">— Not attached —</option>
              {runtimes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.remoteControlName ?? r.tmuxSessionName} · {accountName(r.id)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {parsed?.kind !== 'environment' && (
          <>
            <Field label="Title (optional)">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Database schema review" />
            </Field>
            <label className="flex items-center gap-2 text-[12.5px]">
              <Checkbox checked={makeDefault} onChange={setMakeDefault} disabled={!runtimeId} /> Make this the default conversation for Open Claude
            </label>
          </>
        )}
        {!runtimeId && parsed?.kind === 'session' && (
          <Callout tone="warn">Without a session, Claude Deck cannot tell which account (and Chrome profile) this conversation belongs to.</Callout>
        )}
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    </Modal>
  )
}
