import { fieldsUsed } from '@shared/aggregations/compiler'
import { flatten, hitsTotal, levelGroups, type Row } from '@shared/aggregations/flatten'
import type { Stage } from '@shared/aggregations/model'
import { JsonView } from '../../components/JsonView'
import { flatten as flattenDoc } from '../indexView/ResultsTable'
import type { Preview } from './preview'

export function fmt(v: unknown, approx = false): string {
  if (v === undefined) return ''
  if (v === null) return '—'
  if (typeof v === 'number') return (approx ? '≈' : '') + (Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 }))
  if (Array.isArray(v)) return `${v.length} docs`
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** Compact number for chips: 12.4M, 48,213. */
export function short(n: number | undefined, approx = false): string {
  if (n === undefined) return '…'
  const a = approx ? '≈' : ''
  if (n >= 1e9) return `${a}${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${a}${(n / 1e6).toFixed(1)}M`
  return a + n.toLocaleString('en-US')
}

function MiniTable({ columns, rows, keyColumns, max = 6, approx }: { columns: string[]; rows: Row[]; keyColumns: string[]; max?: number; approx?: boolean }) {
  if (!rows.length) return <div className="agg-out-empty">No buckets</div>
  const template = `minmax(0, 1.4fr) repeat(${Math.max(1, columns.length - 1)}, minmax(0, 1fr))`
  return (
    <div className="agg-table" role="table">
      <div className="agg-tr head mono" role="row" style={{ gridTemplateColumns: template }}>
        {columns.map((c) => (
          <span key={c} role="columnheader" title={c}>
            {c}
          </span>
        ))}
      </div>
      {rows.slice(0, max).map((r, i) => (
        <div key={i} className="agg-tr mono" role="row" style={{ gridTemplateColumns: template }}>
          {columns.map((c) => (
            <span key={c} role="cell" className={keyColumns.includes(c) ? 'ts' : typeof r[c] === 'number' && c !== 'doc_count' ? 'tn' : ''} title={fmt(r[c])}>
              {fmt(r[c], approx && c === 'doc_count')}
            </span>
          ))}
        </div>
      ))}
      {rows.length > max && <div className="agg-tr more">+{rows.length - max} more rows</div>}
    </div>
  )
}

const Head = ({ n, children }: { n: number; children: React.ReactNode }) => (
  <div className="agg-out-head">
    Output after stage {n} {children}
  </div>
)

/** What a stage returns (AGGREGATIONS.md §6 “What each stage's output panel shows”). */
export function OutputPanel({ stage, index, preview, previous, stages }: { stage: Stage; index: number; preview?: Preview; previous?: Preview; stages: Stage[] }) {
  const n = index + 1
  if (!stage.enabled) return <div className="agg-out-empty">Disabled — this stage is skipped.</div>
  if (!preview || preview.status === 'off') return <div className="agg-out-empty">Live preview is off — press Run to see this stage’s output.</div>
  if (preview.status === 'error' && !preview.response) return <div className="agg-out-error">{preview.error}</div>
  if (!preview.response) return <div className="agg-out-empty"><span className="spin inline" /> Running preview…</div>
  const res = preview.response
  const c = preview.compiled
  const info = c.stages[index]!
  const approx = !!preview.sampled
  const stale = preview.status === 'loading' ? ' stale' : ''

  if (stage.kind === 'filter' && info.level === 0) {
    const total = hitsTotal(res)
    const hits = ((res.hits as { hits?: Array<{ _source?: Record<string, unknown> }> } | undefined)?.hits ?? []).slice(0, 3)
    const shown = fieldsUsed(stages)
    return (
      <div className={`agg-out${stale}`}>
        <Head n={n}>
          <b className="mono">{fmt(total)}</b> documents{hits.length ? ` · sample of ${hits.length}` : ''}
        </Head>
        <div className="agg-docs">
          {hits.map((h, i) => {
            const flat = flattenDoc(h._source ?? {})
            const keys = (shown.length ? shown.filter((k) => k in flat) : Object.keys(flat)).slice(0, 5)
            return (
              <div key={i} className="agg-doc mono">
                {(keys.length ? keys : Object.keys(flat).slice(0, 4)).map((k) => (
                  <div key={k}>
                    <span className="tk">{k}</span>: <span className={typeof flat[k] === 'number' ? 'tn' : 'ts'}>{JSON.stringify(flat[k])}</span>
                  </div>
                ))}
              </div>
            )
          })}
          {!hits.length && <div className="agg-out-empty">No documents match.</div>}
        </div>
      </div>
    )
  }

  if (stage.kind === 'groupBy') {
    const lvl = c.levels.findIndex((l) => l.stageIndex === index)
    if (lvl < 0) return <div className="agg-out-error">{preview.error ?? 'Not compiled'}</div>
    const g = levelGroups(res, c, lvl)
    const nested = c.levels[lvl]!.parent !== 0
    const first = g.parents[0]
    const counts = g.parents.map((p) => p.buckets.length)
    const max = Math.max(1, ...(first?.buckets.map((b) => b.docCount) ?? [1]))
    const covered = first?.buckets.reduce((s, b) => s + b.docCount, 0) ?? 0
    const parentLabel = c.levels[c.levels[lvl]!.parent ?? 0]!.label
    const SHOW = 5
    return (
      <div className={`agg-out${stale}`}>
        <Head n={n}>
          {nested ? (
            <>
              <b className="mono">{counts.length ? (Math.min(...counts) === Math.max(...counts) ? Math.max(...counts) : `${Math.min(...counts)}–${Math.max(...counts)}`) : 0}</b> buckets per {parentLabel}
              {first && <span className="mono"> · first: {first.keys.at(-1)}</span>}
            </>
          ) : (
            <>
              <b className="mono">{g.total}</b> buckets · <span className="mono">{fmt(covered, approx)}</span> docs covered{first?.otherDocs ? <> · <span className="mono">{fmt(first.otherDocs, approx)}</span> in other buckets</> : null}
            </>
          )}
        </Head>
        <div className="agg-buckets">
          {first?.buckets.slice(0, SHOW).map((b) => (
            <div key={b.key} className="agg-bucket">
              <span className="mono ts agg-bucket-key" title={b.key}>
                {b.key}
              </span>
              <span className="mono">
                {fmt(b.docCount, approx)} <span className="faint">docs</span>
              </span>
              <span className="agg-bar">
                <span style={{ width: `${Math.round((b.docCount / max) * 100)}%` }} />
              </span>
            </div>
          ))}
          {first && first.buckets.length > SHOW && <div className="agg-bucket more">+{first.buckets.length - SHOW} more</div>}
          {!first && <div className="agg-out-empty">No buckets</div>}
        </div>
      </div>
    )
  }

  if (stage.kind === 'custom') {
    const rows = flatten(res, c, Math.max(0, info.level)).rows
    const name = info.names[0]
    const frag = stage.place === 'request' ? undefined : rows[0]?.[name ?? '']
    return (
      <div className={`agg-out${stale}`}>
        <Head n={n}>{stage.place === 'request' ? '· request options' : `· ${name} in the first bucket`}</Head>
        {stage.place === 'request' ? <div className="agg-out-empty">Applied to the whole request.</div> : <JsonView value={frag ?? null} maxHeight={160} />}
      </div>
    )
  }

  if (info.level === 0 && (stage.kind === 'sortLimit' || stage.kind === 'topDocs')) {
    const hits = ((res.hits as { hits?: Array<{ _id: string; _source?: Record<string, unknown> }> } | undefined)?.hits ?? []).slice(0, 3)
    return (
      <div className={`agg-out${stale}`}>
        <Head n={n}>
          · <b className="mono">{fmt(hitsTotal(res))}</b> matching · first {hits.length}
        </Head>
        <div className="agg-docs">
          {hits.map((h) => (
            <div key={h._id} className="agg-doc mono">
              {Object.entries(flattenDoc(h._source ?? {}))
                .slice(0, 4)
                .map(([k, v]) => (
                  <div key={k}>
                    <span className="tk">{k}</span>: <span className={typeof v === 'number' ? 'tn' : 'ts'}>{JSON.stringify(v)}</span>
                  </div>
                ))}
            </div>
          ))}
        </div>
      </div>
    )
  }

  // A Filter inside a group shows the documents left per bucket (the level it opens).
  const opened = c.levels.findIndex((l) => l.stageIndex === index)
  const level = stage.kind === 'filter' && opened > 0 ? opened : Math.max(0, info.level)
  const table = flatten(res, c, level)
  if (stage.kind === 'topDocs') {
    const name = info.names[0]!
    return (
      <div className={`agg-out${stale}`}>
        <Head n={n}>· top documents per {c.levels[level]?.label ?? 'bucket'}</Head>
        <div className="agg-docs">
          {table.rows.slice(0, 3).map((r, i) => {
            const hits = (r[name] as Array<{ _id: string; _source?: Record<string, unknown> }> | undefined) ?? []
            return (
              <div key={i} className="agg-doc mono">
                <div className="ts agg-doc-key">{table.keyColumns.map((k) => fmt(r[k])).join(' · ') || 'all'}</div>
                {hits.map((h) => (
                  <div key={h._id} className="agg-doc-line" title={JSON.stringify(h._source)}>
                    {Object.values(flattenDoc(h._source ?? {}))
                      .slice(0, 3)
                      .map((v) => String(v))
                      .join(' · ')}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  let extra: React.ReactNode = null
  if (stage.kind === 'keepOnly' && previous?.response && previous.compiled) {
    const before = flatten(previous.response, previous.compiled, level).rows.length
    extra = (
      <>
        · <b className="mono">{table.rows.length}</b> of <span className="mono">{before}</span> {c.levels[level]?.label ?? 'bucket'} buckets kept
      </>
    )
  } else if (stage.kind === 'metrics') {
    const names = info.names.length
    extra = (
      <>
        · <b className="mono">{table.rows.length}</b> {level === 0 ? 'over all documents' : 'buckets'} × {names} metric{names === 1 ? '' : 's'}
      </>
    )
  } else if (stage.kind === 'sortLimit') {
    extra = (
      <>
        · <b className="mono">{table.rows.length}</b> {c.levels[level]?.label ?? 'bucket'} buckets returned
      </>
    )
  } else if (stage.kind === 'filter') {
    extra = <>· documents left in each {c.levels[c.levels[level]?.parent ?? 0]?.label ?? 'bucket'} bucket</>
  } else extra = <>· {c.levels[level]?.label ?? 'bucket'} buckets</>
  return (
    <div className={`agg-out${stale}`}>
      <Head n={n}>{extra}</Head>
      <MiniTable columns={table.columns} rows={table.rows} keyColumns={table.keyColumns} approx={approx} />
    </div>
  )
}
