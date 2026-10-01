import { useMemo, useState } from 'react'
import { toEsql } from '@shared/aggregations/esql'
import type { Stage } from '@shared/aggregations/model'
import type { FieldInfo } from '@shared/meta'
import type { ConnectionConfig } from '@shared/types'
import { api } from '../../api'
import { reason } from '../explorer/indexActions'
import { fmt } from './OutputPanel'

/** ES|QL needs Elasticsearch 8.11+. */
export function esqlSupport(conn: ConnectionConfig): { ok: boolean; why?: string; hide?: boolean } {
  const d = conn.detected
  if ((d?.engine ?? conn.engine) === 'opensearch') return { ok: false, hide: true, why: 'OpenSearch has no ES|QL (PPL view: later)' }
  if (!d) return { ok: true }
  const [maj = 0, min = 0] = d.version.split('.').map(Number)
  return maj > 8 || (maj === 8 && min >= 11) ? { ok: true } : { ok: false, why: `ES|QL needs Elasticsearch 8.11+ (this cluster is ${d.version})` }
}

/** Read-only ES|QL translation with a warning per stage it can't keep (AGGREGATIONS.md §8). */
export function EsqlView({ conn, target, stages, fields, onOpenInWorkspace }: { conn: ConnectionConfig; target: string; stages: Stage[]; fields?: FieldInfo[]; onOpenInWorkspace(body: string): void }) {
  const r = useMemo(() => toEsql({ target, stages }, fields), [target, stages, fields])
  const [result, setResult] = useState<{ columns: Array<{ name: string }>; values: unknown[][]; ms: number } | { error: string } | null>(null)
  const [running, setRunning] = useState(false)
  const body = JSON.stringify({ query: r.query }, null, 2)
  const run = async () => {
    setRunning(true)
    try {
      const res = await api.cluster.request({ connectionId: conn.id, method: 'POST', path: '_query?format=json', body })
      setResult(res.status < 400 ? { ...(JSON.parse(res.body) as { columns: Array<{ name: string }>; values: unknown[][] }), ms: res.ms } : { error: reason(res.body) })
    } catch (e) {
      setResult({ error: (e as Error).message })
    } finally {
      setRunning(false)
    }
  }
  return (
    <div className="agg-esql">
      <div className="hint">The same pipeline as an ES|QL query. ES|QL is piped, so each line is one stage. Requires Elasticsearch 8.11+.</div>
      <div className="agg-esql-code mono" aria-label="ES|QL query">
        {r.lines.map((l, i) => (
          <div key={i} className="agg-esql-line">
            <span className="agg-gutter">{l.stage ?? ''}</span>
            <EsqlText text={l.text} />
          </div>
        ))}
      </div>
      <div className="agg-row">
        <button type="button" className="btn xs" onClick={() => navigator.clipboard.writeText(r.query)}>
          Copy
        </button>
        <button type="button" className="btn xs" onClick={() => onOpenInWorkspace(body)}>
          Open in workspace
        </button>
        <button type="button" className="btn xs" onClick={run} disabled={running}>
          {running ? 'Running…' : '▶ Run ES|QL'}
        </button>
      </div>
      {r.warnings.map((w, i) => (
        <div key={i} className="agg-esql-note" role="note">
          <b>Note</b>
          <span>{w.message.startsWith('Stage') ? w.message : `Stage ${w.stage}: ${w.message}`}</span>
        </div>
      ))}
      {result &&
        ('error' in result ? (
          <div className="agg-error">{result.error}</div>
        ) : (
          <div className="agg-table esql">
            <div className="agg-tr head mono" style={{ gridTemplateColumns: `repeat(${result.columns.length}, minmax(0, 1fr))` }}>
              {result.columns.map((c) => (
                <span key={c.name}>{c.name}</span>
              ))}
            </div>
            {result.values.slice(0, 50).map((row, i) => (
              <div key={i} className="agg-tr mono" style={{ gridTemplateColumns: `repeat(${result.columns.length}, minmax(0, 1fr))` }}>
                {row.map((v, j) => (
                  <span key={j} title={fmt(v)}>
                    {fmt(v)}
                  </span>
                ))}
              </div>
            ))}
            <div className="agg-tr more">
              {result.values.length} rows · {result.ms} ms
            </div>
          </div>
        ))}
    </div>
  )
}

const KW = /\b(FROM|WHERE|STATS|BY|SORT|LIMIT|KEEP|AND|OR|IN|IS|NOT|NULL|LIKE|DESC|ASC)\b/g

function EsqlText({ text }: { text: string }) {
  const parts: Array<{ t: string; c?: string }> = []
  let last = 0
  const re = new RegExp(`${KW.source}|"(?:[^"\\\\]|\\\\.)*"|\\b\\d+(?:\\.\\d+)?\\b|^\\| `, 'g')
  for (const m of text.matchAll(re)) {
    if (m.index! > last) parts.push({ t: text.slice(last, m.index) })
    const t = m[0]
    parts.push({ t, c: t.startsWith('"') ? 'ts' : /^\d/.test(t) ? 'tn' : t === '| ' ? 'tp' : 'kw' })
    last = m.index! + t.length
  }
  parts.push({ t: text.slice(last) })
  return (
    <span>
      {parts.map((p, i) =>
        p.c ? (
          <span key={i} className={p.c}>
            {p.t}
          </span>
        ) : (
          p.t
        )
      )}
    </span>
  )
}
