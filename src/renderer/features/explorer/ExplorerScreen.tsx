import { treeCounts, type ClusterTree } from '@shared/meta'
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
              <ClusterHome conn={conn.name} tree={t} />
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

function ClusterHome({ conn, tree }: { conn: string; tree: ClusterTree }) {
  const { shown, system } = treeCounts(tree)
  const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`
  const parts = [
    plural(shown.indices, 'index', 'indices'),
    shown.dataStreams ? plural(shown.dataStreams, 'data stream') : '',
    plural(shown.aliases, 'alias', 'aliases'),
    plural(shown.indexTemplates, 'index template')
  ].filter(Boolean)
  const hidden = [
    system.indices ? plural(system.indices, 'index', 'indices') : '',
    system.dataStreams ? plural(system.dataStreams, 'data stream') : '',
    system.aliases ? plural(system.aliases, 'alias', 'aliases') : '',
    system.indexTemplates + system.componentTemplates ? plural(system.indexTemplates + system.componentTemplates, 'template') : ''
  ].filter(Boolean)
  return (
    <div className="placeholder">
      <h2>{conn}</h2>
      <div>{parts.join(' · ')}</div>
      {hidden.length > 0 && <div className="hint">plus system objects hidden by “Hide system”: {hidden.join(' · ')}</div>}
      <div className="hint">Pick an index, alias or template on the left.</div>
    </div>
  )
}
