import { formatBytes, type ClusterTree } from '@shared/meta'
import type { ConnectionConfig } from '@shared/types'
import { Async } from '../../components/Async'
import { JsonView } from '../../components/JsonView'
import { useAliasDetail } from '../../queries'
import { useApp } from '../../store'
import { HealthPill } from './IndexPage'
import { MappingTable } from './MappingTable'
import { useState } from 'react'
import { Menu } from '../../components/Menu'
import { DeleteModal, EmptyModal } from './DangerModals'
import { ExportModal } from '../../components/ExportModal'

export function AliasPage({ conn, name }: { conn: ConnectionConfig; name: string }) {
  const q = useAliasDetail(conn.id, name)
  const { select, openQuery } = useApp.getState()
  const [exporting, setExporting] = useState(false)
  return (
    <div className="page">
      <div className="page-head padded">
        <div className="crumbs">
          Aliases / <span>{name}</span>
        </div>
        <div className="title-row">
          <h1 className="mono">{name}</h1>
          {q.data && <span className="pill alias">→ {q.data.targets.length === 1 ? q.data.targets[0]!.index : `${q.data.targets.length} indices`}</span>}
          <div className="spacer" />
          <button className="btn md" onClick={() => setExporting(true)}>
            Export…
          </button>
          <button className="btn md primary" onClick={() => openQuery(conn.id, name)}>
            Query this alias
          </button>
        </div>
      </div>
      {exporting && <ExportModal conn={conn} target={name} onClose={() => setExporting(false)} />}
      <div className="page-body">
        <Async query={q}>
          {(d) => (
            <div className="overview-split">
              <MappingTable fields={d.fields} raw={d.fields} fill />
              <div className="side-cards">
                <section className="card pad">
                  <h2>Targets</h2>
                  {d.targets.map((t) => (
                    <div key={t.index} className="inline-row">
                      <button className="link mono" onClick={() => select(conn.id, { kind: 'index', name: t.index })}>
                        {t.index}
                      </button>
                      {t.isWriteIndex && <span className="pill tiny accent">write index</span>}
                      {t.filter && <span className="pill tiny">filtered</span>}
                    </div>
                  ))}
                </section>
                {Object.keys(d.filters).length > 0 && (
                  <section className="card pad">
                    <h2>Filters</h2>
                    {Object.entries(d.filters).map(([index, f]) => (
                      <div key={index}>
                        <div className="hint mono">{index}</div>
                        <JsonView value={f} className="inset" />
                      </div>
                    ))}
                  </section>
                )}
              </div>
            </div>
          )}
        </Async>
      </div>
    </div>
  )
}

export function DataStreamPage({ conn, name, tree }: { conn: ConnectionConfig; name: string; tree: ClusterTree }) {
  const ds = tree.dataStreams.find((d) => d.name === name)
  const { select, openQuery } = useApp.getState()
  const [danger, setDanger] = useState<'delete' | 'empty' | null>(null)
  const [exporting, setExporting] = useState(false)
  if (!ds) return <div className="empty">Data stream {name} no longer exists.</div>
  const backing = ds.indices.map((i) => tree.indices.find((x) => x.name === i)).filter((x) => !!x)
  const docs = backing.reduce((n, i) => n + i.docs, 0)
  const bytes = backing.reduce((n, i) => n + i.storeBytes, 0)
  return (
    <div className="page">
      <div className="page-head padded">
        <div className="crumbs">
          Data streams / <span>{name}</span>
        </div>
        <div className="title-row">
          <h1 className="mono">{name}</h1>
          <HealthPill health={ds.health} />
          <div className="spacer" />
          <button className="btn md primary" onClick={() => openQuery(conn.id, name)}>
            Query this data stream
          </button>
          <Menu
            label="More actions"
            items={[
              { label: 'Export documents…', onSelect: () => setExporting(true) },
              'sep',
              { label: 'Empty (delete all documents)…', danger: true, onSelect: () => setDanger('empty') },
              { label: 'Delete data stream…', danger: true, onSelect: () => setDanger('delete') }
            ]}
          >
            ⋯
          </Menu>
        </div>
        {danger === 'delete' && <DeleteModal conn={conn} name={name} kind="datastream" onClose={() => setDanger(null)} onDone={() => (setDanger(null), useApp.getState().updateExplorer(conn.id, { sel: undefined }))} />}
        {danger === 'empty' && <EmptyModal conn={conn} name={name} onClose={() => setDanger(null)} onDone={() => setDanger(null)} />}
        {exporting && <ExportModal conn={conn} target={name} onClose={() => setExporting(false)} />}
      </div>
      <div className="page-body">
        <div className="stats">
          <div className="stat">
            <span className="hint">Documents</span>
            <span className="mono stat-value">{docs.toLocaleString()}</span>
          </div>
          <div className="stat">
            <span className="hint">Store size</span>
            <span className="mono stat-value">{formatBytes(bytes)}</span>
          </div>
          <div className="stat">
            <span className="hint">Backing indices</span>
            <span className="mono stat-value">{ds.indices.length}</span>
          </div>
          <div className="stat">
            <span className="hint">Template</span>
            <span className="mono stat-value small">
              {ds.template ? (
                <button className="link mono" onClick={() => select(conn.id, { kind: 'template', name: ds.template! })}>
                  {ds.template}
                </button>
              ) : (
                '—'
              )}
            </span>
          </div>
        </div>
        <section className="card pad" style={{ marginTop: 16 }}>
          <h2>Backing indices</h2>
          {backing.map((i) => (
            <div key={i.name} className="inline-row between">
              <button className="link mono" onClick={() => select(conn.id, { kind: 'index', name: i.name })}>
                {i.name}
              </button>
              <span className="hint mono">
                {i.docs.toLocaleString()} docs · {formatBytes(i.storeBytes)}
              </span>
            </div>
          ))}
        </section>
      </div>
    </div>
  )
}

export function TemplatePage({ conn, name, tree }: { conn: ConnectionConfig; name: string; tree: ClusterTree }) {
  const t = tree.templates.find((x) => x.name === name)
  const { select } = useApp.getState()
  if (!t) return <div className="empty">Template {name} no longer exists.</div>
  const matching = t.kind === 'index' ? tree.indices.filter((i) => t.patterns.some((p) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(i.name))) : []
  const usedBy = t.kind === 'component' ? tree.templates.filter((x) => x.composedOf.includes(t.name)) : []
  return (
    <div className="page">
      <div className="page-head padded">
        <div className="crumbs">
          {t.kind === 'index' ? 'Index templates' : 'Component templates'} / <span>{name}</span>
        </div>
        <div className="title-row">
          <h1 className="mono">{name}</h1>
          {t.priority !== undefined && <span className="pill">priority {t.priority}</span>}
          {t.dataStream && <span className="pill accent">data stream</span>}
        </div>
      </div>
      <div className="page-body">
        <div className="overview-split">
          <section className="card fill">
            <div className="card-head">
              <h2>Definition</h2>
            </div>
            <JsonView value={t.body} className="card-scroll" />
          </section>
          <div className="side-cards">
            {t.kind === 'index' ? (
              <>
                <section className="card pad">
                  <h2>Index patterns</h2>
                  <div className="mono">{t.patterns.join(', ')}</div>
                  {t.composedOf.length > 0 && (
                    <div className="hint">
                      composed of{' '}
                      {t.composedOf.map((c, i) => (
                        <span key={c}>
                          {i > 0 && ', '}
                          <button className="link mono" onClick={() => select(conn.id, { kind: 'template', name: c })}>
                            {c}
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </section>
                <section className="card pad">
                  <h2>Matching indices · {matching.length}</h2>
                  {matching.slice(0, 30).map((i) => (
                    <button key={i.name} className="link mono left" onClick={() => select(conn.id, { kind: 'index', name: i.name })}>
                      {i.name}
                    </button>
                  ))}
                  {matching.length === 0 && <span className="hint">No existing index matches</span>}
                </section>
              </>
            ) : (
              <section className="card pad">
                <h2>Used by · {usedBy.length}</h2>
                {usedBy.map((u) => (
                  <button key={u.name} className="link mono left" onClick={() => select(conn.id, { kind: 'template', name: u.name })}>
                    {u.name}
                  </button>
                ))}
                {usedBy.length === 0 && <span className="hint">No index template uses this component</span>}
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
