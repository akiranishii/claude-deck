// UI flows shared by cards, rows, the command palette and keyboard shortcuts.

import type { OpenRequest } from '@shared/routing'
import type { Conversation, Project } from '@shared/types'
import { call, errorMessage } from './api'
import { ui } from './store'
import type { ProjectVM, RuntimeVM } from './selectors'

export async function refreshAll(): Promise<void> {
  ui().setBusy('refresh', 'Refreshing')
  try {
    await call('state.refresh', undefined)
  } catch (err) {
    ui().toast('error', errorMessage(err))
  } finally {
    ui().setBusy('refresh', null)
  }
}

export async function openClaude(req: OpenRequest, acknowledge = false): Promise<void> {
  const key = `open:${req.runtimeId ?? req.conversationId ?? req.accountId}`
  ui().setBusy(key, 'Opening')
  try {
    const res = await call('open.claude', {
      runtimeId: req.runtimeId ?? undefined,
      conversationId: req.conversationId ?? undefined,
      accountId: req.accountId ?? undefined,
      target: req.target,
      acknowledge,
    })
    if (res.opened) {
      const p = res.plan
      const what = p.urlKind === 'conversation' ? 'conversation' : p.urlKind === 'environment' ? 'environment page' : 'claude.ai/code'
      ui().toast('success', `Opened ${what} in Chrome profile “${p.profileName}” as ${p.accountName}`)
      const info = p.issues.find((i) => i.severity === 'info')
      if (info) ui().toast('info', info.message)
    } else {
      ui().openDialog({ kind: 'open-issues', plan: res.plan, request: req })
    }
  } catch (err) {
    ui().toast('error', errorMessage(err))
  } finally {
    ui().setBusy(key, null)
  }
}

export async function openTerminal(runtimeId: string): Promise<void> {
  try {
    await call('open.terminal', { runtimeId })
  } catch (err) {
    ui().toast('error', errorMessage(err))
  }
}

export function startRuntime(runtimeId: string, restart = false): void {
  ui().openDialog({ kind: 'start', runtimeId, restart })
}

export function stopRuntime(runtimeId: string): void {
  ui().openDialog({ kind: 'stop', runtimeId })
}

export function endSession(runtimeId: string): void {
  ui().openDialog({ kind: 'end', runtimeId })
}

export async function copyText(text: string, what: string): Promise<void> {
  try {
    await call('clipboard.write', { text })
    ui().toast('success', `Copied ${what}`)
  } catch (err) {
    ui().toast('error', errorMessage(err))
  }
}

export function confirmAction(spec: { title: string; body: string; confirmLabel: string; danger?: boolean; typed?: string; onConfirm: () => Promise<void> | void }): void {
  ui().openDialog({ kind: 'confirm', ...spec })
}

export function removeRuntime(vm: RuntimeVM): void {
  confirmAction({
    title: 'Remove session from dashboard?',
    body: `“${vm.runtime.remoteControlName ?? vm.runtime.tmuxSessionName}” will be removed from Claude Deck. Nothing on the VM is touched — the tmux session${vm.running ? ' and the running Claude process keep running' : ' (if any) is left as is'}. Conversation links stay with the project.`,
    confirmLabel: 'Remove from dashboard',
    onConfirm: async () => {
      await call('runtime.remove', { id: vm.runtime.id })
      ui().toast('success', 'Removed from dashboard')
    },
  })
}

export async function setArchived(project: Project, archived: boolean): Promise<void> {
  try {
    await call('project.archive', { id: project.id, archived })
    ui().toast('success', archived ? `Archived ${project.displayName}` : `Restored ${project.displayName}`)
  } catch (err) {
    ui().toast('error', errorMessage(err))
  }
}

export function deleteProject(vm: ProjectVM): void {
  confirmAction({
    title: `Delete “${vm.project.displayName}” from Claude Deck?`,
    body: `This deletes Claude Deck's metadata for this project: ${vm.runtimes.length} session record(s), ${vm.conversations.length} conversation link(s), notes and tags. Files, repositories and tmux sessions on the VM are NOT touched.`,
    confirmLabel: 'Delete metadata',
    danger: true,
    typed: vm.project.displayName,
    onConfirm: async () => {
      await call('project.delete', { id: vm.project.id })
      ui().toast('success', `Deleted ${vm.project.displayName} from Claude Deck`)
    },
  })
}

export async function togglePin(project: Project): Promise<void> {
  try {
    await call('project.update', { id: project.id, patch: { pinned: !project.pinned } })
  } catch (err) {
    ui().toast('error', errorMessage(err))
  }
}

export async function setDefaultConversation(conv: Conversation, pinned = true): Promise<void> {
  try {
    await call('conversation.update', { id: conv.id, patch: { pinned } })
    ui().toast('success', pinned ? 'Set as the default conversation for Open Claude' : 'Default cleared')
  } catch (err) {
    ui().toast('error', errorMessage(err))
  }
}

export function removeConversation(conv: Conversation): void {
  confirmAction({
    title: 'Remove conversation link?',
    body: `The saved link to ${conv.displayTitle ?? conv.autoTitle ?? conv.remoteSessionId} will be removed from Claude Deck. The conversation itself on claude.ai is not affected.`,
    confirmLabel: 'Remove link',
    onConfirm: async () => {
      await call('conversation.remove', { id: conv.id })
    },
  })
}

export async function checkAuth(accountId?: string): Promise<void> {
  ui().setBusy(`auth:${accountId ?? 'all'}`, 'Checking')
  try {
    await call('account.checkAuth', { id: accountId })
  } catch (err) {
    ui().toast('error', errorMessage(err))
  } finally {
    ui().setBusy(`auth:${accountId ?? 'all'}`, null)
  }
}
