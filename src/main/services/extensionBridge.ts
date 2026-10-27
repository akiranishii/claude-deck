// Optional bridge for the "Claude Deck Link Capture" Chrome extension (extension/ folder).
//
// * Off by default; listens on 127.0.0.1 only.
// * The only thing it accepts is "this Chrome profile is showing https://claude.ai/code/session_…".
//   There is no command execution of any kind.
// * Each Chrome profile pairs with a one-time code generated for a specific Claude account; the
//   extension then authenticates with a random bearer token (only its SHA-256 is stored).
// * Requests from web pages are rejected: Host header must be loopback (DNS-rebinding guard),
//   Origin (if any) must be chrome-extension://, and a valid token is required.

import http from 'node:http'
import crypto from 'node:crypto'
import { isSessionId, parseClaudeUrl, sessionUrl } from '../../shared/urls'
import { nowIso } from '../db/store'
import { log } from '../log'
import { DeckError, type Ctx } from './context'

interface Pairing {
  code: string
  accountId: string
  profileDir: string | null
  expiresAt: number
}

interface TokenRecord {
  hash: string
  accountId: string
  profileDir: string | null
  createdAt: string
}

export interface InboxItem {
  remoteSessionId: string
  url: string
  title: string | null
  accountId: string
  seenAt: string
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

export function cleanTabTitle(title: unknown): string | null {
  if (typeof title !== 'string') return null
  const t = title.replace(/\s*[|·–—-]\s*Claude(?: Code)?\s*$/i, '').trim()
  return t ? t.slice(0, 200) : null
}

export class ExtensionBridge {
  private server: http.Server | null = null
  private port: number | null = null
  private pairings = new Map<string, Pairing>()

  constructor(private readonly ctx: Ctx) {}

  status(): { running: boolean; port: number | null; pairedProfiles: string[]; inbox?: InboxItem[] } {
    return {
      running: Boolean(this.server),
      port: this.port,
      pairedProfiles: this.tokens().map((t) => t.profileDir ?? t.accountId),
      inbox: this.inbox(),
    }
  }

  private tokens(): TokenRecord[] {
    try {
      return JSON.parse(this.ctx.store.getMeta('extension_tokens') ?? '[]') as TokenRecord[]
    } catch {
      return []
    }
  }

  private saveTokens(tokens: TokenRecord[]): void {
    this.ctx.store.setMeta('extension_tokens', JSON.stringify(tokens))
  }

  inbox(): InboxItem[] {
    try {
      return JSON.parse(this.ctx.store.getMeta('extension_inbox') ?? '[]') as InboxItem[]
    } catch {
      return []
    }
  }

  private saveInbox(items: InboxItem[]): void {
    this.ctx.store.setMeta('extension_inbox', JSON.stringify(items.slice(-50)))
  }

  dismissInbox(remoteSessionId: string): void {
    this.saveInbox(this.inbox().filter((i) => i.remoteSessionId !== remoteSessionId))
    this.ctx.changed()
  }

  pairingCode(accountId: string): { code: string; port: number; profileDir: string | null } {
    const account = this.ctx.store.accounts.get(accountId)
    if (!account) throw new DeckError('not_found', 'Account not found')
    if (!this.server || !this.port) throw new DeckError('not_running', 'Enable the Chrome extension bridge in Settings first')
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase()
    const code = `CDECK-${this.port}-${raw}`
    this.pairings.set(raw, { code, accountId, profileDir: account.chromeProfileDir, expiresAt: Date.now() + 10 * 60_000 })
    return { code, port: this.port, profileDir: account.chromeProfileDir }
  }

  async start(port: number): Promise<void> {
    if (this.server && this.port === port) return
    await this.stop()
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        log.warn('extension bridge request failed', { error: String(err) })
        if (!res.headersSent) this.send(res, 500, { error: 'internal' })
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolve())
    })
    this.server = server
    this.port = port
    log.info('extension bridge listening', { port })
    this.ctx.changed()
  }

  async stop(): Promise<void> {
    const s = this.server
    this.server = null
    this.port = null
    if (s) await new Promise<void>((r) => s.close(() => r()))
    this.ctx.changed()
  }

  private send(res: http.ServerResponse, status: number, body: unknown, origin?: string): void {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    if (origin) {
      headers['Access-Control-Allow-Origin'] = origin
      headers['Vary'] = 'Origin'
    }
    res.writeHead(status, headers)
    res.end(JSON.stringify(body))
  }

  private async readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > 8192) throw new DeckError('too_large', 'body too large')
      chunks.push(chunk as Buffer)
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const host = req.headers.host ?? ''
    if (!new RegExp(`^(127\\.0\\.0\\.1|localhost):${this.port}$`).test(host)) return this.send(res, 403, { error: 'bad host' })
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return this.send(res, 403, { error: 'bad origin' })
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin ?? '',
        'Access-Control-Allow-Methods': 'POST, GET',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '600',
      })
      return void res.end()
    }
    const url = new URL(req.url ?? '/', `http://${host}`)

    if (req.method === 'POST' && url.pathname === '/v1/pair') {
      const body = await this.readJson(req)
      const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : ''
      const raw = code.split('-').pop() ?? ''
      const pairing = this.pairings.get(raw)
      if (!pairing || pairing.expiresAt < Date.now() || pairing.code !== code) return this.send(res, 401, { error: 'invalid or expired pairing code' }, origin)
      this.pairings.delete(raw)
      const token = crypto.randomBytes(32).toString('hex')
      this.saveTokens([...this.tokens(), { hash: sha256(token), accountId: pairing.accountId, profileDir: pairing.profileDir, createdAt: nowIso() }])
      const account = this.ctx.store.accounts.get(pairing.accountId)
      this.ctx.event({ level: 'info', type: 'extension.paired', summary: `Chrome extension paired for ${account?.displayName ?? 'account'} (${pairing.profileDir ?? 'profile'})` })
      return this.send(res, 200, { token, account: account?.displayName ?? null }, origin)
    }

    const auth = req.headers.authorization ?? ''
    const token = /^Bearer ([a-f0-9]{64})$/.exec(auth)?.[1]
    const rec = token ? this.tokens().find((t) => t.hash === sha256(token)) : undefined
    if (!rec) return this.send(res, 401, { error: 'unauthorized' }, origin)

    if (req.method === 'GET' && url.pathname === '/v1/ping') {
      const account = this.ctx.store.accounts.get(rec.accountId)
      return this.send(res, 200, { ok: true, account: account?.displayName ?? null }, origin)
    }

    if (req.method === 'POST' && url.pathname === '/v1/visit') {
      const body = await this.readJson(req)
      const parsed = parseClaudeUrl(typeof body.url === 'string' ? body.url : '')
      if (!parsed || parsed.kind !== 'session') return this.send(res, 400, { error: 'not a claude.ai conversation URL' }, origin)
      this.recordVisit(rec, parsed.sessionId, cleanTabTitle(body.title))
      return this.send(res, 200, { ok: true }, origin)
    }
    return this.send(res, 404, { error: 'not found' }, origin)
  }

  /** A paired profile is showing a conversation: update the link or ask the user where it belongs. */
  recordVisit(rec: { accountId: string; profileDir: string | null }, sessionId: string, title: string | null): void {
    if (!isSessionId(sessionId)) return
    const { store } = this.ctx
    const now = nowIso()
    const existing = store.conversationBySessionId(sessionId)
    const account = store.accounts.get(rec.accountId)
    if (existing) {
      store.conversations.update(existing.id, { lastOpenedAt: now, ...(title ? { autoTitle: title } : {}), updatedAt: now })
      const runtime = existing.runtimeId ? store.runtimes.get(existing.runtimeId) : null
      if (runtime?.accountId && runtime.accountId !== rec.accountId) {
        const owner = store.accounts.get(runtime.accountId)
        this.ctx.event({
          level: 'warn',
          type: 'extension.account_mismatch',
          summary: `Conversation ${title ?? sessionId} belongs to ${owner?.displayName ?? 'another account'} but was opened in ${account?.displayName ?? 'another'}’s Chrome profile`,
          runtimeId: runtime.id,
          projectId: existing.projectId,
        })
      }
      this.ctx.changed()
      return
    }
    // Unknown conversation: it may be a cloud/web session rather than one served from the VM
    // (those are linked automatically from Claude's own records), so ask the user instead of guessing.
    const inbox = this.inbox().filter((i) => i.remoteSessionId !== sessionId)
    inbox.push({ remoteSessionId: sessionId, url: sessionUrl(sessionId), title, accountId: rec.accountId, seenAt: now })
    this.saveInbox(inbox)
    this.ctx.changed()
  }
}
