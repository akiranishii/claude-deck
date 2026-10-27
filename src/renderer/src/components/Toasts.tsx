import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import { useUi } from '../lib/store'
import { cx } from './ui'

export function Toasts() {
  const toasts = useUi((s) => s.toasts)
  const dismiss = useUi((s) => s.dismissToast)
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[90] flex w-[380px] flex-col gap-2">
      {toasts.map((t) => {
        const Icon = t.level === 'success' ? CircleCheck : t.level === 'error' ? CircleAlert : t.level === 'warn' ? TriangleAlert : Info
        const color = t.level === 'success' ? 'text-ok' : t.level === 'error' ? 'text-danger' : t.level === 'warn' ? 'text-warn' : 'text-info'
        return (
          <div key={t.id} className="animate-pop pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line bg-panel px-3 py-2.5 shadow-pop">
            <Icon className={cx('mt-px size-4 shrink-0', color)} />
            <div className="min-w-0 flex-1 text-[12.5px] leading-snug text-fg select-text">{t.message}</div>
            {t.action && (
              <button className="shrink-0 text-[12px] font-medium text-accent hover:underline" onClick={t.action.run}>
                {t.action.label}
              </button>
            )}
            <button className="shrink-0 rounded p-0.5 text-fg-3 hover:text-fg" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <X className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
