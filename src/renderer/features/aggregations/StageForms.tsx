import { useEffect, useState, type ReactNode } from 'react'
import { defaultGroupName, defaultMetricName } from '@shared/aggregations/compiler'
import {
  CALENDAR_INTERVALS,
  FILTER_OP_LABEL,
  GROUP_LABEL,
  isDateType,
  isNumericType,
  METRIC_LABEL,
  type Condition,
  type FilterOp,
  type GroupSpec,
  type GroupType,
  type MetricOp,
  type Scalar,
  type Stage,
  type StageOf
} from '@shared/aggregations/model'
import type { FieldInfo } from '@shared/meta'
import { ChipInput } from '../../components/ChipInput'
import { CodeEditor } from '../../components/CodeEditor'
import { fieldOptions, fieldType, Picker, type PickOption } from './Picker'

export interface FormCtx {
  fields?: FieldInfo[]
  /** Metric references available to this stage (Keep only / Sort & limit / Running total / Change over time / terms order). */
  metricRefs: PickOption[]
  /** Label of the level this stage runs in, e.g. "city". */
  levelLabel?: string
  /** No Group by above: Sort & limit / Top documents sort documents by a field. */
  atRoot: boolean
}

type Props<K extends Stage['kind']> = { stage: StageOf<K>; onChange(s: StageOf<K>): void; ctx: FormCtx }

const NO_VALUE: FilterOp[] = ['exists', 'missing']

function toValue(raw: string, type: string | undefined): Scalar {
  if (type && isNumericType(type) && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw)
  if (type === 'boolean' && (raw === 'true' || raw === 'false')) return raw === 'true'
  return raw
}

/** Text input that keeps what's typed while the stage stores a parsed value. */
function ValueInput({ value, onChange, type, label, width = 140, placeholder = 'value' }: { value: Scalar | undefined; onChange(v: Scalar): void; type?: string; label: string; width?: number; placeholder?: string }) {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  useEffect(() => {
    if (String(toValue(text, type)) !== String(value ?? '')) setText(value === undefined ? '' : String(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  const numeric = !!type && isNumericType(type)
  return (
    <input
      className={`agg-fld mono ${numeric ? 'tn' : 'ts'}`}
      style={{ width }}
      aria-label={label}
      placeholder={type && isDateType(type) ? 'now-30d or 2024-01-01' : placeholder}
      value={text}
      spellCheck={false}
      onChange={(e) => {
        setText(e.target.value)
        onChange(toValue(e.target.value, type))
      }}
    />
  )
}

function NumInput({ value, onChange, label, width = 70, min = 0, step }: { value: number | undefined; onChange(v: number | undefined): void; label: string; width?: number; min?: number; step?: number }) {
  return (
    <input
      type="number"
      className="agg-fld mono tn"
      style={{ width }}
      aria-label={label}
      min={min}
      step={step}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
    />
  )
}

function Select<T extends string>({ value, options, onChange, label, width, className }: { value: T; options: Array<[T, string]>; onChange(v: T): void; label: string; width?: number; className?: string }) {
  return (
    <select className={`agg-fld${className ? ` ${className}` : ''}`} aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)} style={width ? { width } : undefined}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  )
}

const X = ({ onClick, label }: { onClick(): void; label: string }) => (
  <button type="button" className="agg-x" aria-label={label} onClick={onClick}>
    ✕
  </button>
)

const Add = ({ onClick, children }: { onClick(): void; children: string }) => (
  <button type="button" className="agg-add" onClick={onClick}>
    + {children}
  </button>
)

// ---------- Filter ----------

function ConditionRow({ c, onChange, fields, label }: { c: Condition; onChange(c: Condition): void; fields?: FieldInfo[]; label: string }) {
  const type = fieldType(fields, c.field)
  const opts = fieldOptions(fields, 'filter')
  return (
    <>
      <Picker label={`${label} field`} value={c.field} options={opts} onChange={(field) => onChange({ ...c, field })} placeholder="field" allowCustom />
      <Select label={`${label} operator`} className={['oneOf', 'between', 'exists', 'missing', 'contains', 'isNot'].includes(c.op) ? undefined : 'agg-op'} value={c.op} options={(Object.keys(FILTER_OP_LABEL) as FilterOp[]).map((o) => [o, FILTER_OP_LABEL[o]])} onChange={(op) => onChange({ ...c, op, ...(op === 'oneOf' && !c.values ? { values: c.value !== undefined && c.value !== '' ? [c.value] : [] } : {}) })} />
      {c.op === 'oneOf' ? (
        <div className="agg-chips">
          <ChipInput label={`${label} values`} value={(c.values ?? []).map(String)} onChange={(v) => onChange({ ...c, values: v.map((x) => toValue(x, type)) })} placeholder="value, value…" />
        </div>
      ) : c.op === 'between' ? (
        <>
          <ValueInput label={`${label} from`} value={c.value} type={type} onChange={(value) => onChange({ ...c, value })} width={110} placeholder="from" />
          <span className="agg-of">and</span>
          <ValueInput label={`${label} to`} value={c.value2} type={type} onChange={(value2) => onChange({ ...c, value2 })} width={110} placeholder="to" />
        </>
      ) : NO_VALUE.includes(c.op) ? null : (
        <ValueInput label={`${label} value`} value={c.value} type={type} onChange={(value) => onChange({ ...c, value })} />
      )}
    </>
  )
}

export function FilterForm({ stage, onChange, ctx }: Props<'filter'>) {
  if (stage.raw)
    return (
      <div className="agg-rows">
        <div className="agg-row">
          <span className="agg-lbl">Raw query</span>
          <span className="hint">This filter came from JSON that doesn’t map to conditions. Edit it with “&lt;/&gt; JSON”, or</span>
          <button type="button" className="agg-add" onClick={() => onChange({ ...stage, raw: undefined, conditions: [{ field: '', op: 'is', value: '' }] })}>
            replace with conditions
          </button>
        </div>
        <pre className="agg-raw mono">{JSON.stringify(stage.raw)}</pre>
      </div>
    )
  const set = (i: number, c: Condition) => onChange({ ...stage, conditions: stage.conditions.map((x, j) => (j === i ? c : x)) })
  return (
    <div className="agg-rows">
      {stage.conditions.map((c, i) => (
        <div className="agg-row" key={i}>
          <span className="agg-lbl">
            {i === 0 ? (
              <Select label="Match" value={stage.match} options={[['all', 'Match all of'], ['any', 'Match any of']]} onChange={(match) => onChange({ ...stage, match })} />
            ) : (
              <span className="agg-and">{stage.match === 'all' ? 'and' : 'or'}</span>
            )}
          </span>
          <ConditionRow c={c} onChange={(n) => set(i, n)} fields={ctx.fields} label={`Condition ${i + 1}`} />
          {stage.conditions.length > 1 && <X label={`Remove condition ${i + 1}`} onClick={() => onChange({ ...stage, conditions: stage.conditions.filter((_, j) => j !== i) })} />}
        </div>
      ))}
      <div className="agg-indent">
        <Add onClick={() => onChange({ ...stage, conditions: [...stage.conditions, { field: '', op: 'is', value: '' }] })}>Condition</Add>
      </div>
      {!ctx.atRoot && <div className="agg-note">Runs inside every {ctx.levelLabel ?? 'bucket'} bucket: later stages only see matching documents.</div>}
    </div>
  )
}

// ---------- Group by ----------

function convertGroup(g: GroupSpec, type: GroupType, fields?: FieldInfo[]): GroupSpec {
  const field = 'field' in g ? g.field : g.type === 'composite' ? (g.sources[0]?.field ?? '') : ''
  const t = fieldType(fields, field)
  const keep = (ok: boolean) => (ok ? field : '')
  switch (type) {
    case 'terms':
      return { type, field, size: 10 }
    case 'histogram':
      return { type, field: keep(!!t && isNumericType(t)), interval: 10 }
    case 'date_histogram':
      return { type, field: keep(!!t && isDateType(t)), calendarInterval: 'month' }
    case 'range':
      return { type, field: keep(!!t && isNumericType(t)), ranges: [{ to: 100 }, { from: 100 }] }
    case 'date_range':
      return { type, field: keep(!!t && isDateType(t)), ranges: [{ to: 'now-1M/M' }, { from: 'now-1M/M' }] }
    case 'filters':
      return { type, filters: [{ name: 'first', condition: { field, op: 'exists' } }] }
    case 'composite':
      return { type, size: 100, sources: [{ field, type: 'terms' }] }
  }
}

export function GroupForm({ stage, onChange, ctx }: Props<'groupBy'>) {
  const g = stage.group
  const set = (group: GroupSpec) => onChange({ ...stage, group })
  const groupOpts = fieldOptions(ctx.fields, 'group')
  const numOpts = fieldOptions(ctx.fields, 'numeric')
  const dateOpts = fieldOptions(ctx.fields, 'date')
  const kind = (
    <Select label="Group kind" value={g.type} options={(Object.keys(GROUP_LABEL) as GroupType[]).map((t) => [t, GROUP_LABEL[t]])} onChange={(t) => set(convertGroup(g, t, ctx.fields))} />
  )
  const name = (
    <input className="agg-fld mono" style={{ width: 150 }} aria-label="Group name" placeholder={defaultGroupName(g)} value={stage.name} spellCheck={false} onChange={(e) => onChange({ ...stage, name: e.target.value })} />
  )
  let body: ReactNode = null
  switch (g.type) {
    case 'terms':
      body = (
        <>
          <div className="agg-row">
            <span className="agg-lbl">Field</span>
            <Picker label="Group field" value={g.field} options={groupOpts} onChange={(field) => set({ ...g, field })} placeholder="field" />
            <span className="agg-lbl inline">Buckets</span>
            <NumInput label="Buckets" value={g.size} min={1} onChange={(size) => set({ ...g, size: size ?? 10 })} />
          </div>
          <div className="agg-row">
            <span className="agg-lbl">Order by</span>
            <Picker
              label="Order by"
              mono={false}
              value={g.order?.by ?? '_count'}
              options={[{ value: '_count', label: 'Document count' }, { value: '_key', label: 'Key' }, ...ctx.metricRefs.filter((o) => o.value !== '_count' && o.value !== '_key')]}
              onChange={(by) => set({ ...g, order: { by, dir: g.order?.dir ?? (by === '_key' ? 'asc' : 'desc') } })}
              allowCustom
            />
            <Select label="Order direction" value={g.order?.dir ?? 'desc'} options={[['desc', 'Descending'], ['asc', 'Ascending']]} onChange={(dir) => set({ ...g, order: { by: g.order?.by ?? '_count', dir } })} />
            <Select label="Missing values" value={g.missing ?? 'skip'} options={[['skip', 'Missing: skip'], ['bucket', 'Missing: “(missing)”']]} onChange={(missing) => set({ ...g, missing })} />
          </div>
        </>
      )
      break
    case 'histogram':
      body = (
        <div className="agg-row">
          <span className="agg-lbl">Field</span>
          <Picker label="Group field" value={g.field} options={numOpts} onChange={(field) => set({ ...g, field })} placeholder="numeric field" />
          <span className="agg-lbl inline">Every</span>
          <NumInput label="Interval" value={g.interval} min={0} step={1} width={90} onChange={(interval) => set({ ...g, interval: interval ?? 1 })} />
        </div>
      )
      break
    case 'date_histogram':
      body = (
        <div className="agg-row">
          <span className="agg-lbl">Field</span>
          <Picker label="Group field" value={g.field} options={dateOpts} onChange={(field) => set({ ...g, field })} placeholder="date field" />
          <span className="agg-lbl inline">Every</span>
          <Select
            label="Interval"
            value={g.calendarInterval ?? 'fixed'}
            options={[...CALENDAR_INTERVALS.map((i) => [i, i] as [string, string]), ['fixed', 'fixed…']]}
            onChange={(v) => set(v === 'fixed' ? { ...g, calendarInterval: undefined, fixedInterval: g.fixedInterval ?? '12h' } : { ...g, calendarInterval: v, fixedInterval: undefined })}
          />
          {!g.calendarInterval && <input className="agg-fld mono" style={{ width: 70 }} aria-label="Fixed interval" value={g.fixedInterval ?? ''} placeholder="12h" onChange={(e) => set({ ...g, fixedInterval: e.target.value })} />}
        </div>
      )
      break
    case 'range':
    case 'date_range': {
      const isDate = g.type === 'date_range'
      body = (
        <>
          <div className="agg-row">
            <span className="agg-lbl">Field</span>
            <Picker label="Group field" value={g.field} options={isDate ? dateOpts : numOpts} onChange={(field) => set({ ...g, field } as GroupSpec)} placeholder={isDate ? 'date field' : 'numeric field'} />
          </div>
          {g.ranges.map((r, i) => (
            <div className="agg-row" key={i}>
              <span className="agg-lbl">{i === 0 ? 'Ranges' : ''}</span>
              <ValueInput label={`Range ${i + 1} from`} value={r.from} type={isDate ? 'date' : 'double'} width={110} placeholder="from (any)" onChange={(from) => set({ ...g, ranges: g.ranges.map((x, j) => (j === i ? { ...x, from: from === '' ? undefined : from } : x)) } as GroupSpec)} />
              <span className="agg-of">to</span>
              <ValueInput label={`Range ${i + 1} to`} value={r.to} type={isDate ? 'date' : 'double'} width={110} placeholder="to (any)" onChange={(to) => set({ ...g, ranges: g.ranges.map((x, j) => (j === i ? { ...x, to: to === '' ? undefined : to } : x)) } as GroupSpec)} />
              <input className="agg-fld mono" style={{ width: 90 }} aria-label={`Range ${i + 1} name`} placeholder="name" value={r.key ?? ''} onChange={(e) => set({ ...g, ranges: g.ranges.map((x, j) => (j === i ? { ...x, key: e.target.value || undefined } : x)) } as GroupSpec)} />
              {g.ranges.length > 1 && <X label={`Remove range ${i + 1}`} onClick={() => set({ ...g, ranges: g.ranges.filter((_, j) => j !== i) } as GroupSpec)} />}
            </div>
          ))}
          <div className="agg-indent">
            <Add onClick={() => set({ ...g, ranges: [...g.ranges, {}] } as GroupSpec)}>Range</Add>
          </div>
        </>
      )
      break
    }
    case 'filters':
      body = (
        <>
          {g.filters.map((f, i) => (
            <div className="agg-row" key={i}>
              <input className="agg-fld mono" style={{ width: 92 }} aria-label={`Filter ${i + 1} name`} value={f.name} onChange={(e) => set({ ...g, filters: g.filters.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
              <ConditionRow c={f.condition} fields={ctx.fields} label={`Filter ${i + 1}`} onChange={(condition) => set({ ...g, filters: g.filters.map((x, j) => (j === i ? { ...x, condition } : x)) })} />
              {g.filters.length > 1 && <X label={`Remove filter ${i + 1}`} onClick={() => set({ ...g, filters: g.filters.filter((_, j) => j !== i) })} />}
            </div>
          ))}
          <div className="agg-indent">
            <Add onClick={() => set({ ...g, filters: [...g.filters, { name: `filter_${g.filters.length + 1}`, condition: { field: '', op: 'is', value: '' } }] })}>Named filter</Add>
          </div>
        </>
      )
      break
    case 'composite':
      body = (
        <>
          {g.sources.map((s, i) => (
            <div className="agg-row" key={i}>
              <span className="agg-lbl">{i === 0 ? 'Fields' : 'then'}</span>
              <Picker label={`Source ${i + 1} field`} value={s.field} options={s.type === 'terms' ? groupOpts : s.type === 'histogram' ? numOpts : dateOpts} onChange={(field) => set({ ...g, sources: g.sources.map((x, j) => (j === i ? { ...x, field } : x)) })} placeholder="field" />
              <Select label={`Source ${i + 1} kind`} value={s.type} options={[['terms', 'values'], ['histogram', 'histogram'], ['date_histogram', 'date histogram']]} onChange={(type) => set({ ...g, sources: g.sources.map((x, j) => (j === i ? { ...x, type, interval: type === 'terms' ? undefined : type === 'histogram' ? 10 : 'month' } : x)) })} />
              {s.type !== 'terms' && <input className="agg-fld mono" style={{ width: 80 }} aria-label={`Source ${i + 1} interval`} value={s.interval ?? ''} onChange={(e) => set({ ...g, sources: g.sources.map((x, j) => (j === i ? { ...x, interval: s.type === 'histogram' ? Number(e.target.value) || 1 : e.target.value } : x)) })} />}
              {g.sources.length > 1 && <X label={`Remove source ${i + 1}`} onClick={() => set({ ...g, sources: g.sources.filter((_, j) => j !== i) })} />}
            </div>
          ))}
          <div className="agg-row">
            <span className="agg-lbl" />
            <Add onClick={() => set({ ...g, sources: [...g.sources, { field: '', type: 'terms' }] })}>Field</Add>
            <span className="agg-lbl inline">Page size</span>
            <NumInput label="Page size" value={g.size} min={1} onChange={(size) => set({ ...g, size: size ?? 100 })} />
          </div>
        </>
      )
      break
  }
  return (
    <div className="agg-rows">
      <div className="agg-row">
        <span className="agg-lbl">Group</span>
        {kind}
        <span className="agg-lbl inline">Name</span>
        {name}
      </div>
      {body}
    </div>
  )
}

// ---------- Metrics ----------

export function MetricsForm({ stage, onChange, ctx }: Props<'metrics'>) {
  const numOpts = fieldOptions(ctx.fields, 'numeric')
  const anyOpts = fieldOptions(ctx.fields, 'group')
  const set = (i: number, m: StageOf<'metrics'>['metrics'][number]) => onChange({ ...stage, metrics: stage.metrics.map((x, j) => (j === i ? m : x)) })
  return (
    <div className="agg-rows">
      {stage.metrics.map((m, i) => (
        <div className="agg-row" key={i}>
          <input className="agg-fld mono" style={{ width: 130 }} aria-label={`Metric ${i + 1} name`} placeholder={defaultMetricName(m)} value={m.name} spellCheck={false} onChange={(e) => set(i, { ...m, name: e.target.value })} />
          <span className="agg-of">=</span>
          <Select label={`Metric ${i + 1} operation`} value={m.op} options={(Object.keys(METRIC_LABEL) as MetricOp[]).map((o) => [o, METRIC_LABEL[o]])} onChange={(op) => set(i, { ...m, op, ...(op === 'percentiles' && !m.percents ? { percents: [50, 95, 99] } : {}) })} />
          {m.op !== 'count' && (
            <>
              <span className="agg-of">of</span>
              <Picker label={`Metric ${i + 1} field`} value={m.field ?? ''} options={m.op === 'cardinality' || m.op === 'value_count' ? anyOpts : numOpts} onChange={(field) => set(i, { ...m, field })} placeholder="field" />
            </>
          )}
          {m.op === 'percentiles' && (
            <input
              className="agg-fld mono tn"
              style={{ width: 100 }}
              aria-label={`Metric ${i + 1} percents`}
              defaultValue={(m.percents ?? []).join(', ')}
              onBlur={(e) => set(i, { ...m, percents: e.target.value.split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n)) })}
            />
          )}
          {stage.metrics.length > 1 && <X label={`Remove metric ${i + 1}`} onClick={() => onChange({ ...stage, metrics: stage.metrics.filter((_, j) => j !== i) })} />}
        </div>
      ))}
      <Add onClick={() => onChange({ ...stage, metrics: [...stage.metrics, { name: '', op: 'avg', field: '' }] })}>Metric · avg, sum, min, max, stats, percentiles, unique count</Add>
    </div>
  )
}

// ---------- Keep only / Sort & limit / Running total / Change ----------

const refOptions = (ctx: FormCtx, withKey = false): PickOption[] => [{ value: '_count', label: 'Document count' }, ...(withKey ? [{ value: '_key', label: 'Key' }] : []), ...ctx.metricRefs.filter((o) => o.value !== '_count' && o.value !== '_key')]

export function KeepForm({ stage, onChange, ctx }: Props<'keepOnly'>) {
  const set = (i: number, r: StageOf<'keepOnly'>['rules'][number]) => onChange({ ...stage, rules: stage.rules.map((x, j) => (j === i ? r : x)) })
  return (
    <div className="agg-rows">
      {stage.rules.map((r, i) => (
        <div className="agg-row" key={i}>
          <span className="agg-lbl">{i === 0 ? 'Keep buckets where' : 'and'}</span>
          <Picker label={`Rule ${i + 1} metric`} value={r.metric} options={refOptions(ctx)} onChange={(metric) => set(i, { ...r, metric })} placeholder="metric" allowCustom />
          <Select label={`Rule ${i + 1} comparator`} value={r.cmp} options={[['>', '>'], ['>=', '≥'], ['<', '<'], ['<=', '≤'], ['==', '='], ['!=', '≠']]} onChange={(cmp) => set(i, { ...r, cmp })} />
          <NumInput label={`Rule ${i + 1} value`} value={Number.isFinite(r.value) ? r.value : undefined} width={130} min={-Infinity} onChange={(v) => set(i, { ...r, value: v ?? Number.NaN })} />
          {stage.rules.length > 1 && <X label={`Remove rule ${i + 1}`} onClick={() => onChange({ ...stage, rules: stage.rules.filter((_, j) => j !== i) })} />}
        </div>
      ))}
      <div className="agg-indent">
        <Add onClick={() => onChange({ ...stage, rules: [...stage.rules, { metric: '', cmp: '>', value: 0 }] })}>Rule</Add>
      </div>
    </div>
  )
}

export function SortForm({ stage, onChange, ctx }: Props<'sortLimit'>) {
  const byOpts = ctx.atRoot ? [{ value: '_count', label: 'Relevance' }, ...fieldOptions(ctx.fields, 'group')] : refOptions(ctx, true)
  return (
    <div className="agg-rows">
      <div className="agg-row">
        <span className="agg-lbl">Sort by</span>
        <Picker label="Sort by" value={stage.by} mono={stage.by !== '_count' && stage.by !== '_key'} options={byOpts} onChange={(by) => onChange({ ...stage, by })} allowCustom />
        <Select label="Sort direction" value={stage.dir} options={[['desc', 'Descending'], ['asc', 'Ascending']]} onChange={(dir) => onChange({ ...stage, dir })} />
      </div>
      <div className="agg-row">
        <span className="agg-lbl">Keep</span>
        <NumInput label="Keep" value={stage.size} min={0} onChange={(size) => onChange({ ...stage, size: size ?? 0 })} />
        <span className="agg-lbl inline">Skip</span>
        <NumInput label="Skip" value={stage.from} min={0} onChange={(from) => onChange({ ...stage, from: from || undefined })} />
      </div>
    </div>
  )
}

export function MetricRefForm({ stage, onChange, ctx }: Props<'runningTotal'> | Props<'changeOverTime'>) {
  return (
    <div className="agg-rows">
      <div className="agg-row">
        <span className="agg-lbl">Metric</span>
        <Picker label="Metric" value={stage.metric} options={refOptions(ctx)} onChange={(metric) => (onChange as (s: Stage) => void)({ ...stage, metric })} placeholder="metric" allowCustom />
        {stage.kind === 'changeOverTime' && (
          <Select label="Change mode" value={stage.mode} options={[['diff', 'Difference'], ['pct', '% change']]} onChange={(mode) => (onChange as (s: Stage) => void)({ ...stage, mode })} />
        )}
      </div>
      <div className="agg-note">Needs a Histogram or Date histogram group; adds a column next to {stage.metric || 'the metric'}.</div>
    </div>
  )
}

export function TopDocsForm({ stage, onChange, ctx }: Props<'topDocs'>) {
  const opts = fieldOptions(ctx.fields, 'group')
  return (
    <div className="agg-rows">
      <div className="agg-row">
        <span className="agg-lbl">Show</span>
        <NumInput label="Documents" value={stage.size} min={1} onChange={(size) => onChange({ ...stage, size: size ?? 1 })} />
        <span className="agg-of">{ctx.atRoot ? 'documents' : 'per bucket'}, sorted by</span>
        <Picker label="Sort documents by" value={stage.sort?.field ?? ''} options={[{ value: '', label: 'relevance' }, ...opts]} onChange={(field) => onChange({ ...stage, sort: field ? { field, dir: stage.sort?.dir ?? 'desc' } : undefined })} placeholder="relevance" />
        {stage.sort?.field && <Select label="Document sort direction" value={stage.sort.dir} options={[['desc', 'desc'], ['asc', 'asc']]} onChange={(dir) => onChange({ ...stage, sort: { field: stage.sort!.field, dir } })} />}
      </div>
      <div className="agg-row">
        <span className="agg-lbl">Fields</span>
        <div className="agg-chips">
          <ChipInput label="Fields to show" value={stage.fields ?? []} suggestions={(ctx.fields ?? []).map((f) => f.path)} onChange={(fields) => onChange({ ...stage, fields: fields.length ? fields : undefined })} placeholder="all fields" />
        </div>
      </div>
    </div>
  )
}

export function CustomForm({ stage, onChange }: Props<'custom'>) {
  const [text, setText] = useState(() => JSON.stringify(stage.json, null, 2))
  const [error, setError] = useState<string>()
  return (
    <div className="agg-rows">
      <div className="agg-row">
        <span className="agg-lbl">{stage.place === 'request' ? 'Request keys' : 'Agg name'}</span>
        {stage.place === 'request' ? (
          <span className="hint">merged into the request root</span>
        ) : (
          <input className="agg-fld mono" style={{ width: 180 }} aria-label="Custom agg name" value={stage.name} onChange={(e) => onChange({ ...stage, name: e.target.value })} />
        )}
      </div>
      <div className="agg-custom-editor">
        <CodeEditor
          value={text}
          height={Math.min(260, 42 + text.split('\n').length * 21)}
          options={{ lineNumbers: 'off', folding: false, padding: { top: 6, bottom: 6 } }}
          onChange={(v) => {
            setText(v)
            try {
              const j = JSON.parse(v) as unknown
              if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('Must be a JSON object')
              setError(undefined)
              onChange({ ...stage, json: j as Record<string, unknown> })
            } catch (e) {
              setError((e as Error).message)
            }
          }}
        />
      </div>
      {error && <div className="hint error">{error}</div>}
    </div>
  )
}

export function StageForm({ stage, onChange, ctx }: { stage: Stage; onChange(s: Stage): void; ctx: FormCtx }) {
  switch (stage.kind) {
    case 'filter':
      return <FilterForm stage={stage} onChange={onChange} ctx={ctx} />
    case 'groupBy':
      return <GroupForm stage={stage} onChange={onChange} ctx={ctx} />
    case 'metrics':
      return <MetricsForm stage={stage} onChange={onChange} ctx={ctx} />
    case 'keepOnly':
      return <KeepForm stage={stage} onChange={onChange} ctx={ctx} />
    case 'sortLimit':
      return <SortForm stage={stage} onChange={onChange} ctx={ctx} />
    case 'runningTotal':
    case 'changeOverTime':
      return <MetricRefForm stage={stage as StageOf<'runningTotal'>} onChange={onChange} ctx={ctx} />
    case 'topDocs':
      return <TopDocsForm stage={stage} onChange={onChange} ctx={ctx} />
    case 'custom':
      return <CustomForm stage={stage} onChange={onChange} ctx={ctx} />
  }
}
