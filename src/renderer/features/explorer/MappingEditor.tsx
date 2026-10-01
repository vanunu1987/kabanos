import { useState } from 'react'
import { addField, copyableSettings, diffMappings, FIELD_TYPES, getField, nextIndexName, reindexRoutine, replaceField, type FieldDef, type Mapping, type MappingDiff } from '@shared/mappingEdit'
import type { IndexDetail } from '@shared/meta'
import type { ConnectionConfig } from '@shared/types'
import { api, KabanosError } from '../../api'
import { CodeEditor } from '../../components/CodeEditor'
import { Modal } from '../../components/Modal'
import { refreshConnection, useTree } from '../../queries'
import { useApp } from '../../store'
import { useRoutines } from '../routines/store'
import { reason } from './indexActions'
import { MappingTable } from './MappingTable'

const ANALYZERS = ['standard', 'simple', 'whitespace', 'keyword', 'english', 'french', 'german', 'spanish', 'arabic', 'russian', 'cjk']

/** Mapping tab with editing: new fields apply in place; changes to existing fields go through a reindex. */
export function MappingEditor({ conn, detail }: { conn: ConnectionConfig; detail: IndexDetail }) {
  const mapping = (detail.mapping ?? {}) as Mapping
  const [modal, setModal] = useState<{ kind: 'add' } | { kind: 'edit'; path: string } | { kind: 'json' } | { kind: 'reindex'; next: Mapping; diff: MappingDiff } | null>(null)
  const closed = detail.summary?.status === 'close'

  const apply = async (next: Mapping, ok: string): Promise<string | null> => {
    try {
      const res = await api.cluster.request({ connectionId: conn.id, method: 'PUT', path: `${encodeURIComponent(detail.name)}/_mapping`, body: JSON.stringify(next) })
      if (res.status >= 400) return reason(res.body)
      useApp.getState().showToast(ok)
      await refreshConnection(conn.id)
      return null
    } catch (e) {
      if (e instanceof KabanosError && e.code === 'NOT_CONFIRMED') return 'Not applied — confirmation declined'
      return (e as Error).message
    }
  }

  /** Additions apply directly; anything else needs the reindex warning first. */
  const submit = async (next: Mapping, ok: string): Promise<string | null> => {
    const diff = diffMappings(mapping, next)
    if (diff.changed.length || diff.removed.length) {
      setModal({ kind: 'reindex', next, diff })
      return null
    }
    if (!diff.added.length && JSON.stringify(next) === JSON.stringify(mapping)) return 'Nothing changed'
    const err = await apply(next, ok)
    if (!err) setModal(null)
    return err
  }

  return (
    <>
      <MappingTable
        fields={detail.fields}
        raw={detail.mapping}
        fill
        onEditField={closed ? undefined : (path) => setModal({ kind: 'edit', path })}
        toolbar={
          !closed && (
            <>
              <button className="btn xs" onClick={() => setModal({ kind: 'json' })}>
                Edit JSON
              </button>
              <button className="btn xs primary" onClick={() => setModal({ kind: 'add' })}>
                + Add field
              </button>
            </>
          )
        }
      />
      {modal?.kind === 'add' && <FieldModal conn={conn} detail={detail} mapping={mapping} onClose={() => setModal(null)} submit={submit} />}
      {modal?.kind === 'edit' && <FieldModal conn={conn} detail={detail} mapping={mapping} editPath={modal.path} onClose={() => setModal(null)} submit={submit} />}
      {modal?.kind === 'json' && <JsonModal mapping={mapping} onClose={() => setModal(null)} submit={submit} />}
      {modal?.kind === 'reindex' && <ReindexModal conn={conn} detail={detail} next={modal.next} diff={modal.diff} apply={apply} onClose={() => setModal(null)} />}
    </>
  )
}

function FieldModal({ conn, detail, mapping, editPath, onClose, submit }: { conn: ConnectionConfig; detail: IndexDetail; mapping: Mapping; editPath?: string; onClose(): void; submit(next: Mapping, ok: string): Promise<string | null> }) {
  const existing = editPath ? (getField(mapping, editPath) ?? multiField(mapping, editPath)) : undefined
  const { type: t0, properties: _p, fields: _f, ...params0 } = existing ?? {}
  const [path, setPath] = useState(editPath ?? '')
  const [parent, setParent] = useState('')
  const [type, setType] = useState<string>(t0 ?? (existing?.properties ? 'object' : 'keyword'))
  const [analyzer, setAnalyzer] = useState(String(params0.analyzer ?? ''))
  const [ignoreAbove, setIgnoreAbove] = useState(params0.ignore_above !== undefined ? String(params0.ignore_above) : '')
  const [format, setFormat] = useState(String(params0.format ?? ''))
  const [scaling, setScaling] = useState(params0.scaling_factor !== undefined ? String(params0.scaling_factor) : '100')
  const [dims, setDims] = useState(params0.dims !== undefined ? String(params0.dims) : '')
  const [keywordSub, setKeywordSub] = useState(!editPath)
  const [extra, setExtra] = useState(() => {
    const { analyzer: _a, ignore_above: _i, format: _fm, scaling_factor: _s, dims: _d, ...rest } = params0
    return Object.keys(rest).length ? JSON.stringify(rest) : ''
  })
  const [backfill, setBackfill] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const leafFields = detail.fields.filter((f) => !f.multiField && f.type !== 'object' && f.type !== 'nested')

  const build = (): FieldDef => {
    const def: FieldDef = type === 'object' ? {} : { type }
    if (type === 'object' && existing?.type === 'object') def.type = 'object'
    if ((type === 'text' || type === 'search_as_you_type' || type === 'match_only_text') && analyzer) def.analyzer = analyzer
    if (type === 'keyword' && ignoreAbove) def.ignore_above = Number(ignoreAbove)
    if ((type === 'date' || type === 'date_nanos') && format) def.format = format
    if (type === 'scaled_float') def.scaling_factor = Number(scaling)
    if (type === 'dense_vector' && dims) def.dims = Number(dims)
    if (type === 'text' && keywordSub && !editPath && !parent) def.fields = { keyword: { type: 'keyword', ignore_above: 256 } }
    if (extra.trim()) Object.assign(def, JSON.parse(extra) as object)
    if (type === 'object' || type === 'nested') def.properties ??= {}
    return def
  }

  const save = async () => {
    setError(null)
    let def: FieldDef
    try {
      def = build()
    } catch {
      return setError('Extra parameters must be a JSON object')
    }
    let next: Mapping
    const fullPath = parent ? `${parent}.${path.trim()}` : path.trim()
    try {
      next = editPath ? replaceField(mapping, editPath, def) : addField(mapping, fullPath, def, !!parent)
    } catch (e) {
      return setError((e as Error).message)
    }
    setBusy(true)
    const err = await submit(next, editPath ? `Updated ${editPath}` : `Added ${fullPath}`)
    setBusy(false)
    if (err) return setError(err)
    if (!editPath && backfill) {
      // Index existing documents into the new field (runs in the background on the cluster).
      try {
        const res = await api.cluster.request({ connectionId: conn.id, method: 'POST', path: `${encodeURIComponent(detail.name)}/_update_by_query?conflicts=proceed&wait_for_completion=false` })
        const task = res.status < 400 ? (JSON.parse(res.body) as { task?: string }).task : undefined
        useApp.getState().showToast(task ? `Re-indexing existing documents in place (task ${task}) — see Stack management → Tasks` : `_update_by_query failed: ${reason(res.body)}`)
      } catch (e) {
        if (!(e instanceof KabanosError && e.code === 'NOT_CONFIRMED')) useApp.getState().showToast((e as Error).message)
      }
    }
  }

  return (
    <Modal
      title={editPath ? `Edit field ${editPath}` : `Add field to ${detail.name}`}
      width={560}
      onClose={onClose}
      actions={
        <>
          {error && <span className="hint error left">{error}</span>}
          <button className="btn md" onClick={onClose}>
            Cancel
          </button>
          <button className="btn md primary" disabled={busy || (!editPath && !path.trim())} onClick={save}>
            {editPath ? 'Review change' : 'Add field'}
          </button>
        </>
      }
    >
      {editPath ? (
        <div className="reindex-note">
          <b>Editing an existing field usually requires a reindex.</b> Elasticsearch can't change a field's type or analysis in place — only a few parameters (like <span className="mono">ignore_above</span>) can be
          updated. You'll see what applies before anything changes.
        </div>
      ) : (
        <div className="grid-2">
          <div className="field">
            <label htmlFor="f-name">Field name</label>
            <input id="f-name" className="input mono" autoFocus value={path} onChange={(e) => setPath(e.target.value)} placeholder={parent ? 'english' : 'seller.phone'} spellCheck={false} />
          </div>
          <div className="field">
            <label htmlFor="f-parent">Add as sub-field of</label>
            <select id="f-parent" className="select" value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">— a new field —</option>
              {leafFields.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path} ({f.type})
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      <div className="grid-2">
        <div className="field">
          <label htmlFor="f-type">Type</label>
          <select id="f-type" className="select" value={type} onChange={(e) => setType(e.target.value)}>
            {FIELD_TYPES.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </div>
        {(type === 'text' || type === 'search_as_you_type' || type === 'match_only_text') && (
          <div className="field">
            <label htmlFor="f-an">Analyzer</label>
            <input id="f-an" className="input mono" list="analyzers" value={analyzer} onChange={(e) => setAnalyzer(e.target.value)} placeholder="standard" />
            <datalist id="analyzers">
              {[...ANALYZERS, ...Object.keys(detail.settings).filter((k) => k.startsWith('index.analysis.analyzer.')).map((k) => k.split('.')[3]!)].map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </div>
        )}
        {type === 'keyword' && (
          <div className="field">
            <label htmlFor="f-ia">ignore_above</label>
            <input id="f-ia" className="input mono" value={ignoreAbove} onChange={(e) => setIgnoreAbove(e.target.value.replace(/\D/g, ''))} placeholder="256" />
          </div>
        )}
        {(type === 'date' || type === 'date_nanos') && (
          <div className="field">
            <label htmlFor="f-fmt">Format</label>
            <input id="f-fmt" className="input mono" value={format} onChange={(e) => setFormat(e.target.value)} placeholder="strict_date_optional_time||epoch_millis" />
          </div>
        )}
        {type === 'scaled_float' && (
          <div className="field">
            <label htmlFor="f-sf">scaling_factor</label>
            <input id="f-sf" className="input mono" value={scaling} onChange={(e) => setScaling(e.target.value)} />
          </div>
        )}
        {type === 'dense_vector' && (
          <div className="field">
            <label htmlFor="f-dims">dims</label>
            <input id="f-dims" className="input mono" value={dims} onChange={(e) => setDims(e.target.value.replace(/\D/g, ''))} placeholder="384" />
          </div>
        )}
      </div>
      {type === 'text' && !editPath && !parent && (
        <label className="check">
          <input type="checkbox" checked={keywordSub} onChange={(e) => setKeywordSub(e.target.checked)} />
          Also add a <span className="mono">.keyword</span> sub-field for sorting and aggregations
        </label>
      )}
      <div className="field">
        <label htmlFor="f-extra">Extra parameters (JSON)</label>
        <input id="f-extra" className="input mono" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder='{"index": false}' spellCheck={false} />
      </div>
      {!editPath && (
        <label className="check">
          <input type="checkbox" checked={backfill} onChange={(e) => setBackfill(e.target.checked)} />
          <span>
            Index existing documents into it now <span className="sub">— runs _update_by_query in the background; otherwise only new or updated documents get the field</span>
          </span>
        </label>
      )}
    </Modal>
  )
}

function multiField(mapping: Mapping, path: string): FieldDef | undefined {
  const parts = path.split('.')
  return getField(mapping, parts.slice(0, -1).join('.'))?.fields?.[parts.at(-1)!]
}

function JsonModal({ mapping, onClose, submit }: { mapping: Mapping; onClose(): void; submit(next: Mapping, ok: string): Promise<string | null> }) {
  const [text, setText] = useState(JSON.stringify(mapping, null, 2))
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    let next: Mapping
    try {
      next = JSON.parse(text) as Mapping
    } catch (e) {
      return setError(`Invalid JSON: ${(e as Error).message}`)
    }
    const err = await submit(next, 'Mapping updated')
    if (err) setError(err)
  }
  return (
    <Modal
      title="Edit mapping JSON"
      width={760}
      onClose={onClose}
      actions={
        <>
          {error && <span className="hint error left">{error}</span>}
          <button className="btn md" onClick={onClose}>
            Cancel
          </button>
          <button className="btn md primary" onClick={save}>
            Review change
          </button>
        </>
      }
    >
      <span className="hint">New fields are applied in place. Changing or removing existing fields needs a reindex — you'll be asked first.</span>
      <div className="editor-box" style={{ height: 440 }}>
        <CodeEditor value={text} onChange={setText} path="mapping://edit" />
      </div>
    </Modal>
  )
}

/** The warning: existing fields can't change in place. Offer an in-place attempt or a generated reindex routine. */
function ReindexModal({ conn, detail, next, diff, apply, onClose }: { conn: ConnectionConfig; detail: IndexDetail; next: Mapping; diff: MappingDiff; apply(next: Mapping, ok: string): Promise<string | null>; onClose(): void }) {
  const tree = useTree(conn.id)
  const [target, setTarget] = useState(() => nextIndexName(detail.name, tree.data?.indices.map((i) => i.name)))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const tryInPlace = async () => {
    setBusy(true)
    const err = await apply(next, 'Mapping updated in place')
    setBusy(false)
    if (err) setError(`The cluster rejected the in-place change: ${err}. Use a reindex routine instead.`)
    else onClose()
  }
  const createRoutine = async () => {
    setBusy(true)
    try {
      const r = reindexRoutine({
        source: detail.name,
        target: target.trim(),
        mapping: next,
        settings: copyableSettings(detail.settings),
        aliases: detail.aliases.map((a) => ({ name: a.name, isWriteIndex: a.isWriteIndex, filter: a.filter, routing: a.routing }))
      })
      const saved = await api.routines.save({ ...r, defaultConnectionId: conn.id })
      await useRoutines.getState().load()
      useRoutines.getState().select(saved.id)
      useApp.getState().setView('routines')
      useApp.getState().showToast('Reindex routine created — review the steps, then Dry run or Run all')
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="This change needs a reindex"
      width={620}
      onClose={onClose}
      actions={
        <>
          {error && <span className="hint error left">{error}</span>}
          <button className="btn md" onClick={onClose}>
            Cancel
          </button>
          {diff.removed.length === 0 && (
            <button className="btn md" disabled={busy} onClick={tryInPlace} title="Works for the few parameters Elasticsearch can update on existing fields">
              Try in place
            </button>
          )}
          <button className="btn md primary" disabled={busy || !target.trim() || !!tree.data?.indices.some((i) => i.name === target.trim())} onClick={createRoutine} title={tree.data?.indices.some((i) => i.name === target.trim()) ? 'An index with that name already exists' : undefined}>
            Create reindex routine
          </button>
        </>
      }
    >
      <div className="reindex-note warn">
        <b>⚠ Existing fields can't be changed or removed in place.</b> The type, analyzer and most parameters of a mapped field are fixed once data is indexed. To apply this mapping, kabanos can build a routine that creates a new index,
        reindexes all documents into it, verifies the count and moves the aliases.
      </div>
      {diff.changed.length > 0 && (
        <div>
          <span className="hint">Changed: </span>
          {diff.changed.map((p) => (
            <span key={p} className="role-tag mono" style={{ marginRight: 4 }}>
              {p}
            </span>
          ))}
        </div>
      )}
      {diff.removed.length > 0 && (
        <div>
          <span className="hint">Removed: </span>
          {diff.removed.map((p) => (
            <span key={p} className="chip-token danger mono" style={{ marginRight: 4 }}>
              {p}
            </span>
          ))}
        </div>
      )}
      {diff.added.length > 0 && (
        <div>
          <span className="hint">Added: </span>
          {diff.added.map((p) => (
            <span key={p} className="pill tiny" style={{ marginRight: 4 }}>
              {p}
            </span>
          ))}
        </div>
      )}
      <div className="field">
        <label htmlFor="ri-target">New index name</label>
        <input id="ri-target" className="input mono" value={target} onChange={(e) => setTarget(e.target.value)} />
        <span className="hint">
          The routine copies shards, replicas and analysis settings
          {detail.aliases.length ? `, then moves ${detail.aliases.map((a) => a.name).join(', ')} to the new index (asks before that step)` : ''}. {detail.name} is kept — delete it yourself once you're happy.
        </span>
      </div>
    </Modal>
  )
}
