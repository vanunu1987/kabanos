import { useEffect } from 'react'
import { ConnectionsScreen } from './features/connections/ConnectionsScreen'
import { ExplorerScreen } from './features/explorer/ExplorerScreen'
import { WorkspaceScreen } from './features/workspace/WorkspaceScreen'
import { RoutinesScreen } from './features/routines/RoutinesScreen'
import { StackScreen } from './features/security/StackScreen'
import { SettingsScreen } from './features/settings/SettingsScreen'
import { ActivityBar } from './shell/ActivityBar'
import { TitleBar } from './shell/TitleBar'
import { CommandPalette } from './shell/CommandPalette'
import { useApp } from './store'

export function App() {
  const view = useApp((s) => s.view)
  const toast = useApp((s) => s.toast)
  const activeTab = useApp((s) => s.activeTab)
  const activeConn = useApp((s) => s.connections.find((c) => c.id === s.activeTab))

  const paletteOpen = useApp((s) => s.paletteOpen)
  useEffect(() => {
    void useApp.getState().refresh()
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        useApp.setState((s) => ({ paletteOpen: !s.paletteOpen }))
      }
    }
    window.addEventListener('keydown', onKey, true)
    const offOpen = window.kabanosIpc.onOpenConnection((id) => {
      useApp.getState().openTab(id)
      useApp.getState().setView('explorer')
    })
    return () => {
      window.removeEventListener('keydown', onKey, true)
      offOpen()
    }
  }, [])

  return (
    <div className="app">
      <TitleBar />
      <div className="body">
        <ActivityBar />
        {view === 'connections' ? (
          <ConnectionsScreen />
        ) : view === 'explorer' && activeTab ? (
          <ExplorerScreen key={activeTab} connectionId={activeTab} />
        ) : view === 'workspace' ? (
          <WorkspaceScreen />
        ) : view === 'routines' ? (
          <RoutinesScreen />
        ) : view === 'settings' ? (
          <SettingsScreen />
        ) : view === 'security' && activeConn ? (
          <StackScreen key={activeConn.id} conn={activeConn} />
        ) : (
          <main className="main">
            <NoConnection />
          </main>
        )}
      </div>
      {paletteOpen && <CommandPalette onClose={() => useApp.setState({ paletteOpen: false })} />}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  )
}

function NoConnection() {
  return (
    <div className="placeholder">
      <h2>No connection open</h2>
      <div>Open a connection first — the Explorer and Stack management work on the active connection tab.</div>
      <button className="btn md primary" style={{ marginTop: 8 }} onClick={() => useApp.getState().setView('connections')}>
        Go to Connections
      </button>
    </div>
  )
}
