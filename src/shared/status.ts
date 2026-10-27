// Runtime status classification. Pure: takes observed evidence, returns a status.
// Rule of thumb: "Connected" requires positive evidence (Claude's own status line or a live
// TLS connection held by the Remote Control process) — a tmux session existing is never enough.

import type { RuntimeStatus, StatusPatterns } from './types'

export interface StatusFacts {
  now: number
  /** tmux session (by exact name) exists */
  sessionExists: boolean
  pane: null | {
    dead: boolean
    deadStatus: number | null
    foregroundKind: 'claude' | 'shell-idle' | 'other' | 'dead' | 'unknown'
    foregroundComm?: string | null
    claudeKind?: string | null
  }
  server: null | { pid: number; httpsConnections: number | null }
  screen: null | { statusLine: string | null; stateWord: string | null; lastLog: string | null; tail: string[] }
  /** ms epoch when Claude Deck last launched/restarted this runtime */
  launchedAt: number | null
  graceSec: number
  stopping: boolean
}

export interface StatusResult {
  status: RuntimeStatus
  detail: string
  evidence: string[]
  promptText: string | null
}

const compiled = new Map<string, RegExp | null>()

function rx(pattern: string): RegExp | null {
  if (!compiled.has(pattern)) {
    try {
      compiled.set(pattern, new RegExp(pattern, 'i'))
    } catch {
      compiled.set(pattern, null)
    }
  }
  return compiled.get(pattern) ?? null
}

export function matchesAny(text: string | null | undefined, patterns: string[]): boolean {
  if (!text) return false
  return patterns.some((p) => rx(p)?.test(text) ?? false)
}

function lastNonBlank(lines: string[], n: number): string[] {
  return lines.filter((l) => l.trim()).slice(-n)
}

/** Unanswered interactive prompt at the bottom of the screen, e.g. "Trust /path? [y/N]". */
export function detectPrompt(tail: string[], patterns: StatusPatterns): string | null {
  const last = lastNonBlank(tail, 8)
  if (!last.length) return null
  const bottom = last[last.length - 1]
  // A y/n prompt must be the very last line and still unanswered.
  if (/\[(?:y\/N|Y\/n)\]\s*$|\(y\/n\)\s*$/i.test(bottom)) return bottom.trim()
  const menu = last.some((l) => /^\s*(?:❯|>)\s*1\./.test(l))
  const confirmHint = last.some((l) => /Enter to confirm|Press Enter to continue|Esc to (?:exit|cancel)/i.test(l))
  if (menu && confirmHint) {
    const question = [...last].reverse().find((l) => /\?\s*$/.test(l.trim()))
    return (question ?? last.find((l) => /^\s*(?:❯|>)\s*1\./.test(l)) ?? bottom).trim()
  }
  const custom = patterns.needsInput.filter((p) => !/y\/N|Y\/n|y\/n|❯|Enter to confirm|Press Enter/.test(p))
  const hit = last.slice(-3).find((l) => matchesAny(l, custom))
  return hit ? hit.trim() : null
}

export function detectAuthProblem(tail: string[], patterns: StatusPatterns): string | null {
  const hit = lastNonBlank(tail, 12).find((l) => matchesAny(l, patterns.authRequired))
  return hit ? hit.trim() : null
}

export function classifyRuntime(f: StatusFacts, patterns: StatusPatterns): StatusResult {
  const inGrace = f.launchedAt !== null && f.now - f.launchedAt < f.graceSec * 1000
  const tail = f.screen?.tail ?? []
  const evidence: string[] = []

  if (!f.sessionExists || !f.pane) {
    if (inGrace && f.launchedAt !== null) {
      return { status: 'failed', detail: 'The tmux session exited during startup', evidence: ['tmux session gone'], promptText: null }
    }
    return { status: 'missing', detail: 'tmux session not found on the VM', evidence: ['tmux session not found'], promptText: null }
  }

  const auth = detectAuthProblem(tail, patterns)

  if (f.pane.dead || f.pane.foregroundKind === 'dead') {
    const code = f.pane.deadStatus
    const exitText = code === null ? 'Exited' : `Exited with status ${code}`
    evidence.push('pane is dead (remain-on-exit)')
    if (auth) return { status: 'auth_required', detail: auth, evidence: [...evidence, 'auth error in output'], promptText: null }
    if (f.stopping) return { status: 'stopped', detail: exitText, evidence, promptText: null }
    if (inGrace) return { status: 'failed', detail: `${exitText} during startup`, evidence, promptText: null }
    return { status: 'stopped', detail: exitText, evidence, promptText: null }
  }

  if (!f.server) {
    if (auth) return { status: 'auth_required', detail: auth, evidence: ['auth error in output'], promptText: null }
    if (f.stopping) return { status: 'stopped', detail: 'Remote Control process exited', evidence: ['no Remote Control process'], promptText: null }
    const prompt = detectPrompt(tail, patterns)
    if (inGrace) {
      if (prompt && f.pane.foregroundKind === 'claude') {
        return { status: 'needs_input', detail: prompt, evidence: ['interactive prompt on screen'], promptText: prompt }
      }
      return { status: 'starting', detail: 'Waiting for Remote Control to start', evidence: ['launched recently'], promptText: null }
    }
    if (f.pane.foregroundKind === 'claude') {
      const kind = f.pane.claudeKind === 'interactive' ? 'An interactive Claude session (not Remote Control) is running' : 'Claude is running but not in Remote Control mode'
      return { status: 'stopped', detail: kind, evidence: ['no Remote Control process'], promptText: null }
    }
    if (f.pane.foregroundKind === 'shell-idle') {
      return { status: 'stopped', detail: 'Shell prompt — Remote Control is not running', evidence: ['idle shell in pane'], promptText: null }
    }
    const comm = f.pane.foregroundComm ? `Pane is running ${f.pane.foregroundComm}` : 'Remote Control is not running'
    return { status: 'stopped', detail: comm, evidence: ['no Remote Control process'], promptText: null }
  }

  evidence.push(`Remote Control process ${f.server.pid} is running`)
  if (f.stopping) return { status: 'stopping', detail: 'Stop requested', evidence, promptText: null }
  if (auth) return { status: 'auth_required', detail: auth, evidence: [...evidence, 'auth error in output'], promptText: null }

  const prompt = detectPrompt(tail, patterns)
  if (prompt) return { status: 'needs_input', detail: prompt, evidence: [...evidence, 'interactive prompt on screen'], promptText: prompt }

  const https = f.server.httpsConnections ?? 0
  const word = f.screen?.stateWord ?? null
  if (word) {
    if (matchesAny(word, patterns.connected)) {
      return { status: 'connected', detail: 'Connected', evidence: [...evidence, `status line: ${f.screen?.statusLine ?? word}`], promptText: null }
    }
    if (matchesAny(word, patterns.disconnected)) {
      return { status: 'reconnecting', detail: f.screen?.statusLine ?? word, evidence: [...evidence, `status line: ${word}`], promptText: null }
    }
  }
  const lastLog = f.screen?.lastLog ?? null
  if (lastLog && matchesAny(lastLog, patterns.disconnected) && https === 0) {
    return { status: 'reconnecting', detail: lastLog, evidence: [...evidence, `last log: ${lastLog}`], promptText: null }
  }
  if (https > 0) {
    const via = lastLog && matchesAny(lastLog, patterns.connected) ? `; last log: ${lastLog}` : ''
    return {
      status: 'connected',
      detail: 'Connected',
      evidence: [...evidence, `live HTTPS connection held by the server process${via}`],
      promptText: null,
    }
  }
  if (inGrace) return { status: 'starting', detail: 'Connecting to claude.ai…', evidence, promptText: null }
  const errLine = lastNonBlank(tail, 6).find((l) => matchesAny(l, patterns.error))
  return {
    status: 'running',
    detail: errLine ? errLine.trim() : 'Running — connection status could not be confirmed',
    evidence,
    promptText: null,
  }
}
