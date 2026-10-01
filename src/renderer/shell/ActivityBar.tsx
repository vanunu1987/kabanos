import type { ReactElement } from 'react'
import { useApp, type View } from '../store'
import { Icon } from './icons'

const ITEMS: Array<{ view: View; label: string; icon: () => ReactElement }> = [
  { view: 'connections', label: 'Connections', icon: Icon.connections },
  { view: 'explorer', label: 'Explorer', icon: Icon.explorer },
  { view: 'workspace', label: 'Query workspace', icon: Icon.workspace },
  { view: 'routines', label: 'Routines', icon: Icon.routines },
  { view: 'security', label: 'Stack management', icon: Icon.security }
]

export function ActivityBar() {
  const view = useApp((s) => s.view)
  const setView = useApp((s) => s.setView)
  const button = (item: (typeof ITEMS)[number] | { view: View; label: string; icon: () => ReactElement }) => (
    <button
      key={item.view}
      className={`ab${view === item.view ? ' on' : ''}`}
      aria-label={item.label}
      aria-current={view === item.view ? 'page' : undefined}
      title={item.label}
      onClick={() => setView(item.view)}
    >
      {item.icon()}
    </button>
  )
  return (
    <nav className="activity" aria-label="Main">
      {ITEMS.map(button)}
      <div className="spacer" />
      {button({ view: 'settings', label: 'Settings', icon: Icon.settings })}
    </nav>
  )
}
