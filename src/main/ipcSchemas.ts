// Runtime validation for every IPC request. Anything that does not match is rejected before it
// reaches a service, so the renderer cannot smuggle unexpected fields or types into the main
// process.

import { z } from 'zod'
import type { DeckChannel } from '../shared/ipc'

const id = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/)
const s = (max = 1000) => z.string().max(max)
const path = z.string().min(1).max(1024)
const none = z.undefined().or(z.null()).optional()
const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/)
const profileDir = z.string().min(1).max(64)
const permission = z.enum(['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan'])
const spawn = z.enum(['same-dir', 'worktree', 'session'])
const taskStatus = z.enum(['planned', 'in_progress', 'blocked', 'completed'])
const shellMode = z.enum(['interactive-login', 'login', 'direct'])
const target = z.enum(['conversation', 'environment', 'home'])
const tags = z.array(s(40)).max(20)
const patterns = z.array(s(300)).max(40)

const container = z.object({
  enabled: z.boolean(),
  matchBy: z.enum(['devcontainer', 'name']),
  name: s(128).nullable(),
  hostPath: s(1024).nullable(),
  containerPath: s(1024).nullable(),
  user: s(64).nullable(),
  shell: s(64).nullable(),
  commandRunner: s(300).nullable(),
})

const settingsPatch = z.object({
  theme: z.enum(['system', 'light', 'dark']).optional(),
  viewMode: z.enum(['cards', 'list']).optional(),
  refreshIntervalSec: z.number().int().min(5).max(600).optional(),
  gitRefreshIntervalSec: z.number().int().min(15).max(3600).optional(),
  authCheckIntervalMin: z.number().int().min(5).max(1440).optional(),
  startupGraceSec: z.number().int().min(15).max(300).optional(),
  stopTimeoutSec: z.number().int().min(3).max(60).optional(),
  browser: z
    .object({
      kind: z.enum(['chrome', 'chrome-beta', 'chrome-canary', 'chromium', 'brave', 'edge']),
      appPath: s(500).regex(/^\/.*\.app$/),
      userDataDir: s(500),
    })
    .optional(),
  terminalApp: z.enum(['terminal', 'iterm']).optional(),
  notifications: z.boolean().optional(),
  trayEnabled: z.boolean().optional(),
  onboardingComplete: z.boolean().optional(),
  statusPatterns: z
    .object({ connected: patterns, disconnected: patterns, authRequired: patterns, needsInput: patterns, error: patterns })
    .optional(),
  extensionEnabled: z.boolean().optional(),
  extensionPort: z.number().int().min(1024).max(65535).optional(),
})

const startArgs = z.object({ id, resume: z.boolean().optional(), acknowledgeImportedShell: z.boolean().optional() })
const openArgs = z.object({ runtimeId: id.optional(), conversationId: id.optional(), accountId: id.optional(), target: target.optional() })

export const SCHEMAS: Record<DeckChannel, z.ZodType> = {
  'state.get': none,
  'state.refresh': z.object({ hostId: id.optional() }).or(none),

  'host.listSshAliases': none,
  'host.probe': z.object({ alias: s(253).min(1), claudePath: path.nullable().optional(), pythonCommand: s(200).optional() }),
  'host.save': z.object({
    displayName: s(100),
    sshAlias: s(253).min(1),
    claudePath: path.nullable().optional(),
    shellMode: shellMode.optional(),
    defaultParentDir: path.optional(),
    pythonCommand: s(200).optional(),
  }),
  'host.update': z.object({
    id,
    patch: z.object({
      displayName: s(100).optional(),
      claudePath: path.nullable().optional(),
      shellMode: shellMode.optional(),
      defaultParentDir: path.optional(),
      pythonCommand: s(200).optional(),
    }),
  }),
  'host.reprobe': z.object({ id }),
  'host.remove': z.object({ id }),
  'host.reconnect': z.object({ id }),

  'discovery.scan': z.object({ hostId: id, checkAuth: z.boolean().optional() }),
  'discovery.import': z.object({
    hostId: id,
    items: z
      .array(
        z.object({
          key: s(300),
          projectId: id.nullable().optional(),
          newProjectName: s(120).nullable().optional(),
          accountId: id.nullable().optional(),
          taskSummary: s(300).nullable().optional(),
        }),
      )
      .max(200),
    createAccounts: z
      .array(z.object({ configDir: path.nullable(), displayName: s(60).min(1), color: color.optional(), chromeProfileDir: profileDir.nullable().optional() }))
      .max(30)
      .optional(),
  }),

  'account.create': z.object({
    displayName: s(60).min(1),
    label: s(200).nullable().optional(),
    configDir: path.nullable(),
    color: color.optional(),
    chromeProfileDir: profileDir.nullable().optional(),
  }),
  'account.update': z.object({
    id,
    patch: z.object({
      displayName: s(60).optional(),
      label: s(200).nullable().optional(),
      configDir: path.nullable().optional(),
      color: color.optional(),
      chromeProfileDir: profileDir.nullable().optional(),
      sortOrder: z.number().int().min(0).max(1000).optional(),
      archived: z.boolean().optional(),
    }),
  }),
  'account.delete': z.object({ id }),
  'account.checkAuth': z.object({ id: id.optional() }),
  'account.listConfigDirs': z.object({ hostId: id, checkAuth: z.boolean().optional() }),
  'account.createConfigDir': z.object({ hostId: id, path }),
  'account.confirmProfile': z.object({ id, confirmed: z.boolean() }),

  'login.start': z.object({ accountId: id, hostId: id, method: z.enum(['claudeai', 'console', 'sso']).optional() }),
  'login.poll': z.object({ loginId: s(100) }),
  'login.openUrl': z.object({ loginId: s(100), url: s(8000), profileDir: profileDir.nullable().optional() }),
  'login.openTerminal': z.object({ loginId: s(100) }),
  'login.finish': z.object({ loginId: s(100) }),

  'chrome.profiles': none,
  'chrome.test': z.object({ profileDir, url: s(2000).optional() }),
  'chrome.createProfile': none,
  'chrome.activeTabUrl': none,

  'project.create': z.object({
    hostId: id,
    displayName: s(120),
    remotePath: path,
    taskSummary: s(300).nullable().optional(),
    taskStatus: taskStatus.nullable().optional(),
    notes: s(20000).nullable().optional(),
    tags: tags.optional(),
    pinned: z.boolean().optional(),
    parentProjectId: id.nullable().optional(),
  }),
  'project.update': z.object({
    id,
    patch: z.object({
      displayName: s(120).optional(),
      remotePath: path.optional(),
      taskSummary: s(300).nullable().optional(),
      taskStatus: taskStatus.nullable().optional(),
      notes: s(20000).nullable().optional(),
      tags: tags.optional(),
      pinned: z.boolean().optional(),
      parentProjectId: id.nullable().optional(),
      container: container.nullable().optional(),
    }),
  }),
  'project.archive': z.object({ id, archived: z.boolean() }),
  'project.delete': z.object({ id }),

  'remote.listDir': z.object({ hostId: id, path, showHidden: z.boolean().optional() }),
  'remote.checkPath': z.object({ hostId: id, path }),

  'session.create': z.object({
    opId: s(100).min(1),
    hostId: id,
    location: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('new-folder'), parent: path, name: s(128).min(1) }),
      z.object({ kind: z.literal('existing-folder'), path }),
      z.object({ kind: z.literal('existing-project'), projectId: id }),
    ]),
    attachToProjectId: id.nullable().optional(),
    projectName: s(120),
    taskSummary: s(300).nullable().optional(),
    tags: tags.optional(),
    accountId: id,
    spawnMode: spawn.nullable(),
    permissionMode: permission.nullable(),
    bypassAcknowledged: z.boolean(),
    remoteControlName: s(120).nullable().optional(),
    capacity: z.number().int().min(1).max(256).nullable().optional(),
    launch: z.boolean(),
  }),

  'runtime.start': startArgs,
  'runtime.stop': z.object({ id, mode: z.enum(['interrupt', 'terminate', 'kill']) }),
  'runtime.restart': startArgs,
  'runtime.end': z.object({ id, force: z.boolean().optional(), allowUnmanaged: z.boolean().optional() }),
  'runtime.update': z.object({
    id,
    patch: z.object({
      environmentUrl: s(2000).nullable().optional(),
      accountId: id.nullable().optional(),
      taskSummary: s(300).nullable().optional(),
      remoteControlName: s(120).nullable().optional(),
      spawnMode: spawn.nullable().optional(),
      permissionMode: permission.nullable().optional(),
      bypassAcknowledged: z.boolean().optional(),
      capacity: z.number().int().min(1).max(256).nullable().optional(),
      createSessionInDir: z.boolean().nullable().optional(),
      projectId: id.optional(),
      tmuxSessionName: s(80).optional(),
      archived: z.boolean().optional(),
    }),
  }),
  'runtime.remove': z.object({ id }),
  'runtime.capture': z.object({ id, lines: z.number().int().min(10).max(2000).optional() }),
  'runtime.launchPreview': z.object({ id, resume: z.boolean().optional(), restart: z.boolean().optional() }),

  'conversation.link': z.object({
    url: s(2000),
    projectId: id,
    runtimeId: id.nullable(),
    title: s(200).nullable().optional(),
    pinned: z.boolean().optional(),
    source: z.enum(['user', 'clipboard', 'chrome-tab']).optional(),
  }),
  'conversation.update': z.object({
    id,
    patch: z.object({
      displayTitle: s(200).nullable().optional(),
      pinned: z.boolean().optional(),
      runtimeId: id.nullable().optional(),
      projectId: id.optional(),
      archived: z.boolean().optional(),
    }),
  }),
  'conversation.remove': z.object({ id }),

  'open.plan': openArgs,
  'open.claude': openArgs.extend({ acknowledge: z.boolean().optional() }),
  'open.terminal': z.object({ runtimeId: id }),
  'open.containerTerminal': z.object({ projectId: id }),
  'open.external': z.object({ url: s(2000) }),

  'clipboard.readUrl': none,
  'clipboard.write': z.object({ text: s(10000) }),

  'settings.update': settingsPatch,
  'data.export': none,
  'data.import': none,
  'events.list': z.object({ runtimeId: id.optional(), projectId: id.optional(), limit: z.number().int().min(1).max(1000).optional() }),
  'extension.pairing': z.object({ accountId: id }),
  'extension.dismissInbox': z.object({ remoteSessionId: s(100) }),
}
