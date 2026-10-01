import { describe, expect, it, vi } from 'vitest'
import type { Routine, RoutineStep } from '@shared/routines'
import type { ClusterRequest, ClusterResponse, ConnectionConfig } from '@shared/types'
import { KabanosError } from '../errors'
import { evaluate, RoutineRunner, type RunnerDeps } from '../routines/RoutineRunner'

const conn = (id: string, isProd = false): ConnectionConfig =>
  ({ id, name: id, isProd, folder: 'Local', color: 'green', favorite: false, readOnly: false, engine: 'auto', url: 'http://x', authKind: 'none', tls: { verify: true }, timeoutMs: 1000, compression: true, headers: {} }) as ConnectionConfig

/** A tiny fake cluster: responses keyed by "METHOD path". */
function setup(handlers: Record<string, (req: ClusterRequest) => unknown>, extra: Partial<RunnerDeps> = {}) {
  const calls: ClusterRequest[] = []
  const deps: RunnerDeps = {
    request: async (req) => {
      calls.push(req)
      const h = handlers[`${req.method} ${req.path}`]
      if (!h) return reply(404, { error: { reason: `no handler for ${req.method} ${req.path}` } })
      const out = h(req)
      return out && typeof out === 'object' && 'status' in (out as object) && 'body' in (out as object) ? (out as ClusterResponse) : reply(200, out)
    },
    cancel: vi.fn(async () => undefined),
    connection: (id) => conn(id, id === 'prod'),
    query: () => ({ method: 'GET', path: '_cluster/health', body: '' }),
    confirm: vi.fn(async () => true),
    emit: vi.fn(),
    save: vi.fn(),
    sleep: async () => undefined,
    ...extra
  }
  return { runner: new RoutineRunner(deps), calls, deps }
}
const reply = (status: number, body: unknown): ClusterResponse => ({ status, headers: {}, body: JSON.stringify(body), ms: 3, bytes: 10, opaqueId: 'x' })
const step = (s: Partial<RoutineStep> & Pick<RoutineStep, 'id' | 'method' | 'path'>): RoutineStep => ({ name: s.id, onFail: 'stop', ...s })
const routine = (steps: RoutineStep[], variables: Record<string, string> = {}): Routine => ({ id: 'r1', name: 'r', defaultConnectionId: 'dev', variables, steps, updatedAt: '' })

describe('RoutineRunner', () => {
  it('runs the SPEC §8 reindex routine: assert, capture, templating, polling', async () => {
    let polls = 0
    const { runner, calls } = setup({
      'GET _cluster/health': () => ({ status: 'green' }),
      'POST listings-v7/_count': () => ({ count: 400 }),
      'POST _reindex?wait_for_completion=false': () => ({ task: 'node:42' }),
      'GET _tasks/node:42': () => ({ completed: ++polls >= 3 }),
      'POST listings-v8/_count': () => ({ count: 400 }),
      'POST _aliases': () => ({ acknowledged: true })
    })
    const run = await runner.runToEnd(
      routine(
        [
          step({ id: 'health', method: 'GET', path: '_cluster/health', assert: "status != 'red'" }),
          step({ id: 'count', method: 'POST', path: '{{source}}/_count', capture: { value: 'count' } }),
          step({ id: 'reindex', method: 'POST', path: '_reindex?wait_for_completion=false', body: '{"source":{"index":"{{source}}"},"dest":{"index":"{{target}}"}}', capture: { task: 'task' } }),
          step({ id: 'wait', method: 'GET', path: '_tasks/{{steps.reindex.task}}', repeat: { until: 'completed == true', everySec: 10, timeoutMin: 45 } }),
          step({ id: 'verify', method: 'POST', path: '{{target}}/_count', assert: 'count == steps.count.value' }),
          step({ id: 'swap', method: 'POST', path: '_aliases', body: '{"actions":[]}', confirm: true })
        ],
        { source: 'listings-v7', target: 'listings-v8' }
      )
    )
    expect(run.status).toBe('ok')
    expect(run.steps.map((s) => s.outcome)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok'])
    expect(run.captured).toEqual({ count: { value: 400 }, reindex: { task: 'node:42' } })
    expect(run.steps[3]!.attempts).toBe(3)
    expect(JSON.parse(calls.find((c) => c.path.startsWith('_reindex'))!.body!)).toEqual({ source: { index: 'listings-v7' }, dest: { index: 'listings-v8' } })
  })

  it('stops on a failed assertion, or continues when onFail is continue', async () => {
    const h = { 'GET _cluster/health': () => ({ status: 'red' }), 'GET _cat/indices': () => [] }
    const stop = await setup(h).runner.runToEnd(routine([step({ id: 'h', method: 'GET', path: '_cluster/health', assert: "status != 'red'" }), step({ id: 'i', method: 'GET', path: '_cat/indices' })]))
    expect(stop.status).toBe('failed')
    expect(stop.steps.map((s) => s.outcome)).toEqual(['failed', 'pending'])
    expect(stop.steps[0]!.message).toContain('assertion failed')

    const cont = await setup(h).runner.runToEnd(routine([step({ id: 'h', method: 'GET', path: '_cluster/health', assert: "status != 'red'", onFail: 'continue' }), step({ id: 'i', method: 'GET', path: '_cat/indices' })]))
    expect(cont.steps.map((s) => s.outcome)).toEqual(['failed', 'ok'])
    expect(cont.status).toBe('failed')
  })

  it('HTTP errors fail the step with the cluster reason', async () => {
    const run = await setup({}).runner.runToEnd(routine([step({ id: 'x', method: 'GET', path: 'missing/_count' })]))
    expect(run.steps[0]).toMatchObject({ outcome: 'failed', status: 404 })
    expect(run.steps[0]!.message).toContain('no handler')
  })

  it('dry run executes reads only and reports what writes would do', async () => {
    const { runner, calls } = setup({ 'GET _cluster/health': () => ({ status: 'green' }), 'POST a/_count': () => ({ count: 1 }) })
    const run = await runner.runToEnd(
      routine([step({ id: 'h', method: 'GET', path: '_cluster/health' }), step({ id: 'c', method: 'POST', path: 'a/_count' }), step({ id: 'd', method: 'DELETE', path: 'a' }), step({ id: 'w', method: 'GET', path: '_tasks/{{steps.d.task}}' })]),
      { dryRun: true }
    )
    expect(run.steps.map((s) => s.outcome)).toEqual(['ok', 'ok', 'dry', 'dry'])
    expect(run.steps[2]!.message).toBe('would run DELETE a on dev')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET _cluster/health', 'POST a/_count'])
    expect(run.status).toBe('ok')
  })

  it('per-step connection override and a declined production confirmation', async () => {
    const declining = setup(
      { 'GET _cluster/health': () => ({ status: 'green' }) },
      {
        request: async (req) => {
          if (req.connectionId === 'prod' && req.method !== 'GET') throw new KabanosError('NOT_CONFIRMED', 'declined')
          return reply(200, { status: 'green' })
        }
      }
    )
    const run = await declining.runner.runToEnd(
      routine([step({ id: 'h', method: 'GET', path: '_cluster/health' }), step({ id: 'p', method: 'GET', path: '_cluster/health', connectionId: 'prod' }), step({ id: 'w', method: 'POST', path: '_aliases', body: '{}', connectionId: 'prod' }), step({ id: 'z', method: 'GET', path: '_cluster/health' })])
    )
    expect(run.steps.map((s) => [s.outcome, s.connectionId])).toEqual([
      ['ok', 'dev'],
      ['ok', 'prod'],
      ['declined', 'prod'],
      ['pending', undefined]
    ])
    expect(run.status).toBe('failed')
    // Prod writes are confirmed by ConnectionManager, never twice.
    expect(declining.deps.confirm).not.toHaveBeenCalled()
  })

  it('skips steps whose when-condition is false and times out polling', async () => {
    const { runner } = setup({ 'GET _tasks/t': () => ({ completed: false }), 'GET x': () => ({}) })
    const run = await runner.runToEnd(
      routine([
        step({ id: 's', method: 'GET', path: 'x', when: "vars.env = 'prod'" }),
        step({ id: 'w', method: 'GET', path: '_tasks/t', repeat: { until: 'completed', everySec: 0, timeoutMin: 0 } })
      ], { env: 'dev' })
    )
    expect(run.steps.map((s) => s.outcome)).toEqual(['skipped', 'failed'])
    expect(run.steps[1]!.message).toMatch(/Timed out/)
  })

  it('step-through pauses before each step; stop ends the run', async () => {
    const { runner, deps } = setup({ 'GET a': () => ({}), 'GET b': () => ({}) })
    const id = runner.start(routine([step({ id: 'a', method: 'GET', path: 'a' }), step({ id: 'b', method: 'GET', path: 'b' })]), { stepThrough: true })
    await vi.waitFor(() => expect(deps.emit).toHaveBeenCalledWith({ type: 'paused', runId: id, nextStepId: 'a' }))
    runner.resume(id)
    await vi.waitFor(() => expect(deps.emit).toHaveBeenCalledWith({ type: 'paused', runId: id, nextStepId: 'b' }))
    await runner.stop(id)
    await vi.waitFor(() => expect(runner.isRunning('r1')).toBe(false))
    const last = vi.mocked(deps.save).mock.calls.at(-1)![0]
    expect(last.status).toBe('stopped')
    expect(last.steps.map((s) => s.outcome)).toEqual(['ok', 'pending'])
  })
})

describe('evaluate', () => {
  it('supports == and field / binding access, and never runs JS', async () => {
    expect(await evaluate('count == steps.c.value', { count: 3 }, { steps: { c: { value: 3 } }, vars: {} })).toBe(true)
    expect(await evaluate("status != 'red'", { status: 'green' }, { steps: {}, vars: {} })).toBe(true)
    expect(await evaluate('$vars.idx', {}, { steps: {}, vars: { idx: 'a' } })).toBe('a')
    expect(await evaluate("'a==b'", {}, { steps: {}, vars: {} })).toBe('a==b')
    await expect(evaluate('process.exit(1)', {}, { steps: {}, vars: {} })).resolves.toBeUndefined()
    await expect(evaluate('count ===', {}, { steps: {}, vars: {} })).rejects.toThrow(/Invalid expression/)
  })
})
