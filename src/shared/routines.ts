import type { HttpMethod } from './types'

/** One step of a routine (SPEC §8). Paths and bodies may use {{var}} and {{steps.<id>.<name>}}. */
export interface RoutineStep {
  id: string
  name: string
  method: HttpMethod
  path: string
  body?: string
  /** Use a saved library query's method/path/body at run time (edits to the query flow into the routine). */
  queryRef?: string
  /** Run this step against another connection than the routine's default. */
  connectionId?: string
  /** name → jsonata expression evaluated on the response body, e.g. { "value": "count" }. */
  capture?: Record<string, string>
  /** jsonata expression that must be truthy, e.g. "status != 'red'" or "count == steps.count.value". */
  assert?: string
  onFail: 'stop' | 'continue'
  /** Skip the step unless this expression is truthy (evaluated on { steps, vars }). */
  when?: string
  /** Poll: re-run until `until` is truthy, every `everySec`, giving up after `timeoutMin`. */
  repeat?: { until: string; everySec: number; timeoutMin: number }
  /** Always ask before running (forced for writes on production connections). */
  confirm?: boolean
}

export interface Routine {
  id: string
  name: string
  defaultConnectionId?: string
  variables: Record<string, string>
  steps: RoutineStep[]
  lastStatus?: RunStatus
  lastRunAt?: string
  updatedAt: string
}

export type RunStatus = 'running' | 'ok' | 'failed' | 'stopped'
export type StepOutcome = 'ok' | 'failed' | 'skipped' | 'dry' | 'declined' | 'running' | 'polling' | 'pending'

export interface StepResult {
  stepId: string
  outcome: StepOutcome
  status?: number
  ms?: number
  method?: HttpMethod
  path?: string
  connectionId?: string
  message?: string
  response?: string
  captured?: Record<string, unknown>
  attempts?: number
}

export interface LogLine {
  t: string
  level: 'ok' | 'info' | 'run' | 'warn' | 'error'
  msg: string
}

export interface RoutineRun {
  id: string
  routineId: string
  status: RunStatus
  dryRun: boolean
  startedAt: string
  finishedAt?: string
  steps: StepResult[]
  log: LogLine[]
  captured: Record<string, Record<string, unknown>>
}

/** Pushed from main while a routine runs. */
export type RoutineEvent =
  | { type: 'run'; run: RoutineRun }
  | { type: 'paused'; runId: string; nextStepId: string }

export const ROUTINE_EVENT_CHANNEL = 'kabanos:routine-event'

/** Flatten captured values to template keys: steps.count.value → 12418203. */
export function templateVars(vars: Record<string, string>, captured: Record<string, Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = { ...vars }
  for (const [step, values] of Object.entries(captured)) {
    for (const [name, v] of Object.entries(values)) out[`steps.${step}.${name}`] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return out
}

/** Spec examples use `==`; jsonata uses `=`. Rewrite `==` outside of string literals. */
export function toJsonata(expr: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!
    if (quote) {
      out += c
      if (c === '\\') out += expr[++i] ?? ''
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    if (c === '=' && expr[i + 1] === '=') {
      out += '='
      i++
      continue
    }
    out += c
  }
  return out
}

export function newStepId(existing: RoutineStep[], base = 'step'): string {
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'step'
  let id = slug
  for (let n = 2; existing.some((s) => s.id === id); n++) id = `${slug}_${n}`
  return id
}
