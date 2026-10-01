import { useMemo, useState } from 'react'
import { formatBytes, isSystemAlias, isSystemDataStream, isSystemIndex, isSystemTemplate, type ClusterTree, type Health } from '@shared/meta'
import type { ConnectionConfig } from '@shared/types'
import { Icon } from '../../shell/icons'
import { useApp, type ExplorerSel, type NodeKind } from '../../store'

export const HEALTH_COLOR: Record<Health, string> = { green: 'var(--green)', yellow: 'var(--yellow)', red: 'var(--red)', unknown: 'var(--faint)' }

type Sort = 'name' | 'size' | 'docs'
const SORT_NEXT: Record<Sort, Sort> = { name: 'size', size: 'docs', docs: 'name' }

interface Row {
  kind: NodeKind
  name: string
  label: string
  meta: string
  color: string
  square?: boolean
}

/**
 * Cluster tree: indices, data streams, aliases, templates. `compact` is the narrower variant
 * used beside the Index view, where clicking opens a query tab instead of the inspector.
 */
export function ExplorerTree({ conn, tree, compact, onPick, selected }: { conn: ConnectionConfig; tree: ClusterTree; compact?: boolean; onPick(sel: ExplorerSel): void; selected?: ExplorerSel }) {
  const [filter, setFilter] = useState('')
  const [hideSystem, setHideSystem] = useState(true)
  const [hideClosed, setHideClosed] = useState(false)
  const [sort, setSort] = useState<Sort>('name')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['Component templates']))
  const [showAll, setShowAll] = useState<Set<string>>(new Set())

  const sections = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const match = (s: string) => !q || s.toLowerCase().includes(q)

    const indices = tree.indices
      .filter((i) => !(hideSystem && isSystemIndex(i)) && !(hideClosed && i.status === 'close') && match(i.name))
      .sort((a, b) => (sort === 'size' ? b.storeBytes - a.storeBytes : sort === 'docs' ? b.docs - a.docs : a.name.localeCompare(b.name)))
      .map(
        (i): Row => ({
          kind: 'index',
          name: i.name,
          label: i.name,
          meta: i.status === 'close' ? 'closed' : sort === 'docs' ? i.docs.toLocaleString() : formatBytes(i.storeBytes),
          color: HEALTH_COLOR[i.health]
        })
      )
    const streams = tree.dataStreams
      .filter((d) => !(hideSystem && isSystemDataStream(d)) && match(d.name))
      .map((d): Row => ({ kind: 'datastream', name: d.name, label: d.name, meta: `${d.indices.length} idx`, color: HEALTH_COLOR[d.health] }))
    const aliases = tree.aliases
      .filter((a) => !(hideSystem && isSystemAlias(a)) && (match(a.name) || a.indices.some((i) => match(i.index))))
      .map(
        (a): Row => ({
          kind: 'alias',
          name: a.name,
          label: `${a.name} → ${a.indices.length === 1 ? a.indices[0]!.index : `${a.indices.length} indices`}`,
          meta: '',
          color: 'var(--json-key)',
          square: true
        })
      )
    const tpl = (kind: 'index' | 'component') =>
      tree.templates
        .filter((t) => t.kind === kind && !(hideSystem && isSystemTemplate(t)) && match(t.name))
        .map((t): Row => ({ kind: 'template', name: t.name, label: t.name, meta: t.priority !== undefined ? `p${t.priority}` : '', color: 'var(--json-number)', square: true }))

    return [
      { name: 'Indices', rows: indices },
      { name: 'Data streams', rows: streams },
      { name: 'Aliases', rows: aliases },
      { name: 'Index templates', rows: tpl('index') },
      { name: 'Component templates', rows: tpl('component') }
    ].filter((s) => s.rows.length > 0 || s.name === 'Indices')
  }, [tree, filter, hideSystem, hideClosed, sort])

  const toggle = (set: Set<string>, name: string) => {
    const n = new Set(set)
    if (n.has(name)) n.delete(name)
    else n.add(name)
    return n
  }
  const LIMIT = 12

  return (
    <aside className={`sidebar explorer-tree${compact ? ' compact' : ''}`}>
      {!compact && (
        <div className="tree-head">
          <div className="tree-title">
            <span className="dot" style={{ background: HEALTH_COLOR[tree.health] }} />
            <span>{tree.clusterName ?? conn.name}</span>
          </div>
          <div className="hint">
            {conn.detected ? `${conn.detected.engine === 'opensearch' ? 'OpenSearch' : 'Elasticsearch'} ${conn.detected.version}` : conn.name} · {tree.health} · {tree.nodes} node
            {tree.nodes === 1 ? '' : 's'}
          </div>
        </div>
      )}
      <div className="tree-tools">
        <label className="filter" style={{ margin: 0 }}>
          {Icon.search()}
          <input aria-label="Filter indices, aliases and templates" placeholder={compact ? 'Filter' : 'Filter indices, aliases, templates'} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        {!compact && (
          <div className="chips">
            <button className={`chip${hideSystem ? ' on' : ''}`} aria-pressed={hideSystem} onClick={() => setHideSystem((v) => !v)}>
              Hide system
            </button>
            <button className={`chip${hideClosed ? ' on' : ''}`} aria-pressed={hideClosed} onClick={() => setHideClosed((v) => !v)}>
              Hide closed
            </button>
            <button className="chip" onClick={() => setSort((s) => SORT_NEXT[s])}>
              Sort: {sort}
            </button>
          </div>
        )}
      </div>
      <div className="sidebar-scroll tree-scroll">
        {sections.map((sec) => {
          const isCollapsed = collapsed.has(sec.name) && !filter
          const rows = showAll.has(sec.name) || filter ? sec.rows : sec.rows.slice(0, LIMIT)
          return (
            <div key={sec.name} className="tree-section">
              <button className={`tree-sec-head${isCollapsed ? ' collapsed' : ''}`} onClick={() => setCollapsed((c) => toggle(c, sec.name))} aria-expanded={!isCollapsed}>
                {Icon.chevronDown()}
                <span>{sec.name}</span>
                <span className="count">{sec.rows.length}</span>
              </button>
              {!isCollapsed && (
                <>
                  {rows.map((r) => {
                    const active = selected?.kind === r.kind && selected.name === r.name
                    return (
                      <button key={`${r.kind}:${r.name}`} className={`tree-row${active ? ' active' : ''}`} onClick={() => onPick({ kind: r.kind, name: r.name })} title={r.label}>
                        <span className="tree-dot" style={{ background: r.color, borderRadius: r.square ? 2 : 4 }} />
                        <span className="tree-label mono">{r.label}</span>
                        {!compact && r.meta && <span className="tree-meta mono">{r.meta}</span>}
                      </button>
                    )
                  })}
                  {sec.rows.length === 0 && <div className="tree-empty">{filter ? 'No matches' : 'None'}</div>}
                  {!filter && sec.rows.length > LIMIT && (
                    <button className="tree-row more" onClick={() => setShowAll((s) => toggle(s, sec.name))}>
                      <span className="tree-label">{showAll.has(sec.name) ? 'Show less' : `+ ${sec.rows.length - LIMIT} more`}</span>
                    </button>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

export function useConnection(id: string | null): ConnectionConfig | undefined {
  return useApp((s) => s.connections.find((c) => c.id === id))
}
