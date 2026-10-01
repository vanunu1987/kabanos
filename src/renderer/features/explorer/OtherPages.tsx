import { formatBytes, type AliasDetail, type ClusterTree } from '@shared/meta'
import type { ConnectionConfig } from '@shared/types'
import { Async } from '../../components/Async'
import { JsonView } from '../../components/JsonView'
import { refreshConnection, useAliasDetail, useTree } from '../../queries'
import { api, KabanosError } from '../../api'
import { reason } from './indexActions'
import { useApp } from '../../store'
import { HealthPill } from './IndexPage'
import { MappingTable } from './MappingTable'
import { TemplateMappingEditor } from './TemplateEditor'
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
                <AliasTargets conn={conn} name={name} targets={d.targets} onOpen={(index) => select(conn.id, { kind: 'index', name: index })} />
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

type AliasAction = { add: { index: string; alias: string; is_write_index?: boolean } } | { remove: { index: string; alias: string } }

/** Alias targets with add / remove / make-write-index — one atomic `POST _aliases` each. */
function AliasTargets({ conn, name, targets, onOpen }: { conn: ConnectionConfig; name: string; targets: AliasDetail['targets']; onOpen(index: string): void }) {
  const tree = useTree(conn.id)
  const [adding, setAdding] = useState(false)
  const [index, setIndex] = useState('')
  const [write, setWrite] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const current = new Set(targets.map((t) => t.index))
  const candidates = (tree.data?.indices ?? []).filter((i) => !current.has(i.name) && !i.dataStream && !i.hidden).map((i) => i.name)
  const writeIndex = targets.find((t) => t.isWriteIndex)?.index

  const send = async (actions: AliasAction[], done: string): Promise<boolean> => {
    setBusy(true)
    setError(undefined)
    try {
      const res = await api.cluster.request({ connectionId: conn.id, method: 'POST', path: '_aliases', body: JSON.stringify({ actions }) })
      if (res.status >= 400) {
        setError(reason(res.body))
        return false
      }
      await refreshConnection(conn.id)
      useApp.getState().showToast(done)
      return true
    } catch (e) {
      if (!(e instanceof KabanosError && e.code === 'NOT_CONFIRMED')) setError((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }

  const add = async () => {
    const target = index.trim()
    if (!target) return
    // Only one write index per alias: demote the current one in the same atomic call.
    const actions: AliasAction[] = write && writeIndex ? [{ add: { index: writeIndex, alias: name, is_write_index: false } }] : []
    actions.push({ add: { index: target, alias: name, ...(write ? { is_write_index: true } : {}) } })
    if (await send(actions, `Added ${target} to ${name}`)) (setAdding(false), setIndex(''), setWrite(false))
  }
  const remove = async (t: AliasDetail['targets'][number]) => {
    const last = targets.length === 1
    const warn = last
      ? `${t.index} is the only index behind ${name} — removing it deletes the alias.`
      : t.isWriteIndex && targets.length > 2
        ? `${t.index} is the write index — writes to ${name} will fail until you make another index the write index.`
        : ''
    if (!confirm(`Remove ${t.index} from alias ${name}?${warn ? `\n\n${warn}` : ''}`)) return
    // The last remaining index becomes the write index, or writes to the alias would fail.
    const rest = targets.filter((x) => x.index !== t.index)
    const promote: AliasAction[] = t.isWriteIndex && rest.length === 1 ? [{ add: { index: rest[0]!.index, alias: name, is_write_index: true } }] : []
    const ok = await send([{ remove: { index: t.index, alias: name } }, ...promote], last ? `Removed ${t.index} — alias ${name} no longer exists` : `Removed ${t.index} from ${name}`)
    if (ok && last) useApp.getState().updateExplorer(conn.id, { sel: undefined })
  }
  const makeWrite = (t: AliasDetail['targets'][number]) =>
    send([...(writeIndex ? [{ add: { index: writeIndex, alias: name, is_write_index: false } }] : []), { add: { index: t.index, alias: name, is_write_index: true } }] as AliasAction[], `${t.index} is now the write index of ${name}`)

  return (
    <section className="card pad" aria-label="Alias targets">
      <div className="inline-row between">
        <h2>Targets</h2>
        {!adding && (
          <button className="link" onClick={() => setAdding(true)} disabled={busy}>
            + Add index
          </button>
        )}
      </div>
      {targets.map((t) => (
        <div key={t.index} className="inline-row alias-target">
          <button className="link mono" onClick={() => onOpen(t.index)}>
            {t.index}
          </button>
          {t.isWriteIndex && <span className="pill tiny accent">write index</span>}
          {t.filter && <span className="pill tiny" title="This index joins the alias with a filter">filtered</span>}
          <span className="alias-target-actions">
            {!t.isWriteIndex && targets.length > 1 && (
              <button className="link-btn" onClick={() => makeWrite(t)} disabled={busy}>
                Make write index
              </button>
            )}
            <button className="link-btn danger" aria-label={`Remove ${t.index} from ${name}`} title={`Remove ${t.index} from ${name}`} onClick={() => remove(t)} disabled={busy}>
              ✕
            </button>
          </span>
        </div>
      ))}
      {adding && (
        <div className="alias-add">
          <input className="input sm mono" list={`alias-add-${name}`} autoFocus placeholder="index name" aria-label="Index to add" value={index} onChange={(e) => setIndex(e.target.value)} onKeyDown={(e) => (e.key === 'Enter' ? void add() : e.key === 'Escape' && setAdding(false))} spellCheck={false} />
          <datalist id={`alias-add-${name}`}>
            {candidates.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <label className="inline-row hint">
            <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} /> write index{writeIndex ? ` (instead of ${writeIndex})` : ''}
          </label>
          <div className="inline-row">
            <button className="btn xs primary" onClick={add} disabled={busy || !index.trim()}>
              Add
            </button>
            <button className="btn xs" onClick={() => (setAdding(false), setError(undefined))}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <div className="hint error">{error}</div>}
    </section>
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
          <div className="tpl-main">
            <TemplateMappingEditor key={JSON.stringify(t.body)} conn={conn} t={t} />
          </div>
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
            <section className="card pad">
              <h2>Definition</h2>
              <JsonView value={t.body} className="inset" maxHeight={320} />
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
