import { EngineBadge } from '../components/EngineBadge'
import { COLORS, useApp } from '../store'
import { Icon } from './icons'
import { BrandMark, Wordmark } from './Brand'

export function TitleBar() {
  const { connections, openTabs, activeTab, view } = useApp()
  const { openTab, closeTab, edit, setView } = useApp.getState()
  const byId = new Map(connections.map((c) => [c.id, c]))

  return (
    <header className="titlebar">
      <div className="brand">
        <BrandMark />
        <Wordmark />
      </div>
      {openTabs.length === 0 ? (
        <div style={{ color: 'var(--faint)' }}>Connections</div>
      ) : (
        <div className="conn-tabs" role="tablist" aria-label="Open connections">
          {openTabs.map((id) => {
            const c = byId.get(id)
            if (!c) return null
            const active = id === activeTab && view !== 'connections'
            return (
              <div
                key={id}
                role="tab"
                aria-selected={active}
                tabIndex={0}
                className={`conn-tab${active ? ' active' : ''}${c.isProd ? ' prod' : ''}`}
                title={c.isProd ? `${c.name} — production` : c.name}
                onClick={() => {
                  openTab(id)
                  if (view === 'connections') setView('explorer')
                }}
              >
                <span className="dot" style={{ background: COLORS[c.color] }} />
                <span className="conn-tab-name">{c.name}</span>
                <EngineBadge conn={c} />
                {c.readOnly && <span className="badge ro" title="Read-only: writes are blocked">RO</span>}
                <button className="conn-tab-close" aria-label={`Close ${c.name}`} onClick={(e) => (e.stopPropagation(), closeTab(id))}>
                  {Icon.close()}
                </button>
              </div>
            )
          })}
          <button className="icon-btn" aria-label="New connection" onClick={() => edit(null)}>
            {Icon.plus(14)}
          </button>
        </div>
      )}
      <div className="spacer" />
      <button className="palette-btn" title="Command palette (⌘K)" onClick={() => useApp.setState({ paletteOpen: true })}>
        {Icon.search()}
        <span>Jump to connection, index, query…</span>
        <span className="mono" style={{ fontSize: 11 }}>⌘K</span>
      </button>
    </header>
  )
}
