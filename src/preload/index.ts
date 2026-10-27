// The renderer's only door to the main process: a typed invoke() over one validated channel
// and an event subscription. No Node.js APIs are exposed.

import { contextBridge, ipcRenderer } from 'electron'

type Listener = (payload: unknown) => void
const listeners = new Map<string, Set<Listener>>()

ipcRenderer.on('deck:event', (_e, event: string, payload: unknown) => {
  for (const l of listeners.get(event) ?? []) {
    try {
      l(payload)
    } catch (err) {
      console.error('deck listener failed', err)
    }
  }
})

contextBridge.exposeInMainWorld('deck', {
  invoke: (channel: string, req: unknown) => ipcRenderer.invoke('deck:invoke', channel, req),
  on: (event: string, listener: Listener) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event)!.add(listener)
    return () => {
      listeners.get(event)?.delete(listener)
    }
  },
  platform: process.platform,
})
