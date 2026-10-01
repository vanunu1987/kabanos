import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { newStepId, type Routine, type RoutineStep, type StepResult } from '@shared/routines'
import type { HttpMethod } from '@shared/types'
import { api } from '../../api'
import { CodeEditor } from '../../components/CodeEditor'
import { useApp } from '../../store'
import { useRoutines } from './store'

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD']

type Visual = 'done' | 'run' | 'wait' | 'gate' | 'fail' | 'skip'

function visual(step: RoutineStep, r: StepResult | undefined, isProd: boolean): Visual {
  switch (r?.outcome) {
    case 'ok':
      return 'done'
    case 'running':
    case 'polling':
      return 'run'
    case 'failed':
    case 'declined':
      return 'fail'
    case 'skipped':
    case 'dry':
      return 'skip'
    default:
      return step.confirm || (isProd && step.method !== 'GET' && step.method !== 'HEAD') ? 'gate' : 'wait'
  }
}

function statusText(step: RoutineStep, r: StepResult | undefined, gate: boolean): string {
  if (!r || r.outcome === 'pending') return gate ? 'asks before run' : 'pending'
  if (r.outcome === 'running') return 'running…'
  if (r.outcome === 'polling') return `polling · ${r.attempts ?? 1}`
  if (r.outcome === 'skipped') return 'skipped'
  if (r.outcome === 'dry') return 'dry run'
  if (r.outcome === 'declined') return 'not confirmed'
  const cap = r.captured ? Object.values(r.captured)[0] : undefined
  const extra = cap !== undefined && (typeof cap === 'number' || typeof cap === 'string') ? ` · ${typeof cap === 'number' ? cap.toLocaleString() : String(cap).slice(0, 24)}` : r.ms !== undefined ? ` · ${r.ms} ms` : ''
  return `${r.status ?? (r.outcome === 'failed' ? 'failed' : '')}${extra}`
}

function chips(step: RoutineStep, queryTitle?: string, connName?: string, isAgg?: boolean): string[] {
  const out: string[] = []
  if (step.queryRef) out.push(`saved ${isAgg ? 'pipeline' : 'query'} “${queryTitle ?? '…'}”`)
  if (step.connectionId) out.push(`on ${connName ?? 'other connection'}`)
  if (step.when) out.push(`when ${step.when}`)
  if (step.assert) out.push(`assert ${step.assert}`)
  if (step.repeat) out.push(`repeat every ${step.repeat.everySec}s until ${step.repeat.until}`, `timeout ${step.repeat.timeoutMin}m`)
  for (const [k, v] of Object.entries(step.capture ?? {})) out.push(`save ${k} ← ${v}`)
  if (step.onFail === 'continue') out.push('on fail: continue')
  else if (step.assert) out.push('on fail: stop')
  if (step.confirm) out.push('needs confirmation')
  return out
}

/** One step on the routine timeline: summary card, expanding into an editor. */
export function StepCard({ routine, step, index, result, last, paused }: { routine: Routine; step: RoutineStep; index: number; result?: StepResult; last: boolean; paused: boolean }) {
  const connections = useApp((s) => s.connections)
  const editing = useRoutines((s) => s.editingStep === step.id)
  const library = useQuery({ queryKey: ['library-all'], queryFn: () => api.library.queries({ kind: 'all' }), staleTime: 5000 })
  const query = step.queryRef ? library.data?.find((q) => q.id === step.queryRef) : undefined
  const conn = connections.find((c) => c.id === (step.connectionId ?? routine.defaultConnectionId))
  const v = visual(step, result, !!conn?.isProd)
  const method = query?.method ?? step.method
  const path = result?.path ?? query?.path ?? step.path

  const set = (patch: Partial<RoutineStep>) => useRoutines.getState().update(routine.id, { steps: routine.steps.map((s) => (s.id === step.id ? { ...s, ...patch } : s)) })
  const move = (d: -1 | 1) => {
    const steps = [...routine.steps]
    const j = index + d
    if (j < 0 || j >= steps.length) return
    ;[steps[index], steps[j]] = [steps[j]!, steps[index]!]
    useRoutines.getState().update(routine.id, { steps })
  }
  const remove = () => useRoutines.getState().update(routine.id, { steps: routine.steps.filter((s) => s.id !== step.id) })

  return (
    <div className="step-row">
      <div className="step-rail">
        <span className={`step-num mono v-${v}${paused ? ' paused' : ''}`}>{index + 1}</span>
        {!last && <span className={`step-line${v === 'done' ? ' done' : ''}`} />}
      </div>
      <div className={`step-card v-${v}${editing ? ' editing' : ''}${paused ? ' paused' : ''}`}>
        <button className="step-summary" onClick={() => useRoutines.setState({ editingStep: editing ? undefined : step.id })} aria-expanded={editing}>
          <span className="step-line1">
            <span className={`mono step-method m-${method.toLowerCase()}`}>{method}</span>
            <span className="mono step-path">{path}</span>
            <span className={`step-status s-${v}`}>{statusText(step, result, v === 'gate')}</span>
          </span>
          <span className="step-line2">
            <span className="step-name">{step.name || <span className="faint">Unnamed step</span>}</span>
            {chips(step, query?.title || query?.path, connections.find((c) => c.id === step.connectionId)?.name, !!query?.pipeline).map((c) => (
              <span key={c} className="step-chip mono">
                {c}
              </span>
            ))}
          </span>
          {result?.outcome === 'polling' && <span className="progress"><span /></span>}
          {result?.message && result.outcome !== 'polling' && <span className={`step-msg${result.outcome === 'failed' || result.outcome === 'declined' ? ' bad' : ''}`}>{result.message}</span>}
        </button>
        {editing && (
          <div className="step-editor">
            <div className="grid-3">
              <div className="field">
                <label>Name</label>
                <input
                  className="input sm"
                  value={step.name}
                  onChange={(e) => {
                    // Placeholder ids follow the name, so {{steps.<id>.…}} reads naturally (start_reindex).
                    const others = routine.steps.filter((x) => x.id !== step.id)
                    const auto = /^(new_step|step)(_\d+)?$/.test(step.id) || step.id === newStepId(others, step.name)
                    set({ name: e.target.value, ...(auto && e.target.value.trim() ? { id: newStepId(others, e.target.value) } : {}) })
                    if (auto && e.target.value.trim()) useRoutines.setState({ editingStep: newStepId(others, e.target.value) })
                  }}
                  aria-label="Step name"
                />
              </div>
              <div className="field">
                <label>Id (for {'{{steps.<id>.…}}'})</label>
                <StepIdField step={step} others={routine.steps.filter((x) => x.id !== step.id)} onCommit={(id) => (set({ id }), useRoutines.setState({ editingStep: id }))} />
              </div>
              <div className="field">
                <label>Connection</label>
                <select className="select sm" value={step.connectionId ?? ''} onChange={(e) => set({ connectionId: e.target.value || undefined })} aria-label="Step connection">
                  <option value="">Routine default</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.isProd ? ' (prod)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label>Request</label>
              <select className="select sm" value={step.queryRef ?? ''} onChange={(e) => set({ queryRef: e.target.value || undefined })} aria-label="Request source">
                <option value="">Inline request</option>
                {(library.data ?? [])
                  .filter((q) => q.folderId !== null || q.pipeline)
                  .map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.pipeline ? '∑ Pipeline' : 'Saved'}: {q.title || q.path}
                    </option>
                  ))}
              </select>
            </div>
            {!step.queryRef && (
              <>
                <div className="row">
                  <select className="select sm" style={{ width: 100 }} value={step.method} onChange={(e) => set({ method: e.target.value as HttpMethod })} aria-label="Step method">
                    {METHODS.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                  <input className="input sm mono" style={{ flexGrow: 1 }} value={step.path} onChange={(e) => set({ path: e.target.value })} placeholder="{{source}}/_count" aria-label="Step path" spellCheck={false} />
                </div>
                {step.method !== 'GET' && step.method !== 'HEAD' && (
                  <div className="editor-box" style={{ height: 150 }}>
                    <CodeEditor value={step.body ?? ''} onChange={(body) => set({ body })} path={`step://${routine.id}/${step.id}`} />
                  </div>
                )}
              </>
            )}
            <div className="grid-2">
              <div className="field">
                <label>Assert (jsonata)</label>
                <input className="input sm mono" value={step.assert ?? ''} onChange={(e) => set({ assert: e.target.value || undefined })} placeholder="status != 'red'" aria-label="Assert" spellCheck={false} />
              </div>
              <div className="field">
                <label>On failure</label>
                <select className="select sm" value={step.onFail} onChange={(e) => set({ onFail: e.target.value as RoutineStep['onFail'] })} aria-label="On failure">
                  <option value="stop">Stop the routine</option>
                  <option value="continue">Continue</option>
                </select>
              </div>
              <div className="field">
                <label>Capture (name = expression, one per line)</label>
                <CaptureField key={step.id} value={step.capture} onCommit={(capture) => set({ capture })} />
              </div>
              <div className="field">
                <label>Run only when (jsonata on steps/vars)</label>
                <input className="input sm mono" value={step.when ?? ''} onChange={(e) => set({ when: e.target.value || undefined })} placeholder="steps.count.value > 0" aria-label="When" spellCheck={false} />
              </div>
            </div>
            <div className="inline-row" style={{ gap: 14 }}>
              <label className="check">
                <input type="checkbox" checked={!!step.repeat} onChange={(e) => set({ repeat: e.target.checked ? { until: 'completed == true', everySec: 10, timeoutMin: 30 } : undefined })} />
                Repeat until
              </label>
              {step.repeat && (
                <>
                  <input className="input sm mono" style={{ width: 200 }} value={step.repeat.until} onChange={(e) => set({ repeat: { ...step.repeat!, until: e.target.value } })} aria-label="Repeat until" />
                  <span className="hint">every</span>
                  <input className="input sm" type="number" style={{ width: 64 }} value={step.repeat.everySec} onChange={(e) => set({ repeat: { ...step.repeat!, everySec: Number(e.target.value) } })} aria-label="Every seconds" />
                  <span className="hint">s, timeout</span>
                  <input className="input sm" type="number" style={{ width: 64 }} value={step.repeat.timeoutMin} onChange={(e) => set({ repeat: { ...step.repeat!, timeoutMin: Number(e.target.value) } })} aria-label="Timeout minutes" />
                  <span className="hint">min</span>
                </>
              )}
              <label className="check" style={{ marginLeft: 'auto' }}>
                <input type="checkbox" checked={!!step.confirm} onChange={(e) => set({ confirm: e.target.checked || undefined })} />
                Ask before running
              </label>
            </div>
            <div className="actions">
              <button className="btn xs" onClick={() => move(-1)} disabled={index === 0}>
                Move up
              </button>
              <button className="btn xs" onClick={() => move(1)} disabled={last}>
                Move down
              </button>
              <button className="btn xs danger" onClick={remove}>
                Remove step
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function parseCapture(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return Object.keys(out).length ? out : undefined
}

/** Free text while typing; parsed into name → expression pairs on blur. */
function CaptureField({ value, onCommit }: { value?: Record<string, string>; onCommit(v: Record<string, string> | undefined): void }) {
  const [text, setText] = useState(
    Object.entries(value ?? {})
      .map(([k, v]) => `${k} = ${v}`)
      .join('\n')
  )
  return (
    <textarea className="input sm mono" rows={2} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onCommit(parseCapture(text))} placeholder="value = count" aria-label="Capture" spellCheck={false} />
  )
}

function StepIdField({ step, others, onCommit }: { step: RoutineStep; others: RoutineStep[]; onCommit(id: string): void }) {
  const [text, setText] = useState(step.id)
  return (
    <input
      className="input sm mono"
      value={text}
      key={step.id}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const id = newStepId(others, text)
        setText(id)
        if (id !== step.id) onCommit(id)
      }}
      aria-label="Step id"
      spellCheck={false}
    />
  )
}
