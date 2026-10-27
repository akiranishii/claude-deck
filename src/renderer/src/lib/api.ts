import type { DeckApi, DeckBridge, DeckChannel, DeckEvents } from '@shared/ipc'

declare global {
  interface Window {
    deck: DeckBridge
  }
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function call<K extends DeckChannel>(channel: K, req: DeckApi[K]['req']): Promise<DeckApi[K]['res']> {
  const res = await window.deck.invoke(channel, req)
  if (!res.ok) throw new ApiError(res.error.code, res.error.message)
  return res.value
}

export function on<E extends keyof DeckEvents>(event: E, listener: (payload: DeckEvents[E]) => void): () => void {
  return window.deck.on(event, listener)
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
