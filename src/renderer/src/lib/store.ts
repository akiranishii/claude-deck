import { create } from 'zustand'
import type { ProgressEvent } from '@shared/ipc'
import type { OpenPlan, OpenRequest } from '@shared/routing'
import type { DeckState } from '@shared/types'

export type View = 'dashboard' | 'running' | 'projects' | 'accounts' | 'archived' | 'settings'
export type SortKey = 'activity' | 'name' | 'status'

export type DialogSpec =
  | { kind: 'new-session'; projectId?: string; hostId?: string }
  | { kind: 'project'; projectId: string; tab?: 'general' | 'container' }
  | { kind: 'runtime'; runtimeId: string }
  | { kind: 'link'; projectId?: string; runtimeId?: string | null; url?: string; title?: string }
  | { kind: 'account'; accountId?: string; step?: 'details' | 'profile' }
  | { kind: 'login'; accountId: string; hostId: string }
  | { kind: 'start'; runtimeId: string; restart: boolean }
  | { kind: 'stop'; runtimeId: string }
  | { kind: 'end'; runtimeId: string }
  | { kind: 'open-issues'; plan: OpenPlan; request: OpenRequest }
  | { kind: 'import'; hostId: string }
  | { kind: 'host'; hostId?: string }
  | { kind: 'inbox' }
  | { kind: 'activity'; runtimeId: string }
  | {
      kind: 'confirm'
      title: string
      body: string
      confirmLabel: string
      danger?: boolean
      typed?: string
      onConfirm: () => Promise<void> | void
    }

export interface Toast {
  id: number
  level: 'info' | 'success' | 'warn' | 'error'
  message: string
  action?: { label: string; run: () => void }
}

interface UiStore {
  state: DeckState | null
  view: View
  search: string
  accountFilter: string[]
  statusFilter: string[]
  tagFilter: string[]
  projectFilter: string[]
  sort: SortKey
  selectedRuntimeId: string | null
  expanded: Record<string, boolean>
  dialogs: DialogSpec[]
  paletteOpen: boolean
  toasts: Toast[]
  progress: Record<string, ProgressEvent[]>
  busy: Record<string, string>
  setState: (s: DeckState) => void
  setView: (v: View) => void
  setSearch: (q: string) => void
  toggleFilter: (key: 'accountFilter' | 'statusFilter' | 'tagFilter' | 'projectFilter', value: string) => void
  setFilter: (key: 'accountFilter' | 'statusFilter' | 'tagFilter' | 'projectFilter', values: string[]) => void
  clearFilters: () => void
  setSort: (s: SortKey) => void
  select: (runtimeId: string | null) => void
  toggleExpanded: (id: string, value?: boolean) => void
  openDialog: (d: DialogSpec) => void
  closeDialog: () => void
  closeAllDialogs: () => void
  setPalette: (open: boolean) => void
  toast: (level: Toast['level'], message: string, action?: Toast['action']) => void
  dismissToast: (id: number) => void
  pushProgress: (e: ProgressEvent) => void
  clearProgress: (opId: string) => void
  setBusy: (key: string, label: string | null) => void
}

let toastSeq = 1

export const useUi = create<UiStore>((set) => ({
  state: null,
  view: 'dashboard',
  search: '',
  accountFilter: [],
  statusFilter: [],
  tagFilter: [],
  projectFilter: [],
  sort: 'activity',
  selectedRuntimeId: null,
  expanded: {},
  dialogs: [],
  paletteOpen: false,
  toasts: [],
  progress: {},
  busy: {},
  setState: (s) => set({ state: s }),
  setView: (v) => set({ view: v }),
  setSearch: (q) => set({ search: q }),
  toggleFilter: (key, value) =>
    set((st) => ({ [key]: st[key].includes(value) ? st[key].filter((x) => x !== value) : [...st[key], value] }) as Partial<UiStore>),
  setFilter: (key, values) => set({ [key]: values } as Partial<UiStore>),
  clearFilters: () => set({ accountFilter: [], statusFilter: [], tagFilter: [], projectFilter: [], search: '' }),
  setSort: (s) => set({ sort: s }),
  select: (runtimeId) => set({ selectedRuntimeId: runtimeId }),
  toggleExpanded: (id, value) => set((st) => ({ expanded: { ...st.expanded, [id]: value ?? !st.expanded[id] } })),
  openDialog: (d) => set((st) => ({ dialogs: [...st.dialogs, d] })),
  closeDialog: () => set((st) => ({ dialogs: st.dialogs.slice(0, -1) })),
  closeAllDialogs: () => set({ dialogs: [] }),
  setPalette: (open) => set({ paletteOpen: open }),
  toast: (level, message, action) => {
    const id = toastSeq++
    set((st) => ({ toasts: [...st.toasts.slice(-3), { id, level, message, action }] }))
    setTimeout(() => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })), level === 'error' ? 9000 : 4500)
  },
  dismissToast: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),
  pushProgress: (e) =>
    set((st) => {
      const list = [...(st.progress[e.opId] ?? [])]
      const idx = list.findIndex((x) => x.step === e.step)
      if (idx >= 0) list[idx] = e
      else list.push(e)
      return { progress: { ...st.progress, [e.opId]: list } }
    }),
  clearProgress: (opId) =>
    set((st) => {
      const next = { ...st.progress }
      delete next[opId]
      return { progress: next }
    }),
  setBusy: (key, label) =>
    set((st) => {
      const next = { ...st.busy }
      if (label) next[key] = label
      else delete next[key]
      return { busy: next }
    }),
}))

export const ui = () => useUi.getState()
