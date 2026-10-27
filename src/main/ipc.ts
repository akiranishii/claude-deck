import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { DeckChannel, IpcEnvelope } from '../shared/ipc'
import type { Deck } from './deck'
import { SCHEMAS } from './ipcSchemas'
import { DeckError } from './services/context'
import { RemoteOpError } from './ssh/helper'
import { SshError } from './ssh/sshClient'
import { log } from './log'

function fail(code: string, message: string): IpcEnvelope<never> {
  return { ok: false, error: { code, message } }
}

export function errorCode(err: unknown): string {
  if (err instanceof DeckError) return err.code
  if (err instanceof SshError) return `ssh_${err.kind}`
  if (err instanceof RemoteOpError) return err.code
  return 'error'
}

/** One invoke channel; the operation name is validated against the schema table. */
export function registerIpc(deck: Deck, isTrusted: (e: IpcMainInvokeEvent) => boolean): void {
  const handlers = deck.handlers() as Record<DeckChannel, (req: unknown) => unknown>
  ipcMain.handle('deck:invoke', async (event, channel: unknown, payload: unknown) => {
    if (!isTrusted(event)) return fail('forbidden', 'Request from an untrusted frame')
    if (typeof channel !== 'string' || !Object.prototype.hasOwnProperty.call(SCHEMAS, channel)) {
      return fail('unknown_channel', `Unknown operation ${String(channel)}`)
    }
    const parsed = SCHEMAS[channel as DeckChannel].safeParse(payload)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      return fail('invalid_request', `Invalid request for ${channel}: ${first ? `${first.path.join('.') || 'value'} — ${first.message}` : 'bad input'}`)
    }
    try {
      const value = await handlers[channel as DeckChannel](parsed.data)
      return { ok: true, value: value ?? null }
    } catch (err) {
      const code = errorCode(err)
      const message = err instanceof Error ? err.message : String(err)
      if (!(err instanceof DeckError)) log.warn('operation failed', { channel, code, message })
      return fail(code, message)
    }
  })
}
