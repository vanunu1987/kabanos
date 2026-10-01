import type { ReactNode } from 'react'

export interface Hit {
  _index: string
  _id: string
  _score?: number | null
  _source?: Record<string, unknown>
  _seq_no?: number
  _primary_term?: number
  sort?: unknown[]
  fields?: Record<string, unknown>
}

/** Compass-style document cards: `_id` header, top-level fields as key/value rows, per-doc actions. */
export function DocumentCards({ hits, actions }: { hits: Hit[]; actions?: (hit: Hit) => ReactNode }) {
  if (hits.length === 0) return <div className="empty">No documents</div>
  return (
    <div className="doc-list">
      {hits.map((h) => (
        <div key={`${h._index}/${h._id}`} className="doc-card">
          <div className="doc-head">
            <span className="mono faint">_id</span>
            <span className="mono ts">{h._id}</span>
            <span className="mono faint small">{h._index}</span>
            {typeof h._score === 'number' && <span className="mono faint small">score {h._score.toFixed(3)}</span>}
            {actions && <span className="doc-actions">{actions(h)}</span>}
          </div>
          {Object.entries(h._source ?? h.fields ?? {}).map(([k, v]) => (
            <div key={k} className="doc-kv mono">
              <span className="doc-k">{k}</span>
              <Value v={v} />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function Value({ v }: { v: unknown }) {
  if (v === null) return <span className="tl">null</span>
  if (typeof v === 'string') return <span className="ts">"{v}"</span>
  if (typeof v === 'number') return <span className="tn">{v}</span>
  if (typeof v === 'boolean') return <span className="tl">{String(v)}</span>
  const json = JSON.stringify(v)
  return <span className="doc-obj">{json.length > 160 ? `${json.slice(0, 160)}…` : json}</span>
}
