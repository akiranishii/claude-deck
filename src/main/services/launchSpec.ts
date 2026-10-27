// Builds the Remote Control launch options for a runtime and validates them against the flags
// the installed Claude Code actually supports. Mirrors build_rc_args() in cdeck_helper.py
// (the helper re-validates everything; this copy powers previews and tests).

import type { ClaudeCapabilities, PermissionMode, Runtime, SpawnMode } from '../../shared/types'
import { shJoin } from '../terminal/quote'

export interface RcOptions {
  name?: string
  spawn?: SpawnMode
  permission_mode?: PermissionMode
  capacity?: number
  continue?: boolean
  create_session_in_dir?: boolean
}

export interface LaunchSpecResult {
  options: RcOptions
  warnings: string[]
  errors: string[]
}

type RuntimeLaunchFields = Pick<Runtime, 'remoteControlName' | 'spawnMode' | 'permissionMode' | 'capacity' | 'createSessionInDir'>

/**
 * Claude rejects --continue together with --spawn, --capacity or --create-session-in-dir
 * ("--session-id and --continue cannot be used with …"), so reattaching is only possible for
 * runtimes using the default spawn mode without those options.
 */
export function canResume(rt: RuntimeLaunchFields): boolean {
  return (rt.spawnMode === null || rt.spawnMode === 'same-dir') && !rt.capacity && rt.createSessionInDir !== false
}

export function rcOptionsFor(rt: RuntimeLaunchFields, caps: ClaudeCapabilities | null, resume = false): LaunchSpecResult {
  const options: RcOptions = {}
  const warnings: string[] = []
  const errors: string[] = []
  const version = caps?.version ? `Claude Code ${caps.version}` : 'the installed Claude Code'
  if (resume && !canResume(rt)) {
    warnings.push('Claude cannot reattach (--continue) when a spawn mode, capacity or --no-create-session-in-dir is set; starting a fresh session.')
    resume = false
  }

  if (caps && !caps.rcSupported) errors.push(`${version} does not support \`claude remote-control\`.`)

  if (rt.remoteControlName) {
    if (!caps || caps.supportsName) options.name = rt.remoteControlName.slice(0, 120)
    else warnings.push(`${version} does not support --name; the environment will use its default name.`)
  }
  if (rt.spawnMode && !(resume && rt.spawnMode === 'same-dir')) {
    if (caps && (!caps.supportsSpawn || (caps.spawnModes.length > 0 && !caps.spawnModes.includes(rt.spawnMode)))) {
      errors.push(`${version} does not support --spawn=${rt.spawnMode}.`)
    } else options.spawn = rt.spawnMode
  }
  if (rt.permissionMode) {
    if (caps && (!caps.supportsPermissionMode || (caps.permissionModes.length > 0 && !caps.permissionModes.includes(rt.permissionMode)))) {
      errors.push(`${version} does not support --permission-mode ${rt.permissionMode}.`)
    } else options.permission_mode = rt.permissionMode
  }
  if (rt.capacity) {
    if (!caps || caps.supportsCapacity) options.capacity = Math.max(1, Math.min(256, Math.round(rt.capacity)))
    else warnings.push(`${version} does not support --capacity; using its default.`)
  }
  if (rt.createSessionInDir === false) {
    if (!caps || caps.supportsCreateSessionInDir) options.create_session_in_dir = false
    else warnings.push(`${version} does not support --no-create-session-in-dir.`)
  }
  if (resume) {
    if (!caps || caps.supportsContinue) options.continue = true
    else warnings.push(`${version} does not support --continue; starting a fresh session.`)
  }
  return { options, warnings, errors }
}

export function buildRcArgs(o: RcOptions): string[] {
  const args: string[] = []
  if (o.name) args.push('--name', o.name)
  if (o.spawn) args.push('--spawn', o.spawn)
  if (o.permission_mode) args.push('--permission-mode', o.permission_mode)
  if (o.capacity !== undefined) args.push('--capacity', String(o.capacity))
  if (o.continue) args.push('--continue')
  if (o.create_session_in_dir === false) args.push('--no-create-session-in-dir')
  return args
}

/** The account is selected purely by this per-process env assignment. */
export function envPrefix(configDir: string | null): string[] {
  return configDir === null ? ['env', '-u', 'CLAUDE_CONFIG_DIR'] : ['env', `CLAUDE_CONFIG_DIR=${configDir}`]
}

export function displayLaunchCommand(configDir: string | null, claudePath: string, o: RcOptions): string {
  return shJoin([...envPrefix(configDir), claudePath, 'remote-control', ...buildRcArgs(o)])
}
