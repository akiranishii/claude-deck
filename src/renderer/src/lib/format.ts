export function relTime(iso: string | number | null | undefined, now = Date.now()): string {
  if (iso === null || iso === undefined || iso === '') return '—'
  const t = typeof iso === 'number' ? iso : Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const s = Math.round((now - t) / 1000)
  if (s < -30) return 'in the future'
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.round(mo / 12)}y ago`
}

export function duration(fromIso: string | null | undefined, now = Date.now()): string {
  if (!fromIso) return '—'
  const t = Date.parse(fromIso)
  if (!Number.isFinite(t)) return '—'
  let s = Math.max(0, Math.round((now - t) / 1000))
  const d = Math.floor(s / 86400)
  s -= d * 86400
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}

export function absTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function tildePath(path: string | null | undefined, home: string | null | undefined): string {
  if (!path) return ''
  if (!home) return path
  const h = home.replace(/\/+$/, '')
  if (path === h) return '~'
  return path.startsWith(`${h}/`) ? `~/${path.slice(h.length + 1)}` : path
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export function modelLabel(model: string | null | undefined): string | null {
  if (!model) return null
  const m = /claude-([a-z]+)-(\d+)-(\d+)/.exec(model)
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`
  return model
}

export function shortSession(id: string): string {
  return id.length > 16 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  const digits = name.match(/\d+/)?.[0]
  if (parts.length > 1 && digits) return `${parts[0][0]}${digits}`.toUpperCase().slice(0, 3)
  if (parts.length > 1) return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
  return name.slice(0, 2).toUpperCase()
}
