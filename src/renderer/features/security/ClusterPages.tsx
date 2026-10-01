import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { formatBytes } from '@shared/meta'
import type { ConnectionConfig } from '@shared/types'
import { api, KabanosError } from '../../api'
import { Async } from '../../components/Async'
import { JsonView } from '../../components/JsonView'
import { relTime } from '../../components/time'
import { useTree } from '../../queries'
import { useApp } from '../../store'

const isOs = (c: ConnectionConfig) => (c.detected?.engine ?? c.engine) === 'opensearch'

async function getJson<T>(conn: ConnectionConfig, path: string, fallback?: T): Promise<T> {
  const res = await api.cluster.request({ connectionId: conn.id, method: 'GET', path })
  if (res.status === 404 && fallback !== undefined) return fallback
  if (res.status >= 400) throw new Error(`GET ${path} → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
  return JSON.parse(res.body) as T
}

/** List on the left, JSON definition on the right — shared by lifecycle policies and ingest pipelines. */
function DefinitionList({ title, sub, items, empty }: { title: string; sub?: string; items: Array<{ name: string; meta?: string; body: unknown }>; empty: string }) {
  const [sel, setSel] = useState<string>()
  const current = items.find((i) => i.name === sel) ?? items[0]
  return (
    <div className="sec-page">
      <div className="sec-head">
        <h1>{title}</h1>
        {sub && <span className="hint">{sub}</span>}
      </div>
      {items.length === 0 ? (
        <div className="empty">{empty}</div>
      ) : (
        <div className="sec-split">
          <div className="sec-table" style={{ maxWidth: 380 }}>
            {items.map((i) => (
              <button key={i.name} className={`sec-row single${current?.name === i.name ? ' sel' : ''}`} onClick={() => setSel(i.name)}>
                <span className="cell-main">
                  <span className="mono ellipsis">{i.name}</span>
                </span>
                {i.meta && <span className="hint">{i.meta}</span>}
              </button>
            ))}
          </div>
          <section className="card fill" style={{ margin: 16 }}>
            <div className="card-head">
              <h2 className="mono">{current?.name}</h2>
            </div>
            <JsonView value={current?.body} className="card-scroll" />
          </section>
        </div>
      )}
    </div>
  )
}

export function LifecyclePage({ conn }: { conn: ConnectionConfig }) {
  const os = isOs(conn)
  const q = useQuery({
    queryKey: ['lifecycle', conn.id],
    queryFn: async () => {
      if (os) {
        const j = await getJson<{ policies?: Array<{ _id: string; policy: { description?: string; states?: unknown[] } }> }>(conn, '_plugins/_ism/policies', { policies: [] })
        return (j.policies ?? []).map((p) => ({ name: p._id, meta: `${p.policy.states?.length ?? 0} states`, body: p.policy }))
      }
      const j = await getJson<Record<string, { policy: { phases?: Record<string, unknown> }; in_use_by?: { indices?: string[] } }>>(conn, '_ilm/policy', {})
      return Object.entries(j).map(([name, p]) => ({ name, meta: `${Object.keys(p.policy.phases ?? {}).join(' → ')} · ${p.in_use_by?.indices?.length ?? 0} indices`, body: p.policy }))
    }
  })
  return <Async query={q}>{(items) => <DefinitionList title="Index lifecycle" sub={os ? 'ISM policies' : 'ILM policies'} items={items} empty="No lifecycle policies." />}</Async>
}

export function PipelinesPage({ conn }: { conn: ConnectionConfig }) {
  const q = useQuery({
    queryKey: ['pipelines', conn.id],
    queryFn: async () => {
      const j = await getJson<Record<string, { description?: string; processors?: unknown[] }>>(conn, '_ingest/pipeline', {})
      return Object.entries(j)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, p]) => ({ name, meta: `${p.processors?.length ?? 0} processors${p.description ? ` · ${p.description}` : ''}`, body: p }))
    }
  })
  return <Async query={q}>{(items) => <DefinitionList title="Ingest pipelines" items={items} empty="No ingest pipelines." />}</Async>
}

export function SnapshotsPage({ conn }: { conn: ConnectionConfig }) {
  const q = useQuery({
    queryKey: ['snapshots', conn.id],
    queryFn: async () => {
      const repos = await getJson<Record<string, { type: string; settings?: Record<string, unknown> }>>(conn, '_snapshot', {})
      return Promise.all(
        Object.entries(repos).map(async ([name, r]) => {
          const s = await getJson<{ snapshots?: Array<{ snapshot: string; state: string; indices?: string[]; start_time?: string; duration_in_millis?: number }> }>(conn, `_snapshot/${encodeURIComponent(name)}/_all`, { snapshots: [] }).catch(() => ({ snapshots: [] }))
          return { name, type: r.type, snapshots: (s.snapshots ?? []).reverse() }
        })
      )
    }
  })
  return (
    <div className="sec-page">
      <div className="sec-head">
        <h1>Snapshots</h1>
      </div>
      <Async query={q}>
        {(repos) =>
          repos.length === 0 ? (
            <div className="empty">No snapshot repositories are registered on this cluster.</div>
          ) : (
            <div className="page-body">
              {repos.map((r) => (
                <section key={r.name} className="card pad">
                  <h2>
                    {r.name} <span className="hint">· {r.type} · {r.snapshots.length} snapshots</span>
                  </h2>
                  {r.snapshots.slice(0, 50).map((s) => (
                    <div key={s.snapshot} className="inline-row between">
                      <span className="mono">{s.snapshot}</span>
                      <span className="hint">
                        <span style={{ color: s.state === 'SUCCESS' ? 'var(--green)' : 'var(--yellow)' }}>{s.state.toLowerCase()}</span> · {s.indices?.length ?? 0} indices · {relTime(s.start_time)}
                      </span>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          )
        }
      </Async>
    </div>
  )
}

export function TemplatesPage({ conn }: { conn: ConnectionConfig }) {
  const tree = useTree(conn.id)
  const { select, setView } = useApp.getState()
  return (
    <div className="sec-page">
      <div className="sec-head">
        <h1>Index templates</h1>
        <span className="hint">Opens the template in the Explorer</span>
      </div>
      <Async query={tree}>
        {(t) => (
          <div className="sec-table">
            {t.templates
              .filter((x) => !x.managed)
              .map((x) => (
                <button key={`${x.kind}:${x.name}`} className="sec-row single" onClick={() => (select(conn.id, { kind: 'template', name: x.name }), setView('explorer'))}>
                  <span className="cell-main">
                    <span className="mono">{x.name}</span>
                    <span className="pill tiny">{x.kind}</span>
                  </span>
                  <span className="hint mono">{x.patterns.join(', ')}{x.priority !== undefined ? ` · p${x.priority}` : ''}</span>
                </button>
              ))}
          </div>
        )}
      </Async>
    </div>
  )
}

export function NodesPage({ conn }: { conn: ConnectionConfig }) {
  const q = useQuery({
    queryKey: ['nodes', conn.id],
    refetchInterval: 10_000,
    queryFn: () => getJson<Array<Record<string, string>>>(conn, '_cat/nodes?format=json&bytes=b&h=name,ip,node.role,master,heap.percent,ram.percent,cpu,load_1m,disk.used,disk.total,version')
  })
  return (
    <div className="sec-page">
      <div className="sec-head">
        <h1>Nodes</h1>
        <span className="hint">refreshes every 10 s</span>
      </div>
      <div className="sec-table">
        <div className="sec-row head nodes">
          <span>Node</span>
          <span>Roles</span>
          <span>Heap</span>
          <span>CPU</span>
          <span>Load</span>
          <span>Disk</span>
          <span>Version</span>
        </div>
        <Async query={q}>
          {(nodes) => (
            <>
              {nodes.map((n) => (
                <div key={n.name} className="sec-row nodes static">
                  <span className="cell-main">
                    <span className="mono ellipsis">{n.name}</span>
                    {n.master === '*' && <span className="pill tiny accent">master</span>}
                  </span>
                  <span className="mono muted">{n['node.role']}</span>
                  <Meter pct={Number(n['heap.percent'])} />
                  <Meter pct={Number(n.cpu)} />
                  <span className="mono">{n.load_1m}</span>
                  <span className="mono muted">
                    {formatBytes(Number(n['disk.used']))} / {formatBytes(Number(n['disk.total']))}
                  </span>
                  <span className="mono muted">{n.version}</span>
                </div>
              ))}
            </>
          )}
        </Async>
      </div>
    </div>
  )
}

function Meter({ pct }: { pct: number }) {
  const color = pct > 85 ? 'var(--red)' : pct > 70 ? 'var(--yellow)' : 'var(--green)'
  return (
    <span className="meter" title={`${pct}%`}>
      <span style={{ width: `${Math.min(100, pct || 0)}%`, background: color }} />
      <span className="mono">{Number.isFinite(pct) ? `${pct}%` : '—'}</span>
    </span>
  )
}

export function SettingsPage({ conn }: { conn: ConnectionConfig }) {
  const q = useQuery({ queryKey: ['cluster-settings', conn.id], queryFn: () => getJson<{ persistent: Record<string, string>; transient: Record<string, string> }>(conn, '_cluster/settings?flat_settings=true') })
  return (
    <div className="sec-page">
      <div className="sec-head">
        <h1>Cluster settings</h1>
        <span className="hint">non-default values · change them from the Workspace with PUT _cluster/settings</span>
      </div>
      <Async query={q}>
        {(s) => (
          <div className="page-body">
            {(['persistent', 'transient'] as const).map((kind) => (
              <section key={kind} className="card">
                <div className="card-head">
                  <h2>{kind}</h2>
                  <span className="hint">{Object.keys(s[kind]).length} settings</span>
                </div>
                {Object.entries(s[kind]).map(([key, v]) => (
                  <div key={key} className="kv-row">
                    <span className="mono muted">{key}</span>
                    <span className="mono">{String(v)}</span>
                  </div>
                ))}
                {Object.keys(s[kind]).length === 0 && <div className="empty">None</div>}
              </section>
            ))}
          </div>
        )}
      </Async>
    </div>
  )
}

interface Task {
  node: string
  id: number
  action: string
  description?: string
  start_time_in_millis: number
  running_time_in_nanos: number
  cancellable: boolean
  cancelled?: boolean
  headers?: Record<string, string>
}

export function TasksPage({ conn }: { conn: ConnectionConfig }) {
  const qc = useQueryClient()
  const [all, setAll] = useState(false)
  const q = useQuery({
    queryKey: ['tasks', conn.id, all],
    refetchInterval: 3000,
    queryFn: async () => {
      const j = await getJson<{ tasks: Task[] }>(conn, `_tasks?detailed=true&group_by=none${all ? '' : '&actions=*search*,*reindex*,*byquery*,*bulk*,*snapshot*,*forcemerge*'}`)
      return j.tasks.sort((a, b) => b.running_time_in_nanos - a.running_time_in_nanos)
    }
  })
  const cancel = async (t: Task) => {
    try {
      const res = await api.cluster.request({ connectionId: conn.id, method: 'POST', path: `_tasks/${encodeURIComponent(`${t.node}:${t.id}`)}/_cancel` })
      useApp.getState().showToast(res.status < 400 ? `Cancel requested for ${t.action}` : `Cancel failed: ${res.body.slice(0, 160)}`)
      void qc.invalidateQueries({ queryKey: ['tasks', conn.id] })
    } catch (e) {
      if (!(e instanceof KabanosError && e.code === 'NOT_CONFIRMED')) useApp.getState().showToast((e as Error).message)
    }
  }
  return (
    <div className="sec-page">
      <div className="sec-head">
        <h1>Tasks</h1>
        <span className="hint">live · refreshes every 3 s</span>
        <div className="spacer" />
        <button className={`chip${all ? ' on' : ''}`} onClick={() => setAll((v) => !v)}>
          Include internal tasks
        </button>
      </div>
      <div className="sec-table">
        <div className="sec-row head tasks">
          <span>Action</span>
          <span>Description</span>
          <span>Running</span>
          <span>Opaque id</span>
          <span />
        </div>
        <Async query={q}>
          {(tasks) => (
            <>
              {tasks.map((t) => (
                <div key={`${t.node}:${t.id}`} className="sec-row tasks static">
                  <span className="mono ellipsis" title={`${t.node}:${t.id}`}>{t.action}</span>
                  <span className="muted ellipsis" title={t.description}>{t.description ?? ''}</span>
                  <span className="mono">{formatDuration(t.running_time_in_nanos / 1e6)}</span>
                  <span className="mono muted ellipsis">{t.headers?.['X-Opaque-Id'] ?? ''}</span>
                  <span>
                    {t.cancellable && !t.cancelled ? (
                      <button className="link danger-text" onClick={() => cancel(t)}>
                        Cancel
                      </button>
                    ) : t.cancelled ? (
                      <span className="hint">cancelling…</span>
                    ) : null}
                  </span>
                </div>
              ))}
              {tasks.length === 0 && <div className="empty">No {all ? '' : 'long-running '}tasks right now.</div>}
            </>
          )}
        </Async>
      </div>
    </div>
  )
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${Math.round(s % 60)}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}
