import * as RDialog from '@radix-ui/react-dialog'
import { Command } from 'cmdk'
import { STATUS_META } from '@shared/constants'
import { ArrowUpRight, Download, Layers, Link2, Moon, Plus, RefreshCw, Search, Settings, SquareTerminal, Sun, UserPlus, LayoutGrid } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { call } from '../lib/api'
import { openClaude, openTerminal, refreshAll } from '../lib/actions'
import { shortSession } from '../lib/format'
import type { ProjectVM, RuntimeVM } from '../lib/selectors'
import { ui, useUi } from '../lib/store'
import type { DeckState } from '@shared/types'
import { conversationTitle } from './ConversationList'
import { AccountAvatar, StatusDot } from './Status'
import { Kbd } from './ui'

function Item({ value, keywords, onSelect, icon, children, hint }: { value: string; keywords?: string[]; onSelect: () => void; icon?: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <Command.Item
      value={value}
      keywords={keywords}
      onSelect={onSelect}
      className="flex h-10 cursor-default items-center gap-3 rounded-lg px-3 text-[13px] text-fg outline-none data-[selected=true]:bg-panel-2"
    >
      <span className="flex size-6 shrink-0 items-center justify-center text-fg-3">{icon}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {hint && <span className="shrink-0 text-[11.5px] text-fg-3">{hint}</span>}
    </Command.Item>
  )
}

export function CommandPalette({ state, projects, runtimes }: { state: DeckState; projects: ProjectVM[]; runtimes: RuntimeVM[] }) {
  const open = useUi((s) => s.paletteOpen)
  const [query, setQuery] = useState('')
  const close = () => {
    ui().setPalette(false)
    setQuery('')
  }
  const run = (fn: () => void) => {
    close()
    setTimeout(fn, 0)
  }
  const activeRuntimes = runtimes.filter((r) => !r.runtime.archived && !r.project.archived)
  const conversations = activeRuntimes.flatMap((r) => r.conversations.map((c) => ({ c, r })))
  const focusProject = (p: ProjectVM) => {
    ui().setView('projects')
    ui().clearFilters()
    ui().setSearch(p.project.displayName)
    if (p.primary) ui().select(p.primary.runtime.id)
  }

  return (
    <RDialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <RDialog.Portal>
        <RDialog.Overlay className="animate-fade fixed inset-0 z-50 bg-overlay" />
        <RDialog.Content aria-describedby={undefined} className="animate-pop fixed top-[12vh] left-1/2 z-50 w-[min(680px,calc(100vw-48px))] -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-panel shadow-pop">
          <RDialog.Title className="sr-only">Command palette</RDialog.Title>
          <Command loop label="Command palette" className="flex flex-col">
            <div className="flex items-center gap-2.5 border-b border-line px-4">
              <Search className="size-4 text-fg-3" />
              <Command.Input
                value={query}
                onValueChange={setQuery}
                placeholder="Open a session, conversation or project…"
                className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-fg-3"
              />
              <Kbd>esc</Kbd>
            </div>
            <Command.List className="max-h-[440px] overflow-y-auto p-2 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-[0.06em] [&_[cmdk-group-heading]]:text-fg-3 [&_[cmdk-group-heading]]:uppercase">
              <Command.Empty className="px-3 py-8 text-center text-[13px] text-fg-3">No matches</Command.Empty>
              <Command.Group heading="Open Claude">
                {activeRuntimes.map((r) => (
                  <Item
                    key={`rt-${r.runtime.id}`}
                    value={`open-${r.runtime.id}`}
                    keywords={[r.project.displayName, r.account?.displayName ?? '', r.runtime.tmuxSessionName, r.runtime.remoteControlName ?? '', r.project.taskSummary ?? '', r.runtime.taskSummary ?? '']}
                    onSelect={() => run(() => void openClaude({ runtimeId: r.runtime.id }))}
                    icon={<AccountAvatar account={r.account} size={20} />}
                    hint={
                      <span className="inline-flex items-center gap-1.5">
                        <StatusDot status={r.status} size={7} />
                        {STATUS_META[r.status].short}
                      </span>
                    }
                  >
                    <span className="truncate font-medium">{r.project.displayName}</span>
                    <span className="truncate text-fg-3">
                      {r.account?.displayName ?? 'account?'} · {r.runtime.tmuxSessionName}
                    </span>
                  </Item>
                ))}
              </Command.Group>
              {query && (
                <Command.Group heading="Conversations">
                  {conversations.map(({ c, r }) => (
                    <Item
                      key={`cv-${c.id}`}
                      value={`conv-${c.id}`}
                      keywords={[conversationTitle(c), c.remoteSessionId, r.project.displayName, r.account?.displayName ?? '']}
                      onSelect={() => run(() => void openClaude({ conversationId: c.id }))}
                      icon={<ArrowUpRight className="size-4" />}
                      hint={shortSession(c.remoteSessionId)}
                    >
                      <span className="truncate">{conversationTitle(c)}</span>
                      <span className="truncate text-fg-3">
                        {r.project.displayName} · {r.account?.displayName}
                      </span>
                    </Item>
                  ))}
                </Command.Group>
              )}
              <Command.Group heading="Projects">
                {projects
                  .filter((p) => !p.project.archived)
                  .map((p) => (
                    <Item
                      key={`pj-${p.project.id}`}
                      value={`proj-${p.project.id}`}
                      keywords={[p.project.displayName, p.project.remotePath, p.project.taskSummary ?? '', ...p.project.tags]}
                      onSelect={() => run(() => focusProject(p))}
                      icon={<Layers className="size-4" />}
                      hint={`${p.runtimes.length} session${p.runtimes.length === 1 ? '' : 's'}`}
                    >
                      <span className="truncate font-medium">{p.project.displayName}</span>
                      <span className="truncate text-fg-3">{p.project.taskSummary ?? p.project.remotePath}</span>
                    </Item>
                  ))}
              </Command.Group>
              {query &&
                activeRuntimes.length > 0 && (
                  <Command.Group heading="Terminals">
                    {activeRuntimes.map((r) => (
                      <Item
                        key={`tm-${r.runtime.id}`}
                        value={`term-${r.runtime.id}`}
                        keywords={['terminal', 'tmux', 'ssh', r.project.displayName, r.runtime.tmuxSessionName]}
                        onSelect={() => run(() => void openTerminal(r.runtime.id))}
                        icon={<SquareTerminal className="size-4" />}
                      >
                        Open terminal · <span className="font-mono text-[12px] text-fg-2">{r.runtime.tmuxSessionName}</span>
                      </Item>
                    ))}
                  </Command.Group>
                )}
              <Command.Group heading="Actions">
                <Item value="new-session" keywords={['new', 'session', 'project', 'launch', 'create']} onSelect={() => run(() => ui().openDialog({ kind: 'new-session' }))} icon={<Plus className="size-4" />} hint="⌘N">
                  New project / session
                </Item>
                <Item value="refresh" keywords={['refresh', 'reload', 'status']} onSelect={() => run(() => void refreshAll())} icon={<RefreshCw className="size-4" />} hint="⌘R">
                  Refresh status
                </Item>
                {state.hosts[0] && (
                  <Item value="import" keywords={['import', 'discover', 'existing', 'tmux']} onSelect={() => run(() => ui().openDialog({ kind: 'import', hostId: state.hosts[0].id }))} icon={<Download className="size-4" />}>
                    Import existing sessions
                  </Item>
                )}
                <Item value="link" keywords={['link', 'conversation', 'url', 'paste']} onSelect={() => run(() => ui().openDialog({ kind: 'link' }))} icon={<Link2 className="size-4" />} hint="⌘L">
                  Link a conversation URL
                </Item>
                <Item value="account" keywords={['account', 'add', 'login', 'profile']} onSelect={() => run(() => ui().openDialog({ kind: 'account' }))} icon={<UserPlus className="size-4" />}>
                  Add Claude account
                </Item>
                <Item value="view" keywords={['cards', 'list', 'view', 'compact']} onSelect={() => run(() => void call('settings.update', { viewMode: state.settings.viewMode === 'cards' ? 'list' : 'cards' }))} icon={<LayoutGrid className="size-4" />} hint="⌘⇧L">
                  Toggle cards / compact list
                </Item>
                <Item
                  value="theme"
                  keywords={['theme', 'dark', 'light', 'appearance']}
                  onSelect={() => run(() => void call('settings.update', { theme: state.settings.theme === 'dark' ? 'light' : state.settings.theme === 'light' ? 'system' : 'dark' }))}
                  icon={state.settings.theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
                  hint={state.settings.theme}
                >
                  Cycle theme (dark → light → system)
                </Item>
                <Item value="settings" keywords={['settings', 'preferences']} onSelect={() => run(() => ui().setView('settings'))} icon={<Settings className="size-4" />} hint="⌘,">
                  Settings
                </Item>
              </Command.Group>
            </Command.List>
          </Command>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}
