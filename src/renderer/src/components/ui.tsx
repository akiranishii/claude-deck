import * as RDialog from '@radix-ui/react-dialog'
import * as RMenu from '@radix-ui/react-dropdown-menu'
import * as RTooltip from '@radix-ui/react-tooltip'
import clsx from 'clsx'
import { Check, ChevronDown, CircleAlert, Info, LoaderCircle, TriangleAlert, X } from 'lucide-react'
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'

export const cx = clsx

// --------------------------------------------------------------------------- buttons

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle'
type Size = 'xs' | 'sm' | 'md' | 'lg'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-strong shadow-[0_1px_0_rgb(0_0_0/0.06)] border border-transparent',
  secondary: 'bg-panel text-fg border border-line hover:bg-panel-2 hover:border-line-strong shadow-card',
  ghost: 'bg-transparent text-fg-2 hover:bg-panel-2 hover:text-fg border border-transparent',
  danger: 'bg-danger text-white hover:brightness-95 border border-transparent',
  subtle: 'bg-panel-2 text-fg hover:bg-panel-3 border border-transparent',
}
const SIZES: Record<Size, string> = {
  xs: 'h-6 px-2 text-[11.5px] gap-1 rounded-md',
  sm: 'h-7 px-2.5 text-[12px] gap-1.5 rounded-md',
  md: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  lg: 'h-9 px-4 text-[13.5px] gap-2 rounded-lg',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cx(
        'inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors duration-100 select-none disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-3.5 animate-spin-slow" /> : icon}
      {children}
    </button>
  )
})

export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(function IconButton(
  { label, variant = 'ghost', size = 'sm', className, children, ...rest },
  ref,
) {
  const dims = size === 'xs' ? 'size-6' : size === 'sm' ? 'size-7' : size === 'md' ? 'size-8' : 'size-9'
  return (
    <Tip label={label}>
      <Button ref={ref} aria-label={label} variant={variant} size={size} className={cx('!px-0', dims, className)} {...rest}>
        {children}
      </Button>
    </Tip>
  )
})

// ---------------------------------------------------------------------------- inputs

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; invalid?: boolean }>(function Input(
  { className, mono, invalid, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      spellCheck={false}
      autoComplete="off"
      className={cx(
        'h-8 w-full rounded-lg border bg-panel px-2.5 text-[13px] text-fg placeholder:text-fg-3 outline-none transition-colors',
        'focus:border-accent focus:ring-3 focus:ring-accent/15',
        invalid ? 'border-danger' : 'border-line hover:border-line-strong',
        mono && 'font-mono text-[12px]',
        className,
      )}
      {...rest}
    />
  )
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(function Textarea(
  { className, mono, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      spellCheck={false}
      className={cx(
        'w-full rounded-lg border border-line bg-panel px-2.5 py-2 text-[13px] text-fg placeholder:text-fg-3 outline-none hover:border-line-strong focus:border-accent focus:ring-3 focus:ring-accent/15',
        mono && 'font-mono text-[12px]',
        className,
      )}
      {...rest}
    />
  )
})

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cx('relative', className)}>
      <select
        className="h-8 w-full appearance-none rounded-lg border border-line bg-panel pr-8 pl-2.5 text-[13px] text-fg outline-none hover:border-line-strong focus:border-accent focus:ring-3 focus:ring-accent/15 disabled:opacity-60"
        {...rest}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-fg-3" />
    </div>
  )
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-line-strong',
      )}
    >
      <span className={cx('size-[14px] rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[14px]' : 'translate-x-[2px]')} />
    </button>
  )
}

export function Checkbox({ checked, onChange, disabled, indeterminate }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; indeterminate?: boolean }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className={cx(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors disabled:opacity-50',
        checked || indeterminate ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong bg-panel hover:border-fg-3',
      )}
    >
      {indeterminate ? <span className="h-0.5 w-2 rounded bg-current" /> : checked ? <Check className="size-3" strokeWidth={3} /> : null}
    </button>
  )
}

export function Segmented<T extends string>({ value, onChange, options, size = 'sm' }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; title?: string }[]; size?: 'sm' | 'md' }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-panel-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            'inline-flex items-center gap-1.5 rounded-md px-2 font-medium transition-colors',
            size === 'sm' ? 'h-6 text-[12px]' : 'h-7 text-[12.5px]',
            value === o.value ? 'bg-panel text-fg shadow-card' : 'text-fg-3 hover:text-fg-2',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function NeedTag({ need }: { need: 'required' | 'optional' }) {
  return need === 'required' ? (
    <span className="ml-1.5 rounded px-1 py-px text-[10px] font-semibold tracking-wide text-accent uppercase ring-1 ring-accent/30">Required</span>
  ) : (
    <span className="ml-1.5 text-[10.5px] font-normal text-fg-3">Optional</span>
  )
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
  right,
  need,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  children: ReactNode
  className?: string
  right?: ReactNode
  /** Shows a Required / Optional tag next to the label. */
  need?: 'required' | 'optional'
}) {
  return (
    <label className={cx('block', className)}>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-fg-2">
          {label}
          {need && <NeedTag need={need} />}
        </span>
        {right}
      </div>
      {children}
      {error ? <div className="mt-1 text-[11.5px] text-danger">{error}</div> : hint ? <div className="mt-1 text-[11.5px] text-fg-3">{hint}</div> : null}
    </label>
  )
}

// ---------------------------------------------------------------------------- display

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cx('inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-line bg-panel-2 px-1 font-sans text-[10.5px] font-medium text-fg-3', className)}>
      {children}
    </kbd>
  )
}

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info' | 'offline'
const TONES: Record<Tone, string> = {
  neutral: 'bg-panel-2 text-fg-2 border-line',
  accent: 'bg-accent-soft text-accent border-transparent',
  ok: 'bg-ok-soft text-ok border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  info: 'bg-info-soft text-info border-transparent',
  offline: 'bg-offline-soft text-offline border-transparent',
}

export function Badge({ tone = 'neutral', children, className, icon, title }: { tone?: Tone; children: ReactNode; className?: string; icon?: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex h-[20px] items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium whitespace-nowrap', TONES[tone], className)}>
      {icon}
      {children}
    </span>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cx('size-3.5 animate-spin-slow text-fg-3', className)} />
}

export function Callout({ tone = 'info', title, children, action, className }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  const Icon = tone === 'danger' ? CircleAlert : tone === 'warn' ? TriangleAlert : tone === 'ok' ? Check : Info
  const styles = {
    info: 'border-info/25 bg-info-soft text-fg',
    warn: 'border-warn/30 bg-warn-soft text-fg',
    danger: 'border-danger/30 bg-danger-soft text-fg',
    ok: 'border-ok/25 bg-ok-soft text-fg',
  }[tone]
  const iconColor = { info: 'text-info', warn: 'text-warn', danger: 'text-danger', ok: 'text-ok' }[tone]
  return (
    <div className={cx('flex items-start gap-2.5 rounded-xl border px-3 py-2.5', styles, className)}>
      <Icon className={cx('mt-[1px] size-4 shrink-0', iconColor)} />
      <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className="text-fg-2">{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  )
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {icon && <div className="mb-3 flex size-11 items-center justify-center rounded-2xl border border-line bg-panel text-fg-3 shadow-card">{icon}</div>}
      <div className="text-[14px] font-semibold">{title}</div>
      {children && <div className="mt-1 max-w-md text-[12.5px] text-fg-3">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function SectionTitle({ children, right, className }: { children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cx('mb-2.5 flex items-center justify-between gap-3', className)}>
      <h3 className="text-[11px] font-semibold tracking-[0.06em] text-fg-3 uppercase">{children}</h3>
      {right}
    </div>
  )
}

export function Mono({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx('font-mono text-[11.5px] text-fg-2', className)}>
      {children}
    </span>
  )
}

// --------------------------------------------------------------------------- tooltip

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RTooltip.Provider delayDuration={350} skipDelayDuration={150}>
      {children}
    </RTooltip.Provider>
  )
}

export function Tip({ label, children, side = 'top' }: { label: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  if (!label) return <>{children}</>
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="animate-fade z-[80] max-w-[320px] rounded-lg bg-[#1b1f27] px-2.5 py-1.5 text-[11.5px] leading-snug text-white shadow-pop dark:bg-[#2a303c]"
        >
          {label}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  )
}

// ---------------------------------------------------------------------------- dialog

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 560,
  icon,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: number
  icon?: ReactNode
}) {
  return (
    <RDialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <RDialog.Portal>
        <RDialog.Overlay className="animate-fade fixed inset-0 z-50 bg-overlay backdrop-blur-[1.5px]" />
        <RDialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            const target = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('[data-autofocus]')
            if (target) {
              e.preventDefault()
              target.focus()
            }
          }}
          className="animate-pop fixed top-[8vh] left-1/2 z-50 flex max-h-[84vh] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-pop outline-none"
          style={{ width: `min(${width}px, calc(100vw - 48px))` }}
        >
          <div className="flex items-start gap-3 border-b border-line px-5 pt-4 pb-3.5">
            {icon && <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-panel-2 text-fg-2">{icon}</div>}
            <div className="min-w-0 flex-1">
              <RDialog.Title className="text-[15px] font-semibold tracking-[-0.01em]">{title}</RDialog.Title>
              {description && <RDialog.Description className="mt-0.5 text-[12.5px] text-fg-3">{description}</RDialog.Description>}
            </div>
            <RDialog.Close asChild>
              <button className="-mr-1 rounded-md p-1 text-fg-3 hover:bg-panel-2 hover:text-fg" aria-label="Close">
                <X className="size-4" />
              </button>
            </RDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 select-text">{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 border-t border-line bg-panel-2/60 px-5 py-3">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}

// ------------------------------------------------------------------------------ menu

export interface MenuItem {
  label: ReactNode
  icon?: ReactNode
  onSelect?: () => void
  danger?: boolean
  disabled?: boolean
  hint?: ReactNode
  separatorBefore?: boolean
  checked?: boolean
}

export function Menu({ trigger, items, align = 'end', header }: { trigger: ReactNode; items: (MenuItem | null | false | undefined | '' | 0)[]; align?: 'start' | 'end'; header?: ReactNode }) {
  return (
    <RMenu.Root modal={false}>
      <RMenu.Trigger asChild>{trigger}</RMenu.Trigger>
      <RMenu.Portal>
        <RMenu.Content
          align={align}
          sideOffset={4}
          collisionPadding={8}
          className="animate-pop z-[60] min-w-[220px] rounded-xl border border-line bg-panel p-1 shadow-pop"
          onClick={(e) => e.stopPropagation()}
        >
          {header && <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-fg-3 uppercase">{header}</div>}
          {items.filter(Boolean).map((raw, i) => {
            const item = raw as MenuItem
            return (
              <div key={i}>
                {item.separatorBefore && i > 0 && <RMenu.Separator className="my-1 h-px bg-line" />}
                <RMenu.Item
                  disabled={item.disabled}
                  onSelect={() => item.onSelect?.()}
                  className={cx(
                    'flex h-8 cursor-default items-center gap-2 rounded-lg px-2.5 text-[12.5px] outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-panel-2',
                    item.danger ? 'text-danger' : 'text-fg',
                  )}
                >
                  <span className={cx('flex size-4 items-center justify-center', item.danger ? 'text-danger' : 'text-fg-3')}>
                    {item.checked !== undefined ? item.checked ? <Check className="size-3.5" /> : null : item.icon}
                  </span>
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.hint && <span className="text-[11px] text-fg-3">{item.hint}</span>}
                </RMenu.Item>
              </div>
            )
          })}
        </RMenu.Content>
      </RMenu.Portal>
    </RMenu.Root>
  )
}
