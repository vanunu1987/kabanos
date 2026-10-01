import { useQuery } from '@tanstack/react-query'
import { api } from '../../api'
import { useApp } from '../../store'
import { BrandMark, Wordmark } from '../../shell/Brand'
import { useTheme, type ThemePref } from '../../theme/theme'

const SHORTCUTS: Array<[string, string]> = [
  ['⌘K', 'Command palette — jump to any connection, index, query, routine'],
  ['⌘↵', 'Run the request under the cursor (workspace, index view)'],
  ['⌘I', 'Auto-indent the request / body'],
  ['⌘F', 'Search the query library (outside an editor)'],
  ['⌃Space', 'Trigger autocomplete in an editor'],
  ['⌘/', 'Toggle comment in an editor'],
  ['Double-click', 'Rename a workspace tab, folder or block']
]

export function SettingsScreen() {
  const info = useQuery({ queryKey: ['app-info'], queryFn: () => api.app.info() })
  const clear = async () => {
    if (!confirm('Clear the request history? Saved queries, tabs and routines are kept.')) return
    await api.library.clearHistory()
    await info.refetch()
    useApp.getState().showToast('History cleared')
  }
  return (
    <main className="main">
      <div className="settings">
        <h1>Settings</h1>
        <section className="card pad">
          <div className="about-brand">
            <BrandMark size={56} speedLines />
            <div>
              <Wordmark size={28} />
              <div className="hint">Elasticsearch &amp; OpenSearch desktop client</div>
            </div>
          </div>
          {info.data && (
            <dl className="kv" style={{ margin: 0 }}>
              <dt>Version</dt>
              <dd>{info.data.version}</dd>
              <dt>Electron</dt>
              <dd>
                {info.data.electron} · Chrome {info.data.chrome} · Node {info.data.node}
              </dd>
              <dt>Data folder</dt>
              <dd>
                {info.data.dataDir}{' '}
                <button className="link" onClick={() => api.app.revealData()}>
                  Show in Finder
                </button>
              </dd>
            </dl>
          )}
          <span className="hint">Connections, the query library, history and routines live in a local SQLite file in the data folder. Passwords, API keys and secret variables are encrypted with a key held in the macOS Keychain.</span>
        </section>
        <Appearance />
        <section className="card pad">
          <h2>Request history</h2>
          <div className="inline-row between">
            <span>{info.data?.historyCount.toLocaleString() ?? '…'} requests recorded (newest 20,000 kept)</span>
            <button className="btn md" onClick={clear}>
              Clear history
            </button>
          </div>
        </section>
        <section className="card pad">
          <h2>Keyboard shortcuts</h2>
          {SHORTCUTS.map(([k, v]) => (
            <div key={k} className="inline-row" style={{ gap: 16 }}>
              <span className="mono kbd">{k}</span>
              <span>{v}</span>
            </div>
          ))}
        </section>
        <section className="card pad">
          <h2>Safety</h2>
          <span>
            Per connection: <b>Production</b> asks before any write and shows a warning stripe; <b>Read-only</b> blocks every write (set them on the Connections screen). Both are enforced in the app's main process, so
            routines, the workspace and the explorer all go through them.
          </span>
        </section>
      </div>
    </main>
  )
}

const THEMES: Array<[ThemePref, string]> = [
  ['dark', 'Dark'],
  ['light', 'Light'],
  ['system', 'Match system']
]

function Appearance() {
  const pref = useTheme((s) => s.pref)
  const setPref = useTheme((s) => s.setPref)
  return (
    <section className="card pad">
      <h2>Appearance</h2>
      <div className="inline-row between">
        <span>Theme</span>
        <div role="group" aria-label="Theme" className="segmented">
          {THEMES.map(([id, label]) => (
            <button key={id} className={pref === id ? 'on' : ''} aria-pressed={pref === id} onClick={() => setPref(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <span className="hint">“Match system” follows macOS appearance. The sun / moon button in the title bar switches between light and dark.</span>
    </section>
  )
}
