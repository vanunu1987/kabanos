import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { formatBytes, type IndexDetail } from '@shared/meta'
import type { ConnectionConfig } from '@shared/types'
import { api } from '../../api'
import { Async } from '../../components/Async'
import { JsonView } from '../../components/JsonView'
import { Menu } from '../../components/Menu'
import { useIndexDetail } from '../../queries'
import { relTime } from '../../components/time'
import { useWorkspace } from '../workspace/store'
import { useApp } from '../../store'
import { DocumentCards, type Hit } from '../indexView/DocumentCards'
import { runIndexAction } from './indexActions'
import { MappingTable } from './MappingTable'
import { MappingEditor } from './MappingEditor'
import { DeleteModal, EmptyModal } from './DangerModals'
import { ExportModal } from '../../components/ExportModal'
import { HEALTH_COLOR } from './ExplorerTree'

const TABS = [
  ['overview', 'Overview'],
  ['mapping', 'Mapping'],
  ['settings', 'Settings'],
  ['documents', 'Documents'],
  ['shards', 'Shards'],
  ['saved', 'Saved queries']
] as const

const KEY_SETTINGS = ['index.refresh_interval', 'index.number_of_replicas', 'index.max_result_window', 'index.lifecycle.name', 'index.plugins.index_state_management.policy_id', 'index.codec']

export function IndexPage({ conn, name }: { conn: ConnectionConfig; name: string }) {
  const q = useIndexDetail(conn.id, name)
  const tab = useApp((s) => s.explorer[conn.id]?.tab ?? 'overview')
  const { updateExplorer, openQuery, select } = useApp.getState()
  const [danger, setDanger] = useState<'delete' | 'empty' | null>(null)
  const [exporting, setExporting] = useState(false)
  const closed = q.data?.summary?.status === 'close'

  return (
    <div className="page">
      <div className="page-head">
        <div className="crumbs">
          Indices / <span>{name}</span>
        </div>
        <div className="title-row">
          <h1 className="mono">{name}</h1>
          {q.data?.summary && <HealthPill health={closed ? 'closed' : q.data.summary.health} />}
          {q.data?.aliases.map((a) => (
            <button key={a.name} className="pill alias" onClick={() => select(conn.id, { kind: 'alias', name: a.name })}>
              alias: {a.name}
            </button>
          ))}
          <div className="spacer" />
          <button className="btn md" onClick={() => openInWorkspace(name)}>
            Open in workspace
          </button>
          <button className="btn md primary" onClick={() => openQuery(conn.id, name)} disabled={closed}>
            Query this index
          </button>
          <Menu
            label="More actions"
            items={[
              { label: 'Refresh', onSelect: () => runIndexAction(conn.id, 'POST', `${enc(name)}/_refresh`, `Refreshed ${name}`), disabled: closed },
              { label: 'Clear cache', onSelect: () => runIndexAction(conn.id, 'POST', `${enc(name)}/_cache/clear`, `Cleared caches of ${name}`), disabled: closed },
              closed
                ? { label: 'Open index', onSelect: () => runIndexAction(conn.id, 'POST', `${enc(name)}/_open`, `Opened ${name}`) }
                : { label: 'Close index', onSelect: () => runIndexAction(conn.id, 'POST', `${enc(name)}/_close`, `Closed ${name}`) },
              { label: 'Export documents…', onSelect: () => setExporting(true), disabled: closed },
              'sep',
              { label: 'Empty index (delete all documents)…', danger: true, onSelect: () => setDanger('empty'), disabled: closed },
              { label: 'Delete index…', danger: true, onSelect: () => setDanger('delete') }
            ]}
          >
            ⋯
          </Menu>
        </div>
        <div className="tabs" role="tablist">
          {TABS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => updateExplorer(conn.id, { tab: id })}>
              {label}
              {id === 'shards' && q.data ? ` · ${q.data.shards.length}` : ''}
            </button>
          ))}
        </div>
      </div>
      <div className="page-body">
        <Async query={q}>
          {(d) =>
            tab === 'overview' ? (
              <Overview d={d} onAlias={(a) => select(conn.id, { kind: 'alias', name: a })} onTemplate={(t) => select(conn.id, { kind: 'template', name: t })} />
            ) : tab === 'mapping' ? (
              <MappingEditor conn={conn} detail={d} />
            ) : tab === 'settings' ? (
              <SettingsTable settings={d.settings} />
            ) : tab === 'documents' ? (
              <Documents conn={conn} name={name} closed={closed} />
            ) : tab === 'shards' ? (
              <Shards d={d} />
            ) : (
              <SavedQueries name={name} aliases={d.aliases.map((a) => a.name)} />
            )
          }
        </Async>
      </div>
      {danger === 'delete' && <DeleteModal conn={conn} name={name} kind="index" onClose={() => setDanger(null)} onDone={() => (setDanger(null), useApp.getState().updateExplorer(conn.id, { sel: undefined }))} />}
      {danger === 'empty' && <EmptyModal conn={conn} name={name} onClose={() => setDanger(null)} onDone={() => setDanger(null)} />}
      {exporting && <ExportModal conn={conn} target={name} definition onClose={() => setExporting(false)} />}
    </div>
  )
}

/** New workspace block targeting this index (sets it as the tab's default target). */
export async function openInWorkspace(target: string): Promise<void> {
  const ws = useWorkspace.getState()
  useApp.getState().setView('workspace')
  if (!ws.activeTab) await ws.load()
  await ws.setDefaultTarget(target)
  await ws.newBlock({ method: 'POST', path: '_search', body: '{\n  "size": 20,\n  "query": {\n    "match_all": {}\n  }\n}' })
}

/** Library queries whose path targets this index or one of its aliases. */
function SavedQueries({ name, aliases }: { name: string; aliases: string[] }) {
  const version = useWorkspace((s) => s.libraryVersion)
  const q = useQuery({
    queryKey: ['saved-for', name, version],
    queryFn: async () => {
      const all = await api.library.queries({ kind: 'all' })
      const targets = new Set([name, ...aliases])
      return all.filter((x) => x.folderId !== null && x.path.split(/[/?]/)[0]!.split(',').some((t) => targets.has(t)))
    }
  })
  const open = async (id: string) => {
    useApp.getState().setView('workspace')
    const ws = useWorkspace.getState()
    if (!ws.activeTab) await ws.load()
    await ws.openQuery(id)
  }
  return (
    <Async query={q}>
      {(list) =>
        list.length === 0 ? (
          <div className="empty">No saved queries target {name}{aliases.length ? ` or ${aliases.join(', ')}` : ''} yet. Save one from the Index view or the Workspace.</div>
        ) : (
          <section className="card pad">
            {list.map((x) => (
              <div key={x.id} className="inline-row between">
                <button className="link" onClick={() => open(x.id)}>
                  <span className={`mono m-${x.method.toLowerCase()}`}>{x.method}</span> {x.title || x.path}
                </button>
                <span className="hint mono">
                  {x.path} · {relTime(x.lastRunAt)}
                </span>
              </div>
            ))}
          </section>
        )
      }
    </Async>
  )
}

export function HealthPill({ health }: { health: string }) {
  const c = health === 'closed' ? 'var(--faint)' : HEALTH_COLOR[health as keyof typeof HEALTH_COLOR]
  return (
    <span className="pill" style={{ color: c, background: health === 'green' ? 'var(--ok-bg)' : 'var(--surface-3)' }}>
      {health}
    </span>
  )
}

function Overview({ d, onAlias, onTemplate }: { d: IndexDetail; onAlias(a: string): void; onTemplate(t: string): void }) {
  const s = d.summary
  const primaries = d.shards.filter((x) => x.primary).length || s?.primaries
  return (
    <div className="overview">
      <div className="stats">
        <Stat label="Documents" value={s ? s.docs.toLocaleString() : '—'} />
        <Stat label="Store size" value={formatBytes(s?.storeBytes)} />
        <Stat label="Shards" value={s ? `${primaries}p · ${s.replicas}r` : '—'} />
        <Stat label="Created" value={s?.createdAt?.slice(0, 10) ?? '—'} />
      </div>
      <div className="overview-split">
        <MappingTable fields={d.fields} raw={d.mapping} fill />
        <div className="side-cards">
          <section className="card pad">
            <h2>Aliases</h2>
            {d.aliases.length === 0 && <span className="hint">No aliases point at this index</span>}
            {d.aliases.map((a) => (
              <div key={a.name} className="inline-row">
                <button className="link mono" onClick={() => onAlias(a.name)}>
                  {a.name}
                </button>
                {a.isWriteIndex && <span className="pill tiny accent">write index</span>}
                {a.filter !== undefined && <span className="hint mono">filter: {JSON.stringify(a.filter).slice(0, 60)}</span>}
              </div>
            ))}
          </section>
          <section className="card pad">
            <h2>Matched index template</h2>
            {d.matchedTemplate ? (
              <>
                <div className="inline-row between">
                  <button className="link mono" onClick={() => onTemplate(d.matchedTemplate!.name)}>
                    {d.matchedTemplate.name}
                  </button>
                  {d.matchedTemplate.priority !== undefined && <span className="hint">priority {d.matchedTemplate.priority}</span>}
                </div>
                <div className="mono hint">index_patterns: {JSON.stringify(d.matchedTemplate.patterns)}</div>
                {d.matchedTemplate.composedOf.length > 0 && <div className="mono hint">composed_of: {d.matchedTemplate.composedOf.join(', ')}</div>}
              </>
            ) : (
              <span className="hint">No composable template matches this name</span>
            )}
          </section>
          <section className="card pad">
            <h2>Key settings</h2>
            {KEY_SETTINGS.filter((k) => k in d.settings || !k.includes('plugins')).map((k) => (
              <div key={k} className="inline-row between">
                <span className="mono muted">{k.replace(/^index\./, '').replace('plugins.index_state_management.', 'ism.')}</span>
                <span className="mono">{d.settings[k] ?? '—'}</span>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="hint">{label}</span>
      <span className="mono stat-value">{value}</span>
    </div>
  )
}

export function SettingsTable({ settings }: { settings: Record<string, string> }) {
  const [filter, setFilter] = useState('')
  const [raw, setRaw] = useState(false)
  const rows = useMemo(
    () =>
      Object.entries(settings)
        .filter(([k, v]) => !filter || k.includes(filter) || String(v).includes(filter))
        .sort(([a], [b]) => a.localeCompare(b)),
    [settings, filter]
  )
  return (
    <section className="card fill">
      <div className="card-head">
        <h2>Settings</h2>
        <span className="hint">{Object.keys(settings).length} settings</span>
        <div className="spacer" />
        {!raw && (
          <label className="filter small">
            <input aria-label="Filter settings" placeholder="Filter settings" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
        )}
        <button className={`btn xs${raw ? ' on' : ''}`} onClick={() => setRaw((v) => !v)}>
          Raw JSON
        </button>
      </div>
      {raw ? (
        <JsonView value={settings} className="card-scroll" />
      ) : (
        <div className="card-scroll">
          {rows.map(([k, v]) => (
            <div key={k} className="kv-row">
              <span className="mono muted">{k}</span>
              <span className="mono">{Array.isArray(v) ? JSON.stringify(v) : String(v)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function Documents({ conn, name, closed }: { conn: ConnectionConfig; name: string; closed: boolean }) {
  const q = useQuery({
    queryKey: ['sample', conn.id, name],
    enabled: !closed,
    queryFn: async () => {
      const res = await api.cluster.request({ connectionId: conn.id, method: 'POST', path: `${enc(name)}/_search`, body: '{"size":20}' })
      if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`)
      return JSON.parse(res.body) as { hits: { total: { value: number } | number; hits: Hit[] } }
    }
  })
  if (closed) return <div className="empty">The index is closed — open it to read documents.</div>
  return (
    <Async query={q}>
      {(r) => (
        <div className="docs-tab">
          <div className="hint">
            First {r.hits.hits.length} of {(typeof r.hits.total === 'number' ? r.hits.total : r.hits.total.value).toLocaleString()} documents ·{' '}
            <button className="link" onClick={() => useApp.getState().openQuery(conn.id, name)}>
              query this index
            </button>
          </div>
          <DocumentCards hits={r.hits.hits} />
        </div>
      )}
    </Async>
  )
}

function Shards({ d }: { d: IndexDetail }) {
  return (
    <section className="card fill">
      <div className="card-scroll">
        <div className="grid-row head shards">
          <span>Shard</span>
          <span>Role</span>
          <span>State</span>
          <span>Docs</span>
          <span>Size</span>
          <span>Node</span>
        </div>
        {d.shards.map((s, i) => (
          <div key={i} className="grid-row shards">
            <span className="mono">{s.shard}</span>
            <span>{s.primary ? 'primary' : 'replica'}</span>
            <span style={{ color: s.state === 'STARTED' ? 'var(--green)' : s.state === 'UNASSIGNED' ? 'var(--red)' : 'var(--yellow)' }}>{s.state.toLowerCase()}</span>
            <span className="mono">{s.docs?.toLocaleString() ?? '—'}</span>
            <span className="mono">{formatBytes(s.storeBytes)}</span>
            <span className="mono muted" title={s.unassignedReason}>
              {s.node ?? s.unassignedReason ?? '—'}
            </span>
          </div>
        ))}
        {d.shards.length === 0 && <div className="empty">No shard information</div>}
      </div>
    </section>
  )
}

function enc(s: string): string {
  return encodeURIComponent(s)
}
