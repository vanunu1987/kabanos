import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isAggregatableType, isDateType, isNumericType } from '@shared/aggregations/model'
import type { FieldInfo } from '@shared/meta'

export interface PickOption {
  value: string
  label?: string
  /** Right-aligned type / hint. */
  hint?: string
  /** Shown greyed out with this explanation (e.g. “use title.keyword”). */
  disabled?: string
  warn?: string
}

/** A compact dropdown with search — used for fields, metric names and operators. */
export function Picker({ value, options, onChange, placeholder = 'Pick…', label, width, mono = true, allowCustom, renderValue }: { value: string; options: PickOption[]; onChange(v: string): void; placeholder?: string; label: string; width?: number; mono?: boolean; allowCustom?: boolean; renderValue?(v: string): ReactNode }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    const list = t ? options.filter((o) => o.value.toLowerCase().includes(t) || o.label?.toLowerCase().includes(t)) : options
    return list.slice(0, 200)
  }, [q, options])
  const current = options.find((o) => o.value === value)
  const pick = (v: string) => {
    onChange(v)
    setOpen(false)
    setQ('')
  }
  return (
    <div className="agg-pick" ref={ref} style={width ? { width } : undefined}>
      <button
        type="button"
        className={`agg-fld${mono ? ' mono' : ''}${value ? '' : ' empty'}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (setOpen((o) => !o), setHi(0))}
        style={width ? { width: '100%' } : undefined}
      >
        <span className="agg-fld-text">{value ? (renderValue ? renderValue(value) : (current?.label ?? value)) : placeholder}</span>
        {current?.warn && <span className="agg-warn" title={current.warn}>⚠</span>}
        {current?.hint && <span className="agg-fld-hint">{current.hint}</span>}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="agg-pop" role="listbox" aria-label={label}>
          {(options.length > 8 || allowCustom) && (
            <input
              className="agg-pop-search"
              autoFocus
              placeholder={allowCustom ? 'Search or type a name…' : 'Search…'}
              value={q}
              aria-label={`Search ${label}`}
              onChange={(e) => (setQ(e.target.value), setHi(0))}
              onKeyDown={(e) => {
                const enabled = shown.filter((o) => !o.disabled)
                if (e.key === 'ArrowDown') (e.preventDefault(), setHi((h) => Math.min(enabled.length - 1, h + 1)))
                if (e.key === 'ArrowUp') (e.preventDefault(), setHi((h) => Math.max(0, h - 1)))
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const o = enabled[hi]
                  if (o) pick(o.value)
                  else if (allowCustom && q.trim()) pick(q.trim())
                }
                if (e.key === 'Escape') setOpen(false)
              }}
            />
          )}
          <div className="agg-pop-list">
            {shown.map((o) => {
              const idx = shown.filter((x) => !x.disabled).indexOf(o)
              return (
                <button
                  type="button"
                  key={o.value}
                  role="option"
                  aria-selected={o.value === value}
                  className={`agg-opt${o.value === value ? ' on' : ''}${idx === hi && !o.disabled ? ' hi' : ''}`}
                  disabled={!!o.disabled}
                  title={o.disabled ?? o.warn}
                  onClick={() => pick(o.value)}
                >
                  <span className={mono ? 'mono' : ''}>{o.label ?? o.value}</span>
                  {o.warn && <span className="agg-warn">⚠</span>}
                  <span className="agg-opt-hint">{o.disabled ?? o.hint}</span>
                </button>
              )
            })}
            {!shown.length && <div className="agg-opt-none">{allowCustom && q.trim() ? `Press ↵ to use “${q.trim()}”` : 'No matches'}</div>}
          </div>
        </div>
      )}
    </div>
  )
}

export type FieldKind = 'group' | 'numeric' | 'date' | 'any' | 'filter' | 'text'

/** Field options for a picker. Non-aggregatable fields are listed greyed out with the sub-field to use instead. */
export function fieldOptions(fields: FieldInfo[] | undefined, kind: FieldKind): PickOption[] {
  const list = (fields ?? []).filter((f) => f.type !== 'object' && f.type !== 'nested' && f.type !== 'alias')
  const keywordOf = (f: FieldInfo) => list.find((x) => x.multiField && x.path.startsWith(`${f.path}.`) && isAggregatableType(x.type))?.path
  return list
    .map((f): PickOption | null => {
      const warn = f.conflicts ? `Mapped as ${f.conflicts.join(' / ')} across indices` : undefined
      const base = { value: f.path, hint: f.type, warn }
      if (kind === 'filter') return base
      if (kind === 'text') return f.type === 'text' || f.type === 'keyword' || f.type === 'match_only_text' ? base : null
      if (kind === 'numeric') return isNumericType(f.type) ? base : null
      if (kind === 'date') return isDateType(f.type) ? base : null
      if (f.type === 'text' || f.type === 'match_only_text') {
        const kw = keywordOf(f)
        return { ...base, disabled: kw ? `text — use ${kw}` : 'text — not aggregatable' }
      }
      return isAggregatableType(f.type) ? base : null
    })
    .filter((o): o is PickOption => !!o)
}

export function fieldType(fields: FieldInfo[] | undefined, path: string): string | undefined {
  return fields?.find((f) => f.path === path)?.type
}
