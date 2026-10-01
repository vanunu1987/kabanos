import { useMemo, useState } from 'react'
import type { ConnectionConfig } from '@shared/types'
import { api } from '../../api'
import { EngineBadge } from '../../components/EngineBadge'
import { Icon } from '../../shell/icons'
import { COLORS, hostOf, useApp } from '../../store'

const FOLDER_ORDER = ['Production', 'Staging', 'Local']

export function ConnectionsSidebar() {
  const connections = useApp((s) => s.connections)
  const editingId = useApp((s) => s.editingId)
  const { edit, refresh, showToast } = useApp.getState()
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const match = (c: ConnectionConfig) => !q || c.name.toLowerCase().includes(q) || hostOf(c).toLowerCase().includes(q) || c.folder.toLowerCase().includes(q)
    const visible = connections.filter(match)
    const out: Array<{ name: string; items: ConnectionConfig[] }> = []
    const favs = visible.filter((c) => c.favorite)
    if (favs.length) out.push({ name: 'Favorites', items: favs })
    const byFolder = new Map<string, ConnectionConfig[]>()
    for (const c of visible.filter((c) => !c.favorite)) byFolder.set(c.folder, [...(byFolder.get(c.folder) ?? []), c])
    const rank = (f: string) => (FOLDER_ORDER.includes(f) ? FOLDER_ORDER.indexOf(f) : FOLDER_ORDER.length)
    for (const [name, items] of [...byFolder].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))) out.push({ name, items })
    return out
  }, [connections, filter])

  const toggle = (name: string) =>
    setCollapsed((s) => {
      const n = new Set(s)
      if (n.has(name)) n.delete(name)
      else n.add(name)
      return n
    })

  const doImport = async () => {
    try {
      const res = await api.connections.importFromFile()
      if (res) {
        await refresh()
        showToast(`Imported ${res.imported} connection${res.imported === 1 ? '' : 's'} — add their passwords or API keys`)
      }
    } catch (e) {
      showToast((e as Error).message)
    }
  }
  const doExport = async () => {
    const res = await api.connections.exportToFile()
    if (res) showToast(`Exported ${res.count} connection${res.count === 1 ? '' : 's'} (no secrets)`)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="sidebar-title">Connections</div>
        <button className="square-btn" aria-label="New connection" title="New connection" onClick={() => edit(null)}>
          {Icon.plus()}
        </button>
      </div>
      <label className="filter">
        {Icon.search()}
        <input aria-label="Filter connections" placeholder="Filter connections" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </label>
      <div className="sidebar-scroll">
        {connections.length === 0 && <div className="hint" style={{ padding: '4px 10px' }}>No saved connections yet. Paste a cluster URL to add one.</div>}
        {groups.map((g) => (
          <div key={g.name} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <button className={`group-head${collapsed.has(g.name) ? ' collapsed' : ''}`} onClick={() => toggle(g.name)} aria-expanded={!collapsed.has(g.name)}>
              {Icon.chevronDown()}
              <span>{g.name}</span>
              <span className="count">{g.items.length}</span>
            </button>
            {!collapsed.has(g.name) &&
              g.items.map((c) => (
                <button key={c.id} className={`conn-row${c.id === editingId ? ' active' : ''}`} onClick={() => edit(c.id)}>
                  <span className="dot" style={{ background: COLORS[c.color] }} />
                  <span className="conn-row-text">
                    <span className="conn-row-name">{c.name}</span>
                    <span className="conn-row-host mono">{hostOf(c)}</span>
                  </span>
                  <EngineBadge conn={c} />
                </button>
              ))}
          </div>
        ))}
      </div>
      <div className="sidebar-foot">
        <button className="link-btn" onClick={doImport}>
          Import…
        </button>
        <button className="link-btn" onClick={doExport} disabled={connections.length === 0}>
          Export…
        </button>
      </div>
    </aside>
  )
}
