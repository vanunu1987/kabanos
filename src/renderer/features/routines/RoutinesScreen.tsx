import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import type { Routine, RoutineRun } from '@shared/routines'
import { api } from '../../api'
import { relTime } from '../../components/time'
import { Icon } from '../../shell/icons'
import { ResizeHandle, usePaneWidth } from '../../components/Resizable'
import { COLORS, useApp } from '../../store'
import { StepCard } from './StepCard'
import { subscribeRoutineEvents, useRoutines } from './store'

const BADGE: Record<string, string> = { running: 'run', ok: 'ok', failed: 'bad', stopped: 'warn' }

/** Screen 5 — routines: ordered requests with captures, assertions, polling, dry run and a live log. */
export function RoutinesScreen() {
  const { routines, selected } = useRoutines()
  const [filter, setFilter] = useState('')
  useEffect(() => {
    subscribeRoutineEvents()
    void useRoutines.getState().load()
  }, [])
  const routine = routines.find((r) => r.id === selected)
  const shown = routines.filter((r) => !filter || r.name.toLowerCase().includes(filter.toLowerCase()))
  const connections = useApp((s) => s.connections)

  return (
    <>
      <aside className="sidebar routines-list">
        <div className="sidebar-head lib-head">
          <div className="tree-title">Routines</div>
          <button className="btn xs" onClick={() => useRoutines.getState().create()}>
            {Icon.plus(12)} New
          </button>
        </div>
        <label className="filter" style={{ margin: '0 16px 10px' }}>
          {Icon.search()}
          <input aria-label="Search routines" placeholder="Search routines" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <div className="sidebar-scroll" style={{ gap: 2 }}>
          {shown.map((r) => {
            const conn = connections.find((c) => c.id === r.defaultConnectionId)
            const live = useRoutines.getState().runs[r.id]
            const status = live?.status ?? r.lastStatus
            return (
              <button key={r.id} className={`routine-row${r.id === selected ? ' active' : ''}`} onClick={() => useRoutines.getState().select(r.id)}>
                <span className="routine-row-top">
                  <span className="routine-name">{r.name}</span>
                  <span className={`run-badge ${status ? BADGE[status] : 'never'}`}>{status ?? 'never'}</span>
                </span>
                <span className="hint">
                  {r.steps.length} step{r.steps.length === 1 ? '' : 's'} · {conn?.name ?? 'no connection'}
                </span>
              </button>
            )
          })}
          {routines.length === 0 && <div className="empty">No routines yet. Create one, or select blocks in the Workspace and use “Add to routine”.</div>}
        </div>
      </aside>
      {routine ? <RoutineDetail key={routine.id} routine={routine} /> : <main className="main"><div className="placeholder"><h2>Routines</h2><div>Run several requests in sequence with captured variables and assertions.</div></div></main>}
    </>
  )
}

function RoutineDetail({ routine }: { routine: Routine }) {
  const st = useRoutines.getState()
  const run = useRoutines((s) => s.runs[routine.id])
  const paused = useRoutines((s) => s.paused[routine.id])
  const connections = useApp((s) => s.connections)
  const [dryRun, setDryRun] = useState(false)
  const [newVar, setNewVar] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [logWidth, setLogWidth] = usePaneWidth('routine-log', 380, 260, 1000)
  const running = run?.status === 'running'
  const stepIndex = run ? run.steps.findIndex((s) => s.outcome === 'running' || s.outcome === 'polling') : -1
  const conn = connections.find((c) => c.id === routine.defaultConnectionId)

  return (
    <main className="main routine-main">
      <div className="routine-head">
        <div className="title-row" style={{ paddingRight: 0 }}>
          <input className="title-input" value={routine.name} onChange={(e) => st.update(routine.id, { name: e.target.value })} aria-label="Routine name" />
          {run && (
            <span className={`run-badge lg ${BADGE[run.status]}`}>
              {running ? (paused ? `Paused · before step ${run.steps.findIndex((s) => s.stepId === paused) + 1}` : `Running · step ${stepIndex + 1} of ${routine.steps.length}`) : `${run.status} · ${relTime(run.finishedAt ?? run.startedAt)}`}
              {run.dryRun && ' · dry run'}
            </span>
          )}
          <div className="spacer" />
          <label className="check" title="Only read requests run; writes are listed with their resolved values">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} disabled={running} />
            Dry run (reads only)
          </label>
          {running && paused ? (
            <button className="btn md" onClick={() => st.resume(routine.id)}>
              Run next step
            </button>
          ) : (
            <button className="btn md" disabled={running || routine.steps.length === 0} onClick={() => st.start(routine.id, { dryRun, stepThrough: true })}>
              Step through
            </button>
          )}
          <button className="btn md stop" disabled={!running} onClick={() => st.stop(routine.id)}>
            Stop
          </button>
          <button className="btn md primary" disabled={running || routine.steps.length === 0 || !routine.defaultConnectionId && routine.steps.some((s) => !s.connectionId)} onClick={() => st.start(routine.id, { dryRun })}>
            ▶ Run all
          </button>
        </div>
        <div className="inline-row" style={{ gap: 10 }}>
          <span className="hint">Runs on</span>
          <span className="conn-pick">
            {conn && <span className="dot" style={{ background: COLORS[conn.color] }} />}
            <select value={routine.defaultConnectionId ?? ''} onChange={(e) => st.update(routine.id, { defaultConnectionId: e.target.value || undefined })} aria-label="Default connection">
              <option value="">Pick a connection</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.isProd ? ' (prod)' : ''}
                </option>
              ))}
            </select>
          </span>
          <span className="hint" style={{ marginLeft: 10 }}>
            Variables
          </span>
          {Object.entries(routine.variables).map(([k, v]) => (
            <VarChip key={k} name={k} value={v} onChange={(nv) => st.update(routine.id, { variables: { ...routine.variables, [k]: nv } })} onRemove={() => st.update(routine.id, { variables: Object.fromEntries(Object.entries(routine.variables).filter(([x]) => x !== k)) })} />
          ))}
          {newVar !== null ? (
            <input
              className="input sm mono"
              autoFocus
              style={{ width: 200, height: 28 }}
              placeholder="name=value"
              value={newVar}
              onChange={(e) => setNewVar(e.target.value)}
              onBlur={() => setNewVar(null)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setNewVar(null)
                if (e.key === 'Enter') {
                  const i = newVar.indexOf('=')
                  if (i > 0) st.update(routine.id, { variables: { ...routine.variables, [newVar.slice(0, i).trim()]: newVar.slice(i + 1).trim() } })
                  setNewVar(null)
                }
              }}
              aria-label="New variable"
            />
          ) : (
            <button className="dashed-btn" onClick={() => setNewVar('')}>
              + variable
            </button>
          )}
          <div className="spacer" />
          <button
            className="link danger-text"
            onClick={async () => {
              if (confirm(`Delete routine "${routine.name}" and its run history?`)) await st.remove(routine.id)
            }}
          >
            Delete routine
          </button>
        </div>
      </div>
      <div className="routine-split">
        <div className="steps">
          {routine.steps.map((s, i) => (
            <StepCard key={i} routine={routine} step={s} index={i} result={run?.steps.find((r) => r.stepId === s.id)} last={i === routine.steps.length - 1} paused={paused === s.id} />
          ))}
          {adding ? (
            <AddStep routine={routine} onDone={() => setAdding(false)} />
          ) : (
            <button className="add-block" style={{ marginLeft: 42 }} onClick={() => setAdding(true)}>
              + Add step — from library or new request
            </button>
          )}
        </div>
        <ResizeHandle width={logWidth} onResize={(w) => setLogWidth(Number.isNaN(w) ? 380 : w)} side="left" label="Resize steps and run log" />
        <RunLog routine={routine} run={run} width={logWidth} />
      </div>
    </main>
  )
}

function VarChip({ name, value, onChange, onRemove }: { name: string; value: string; onChange(v: string): void; onRemove(): void }) {
  const [editing, setEditing] = useState(false)
  return (
    <span className="var-chip mono">
      <span className="tn">{name}</span>&nbsp;=&nbsp;
      {editing ? (
        <input className="inline-input" autoFocus defaultValue={value} onBlur={(e) => (onChange(e.target.value), setEditing(false))} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} aria-label={`Value of ${name}`} />
      ) : (
        <button className="ts var-value" onClick={() => setEditing(true)} title="Click to edit">
          {value || '""'}
        </button>
      )}
      <button className="var-x" aria-label={`Remove ${name}`} onClick={onRemove}>
        ×
      </button>
    </span>
  )
}

function AddStep({ routine, onDone }: { routine: Routine; onDone(): void }) {
  const [search, setSearch] = useState('')
  const lib = useQuery({ queryKey: ['library-search', search], queryFn: () => api.library.queries('*', { kind: 'all' }, search) })
  // Unfiled items are workspace scratch blocks; saved aggregation pipelines count even when unfiled.
  const connections = useApp((s) => s.connections)
  const connName = (id: string | null) => connections.find((c) => c.id === id)?.name ?? 'no cluster'
  const saved = (lib.data ?? []).filter((q) => q.folderId !== null || q.pipeline).slice(0, 8)
  const add = async (step: Parameters<ReturnType<typeof useRoutines.getState>['addSteps']>[1][number]) => {
    await useRoutines.getState().addSteps(routine.id, [step])
    onDone()
  }
  return (
    <div className="add-step card pad" style={{ marginLeft: 42 }}>
      <div className="inline-row between">
        <b>Add a step</b>
        <button className="link" onClick={onDone}>
          Cancel
        </button>
      </div>
      <button className="btn xs" style={{ alignSelf: 'flex-start' }} onClick={() => add({ name: 'New step', method: 'GET', path: '_cluster/health', onFail: 'stop' })}>
        New inline request
      </button>
      <label className="filter small" style={{ width: '100%' }}>
        {Icon.search()}
        <input autoFocus placeholder="Search saved queries" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search saved queries" />
      </label>
      {saved.map((q) => (
        <button key={q.id} className="lib-row" onClick={() => add({ name: q.title || q.path, method: q.method, path: q.path, body: q.body, queryRef: q.id, onFail: 'stop' })}>
          {q.pipeline ? <span className="lib-method mono lib-agg">∑</span> : <span className={`lib-method mono m-${q.method.toLowerCase()}`}>{q.method}</span>}
          <span className="lib-text">
            <span className="lib-name">{q.pipeline ? `Run aggregation pipeline “${q.title}”` : q.title || q.path}</span>
            <span className="lib-meta mono">
              {connName(q.connectionId)} · {q.pipeline ? `${q.path} · rows → steps.<id>.rows` : q.path}
            </span>
          </span>
        </button>
      ))}
      {saved.length === 0 && <span className="hint">No saved queries{search ? ' match' : ' yet'}.</span>}
    </div>
  )
}

function RunLog({ routine, run, width }: { routine: Routine; run?: RoutineRun; width: number }) {
  const [pick, setPick] = useState<string>('latest')
  const runs = useQuery({ queryKey: ['runs', routine.id, run?.status, run?.id], queryFn: () => api.routines.runs(routine.id) })
  const shown = pick === 'latest' ? run : runs.data?.find((r) => r.id === pick)
  const captured = useMemo(() => Object.entries(shown?.captured ?? {}).flatMap(([step, vals]) => Object.entries(vals).map(([k, v]) => [`steps.${step}.${k}`, v] as const)), [shown])
  const COLOR = { ok: 'var(--log-ok)', info: 'var(--text-2)', run: 'var(--json-key)', warn: 'var(--accent)', error: 'var(--bad-text)' }

  return (
    <section className="run-log" style={{ width }}>
      <div className="pane-head">
        <span className="pane-title">Run log</span>
        {shown && <span className="hint">started {new Date(shown.startedAt).toLocaleTimeString()}</span>}
        <select className="select xs" style={{ marginLeft: 'auto', maxWidth: 170 }} value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Previous runs">
          <option value="latest">Latest run</option>
          {runs.data?.map((r) => (
            <option key={r.id} value={r.id}>
              {r.status}
              {r.dryRun ? ' (dry)' : ''} · {relTime(r.startedAt)}
            </option>
          ))}
        </select>
      </div>
      <div className="log-lines mono">
        {!shown && <span className="hint">No runs yet.</span>}
        {shown?.log.map((l, i) => (
          <div key={i} className="log-line">
            <span className="log-t">{new Date(l.t).toLocaleTimeString([], { hour12: false })}</span>
            <span style={{ color: COLOR[l.level] }}>{l.msg}</span>
          </div>
        ))}
      </div>
      <div className="captured">
        <div className="field-label" style={{ fontSize: 12 }}>
          Captured values
        </div>
        {captured.length === 0 && <span className="hint">None yet</span>}
        {captured.map(([k, v]) => (
          <div key={k} className="mono captured-row">
            {k} = <span className={typeof v === 'number' ? 'tn' : 'ts'}>{JSON.stringify(v)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
