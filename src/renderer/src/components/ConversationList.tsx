import type { Conversation } from '@shared/types'
import { ArrowUpRight, Copy, Ellipsis, Link2, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { call, errorMessage } from '../lib/api'
import { copyText, openClaude, removeConversation, setDefaultConversation } from '../lib/actions'
import { modelLabel, relTime, shortSession } from '../lib/format'
import { ui, useUi } from '../lib/store'
import { Button, cx, IconButton, Input, Menu, Tip } from './ui'

const SOURCE_LABEL: Record<Conversation['source'], string> = {
  'claude-metadata': 'Detected from Claude’s local session records on the VM',
  'pane-output': 'Printed by Claude in the terminal',
  user: 'Linked manually',
  clipboard: 'Pasted from the clipboard',
  'chrome-tab': 'Captured from Chrome',
  extension: 'Captured by the Chrome extension',
}

export function conversationTitle(c: Conversation): string {
  return c.displayTitle ?? c.autoTitle ?? shortSession(c.remoteSessionId)
}

function ConversationRow({ conv, isDefault }: { conv: Conversation; isDefault: boolean }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(conv.displayTitle ?? conv.autoTitle ?? '')
  const busy = useUi((s) => s.busy[`open:${conv.id}`])

  const save = async () => {
    setEditing(false)
    try {
      await call('conversation.update', { id: conv.id, patch: { displayTitle: title.trim() || null } })
    } catch (err) {
      ui().toast('error', errorMessage(err))
    }
  }

  return (
    <div className="group flex h-9 items-center gap-2.5 rounded-lg px-2 hover:bg-panel-2">
      <Tip label={conv.live ? `Running now${conv.claudeStatus ? ` · ${conv.claudeStatus}` : ''}` : `Not running at the last check${conv.lastSeenAt ? ` · last seen ${relTime(conv.lastSeenAt)}` : ''}`}>
        <span className={cx('size-1.5 shrink-0 rounded-full', conv.live ? (conv.claudeStatus === 'busy' ? 'animate-dot bg-progress' : 'bg-ok') : 'bg-line-strong')} />
      </Tip>
      {editing ? (
        <Input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
            if (e.key === 'Escape') setEditing(false)
          }}
          className="h-7 max-w-[260px]"
        />
      ) : (
        <button type="button" onDoubleClick={() => setEditing(true)} className="min-w-0 flex-1 truncate text-left text-[12.5px] font-medium text-fg" title={conv.url}>
          {conversationTitle(conv)}
        </button>
      )}
      {isDefault && (
        <Tip label={conv.pinned ? 'Pinned: Open Claude always opens this conversation' : 'Open Claude currently uses this conversation (most recent)'}>
          <span className={cx('inline-flex items-center gap-0.5 rounded px-1 text-[10.5px] font-semibold uppercase', conv.pinned ? 'bg-accent-soft text-accent' : 'text-fg-3')}>
            {conv.pinned ? <Pin className="size-2.5" /> : null}
            default
          </span>
        </Tip>
      )}
      <span className="hidden shrink-0 font-mono text-[11px] text-fg-3 @2xl:inline">{shortSession(conv.remoteSessionId)}</span>
      {conv.model && <span className="hidden shrink-0 text-[11px] whitespace-nowrap text-fg-3 @lg:inline">{modelLabel(conv.model)}</span>}
      <Tip label={SOURCE_LABEL[conv.source]}>
        <Link2 className="hidden size-3 shrink-0 text-fg-3 @md:block" />
      </Tip>
      <span className="hidden shrink-0 text-[11px] whitespace-nowrap text-fg-3 tabular @md:inline">{conv.lastOpenedAt ? `opened ${relTime(conv.lastOpenedAt)}` : conv.lastSeenAt ? `seen ${relTime(conv.lastSeenAt)}` : ''}</span>
      <div className="flex shrink-0 items-center gap-0.5 opacity-70 group-hover:opacity-100">
        <Button size="xs" variant="ghost" loading={Boolean(busy)} icon={<ArrowUpRight className="size-3.5" />} onClick={() => void openClaude({ conversationId: conv.id })}>
          Open
        </Button>
        <IconButton size="xs" label="Copy link" onClick={() => void copyText(conv.url, 'conversation link')}>
          <Copy className="size-3.5" />
        </IconButton>
        <Menu
          trigger={
            <button className="inline-flex size-6 items-center justify-center rounded-md text-fg-3 hover:bg-panel-3 hover:text-fg" aria-label="Conversation actions">
              <Ellipsis className="size-3.5" />
            </button>
          }
          items={[
            conv.pinned
              ? { label: 'Unpin default', icon: <PinOff className="size-3.5" />, onSelect: () => void setDefaultConversation(conv, false) }
              : { label: 'Make default for Open Claude', icon: <Pin className="size-3.5" />, onSelect: () => void setDefaultConversation(conv, true) },
            { label: 'Rename', icon: <Pencil className="size-3.5" />, onSelect: () => setEditing(true) },
            { label: 'Copy link', icon: <Copy className="size-3.5" />, onSelect: () => void copyText(conv.url, 'conversation link') },
            { label: 'Remove link', icon: <Trash2 className="size-3.5" />, danger: true, separatorBefore: true, onSelect: () => removeConversation(conv) },
          ]}
        />
      </div>
    </div>
  )
}

export function ConversationList({ conversations, defaultId, empty }: { conversations: Conversation[]; defaultId: string | null; empty?: React.ReactNode }) {
  if (!conversations.length) return <div className="px-2 py-2 text-[12px] text-fg-3">{empty ?? 'No conversation links yet.'}</div>
  return (
    <div className="@container space-y-px">
      {conversations.map((c) => (
        <ConversationRow key={c.id} conv={c} isDefault={c.id === defaultId} />
      ))}
    </div>
  )
}
