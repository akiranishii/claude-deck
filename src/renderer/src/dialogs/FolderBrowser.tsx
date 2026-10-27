import type { DirListing } from '@shared/ipc'
import { ChevronRight, CornerLeftUp, Folder, FolderGit2, House, LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button, Checkbox, cx } from '../components/ui'
import { call, errorMessage } from '../lib/api'

export function FolderBrowser({ hostId, initialPath, onPick, onCancel, pickLabel = 'Use this folder' }: { hostId: string; initialPath: string; onPick: (path: string) => void; onCancel: () => void; pickLabel?: string }) {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(
    async (path: string, showHidden = hidden) => {
      setLoading(true)
      setError(null)
      try {
        const res = await call('remote.listDir', { hostId, path, showHidden })
        setListing(res)
        setSelected(null)
      } catch (err) {
        setError(errorMessage(err))
        if (!listing && path !== '~') {
          // Fall back to the home directory if the initial path does not exist yet.
          const res = await call('remote.listDir', { hostId, path: '~', showHidden }).catch(() => null)
          if (res) setListing(res)
        }
      } finally {
        setLoading(false)
      }
    },
    [hostId, hidden, listing],
  )

  useEffect(() => {
    void load(initialPath || '~')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const crumbs = listing ? listing.path.split('/').filter(Boolean) : []
  const target = selected ? `${listing?.path.replace(/\/$/, '')}/${selected}` : listing?.path ?? ''

  return (
    <div className="flex h-[360px] flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <button className="rounded p-1 text-fg-3 hover:bg-panel-2 hover:text-fg" onClick={() => listing?.home && void load(listing.home)} aria-label="Home">
          <House className="size-3.5" />
        </button>
        <button className="rounded p-1 text-fg-3 hover:bg-panel-2 hover:text-fg disabled:opacity-40" disabled={!listing?.parent} onClick={() => listing?.parent && void load(listing.parent)} aria-label="Up">
          <CornerLeftUp className="size-3.5" />
        </button>
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto font-mono text-[11.5px] text-fg-2">
          <button className="shrink-0 rounded px-1 hover:bg-panel-2" onClick={() => void load('/')}>
            /
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex shrink-0 items-center">
              <ChevronRight className="size-3 text-fg-3" />
              <button className="rounded px-1 hover:bg-panel-2" onClick={() => void load(`/${crumbs.slice(0, i + 1).join('/')}`)}>
                {c}
              </button>
            </span>
          ))}
        </div>
        {loading && <LoaderCircle className="size-3.5 animate-spin-slow text-fg-3" />}
        <label className="flex shrink-0 items-center gap-1.5 pl-2 text-[11.5px] text-fg-3">
          <Checkbox
            checked={hidden}
            onChange={(v) => {
              setHidden(v)
              if (listing) void load(listing.path, v)
            }}
          />
          Hidden
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {error && <div className="px-2 py-1.5 text-[12px] text-danger">{error}</div>}
        {listing?.entries.map((e) => (
          <button
            key={e.name}
            type="button"
            onClick={() => setSelected(e.name)}
            onDoubleClick={() => void load(`${listing.path.replace(/\/$/, '')}/${e.name}`)}
            className={cx('flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px]', selected === e.name ? 'bg-accent text-accent-fg' : 'hover:bg-panel-2')}
          >
            {e.isGit ? <FolderGit2 className={cx('size-3.5 shrink-0', selected === e.name ? '' : 'text-accent')} /> : <Folder className={cx('size-3.5 shrink-0', selected === e.name ? '' : 'text-fg-3')} />}
            <span className="truncate">{e.name}</span>
            {e.isSymlink && <span className="text-[10.5px] opacity-70">link</span>}
          </button>
        ))}
        {listing && !listing.entries.length && !error && <div className="px-2 py-6 text-center text-[12px] text-fg-3">No sub-folders</div>}
        {listing?.truncated && <div className="px-2 py-1 text-[11px] text-fg-3">Showing the first 2000 folders</div>}
      </div>
      <div className="flex items-center gap-2 border-t border-line bg-panel-2/60 px-2.5 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-2">{target}</span>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={!target} onClick={() => onPick(target)}>
          {pickLabel}
        </Button>
      </div>
    </div>
  )
}
