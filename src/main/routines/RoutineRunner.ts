import { randomUUID } from 'node:crypto'
import jsonata from 'jsonata'
import { classifyRequest } from '@shared/destructive'
import { substituteVars } from '@shared/library'
import { templateVars, toJsonata, type LogLine, type Routine, type RoutineEvent, type RoutineRun, type RoutineStep, type StepResult } from '@shared/routines'
import type { ClusterRequest, ClusterResponse, ConnectionConfig } from '@shared/types'
import { KabanosError } from '../errors'

export interface RunnerDeps {
  request(req: ClusterRequest): Promise<ClusterResponse>
  cancel(opaqueId: string): Promise<void>
  connection(id: string): ConnectionConfig
  /** Library query lookup for steps with `queryRef`. */
  query(id: string): { method: ClusterRequest['method']; path: string; body: string }
  /** Explicit per-step confirmation (production writes are confirmed by ConnectionManager itself). */
  confirm(step: RoutineStep, conn: ConnectionConfig, req: ClusterRequest): Promise<boolean>
  emit(e: RoutineEvent): void
  save(run: RoutineRun): void
  sleep?(ms: number, signal: AbortSignal): Promise<void>
}

export interface RunOptions {
  dryRun?: boolean
  /** Pause before every step until resume() is called. */
  stepThrough?: boolean
}

const MAX_RESPONSE = 64 * 1024

interface Active {
  run: RoutineRun
  abort: AbortController
  opaqueId?: string
  resume?: () => void
}

/**
 * Executes routines step by step in main. Every request still goes through ConnectionManager,
 * so read-only and production-confirmation guards apply exactly as for manual requests.
 */
export class RoutineRunner {
  private readonly active = new Map<string, Active>()

  constructor(private readonly deps: RunnerDeps) {}

  isRunning(routineId: string): boolean {
    return [...this.active.values()].some((a) => a.run.routineId === routineId)
  }

  /** Starts a run and returns its id immediately; progress arrives as events. */
  start(routine: Routine, opts: RunOptions = {}): string {
    if (this.isRunning(routine.id)) throw new KabanosError('VALIDATION', 'This routine is already running')
    const run: RoutineRun = {
      id: randomUUID(),
      routineId: routine.id,
      status: 'running',
      dryRun: !!opts.dryRun,
      startedAt: new Date().toISOString(),
      steps: routine.steps.map((s) => ({ stepId: s.id, outcome: 'pending' })),
      log: [],
      captured: {}
    }
    const active: Active = { run, abort: new AbortController() }
    this.active.set(run.id, active)
    void this.execute(routine, active, opts).finally(() => this.active.delete(run.id))
    return run.id
  }

  /** Run to completion (tests, and callers that want the final result). */
  async runToEnd(routine: Routine, opts: RunOptions = {}): Promise<RoutineRun> {
    const id = this.start(routine, opts)
    const a = this.active.get(id)!
    while (this.active.has(id)) await new Promise((r) => setTimeout(r, 5))
    return a.run
  }

  resume(runId: string): void {
    const a = this.active.get(runId)
    a?.resume?.()
  }

  async stop(runId: string): Promise<void> {
    const a = this.active.get(runId)
    if (!a) return
    a.abort.abort()
    a.resume?.()
    if (a.opaqueId) await this.deps.cancel(a.opaqueId).catch(() => undefined)
  }

  private async execute(routine: Routine, a: Active, opts: RunOptions): Promise<void> {
    const { run } = a
    const log = (level: LogLine['level'], msg: string) => {
      run.log.push({ t: new Date().toISOString(), level, msg })
    }
    const emit = () => this.deps.emit({ type: 'run', run: structuredClone(run) })
    log('info', `${opts.dryRun ? 'Dry run' : 'Run'} started · ${routine.steps.length} steps`)
    this.deps.save(run)
    emit()

    let failed = false
    for (let i = 0; i < routine.steps.length; i++) {
      const step = routine.steps[i]!
      const result = run.steps[i]!
      if (a.abort.signal.aborted) break

      if (opts.stepThrough) {
        this.deps.emit({ type: 'paused', runId: run.id, nextStepId: step.id })
        log('info', `Paused before “${step.name}”`)
        emit()
        await new Promise<void>((resolve) => (a.resume = resolve))
        a.resume = undefined
        if (a.abort.signal.aborted) break
      }

      try {
        await this.runStep(routine, step, result, a, opts, log, emit)
      } catch (err) {
        result.outcome = a.abort.signal.aborted ? 'pending' : 'failed'
        result.message = (err as Error).message
        if (!a.abort.signal.aborted) log('error', `✗ ${step.name}: ${result.message}`)
      }
      emit()

      if (a.abort.signal.aborted) break
      if (result.outcome === 'declined') {
        failed = true
        log('warn', `Stopped: “${step.name}” was not confirmed`)
        break
      }
      if (result.outcome === 'failed') {
        failed = true
        if (step.onFail === 'stop') {
          log('error', `Stopped after failed step “${step.name}”`)
          break
        }
        log('warn', `Continuing after failed step “${step.name}”`)
      }
    }

    run.status = a.abort.signal.aborted ? 'stopped' : failed ? 'failed' : 'ok'
    run.finishedAt = new Date().toISOString()
    log(run.status === 'ok' ? 'ok' : run.status === 'stopped' ? 'warn' : 'error', `Run ${run.status === 'ok' ? 'finished' : run.status}`)
    this.deps.save(run)
    emit()
  }

  private async runStep(routine: Routine, step: RoutineStep, result: StepResult, a: Active, opts: RunOptions, log: (l: LogLine['level'], m: string) => void, emit: () => void): Promise<void> {
    const { run } = a
    const ctx = { steps: run.captured, vars: routine.variables }

    if (step.when && !(await evaluate(step.when, ctx, ctx))) {
      result.outcome = 'skipped'
      log('info', `↷ ${step.name} skipped (when: ${step.when})`)
      return
    }

    const source = step.queryRef ? this.deps.query(step.queryRef) : { method: step.method, path: step.path, body: step.body ?? '' }
    const vars = templateVars(routine.variables, run.captured)
    const path = substituteVars(source.path, vars).replace(/^\/+/, '')
    const body = source.body.trim() ? substituteVars(source.body, vars) : undefined
    const connectionId = step.connectionId ?? routine.defaultConnectionId
    if (!connectionId) throw new KabanosError('VALIDATION', 'No connection — pick one for the routine or this step')
    const conn = this.deps.connection(connectionId)
    Object.assign(result, { method: source.method, path, connectionId })

    const unresolved = /\{\{\s*[\w.-]+\s*\}\}/.exec(`${path} ${body ?? ''}`)
    const safety = classifyRequest(source.method, path, body).safety

    if (opts.dryRun && safety !== 'read') {
      result.outcome = 'dry'
      result.message = `would run ${source.method} ${path} on ${conn.name}`
      log('info', `◌ ${step.name}: ${result.message}`)
      return
    }
    if (unresolved) {
      if (opts.dryRun) {
        result.outcome = 'dry'
        result.message = `needs ${unresolved[0]} from an earlier step`
        log('info', `◌ ${step.name}: ${result.message}`)
        return
      }
      throw new KabanosError('VALIDATION', `Unknown variable ${unresolved[0]}`)
    }

    const req: ClusterRequest = { connectionId, method: source.method, path, body }
    // Production writes are confirmed by ConnectionManager; other steps marked `confirm` ask here.
    const guardedByProd = conn.isProd && safety !== 'read'
    if (step.confirm && !guardedByProd && !(await this.deps.confirm(step, conn, req))) {
      result.outcome = 'declined'
      return
    }

    result.outcome = 'running'
    log('run', `▶ ${step.name} · ${source.method} ${path}${step.connectionId ? ` on ${conn.name}` : ''}`)
    emit()

    const started = Date.now()
    let attempts = 0
    let parsed: unknown
    let res: ClusterResponse
    for (;;) {
      attempts++
      a.opaqueId = `kabanos-${randomUUID()}`
      try {
        res = await this.deps.request({ ...req, opaqueId: a.opaqueId })
      } catch (err) {
        if (err instanceof KabanosError && err.code === 'NOT_CONFIRMED') {
          result.outcome = 'declined'
          return
        }
        throw err
      } finally {
        a.opaqueId = undefined
      }
      parsed = parseJson(res.body)
      if (!step.repeat || res.status >= 400) break
      if (await evaluate(step.repeat.until, parsed, ctx)) break
      if (Date.now() - started > step.repeat.timeoutMin * 60_000) {
        Object.assign(result, { status: res.status, ms: res.ms, response: truncate(res.body), attempts })
        throw new KabanosError('NETWORK', `Timed out after ${step.repeat.timeoutMin} min waiting for: ${step.repeat.until}`)
      }
      result.outcome = 'polling'
      result.attempts = attempts
      result.message = `poll ${attempts} · waiting for ${step.repeat.until}`
      Object.assign(result, { status: res.status, response: truncate(res.body) })
      emit()
      await (this.deps.sleep ?? sleep)(Math.max(0.05, step.repeat.everySec) * 1000, a.abort.signal)
      if (a.abort.signal.aborted) return
    }

    Object.assign(result, { status: res.status, ms: res.ms, response: truncate(res.body), attempts })
    if (res.status >= 400) {
      result.outcome = 'failed'
      result.message = `HTTP ${res.status}: ${errorReason(parsed) ?? res.body.slice(0, 160)}`
      log('error', `✗ ${step.name} → ${result.message}`)
      return
    }
    if (step.assert && !(await evaluate(step.assert, parsed, ctx))) {
      result.outcome = 'failed'
      result.message = `assertion failed: ${step.assert}`
      log('error', `✗ ${step.name} → ${result.message}`)
      return
    }
    if (step.capture && Object.keys(step.capture).length) {
      const values: Record<string, unknown> = {}
      for (const [name, expr] of Object.entries(step.capture)) values[name] = await evaluate(expr, parsed, ctx)
      run.captured[step.id] = values
      result.captured = values
      log('info', `  captured ${Object.entries(values).map(([k, v]) => `steps.${step.id}.${k} = ${JSON.stringify(v)}`).join(', ')}`)
    }
    result.outcome = 'ok'
    result.message = undefined
    log('ok', `✓ ${step.name} → ${res.status} · ${res.ms} ms${attempts > 1 ? ` · ${attempts} polls` : ''}`)
  }
}

/**
 * Evaluate a jsonata expression against a response body. `steps` and `vars` are available both as
 * fields (`steps.count.value`) and as bindings (`$steps`, `$vars`). jsonata has no access to Node.
 */
export async function evaluate(expr: string, input: unknown, ctx: { steps: unknown; vars: unknown }): Promise<unknown> {
  let compiled: jsonata.Expression
  try {
    compiled = jsonata(toJsonata(expr))
  } catch (err) {
    throw new KabanosError('VALIDATION', `Invalid expression “${expr}”: ${(err as Error).message}`)
  }
  const data = input && typeof input === 'object' && !Array.isArray(input) ? { ...(input as object), steps: ctx.steps, vars: ctx.vars } : input
  try {
    return await compiled.evaluate(data, { steps: ctx.steps, vars: ctx.vars })
  } catch (err) {
    throw new KabanosError('VALIDATION', `Expression “${expr}” failed: ${(err as Error).message}`)
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

function errorReason(parsed: unknown): string | undefined {
  const e = (parsed as { error?: { reason?: string; type?: string } | string } | undefined)?.error
  return typeof e === 'string' ? e : (e?.reason ?? e?.type)
}

function truncate(s: string): string {
  return s.length > MAX_RESPONSE ? `${s.slice(0, MAX_RESPONSE)}\n… (truncated)` : s
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })
}
