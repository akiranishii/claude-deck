import type { DeckState } from '@shared/types'
import { useUi, type DialogSpec } from '../lib/store'
import { AccountDialog, LoginDialog } from './AccountDialogs'
import { ProjectDialog, RuntimeDialog } from './EditDialogs'
import { EndDialog, StartDialog, StopDialog } from './LifecycleDialogs'
import { LinkDialog } from './LinkDialog'
import { ActivityDialog, ConfirmDialog, HostDialog, ImportDialog, InboxDialog, OpenIssuesDialog } from './MiscDialogs'
import { NewSessionDialog } from './NewSessionDialog'

function render(d: DialogSpec, state: DeckState, onClose: () => void) {
  switch (d.kind) {
    case 'new-session':
      return <NewSessionDialog state={state} projectId={d.projectId} hostId={d.hostId} onClose={onClose} />
    case 'project':
      return <ProjectDialog state={state} projectId={d.projectId} tab={d.tab} onClose={onClose} />
    case 'runtime':
      return <RuntimeDialog state={state} runtimeId={d.runtimeId} onClose={onClose} />
    case 'link':
      return <LinkDialog state={state} projectId={d.projectId} runtimeId={d.runtimeId} url={d.url} title={d.title} onClose={onClose} />
    case 'account':
      return <AccountDialog state={state} accountId={d.accountId} onClose={onClose} />
    case 'login':
      return <LoginDialog state={state} accountId={d.accountId} hostId={d.hostId} onClose={onClose} />
    case 'start':
      return <StartDialog state={state} runtimeId={d.runtimeId} restart={d.restart} onClose={onClose} />
    case 'stop':
      return <StopDialog state={state} runtimeId={d.runtimeId} onClose={onClose} />
    case 'end':
      return <EndDialog state={state} runtimeId={d.runtimeId} onClose={onClose} />
    case 'open-issues':
      return <OpenIssuesDialog state={state} plan={d.plan} request={d.request} onClose={onClose} />
    case 'import':
      return <ImportDialog state={state} hostId={d.hostId} onClose={onClose} />
    case 'host':
      return <HostDialog onClose={onClose} />
    case 'inbox':
      return <InboxDialog state={state} onClose={onClose} />
    case 'activity':
      return <ActivityDialog state={state} runtimeId={d.runtimeId} onClose={onClose} />
    case 'confirm':
      return <ConfirmDialog {...d} onClose={onClose} />
  }
}

export function DialogHost({ state }: { state: DeckState }) {
  const dialogs = useUi((s) => s.dialogs)
  return (
    <>
      {dialogs.map((d, i) => {
        const onClose = () => useUi.setState((s) => ({ dialogs: s.dialogs.filter((x) => x !== d) }))
        return <div key={`${d.kind}-${i}`}>{render(d, state, onClose)}</div>
      })}
    </>
  )
}
