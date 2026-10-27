// Minimal file logger. Never logs payloads, environments or terminal output; messages are
// additionally passed through redact() as a safety net.

import fs from 'node:fs'
import path from 'node:path'

type Level = 'debug' | 'info' | 'warn' | 'error'

let stream: fs.WriteStream | null = null
let echo = false

const REDACTIONS: [RegExp, string][] = [
  [/\bsk-ant-[A-Za-z0-9_-]{6,}/g, 'sk-ant-[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[redacted jwt]'],
  [/\b((?:bearer|basic)\s+)[A-Za-z0-9_\-.=+/]{8,}/gi, '$1[redacted]'],
  [/(\b(?:token|password|secret|api[_-]?key|authorization)\s*[:=]\s*(?:(?:bearer|basic)\s+)?)(?!\[redacted)[^\s"',;]{8,}/gi, '$1[redacted]'],
  [/([?&](?:code|token|state|code_verifier|access_token)=)[^&\s#"']+/gi, '$1[redacted]'],
]

export function redact(text: string): string {
  let out = text
  for (const [rx, repl] of REDACTIONS) out = out.replace(rx, repl)
  return out.replace(/[A-Za-z0-9_\-+=]{40,}/g, (tok) => {
    if (/^(?:session|cse|env|ccpool)_[A-Za-z0-9]{8,64}$/.test(tok)) return tok
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(tok)).length
    return classes >= 3 || (tok.length >= 64 && classes >= 2) ? '[redacted]' : tok
  })
}

export function initLog(dir: string, alsoConsole: boolean): void {
  echo = alsoConsole
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'main.log')
    try {
      if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`)
    } catch {
      /* first run */
    }
    stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 })
  } catch {
    stream = null
  }
}

function write(level: Level, msg: string, meta?: Record<string, unknown>): void {
  let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`
  if (meta) {
    try {
      line += ` ${JSON.stringify(meta)}`
    } catch {
      /* ignore */
    }
  }
  line = redact(line)
  stream?.write(line + '\n')
  if (echo) (level === 'error' ? console.error : console.log)(line)
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => write('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => write('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write('error', msg, meta),
}
