import { randomUUID } from 'node:crypto'
import type { Routine, RoutineRun, RoutineStep } from '@shared/routines'
import { KabanosError } from '../errors'
import type { Db } from '../store/db'

interface Row {
  id: string
  name: string
  default_connection_id: string | null
  variables_json: string
  steps_json: string
  updated_at: string
  last_status?: string | null
  last_run_at?: string | null
}

const RUNS_KEPT = 20

export class RoutineStore {
  constructor(private readonly db: Db) {}

  list(): Routine[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, (SELECT status FROM routine_runs x WHERE x.routine_id = r.id ORDER BY started_at DESC LIMIT 1) AS last_status,
                (SELECT started_at FROM routine_runs x WHERE x.routine_id = r.id ORDER BY started_at DESC LIMIT 1) AS last_run_at
         FROM routines r ORDER BY r.name COLLATE NOCASE`
      )
      .all() as Row[]
    return rows.map(toRoutine)
  }

  get(id: string): Routine {
    const r = this.list().find((x) => x.id === id)
    if (!r) throw new KabanosError('NOT_FOUND', `Routine ${id} not found`)
    return r
  }

  save(r: { id?: string; name: string; defaultConnectionId?: string; variables: Record<string, string>; steps: RoutineStep[] }): Routine {
    const id = r.id ?? randomUUID()
    this.db
      .prepare(
        `INSERT INTO routines (id, name, default_connection_id, variables_json, steps_json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, default_connection_id = excluded.default_connection_id,
           variables_json = excluded.variables_json, steps_json = excluded.steps_json, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      )
      .run(id, r.name.trim() || 'Untitled routine', r.defaultConnectionId ?? null, JSON.stringify(r.variables), JSON.stringify(r.steps))
    return this.get(id)
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM routines WHERE id = ?').run(id)
  }

  saveRun(run: RoutineRun): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO routine_runs (id, routine_id, status, dry_run, started_at, finished_at, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at, detail_json = excluded.detail_json`
        )
        .run(run.id, run.routineId, run.status, run.dryRun ? 1 : 0, run.startedAt, run.finishedAt ?? null, JSON.stringify({ steps: run.steps, log: run.log, captured: run.captured }))
      this.db
        .prepare('DELETE FROM routine_runs WHERE routine_id = ? AND id NOT IN (SELECT id FROM routine_runs WHERE routine_id = ? ORDER BY started_at DESC LIMIT ?)')
        .run(run.routineId, run.routineId, RUNS_KEPT)
    })()
  }

  runs(routineId: string): RoutineRun[] {
    const rows = this.db.prepare('SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY started_at DESC').all(routineId) as Array<{
      id: string
      routine_id: string
      status: RoutineRun['status']
      dry_run: number
      started_at: string
      finished_at: string | null
      detail_json: string
    }>
    return rows.map((r) => ({ id: r.id, routineId: r.routine_id, status: r.status, dryRun: !!r.dry_run, startedAt: r.started_at, finishedAt: r.finished_at ?? undefined, ...(JSON.parse(r.detail_json) as Pick<RoutineRun, 'steps' | 'log' | 'captured'>) }))
  }

  /** A run still marked running after a restart was interrupted. */
  markInterrupted(): void {
    this.db.prepare("UPDATE routine_runs SET status = 'stopped', finished_at = COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE status = 'running'").run()
  }
}

function toRoutine(r: Row): Routine {
  return {
    id: r.id,
    name: r.name,
    defaultConnectionId: r.default_connection_id ?? undefined,
    variables: JSON.parse(r.variables_json) as Record<string, string>,
    steps: JSON.parse(r.steps_json) as RoutineStep[],
    lastStatus: (r.last_status ?? undefined) as Routine['lastStatus'],
    lastRunAt: r.last_run_at ?? undefined,
    updatedAt: r.updated_at
  }
}
