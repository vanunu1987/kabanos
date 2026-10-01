import { Async } from '../../components/Async'
import { refreshConnection, useTree } from '../../queries'
import { useApp } from '../../store'
import { IndexView } from '../indexView/IndexView'
import { ExplorerTree, useConnection } from './ExplorerTree'
import { IndexPage } from './IndexPage'
import { AliasPage, DataStreamPage, TemplatePage } from './OtherPages'

export function ExplorerScreen({ connectionId }: { connectionId: string }) {
  const conn = useConnection(connectionId)
  const tree = useTree(connectionId)
  const ex = useApp((s) => s.explorer[connectionId]) ?? useApp.getState().explorerOf(connectionId)
  const { select, openQuery } = useApp.getState()
  if (!conn) return null

  if (ex.mode === 'query' && ex.activeQuery) {
    return (
      <>
        {tree.data && <ExplorerTree conn={conn} tree={tree.data} compact onPick={(sel) => openQuery(conn.id, sel.name)} selected={{ kind: 'index', name: ex.activeQuery }} />}
        <IndexView conn={conn} />
      </>
    )
  }

  return (
    <Async query={tree}>
      {(t) => (
        <>
          <ExplorerTree conn={conn} tree={t} onPick={(sel) => select(conn.id, sel)} selected={ex.sel} />
          <main className="main explorer-main">
            <button className="icon-btn refresh-btn" title="Refresh metadata" aria-label="Refresh metadata" onClick={() => refreshConnection(conn.id)}>
              ↻
            </button>
            {!ex.sel ? (
              <ClusterHome conn={conn.name} indices={t.indices.filter((i) => !i.hidden).length} aliases={t.aliases.length} templates={t.templates.filter((x) => x.kind === 'index').length} />
            ) : ex.sel.kind === 'index' ? (
              <IndexPage key={ex.sel.name} conn={conn} name={ex.sel.name} />
            ) : ex.sel.kind === 'alias' ? (
              <AliasPage key={ex.sel.name} conn={conn} name={ex.sel.name} />
            ) : ex.sel.kind === 'datastream' ? (
              <DataStreamPage conn={conn} name={ex.sel.name} tree={t} />
            ) : (
              <TemplatePage conn={conn} name={ex.sel.name} tree={t} />
            )}
          </main>
        </>
      )}
    </Async>
  )
}

function ClusterHome({ conn, indices, aliases, templates }: { conn: string; indices: number; aliases: number; templates: number }) {
  return (
    <div className="placeholder">
      <h2>{conn}</h2>
      <div>
        {indices} indices · {aliases} aliases · {templates} index templates
      </div>
      <div className="hint">Pick an index, alias or template on the left.</div>
    </div>
  )
}
