import type { editor } from 'monaco-editor'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Compiled } from '@shared/aggregations/compiler'
import { decompile } from '@shared/aggregations/decompiler'
import { jsonEqual, STAGE_LABEL, type Stage } from '@shared/aggregations/model'
import { printJson, stageOfPath } from '@shared/aggregations/print'
import { CodeEditor } from '../../components/CodeEditor'
import { describe } from './summary'

const ES_CONSTRUCT: Record<Stage['kind'], (s: Stage, nested: boolean) => string> = {
  filter: (_s, nested) => (nested ? 'filter (single-bucket agg wrapping the rest)' : 'query.bool.filter'),
  groupBy: (s, nested) => (nested ? `a sub-aggregation (${(s as Extract<Stage, { kind: 'groupBy' }>).group.type}) inside the stage above` : 'terms · histogram · date_histogram · range · composite'),
  metrics: () => 'avg · sum · min/max · stats · percentiles · cardinality',
  keepOnly: () => 'bucket_selector (pipeline agg)',
  sortLimit: (_s, nested) => (nested ? 'bucket_sort (pipeline agg)' : 'sort / size / from'),
  runningTotal: () => 'cumulative_sum (pipeline agg)',
  changeOverTime: () => 'derivative (pipeline agg)',
  topDocs: (_s, nested) => (nested ? 'top_hits' : 'size / sort / _source'),
  custom: () => 'inserted verbatim'
}

/** The generated request; editing it decompiles back into stages (AGGREGATIONS.md §7). */
export function JsonPipelineView({ stages, target, compiled, onStages, onRun }: { stages: Stage[]; target: string; compiled: Compiled; onStages(stages: Stage[], unsupported: string[]): void; onRun(): void }) {
  const printed = useMemo(() => printJson(compiled.request), [compiled.request])
  const [text, setText] = useState(printed.text)
  const printedRef = useRef(printed.text)
  printedRef.current = printed.text
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; msg: string }>()
  const editing = useRef(false)
  const ed = useRef<editor.IStandaloneCodeEditor | undefined>(undefined)
  const [mounted, setMounted] = useState(false)
  const deco = useRef<editor.IEditorDecorationsCollection | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Follow pipeline changes made elsewhere unless the user is mid-edit.
  useEffect(() => {
    if (!editing.current) setText(printed.text)
  }, [printed.text])

  // Gutter numbers + tints come from the printed request; while the text differs (mid-edit) they are hidden.
  const gutter = useMemo(() => {
    if (text !== printed.text) return null
    return printed.lines.map((l) => {
      const s = stageOfPath(l.path, compiled.stages)
      return { label: s === undefined || l.closing ? '' : String(s + 1), stage: s }
    })
  }, [text, printed, compiled.stages])

  useEffect(() => {
    const e = ed.current
    if (!e) return
    e.updateOptions({ lineNumbers: gutter ? (n: number) => gutter[n - 1]?.label ?? '' : 'off', lineNumbersMinChars: 3 })
    const decorations = (gutter ?? []).flatMap((g, i) =>
      g.stage === undefined ? [] : [{ range: { startLineNumber: i + 1, startColumn: 1, endLineNumber: i + 1, endColumn: 1 }, options: { isWholeLine: true, className: stages[g.stage]?.kind === 'groupBy' ? 'agg-line-group' : 'agg-line-stage' } }]
    )
    deco.current ??= e.createDecorationsCollection()
    deco.current.set(decorations)
  }, [gutter, stages, mounted])

  const apply = (value: string) => {
    let body: unknown
    try {
      body = JSON.parse(value)
    } catch (err) {
      setNotice({ kind: 'error', msg: `Not valid JSON yet: ${(err as Error).message}` })
      return
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return setNotice({ kind: 'error', msg: 'The request body must be a JSON object.' })
    if (jsonEqual(body, compiled.request)) return setNotice(undefined)
    const d = decompile(body as Record<string, unknown>)
    // Keep stable ids for stages that didn't change (previews and focus survive), and put disabled stages —
    // which aren't in the request — back where they were.
    const enabled = stages.filter((x) => x.enabled)
    const parsed = d.stages.map((s, i) => (enabled[i] && enabled[i]!.kind === s.kind ? { ...s, id: enabled[i]!.id, label: enabled[i]!.label, collapsed: enabled[i]!.collapsed } : s))
    const next: Stage[] = []
    let j = 0
    for (const old of stages) {
      if (!old.enabled) next.push(old)
      else if (j < parsed.length) next.push(parsed[j++]!)
    }
    next.push(...parsed.slice(j))
    onStages(next, d.unsupported)
    setNotice(d.unsupported.length ? { kind: 'info', msg: `${d.unsupported.length} part${d.unsupported.length === 1 ? '' : 's'} kept as Custom JSON stage${d.unsupported.length === 1 ? '' : 's'}: ${d.unsupported.join(', ')}` } : !d.exact ? { kind: 'info', msg: 'Some details were normalised (e.g. size: 0 added for aggregations).' } : undefined)
  }

  const nestedOf = (i: number) => (compiled.stages[i]?.level ?? 0) > 0
  return (
    <div className="agg-json">
      <div className="agg-json-main">
        <div className="hint agg-json-hint">Generated request — edit here and the stages update. The gutter shows which stage each part comes from.</div>
        <div className="agg-json-line mono">
          <span className="kw">POST</span> <span className="tk">{target}</span>/_search
        </div>
        <div className="agg-json-editor">
          <CodeEditor
            value={text}
            path={`agg-json://${encodeURIComponent(target)}`}
            onChange={(v) => {
              editing.current = true
              setText(v)
              clearTimeout(timer.current)
              timer.current = setTimeout(() => apply(v), 1000)
            }}
            onRun={() => {
              clearTimeout(timer.current)
              apply(ed.current?.getValue() ?? text)
              onRun()
            }}
            onMount={(e) => {
              ed.current = e
              setMounted(true)
              e.onDidBlurEditorText(() => {
                clearTimeout(timer.current)
                apply(e.getValue())
                editing.current = false
                // Re-print normalised once the stages settled.
                setTimeout(() => setText(printedRef.current), 0)
              })
            }}
            options={{ lineNumbers: 'off', glyphMargin: false }}
          />
        </div>
        {notice && <div className={notice.kind === 'error' ? 'agg-error' : 'agg-note warn'}>{notice.msg}</div>}
      </div>
      <aside className="agg-json-side">
        <div className="agg-side-title">How stages map to Elasticsearch</div>
        {stages.map((s, i) =>
          s.enabled ? (
            <div key={s.id} className="agg-map-row">
              <span className="agg-num">{i + 1}</span>
              <div>
                <div className="agg-map-stage">
                  {STAGE_LABEL[s.kind]}
                  {s.kind === 'groupBy' && nestedOf(i) ? ' (nested)' : ''}
                </div>
                <div className="mono agg-map-es">{ES_CONSTRUCT[s.kind](s, nestedOf(i))}</div>
                <div className="mono agg-map-desc" title={describe(s, compiled, i)}>
                  {describe(s, compiled, i)}
                </div>
              </div>
            </div>
          ) : null
        )}
        <div className="agg-side-foot">Elasticsearch aggregations are a tree, not a list. Each Group by stage opens a new level and every later stage nests inside it, so the pipeline view stays flat while the request nests. Keep only and Sort &amp; limit attach to the level whose metrics they read.</div>
      </aside>
    </div>
  )
}
