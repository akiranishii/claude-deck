// CRUD for projects and conversations (metadata only — never touches files on the VM).

import type { ConversationPatch, LinkConversationInput, ProjectInput, ProjectPatch } from '../../shared/ipc'
import type { ContainerConfig, Conversation, Project, TaskStatus } from '../../shared/types'
import { TASK_STATUS_META } from '../../shared/constants'
import { newId, normalizeRemotePath, validateRemotePathInput } from '../../shared/naming'
import { parseClaudeUrl } from '../../shared/urls'
import { nowIso } from '../db/store'
import { DeckError, type Ctx } from './context'

const MAX_TAGS = 20

function cleanTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((t) => t.trim().replace(/^#/, '').slice(0, 32)).filter(Boolean))].slice(0, MAX_TAGS)
}

function cleanTaskStatus(s: TaskStatus | null | undefined): TaskStatus | null {
  if (s === null || s === undefined) return null
  if (!(s in TASK_STATUS_META)) throw new DeckError('invalid_task_status', 'Unknown task status')
  return s
}

function cleanContainer(c: ContainerConfig | null): ContainerConfig | null {
  if (!c) return null
  const str = (v: string | null | undefined, max = 200) => {
    const t = (v ?? '').trim()
    if (!t) return null
    if (/[\x00-\x1f]/.test(t) || t.length > max) throw new DeckError('invalid_container', 'Invalid container setting')
    return t
  }
  const user = str(c.user, 64)
  if (user && !/^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/.test(user)) throw new DeckError('invalid_container', 'Container user must be a user name or uid[:gid]')
  const shell = str(c.shell, 64)
  if (shell && !/^[A-Za-z0-9_./-]+$/.test(shell)) throw new DeckError('invalid_container', 'Invalid shell')
  const name = str(c.name, 128)
  if (name && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new DeckError('invalid_container', 'Invalid container name')
  return {
    enabled: Boolean(c.enabled),
    matchBy: c.matchBy === 'name' ? 'name' : 'devcontainer',
    name,
    hostPath: str(c.hostPath),
    containerPath: str(c.containerPath),
    user,
    shell,
    commandRunner: str(c.commandRunner, 300),
  }
}

export class RecordsService {
  constructor(private readonly ctx: Ctx) {}

  createProject(input: ProjectInput): Project {
    const { store } = this.ctx
    if (!store.hosts.get(input.hostId)) throw new DeckError('not_found', 'Host not found')
    const err = validateRemotePathInput(input.remotePath)
    if (err) throw new DeckError('invalid_path', err)
    const now = nowIso()
    const project: Project = {
      id: newId('prj'),
      hostId: input.hostId,
      displayName: input.displayName.trim() || input.remotePath,
      remotePath: normalizeRemotePath(input.remotePath),
      repositoryRoot: null,
      isWorktree: false,
      parentProjectId: input.parentProjectId ?? null,
      taskSummary: input.taskSummary?.trim() || null,
      taskStatus: cleanTaskStatus(input.taskStatus),
      notes: input.notes ?? null,
      tags: cleanTags(input.tags),
      pinned: Boolean(input.pinned),
      archived: false,
      lastActiveAt: null,
      git: null,
      pathStatus: 'unknown',
      pathCheckedAt: null,
      container: null,
      containerState: null,
      createdAt: now,
      updatedAt: now,
    }
    store.projects.insert(project)
    this.ctx.changed()
    return project
  }

  updateProject(id: string, patch: ProjectPatch): Project {
    const { store } = this.ctx
    const current = store.projects.get(id)
    if (!current) throw new DeckError('not_found', 'Project not found')
    const next: Partial<Project> = { updatedAt: nowIso() }
    if (patch.displayName !== undefined) {
      if (!patch.displayName.trim()) throw new DeckError('invalid_name', 'Enter a project name')
      next.displayName = patch.displayName.trim().slice(0, 120)
    }
    if (patch.remotePath !== undefined && patch.remotePath !== current.remotePath) {
      const err = validateRemotePathInput(patch.remotePath)
      if (err) throw new DeckError('invalid_path', err)
      next.remotePath = normalizeRemotePath(patch.remotePath)
      next.pathStatus = 'unknown'
      next.git = null
    }
    if (patch.taskSummary !== undefined) next.taskSummary = patch.taskSummary?.trim().slice(0, 300) || null
    if (patch.taskStatus !== undefined) next.taskStatus = cleanTaskStatus(patch.taskStatus)
    if (patch.notes !== undefined) next.notes = patch.notes?.slice(0, 20_000) || null
    if (patch.tags !== undefined) next.tags = cleanTags(patch.tags)
    if (patch.pinned !== undefined) next.pinned = patch.pinned
    if (patch.parentProjectId !== undefined) {
      if (patch.parentProjectId === id) throw new DeckError('invalid_parent', 'A project cannot be its own parent')
      if (patch.parentProjectId && !store.projects.get(patch.parentProjectId)) throw new DeckError('not_found', 'Parent project not found')
      next.parentProjectId = patch.parentProjectId
    }
    if (patch.container !== undefined) {
      next.container = cleanContainer(patch.container)
      if (!next.container?.enabled) next.containerState = null
    }
    store.projects.update(id, next)
    this.ctx.changed()
    return store.projects.get(id)!
  }

  archiveProject(id: string, archived: boolean): Project {
    const p = this.updateProject(id, {})
    this.ctx.store.projects.update(id, { archived, pinned: archived ? false : p.pinned, updatedAt: nowIso() })
    this.ctx.event({ level: 'info', type: archived ? 'project.archived' : 'project.unarchived', summary: `${archived ? 'Archived' : 'Restored'} project ${p.displayName}`, projectId: id })
    return this.ctx.store.projects.get(id)!
  }

  deleteProject(id: string): void {
    const p = this.ctx.store.projects.get(id)
    if (!p) return
    for (const r of this.ctx.store.runtimes.all('project_id = ?', [id])) this.ctx.live.runtimes.delete(r.id)
    this.ctx.store.projects.delete(id) // cascades to runtimes + conversations (metadata only)
    this.ctx.event({ level: 'info', type: 'project.deleted', summary: `Deleted Claude Deck metadata for ${p.displayName}. Files on the VM were not touched.` })
  }

  // ----------------------------------------------------------------- conversations

  linkConversation(input: LinkConversationInput): Conversation {
    const { store } = this.ctx
    const parsed = parseClaudeUrl(input.url)
    if (!parsed) throw new DeckError('invalid_url', 'Paste a full https://claude.ai/code/session_… link')
    if (parsed.kind === 'environment') {
      throw new DeckError('environment_url', 'That is a Remote Control environment link, not a conversation. Save it as the session’s environment link instead.')
    }
    if (parsed.kind !== 'session') throw new DeckError('invalid_url', 'That link does not point to a specific conversation (it should contain /code/session_…)')
    const project = store.projects.get(input.projectId)
    if (!project) throw new DeckError('not_found', 'Project not found')
    if (input.runtimeId) {
      const rt = store.runtimes.get(input.runtimeId)
      if (!rt || rt.projectId !== input.projectId) throw new DeckError('invalid_runtime', 'Choose a session that belongs to this project')
    }
    const now = nowIso()
    const existing = store.conversationBySessionId(parsed.sessionId)
    let id: string
    if (existing) {
      store.conversations.update(existing.id, {
        projectId: input.projectId,
        runtimeId: input.runtimeId,
        displayTitle: input.title?.trim() || existing.displayTitle,
        archived: false,
        updatedAt: now,
      })
      id = existing.id
    } else {
      const conv: Conversation = {
        id: newId('conv'),
        projectId: input.projectId,
        runtimeId: input.runtimeId,
        remoteSessionId: parsed.sessionId,
        url: parsed.url,
        displayTitle: input.title?.trim() || null,
        autoTitle: null,
        source: input.source ?? 'user',
        pinned: false,
        live: false,
        claudeStatus: null,
        model: null,
        lastSeenAt: null,
        lastOpenedAt: null,
        archived: false,
        createdAt: now,
        updatedAt: now,
      }
      store.conversations.insert(conv)
      id = conv.id
    }
    if (input.pinned) this.updateConversation(id, { pinned: true })
    this.ctx.event({ level: 'info', type: 'conversation.linked', summary: `Linked conversation ${input.title?.trim() || parsed.sessionId}`, projectId: input.projectId, runtimeId: input.runtimeId })
    return store.conversations.get(id)!
  }

  updateConversation(id: string, patch: ConversationPatch): Conversation {
    const { store } = this.ctx
    const current = store.conversations.get(id)
    if (!current) throw new DeckError('not_found', 'Conversation not found')
    const next: Partial<Conversation> = { updatedAt: nowIso() }
    if (patch.displayTitle !== undefined) next.displayTitle = patch.displayTitle?.trim().slice(0, 200) || null
    if (patch.archived !== undefined) next.archived = patch.archived
    if (patch.runtimeId !== undefined && patch.runtimeId !== current.runtimeId) {
      if (patch.runtimeId) {
        const rt = store.runtimes.get(patch.runtimeId)
        if (!rt) throw new DeckError('not_found', 'Session not found')
        next.projectId = rt.projectId
      }
      next.runtimeId = patch.runtimeId
      next.pinned = false
    } else if (patch.projectId !== undefined && patch.projectId !== current.projectId) {
      if (!store.projects.get(patch.projectId)) throw new DeckError('not_found', 'Project not found')
      next.projectId = patch.projectId
      next.runtimeId = null
      next.pinned = false
    }
    store.tx(() => {
      if (patch.pinned !== undefined) {
        next.pinned = patch.pinned
        const runtimeId = next.runtimeId !== undefined ? next.runtimeId : current.runtimeId
        if (patch.pinned) {
          const siblings = runtimeId ? store.conversationsForRuntime(runtimeId) : store.conversations.all('project_id = ? AND runtime_id IS NULL', [current.projectId])
          for (const s of siblings) if (s.id !== id && s.pinned) store.conversations.update(s.id, { pinned: false, updatedAt: nowIso() })
        }
      }
      store.conversations.update(id, next)
    })
    this.ctx.changed()
    return store.conversations.get(id)!
  }

  removeConversation(id: string): void {
    this.ctx.store.conversations.delete(id)
    this.ctx.changed()
  }
}
