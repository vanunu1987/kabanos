import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef, useState } from 'react'
import { compile, type OutputMeta } from '@shared/aggregations/compiler'
import { flatten, type Row } from '@shared/aggregations/flatten'
import { clone, isPipeline, newId, newPipeline, newStage, type Pipeline, type Stage, type StageKind } from '@shared/aggregations/model'
import { printJson } from '@shared/aggregations/print'
import { toCurl } from '@shared/consoleParser'
import { formatBytes, type FieldInfo } from '@shared/meta'
import type { ConnectionConfig } from '@shared/types'
import { api, KabanosError } from '../../api'
import { JsonView } from '../../components/JsonView'
import { Menu } from '../../components/Menu'
import { usePaneWidth } from '../../components/Resizable'
import { useFields } from '../../queries'
import { useApp } from '../../store'
import { reason } from '../explorer/indexActions'
import { tabKey } from '../indexView/state'
import { ResultsTable } from '../indexView/ResultsTable'
import type { Hit } from '../indexView/DocumentCards'
import { SaveQueryModal } from '../workspace/SaveQueryModal'
import { useWorkspace } from '../workspace/store'
import { EsqlView, esqlSupport } from './EsqlView'
import { JsonPipelineView } from './JsonPipelineView'
import { fmt, short } from './OutputPanel'
import type { PickOption } from './Picker'
import { samplingFor, usePreviews } from './preview'
import { ADDABLE, StageCard } from './StageCard'
import type { FormCtx } from './StageForms'
import { useAggs, type AggRun, type AggView } from './store'
import { chipTitle, outcome } from './summary'
import './aggregations.css'

const VIEWS: Array<[AggView, string]> = [
  ['stages', 'Stages'],
  ['json', 'JSON'],
  ['esql', 'ES|QL']
]

/** Metric references a stage may read: outputs defined before it (plus document count). */
function refsFrom(outputs: OutputMeta[]): PickOption[] {
  const out: PickOption[] = []
  for (const o of outputs) {
    if (o.kind === 'stats') for (const s of ['avg', 'min', 'max', 'sum', 'count']) out.push({ value: `${o.name}.${s}`, hint: 'stats' })
    else if (o.kind === 'percentiles') {
      if ((o.percents?.length ?? 0) === 1) out.push({ value: o.name, hint: `p${o.percents![0]}` })
      else for (const p of o.percents ?? []) out.push({ value: `${o.name}.${p}`, hint: `p${p}` })
    } else if (o.kind === 'single' || o.kind === 'count') out.push({ value: o.name, hint: o.kind === 'count' ? 'count' : 'metric' })
  }
  return [...new Map(out.map((o) => [o.value, o])).values()]
}

function defaults(fields: FieldInfo[] | undefined) {
  return {
    keyword: fields?.find((f) => f.type === 'keyword')?.path,
    numeric: fields?.find((f) => ['long', 'integer', 'double', 'float', 'scaled_float', 'short'].includes(f.type))?.path,
    date: fields?.find((f) => f.type === 'date')?.path
  }
}

function parseProfile(response: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {}
  type P = { description?: string; time_in_nanos?: number; children?: P[] }
  const walk = (list: P[] | undefined) => {
    for (const a of list ?? []) {
      if (a.description) out[a.description] = (out[a.description] ?? 0) + (a.time_in_nanos ?? 0) / 1e6
      walk(a.children)
    }
  }
  for (const shard of ((response.profile as { shards?: Array<{ aggregations?: P[] }> } | undefined)?.shards ?? [])) walk(shard.aggregations)
  return out
}

/** Compass-style aggregation pipeline builder (AGGREGATIONS.md, mockup screen 7). */
export function AggregationsTab({ conn, target, docs }: { conn: ConnectionConfig; target: string; docs?: number }) {
  const key = tabKey(conn.id, target)
  const tab = useAggs((s) => s.tabs[key])
  useEffect(() => {
    if (!useAggs.getState().tabs[key]) useAggs.getState().patch(key, { pipeline: newPipeline(target, conn.id) })
  }, [key, target, conn.id])
  if (!tab) return null
  return <Builder key={key} conn={conn} target={target} docs={docs} tabKey_={key} />
}

function Builder({ conn, target, docs, tabKey_: key }: { conn: ConnectionConfig; target: string; docs?: number; tabKey_: string }) {
  const tab = useAggs((s) => s.tabs[key])!
  const { patch, setPipeline } = useAggs.getState()
  const p = tab.pipeline
  const stages = p.stages
  const fieldsQ = useFields(conn.id, target)
  const fields = fieldsQ.data
  const compiled = useMemo(() => compile({ stages }, { fields }), [stages, fields])
  const sampling = useMemo(() => (p.preview.sampled ? samplingFor(conn, docs) : { sample: undefined, note: '' }), [p.preview.sampled, conn, docs])
  const previews = usePreviews({ conn, target, stages, fields, live: p.preview.live, sample: sampling.sample, nonce: tab.refreshNonce })
  const esql = esqlSupport(conn)
  const [saving, setSaving] = useState(false)
  const [resultsHeight, setResultsHeight] = usePaneWidth('agg-results', 300, 120, 900)
  const listRef = useRef<HTMLDivElement>(null)

  const setStages = (fn: (s: Stage[]) => Stage[]) => setPipeline(key, (pl) => ({ ...pl, stages: fn(pl.stages) }))
  const update = (i: number, s: Stage) => setStages((all) => all.map((x, j) => (j === i ? s : x)))
  const replace = (i: number, list: Stage[]) => setStages((all) => [...all.slice(0, i), ...list, ...all.slice(i + 1)])
  const remove = (i: number) => setStages((all) => all.filter((_, j) => j !== i))
  const move = (i: number, d: -1 | 1) =>
    setStages((all) => {
      const j = i + d
      if (j < 0 || j >= all.length) return all
      const next = [...all]
      ;[next[i], next[j]] = [next[j]!, next[i]!]
      return next
    })
  const duplicate = (i: number) =>
    setStages((all) => {
      const copy = { ...clone(all[i]!), id: newId() }
      if ('name' in copy && typeof copy.name === 'string' && copy.name && copy.kind !== 'custom') copy.name = `${copy.name}_copy`
      return [...all.slice(0, i + 1), copy, ...all.slice(i + 1)]
    })
  const add = (kind: StageKind) => {
    const s = newStage(kind, defaults(fields))
    setStages((all) => [...all, s])
    patch(key, { focus: s.id })
    requestAnimationFrame(() => document.getElementById(`stage-${s.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  }
  const focusIndex = stages.findIndex((s) => s.id === tab.focus)

  const ctxFor = (i: number): FormCtx => {
    const info = compiled.stages[i]!
    const opened = compiled.levels.find((l) => l.stageIndex === i)
    const s = stages[i]!
    // Terms order reads metrics defined inside the group; everything else reads what came before.
    const outs = s.kind === 'groupBy' ? compiled.outputs.filter((o) => opened && o.level === opened.index) : compiled.outputs.filter((o) => o.stageIndex < i)
    const atRoot = !compiled.levels.some((l) => l.index > 0 && (l.stageIndex ?? Infinity) < i)
    return { fields, metricRefs: refsFrom(outs), levelLabel: compiled.levels[Math.max(0, info.level)]?.label, atRoot }
  }

  // ---------- run / profile ----------
  const runRef = useRef<((profile?: boolean) => Promise<void>) | undefined>(undefined)
  const run = async (profile = false) => {
    const c = compile({ stages }, { fields, profile })
    const opaqueId = `kabanos-${crypto.randomUUID()}`
    patch(key, { run: { status: 'running', opaqueId, compiled: c }, refreshNonce: tab.refreshNonce + 1 })
    try {
      const res = await api.cluster.run({ connectionId: conn.id, method: 'POST', path: `${encodeURIComponent(target)}/_search`, body: JSON.stringify(c.request, null, 2), opaqueId })
      if (res.status >= 400) return patch(key, { run: { status: 'error', httpStatus: res.status, error: reason(res.body), compiled: c, ms: res.ms } })
      const response = JSON.parse(res.body) as Record<string, unknown>
      patch(key, { run: { status: 'done', httpStatus: res.status, response, compiled: c, ms: res.ms, bytes: res.bytes, profile: profile ? parseProfile(response) : undefined } })
    } catch (e) {
      const msg = e instanceof KabanosError && e.code === 'CANCELLED' ? 'Request cancelled' : (e as Error).message
      patch(key, { run: { status: 'error', error: msg, compiled: c } })
    }
  }
  runRef.current = run
  const cancel = () => tab.run?.opaqueId && tab.run.status === 'running' && api.cluster.cancel(tab.run.opaqueId)

  const body = useMemo(() => printJson(compiled.request).text, [compiled.request])
  const copyCurl = () => {
    const auth = conn.authKind === 'apikey' || (conn.authKind === 'cloudid' && conn.hasApiKey) ? 'apikey' : conn.username ? 'basic' : undefined
    void navigator.clipboard.writeText(toCurl(conn.url, 'POST', `${target}/_search`, JSON.stringify(compiled.request, null, 2), { auth, username: conn.username }))
    useApp.getState().showToast('Copied as cURL (credentials not included)')
  }
  const openInWorkspace = async (path: string, text: string, title: string) => {
    const ws = useWorkspace.getState()
    if (!ws.activeTab) await ws.load()
    await useWorkspace.getState().newBlock({ title, method: 'POST', path, body: text })
    useApp.getState().setView('workspace')
  }
  const save = async (asNew = false) => {
    const payload = { title: p.name, method: 'POST' as const, path: `${target}/_search`, body, tags: p.tags, pipeline: JSON.stringify({ ...p, connectionId: conn.id, target }) }
    if (tab.savedId && !asNew) {
      try {
        await api.library.updateQuery(tab.savedId, payload)
        useWorkspace.getState().bumpLibrary()
        return useApp.getState().showToast(`Saved “${p.name}”`)
      } catch {
        /* deleted from the library meanwhile: save as new */
      }
    }
    setSaving(true)
  }
  const newOne = () => {
    if (stages.length && !confirm('Start a new pipeline? The current one stays in the library only if you saved it.')) return
    patch(key, { pipeline: newPipeline(target, conn.id), savedId: undefined, run: undefined, focus: undefined })
  }
  const cycleView = () => {
    const ids = VIEWS.map(([v]) => v).filter((v) => v !== 'esql' || (esql.ok && !esql.hide))
    patch(key, { view: ids[(ids.indexOf(tab.view) + 1) % ids.length]! })
  }

  // Shortcuts: ⌘↵ run · ⌘⇧J views · ⌘⌥↑/↓ move · ⌘D duplicate · ⌘⌫ delete.
  const keys = useRef({ cycleView, move, duplicate, remove, focusIndex })
  keys.current = { cycleView, move, duplicate, remove, focusIndex }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const el = e.target as HTMLElement | null
      if (el?.closest('.modal')) return
      const typing = !!el?.closest('input, textarea, select, [contenteditable], .monaco-editor')
      const k = keys.current
      if (e.key === 'Enter' && !el?.closest('.monaco-editor')) {
        e.preventDefault()
        void runRef.current?.()
      } else if (e.shiftKey && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        k.cycleView()
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && k.focusIndex >= 0) {
        e.preventDefault()
        k.move(k.focusIndex, e.key === 'ArrowUp' ? -1 : 1)
      } else if (e.key.toLowerCase() === 'd' && !e.shiftKey && k.focusIndex >= 0 && !el?.closest('.monaco-editor')) {
        e.preventDefault()
        k.duplicate(k.focusIndex)
      } else if (e.key === 'Backspace' && !typing && k.focusIndex >= 0) {
        e.preventDefault()
        k.remove(k.focusIndex)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const prevEnabled = (i: number) => {
    for (let j = i - 1; j >= 0; j--) if (stages[j]!.enabled) return previews[stages[j]!.id]
    return undefined
  }
  const profileMsFor = (i: number) => {
    const prof = tab.run?.profile
    if (!prof) return undefined
    const names = compiled.stages[i]!.names
    if (!names.length) return undefined
    return names.reduce((t, n) => t + (prof[n] ?? 0), 0)
  }

  return (
    <div className="agg-tab">
      <div className="agg-toolbar">
        <input className="agg-title" aria-label="Pipeline name" value={p.name} onChange={(e) => setPipeline(key, (pl) => ({ ...pl, name: e.target.value }))} spellCheck={false} />
        <button className="btn xs primary" onClick={() => save()} title={tab.savedId ? 'Update the saved pipeline' : 'Save to the query library'}>
          Save
        </button>
        <Menu
          label="Pipeline actions"
          buttonClass="btn xs"
          align="left"
          items={[
            { label: 'Save as new…', onSelect: () => void save(true) },
            { label: 'Open in workspace', onSelect: () => void openInWorkspace(`${target}/_search`, body, p.name) },
            { label: 'Copy request JSON', onSelect: () => void navigator.clipboard.writeText(body) }
          ]}
        >
          ⋯
        </Menu>
        <button className="btn xs" onClick={newOne}>
          New pipeline
        </button>
        <button className="btn xs" onClick={copyCurl}>
          Copy as cURL
        </button>
        <div className="spacer" />
        <label className="agg-toggle" title="Re-run each stage's preview as you edit">
          <input type="checkbox" checked={p.preview.live} onChange={(e) => setPipeline(key, (pl) => ({ ...pl, preview: { ...pl.preview, live: e.target.checked } }))} />
          <span className="agg-switch" aria-hidden />
          Live preview
        </label>
        <label className="agg-toggle" title={sampling.note || 'Preview on a random sample of documents (numbers marked ≈)'}>
          <input type="checkbox" checked={p.preview.sampled} onChange={(e) => setPipeline(key, (pl) => ({ ...pl, preview: { ...pl.preview, sampled: e.target.checked } }))} />
          <span className="agg-switch" aria-hidden />
          Fast (sampled)
        </label>
        <div role="tablist" aria-label="Pipeline view" className="segmented sm agg-views">
          {VIEWS.filter(([v]) => v !== 'esql' || !esql.hide).map(([v, label]) => (
            <button key={v} role="tab" aria-selected={tab.view === v} className={tab.view === v ? 'on' : ''} disabled={v === 'esql' && !esql.ok} title={v === 'esql' && !esql.ok ? esql.why : `${label} (⌘⇧J cycles)`} onClick={() => patch(key, { view: v })}>
              {label}
            </button>
          ))}
        </div>
        <button className="btn xs" onClick={() => run(true)} disabled={tab.run?.status === 'running'} title="Run with profile: true and show the time per stage">
          Profile
        </button>
        {tab.run?.status === 'running' ? (
          <button className="btn xs primary" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <button className="btn xs primary agg-run" onClick={() => run()} title="Run the full pipeline (⌘↵)">
            ▶ Run
          </button>
        )}
      </div>

      <div className="agg-flow" aria-label="Pipeline flow">
        <span className="agg-flow-label">Flow</span>
        <span className="agg-chip">
          <span className="faint">Index</span>
          <span className="mono">{docs !== undefined ? `${short(docs)} docs` : '…'}</span>
        </span>
        {stages.map((s, i) => {
          if (!s.enabled) return null
          const nested = s.kind === 'groupBy' && compiled.stages[i]!.level > 0
          const err = compiled.stages[i]!.errors.length > 0
          return (
            <span key={s.id} className="agg-flow-step">
              <span className="faint">→</span>
              <button
                type="button"
                className={`agg-chip${s.id === tab.focus ? ' accent' : ''}${err ? ' bad' : ''}`}
                onClick={() => {
                  patch(key, { focus: s.id, view: 'stages' })
                  requestAnimationFrame(() => document.getElementById(`stage-${s.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
                }}
              >
                <span className="faint">{chipTitle(s, i + 1, nested)}</span>
                <span className="mono">
                  {previews[s.id]?.sampled && previews[s.id]?.status === 'done' ? '≈' : ''}
                  {err ? '⚠' : outcome(s, i, previews[s.id], prevEnabled(i))}
                </span>
              </button>
            </span>
          )
        })}
        {p.preview.sampled && sampling.note && <span className="hint agg-flow-note">{sampling.note}</span>}
      </div>

      <div className="agg-main">
        {tab.view === 'stages' ? (
          <div className="agg-stages" ref={listRef}>
            {stages.length === 0 && (
              <div className="agg-empty">
                <div className="agg-empty-title">Build an aggregation step by step</div>
                <div className="hint">Stack stages top to bottom — every stage shows what it returns. Start with a Filter or a Group by, or paste an existing request into the JSON view.</div>
              </div>
            )}
            {stages.map((s, i) => (
              <StageCard
                key={s.id}
                stage={s}
                index={i}
                stages={stages}
                compiled={compiled}
                preview={previews[s.id]}
                previous={prevEnabled(i)}
                ctx={ctxFor(i)}
                focused={s.id === tab.focus}
                profileMs={profileMsFor(i)}
                onChange={(n) => update(i, n)}
                onReplace={(list) => replace(i, list)}
                onRemove={() => remove(i)}
                onMove={(d) => move(i, d)}
                onDuplicate={() => duplicate(i)}
                onFocus={() => tab.focus !== s.id && patch(key, { focus: s.id })}
              />
            ))}
            <div className="agg-add-row">
              <Menu label="Add stage" buttonClass="btn md primary" align="left" items={ADDABLE.map(([k, l]) => ({ label: l, onSelect: () => add(k) }))}>
                + Add stage
              </Menu>
              {ADDABLE.slice(0, 8).map(([k, l]) => (
                <button key={k} type="button" className="agg-type-chip" onClick={() => add(k)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        ) : tab.view === 'json' ? (
          <JsonPipelineView
            stages={stages}
            target={target}
            compiled={compiled}
            onRun={() => void runRef.current?.()}
            onStages={(next) => setStages(() => next)}
          />
        ) : (
          <EsqlView conn={conn} target={target} stages={stages} fields={fields} onOpenInWorkspace={(b) => void openInWorkspace('_query', b, `${p.name} (ES|QL)`)} />
        )}
      </div>

      {tab.run && (
        <>
          <RowResize height={resultsHeight} onResize={setResultsHeight} />
          <ResultsPane run={tab.run} view={tab.resultView} height={resultsHeight} target={target} onView={(v) => patch(key, { resultView: v })} onClose={() => patch(key, { run: undefined })} />
        </>
      )}
      {saving && (
        <SaveQueryModal
          initial={{ title: p.name === 'Untitled pipeline' ? '' : p.name, folderId: null, tags: p.tags }}
          onClose={() => setSaving(false)}
          onSave={async (v) => {
            const pipeline: Pipeline = { ...p, name: v.title || p.name, tags: v.tags, connectionId: conn.id, target }
            const q = await api.library.createQuery({ ...v, title: pipeline.name, method: 'POST', path: `${target}/_search`, body, pipeline: JSON.stringify(pipeline) })
            patch(key, { savedId: q.id, pipeline })
            useWorkspace.getState().bumpLibrary()
            setSaving(false)
            useApp.getState().showToast(`Saved “${pipeline.name}” to the library`)
          }}
        />
      )}
    </div>
  )
}

function ResultsPane({ run, view, height, target, onView, onClose }: { run: AggRun; view: 'table' | 'json'; height: number; target: string; onView(v: 'table' | 'json'): void; onClose(): void }) {
  const table = useMemo(() => (run.response && run.compiled && !run.compiled.documents ? flatten(run.response, run.compiled) : undefined), [run.response, run.compiled])
  const hits = run.compiled?.documents ? ((run.response?.hits as { hits?: Hit[] } | undefined)?.hits ?? []) : undefined
  const exportRows = async (format: 'csv' | 'ndjson') => {
    const rows: Array<Record<string, unknown>> = table ? table.rows : (hits ?? []).map((h) => ({ _id: h._id, ...h._source }))
    const res = await api.export.writeHits({ target: `${target}-aggregation`, hits: rows.map((r, i) => ({ _id: String(i + 1), _index: target, _source: r })), format, includeMeta: false })
    if (res) useApp.getState().showToast(`Exported ${res.count} rows to ${res.path}`)
  }
  return (
    <div className="agg-results" style={{ height }}>
      <div className="pane-head">
        {run.status === 'running' ? (
          <span className="hint">
            <span className="spin inline" /> Running the full pipeline…
          </span>
        ) : (
          <>
            {run.httpStatus !== undefined && <span className={`status-badge mono ${run.httpStatus < 300 ? 'ok' : run.httpStatus < 500 ? 'warn' : 'bad'}`}>{run.httpStatus}</span>}
            <span className="hint">
              {table ? `${table.rows.length.toLocaleString()} rows · ` : hits ? `${hits.length} documents · ` : ''}
              {run.ms !== undefined ? `${run.ms} ms` : ''}
              {run.bytes !== undefined ? ` · ${formatBytes(run.bytes)}` : ''}
              {run.profile ? ' · profiled' : ''}
            </span>
          </>
        )}
        <div className="spacer" />
        {run.status === 'done' && (
          <>
            <div role="group" aria-label="Result view" className="segmented sm">
              {(['table', 'json'] as const).map((v) => (
                <button key={v} className={view === v ? 'on' : ''} onClick={() => onView(v)}>
                  {v === 'table' ? 'Table' : 'JSON'}
                </button>
              ))}
            </div>
            <Menu label="Export results" buttonClass="link-btn" items={[{ label: 'Export as CSV…', onSelect: () => void exportRows('csv') }, { label: 'Export as NDJSON…', onSelect: () => void exportRows('ndjson') }]}>
              Export results
            </Menu>
            <button className="link-btn" onClick={() => navigator.clipboard.writeText(JSON.stringify(run.response, null, 2))}>
              Copy
            </button>
          </>
        )}
        <button className="link-btn" aria-label="Close results" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="results-body">
        {run.status === 'error' ? (
          <div className="error-box">{run.error}</div>
        ) : run.status === 'running' ? null : view === 'json' ? (
          <JsonView value={JSON.stringify(run.response, null, 2)} />
        ) : hits ? (
          <ResultsTable hits={hits} />
        ) : table ? (
          <RowsTable columns={table.columns} keyColumns={table.keyColumns} rows={table.rows} />
        ) : null}
      </div>
    </div>
  )
}

/** Drag handle above the results pane (drag up = taller). */
function RowResize({ height, onResize }: { height: number; onResize(h: number): void }) {
  const [drag, setDrag] = useState<{ y: number; h: number } | null>(null)
  useEffect(() => {
    if (!drag) return
    const move = (e: MouseEvent) => onResize(drag.h - (e.clientY - drag.y))
    const up = () => (setDrag(null), document.body.classList.remove('resizing'))
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => (window.removeEventListener('mousemove', move), window.removeEventListener('mouseup', up))
  }, [drag, onResize])
  return (
    <div
      className={`agg-row-resize${drag ? ' on' : ''}`}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize results"
      onMouseDown={(e) => (e.preventDefault(), document.body.classList.add('resizing'), setDrag({ y: e.clientY, h: height }))}
      onDoubleClick={() => onResize(300)}
    />
  )
}

/** Flattened aggregation rows — one per leaf bucket combination. */
function RowsTable({ columns, keyColumns, rows }: { columns: string[]; keyColumns: string[]; rows: Row[] }) {
  const parent = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => parent.current, estimateSize: () => 30, overscan: 12 })
  const template = `repeat(${columns.length}, minmax(130px, 1fr))`
  if (!rows.length) return <div className="empty">No buckets</div>
  return (
    <div className="rtable" ref={parent} aria-label="Aggregation results">
      <div className="rtable-inner" style={{ minWidth: columns.length * 130 }}>
        <div className="rtable-row head" style={{ gridTemplateColumns: template }}>
          {columns.map((c) => (
            <span key={c} className="mono" title={c}>
              {c}
            </span>
          ))}
        </div>
        <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map((vi) => {
            const r = rows[vi.index]!
            return (
              <div key={vi.key} className="rtable-row" style={{ gridTemplateColumns: template, position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` }}>
                {columns.map((c) => (
                  <span key={c} className={`mono${keyColumns.includes(c) ? ' ts' : typeof r[c] === 'number' && c !== 'doc_count' ? ' tn' : ''}`} title={fmt(r[c])}>
                    {fmt(r[c])}
                  </span>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** Load a saved pipeline (from the library) into an index view tab. */
export function openSavedPipeline(connectionId: string, queryId: string, pipelineJson: string): boolean {
  let pipeline: unknown
  try {
    pipeline = JSON.parse(pipelineJson)
  } catch {
    return false
  }
  if (!isPipeline(pipeline)) return false
  const key = tabKey(connectionId, pipeline.target)
  useAggs.getState().patch(key, { pipeline: { ...pipeline, connectionId }, savedId: queryId, view: 'stages', run: undefined })
  return true
}

