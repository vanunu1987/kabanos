import { useMemo, useState, type ReactNode } from 'react'
import type { FieldInfo } from '@shared/meta'
import { Icon } from '../../shell/icons'
import { JsonView } from '../../components/JsonView'

export const TYPE_COLOR: Record<string, string> = {
  keyword: '#E7C58B',
  constant_keyword: '#E7C58B',
  wildcard: '#E7C58B',
  text: '#9CC4FF',
  match_only_text: '#9CC4FF',
  long: '#C7A2FF',
  integer: '#C7A2FF',
  short: '#C7A2FF',
  byte: '#C7A2FF',
  double: '#C7A2FF',
  float: '#C7A2FF',
  half_float: '#C7A2FF',
  scaled_float: '#C7A2FF',
  unsigned_long: '#C7A2FF',
  date: '#5CCB8A',
  date_nanos: '#5CCB8A',
  geo_point: '#4DC4D6',
  geo_shape: '#4DC4D6',
  boolean: '#FF9E7A',
  object: '#8B94A3',
  nested: '#8B94A3',
  flattened: '#8B94A3'
}

/** Field tree with type colours, a filter and a raw JSON toggle (Explorer → Mapping). */
export function MappingTable({ fields, raw, fill, onEditField, toolbar }: { fields: FieldInfo[]; raw: unknown; fill?: boolean; onEditField?(path: string): void; toolbar?: ReactNode }) {
  const [filter, setFilter] = useState('')
  const [showRaw, setShowRaw] = useState(false)
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? fields.filter((f) => f.path.toLowerCase().includes(q) || f.type.includes(q)) : fields
  }, [fields, filter])
  const leafCount = fields.filter((f) => f.type !== 'object' && f.type !== 'nested').length

  return (
    <section className={`card${fill ? ' fill' : ''}`}>
      <div className="card-head">
        <h2>Mapping</h2>
        <span className="hint">
          {leafCount} field{leafCount === 1 ? '' : 's'}
        </span>
        <div className="spacer" />
        {!showRaw && (
          <label className="filter small">
            {Icon.search()}
            <input aria-label="Filter fields" placeholder="Filter fields" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
        )}
        <button className={`btn xs${showRaw ? ' on' : ''}`} aria-pressed={showRaw} onClick={() => setShowRaw((v) => !v)}>
          Raw JSON
        </button>
        {toolbar}
      </div>
      {showRaw ? (
        <JsonView value={raw} className="card-scroll" />
      ) : (
        <div className="card-scroll">
          <div className={`grid-row head${onEditField ? ' editable' : ''}`}>
            <span>Field</span>
            <span>Type</span>
            <span>Details</span>
            {onEditField && <span />}
          </div>
          {visible.map((f) => (
            <div key={f.path} className={`grid-row${onEditField ? ' editable' : ''}`}>
              <span className="mono" style={{ paddingLeft: filter ? 0 : f.depth * 18, color: f.depth && !filter ? 'var(--text-2)' : undefined }} title={f.path}>
                {filter ? f.path : f.name}
              </span>
              <span className="mono" style={{ color: TYPE_COLOR[f.type] ?? 'var(--text-2)' }}>
                {f.type}
              </span>
              <span className="hint">{f.details}</span>
              {onEditField && (
                <button className="link row-edit" onClick={() => onEditField(f.path)} aria-label={`Edit field ${f.path}`}>
                  Edit
                </button>
              )}
            </div>
          ))}
          {visible.length === 0 && <div className="empty">{fields.length === 0 ? 'No mapped fields yet' : 'No fields match'}</div>}
        </div>
      )}
    </section>
  )
}
