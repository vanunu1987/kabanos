import { useVirtualizer } from '@tanstack/react-virtual'
import { useMemo, useRef } from 'react'
import type { Hit } from './DocumentCards'

/** Flatten `{a:{b:1}}` → `{'a.b': 1}`; arrays stay as values. */
export function flatten(obj: Record<string, unknown>, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v as Record<string, unknown>, key, out)
    else out[key] = v
  }
  return out
}

const MAX_COLUMNS = 40

/** Hits as a virtualised table: one column per flattened `_source` field (first seen order). */
export function ResultsTable({ hits }: { hits: Hit[] }) {
  const { rows, columns } = useMemo(() => {
    const rows = hits.map((h) => ({ _id: h._id, _index: h._index, ...flatten(h._source ?? {}) }))
    const cols: string[] = []
    const seen = new Set<string>(['_id', '_index'])
    for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) seen.add(k), cols.push(k)
    return { rows, columns: ['_id', ...cols.slice(0, MAX_COLUMNS)] }
  }, [hits])

  const parent = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => parent.current, estimateSize: () => 30, overscan: 12 })
  const template = `repeat(${columns.length}, minmax(140px, 1fr))`

  if (hits.length === 0) return <div className="empty">No documents</div>
  return (
    <div className="rtable" ref={parent}>
      <div className="rtable-inner" style={{ minWidth: columns.length * 140 }}>
        <div className="rtable-row head" style={{ gridTemplateColumns: template }}>
          {columns.map((c) => (
            <span key={c} className="mono" title={c}>
              {c}
            </span>
          ))}
        </div>
        <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map((vi) => {
            const r = rows[vi.index] as Record<string, unknown>
            return (
              <div key={vi.key} className="rtable-row" style={{ gridTemplateColumns: template, position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` }}>
                {columns.map((c) => (
                  <span key={c} className={`mono${c === '_id' ? ' ts' : ''}`} title={display(r[c])}>
                    {display(r[c])}
                  </span>
                ))}
              </div>
            )
          })}
        </div>
      </div>
      {columns.length > MAX_COLUMNS && <div className="hint" style={{ padding: 8 }}>Showing the first {MAX_COLUMNS} columns.</div>}
    </div>
  )
}

function display(v: unknown): string {
  if (v === undefined) return ''
  if (v === null) return 'null'
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}
