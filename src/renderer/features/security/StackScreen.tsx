import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { ConnectionConfig } from '@shared/types'
import { api } from '../../api'
import { Async } from '../../components/Async'
import { LifecyclePage, NodesPage, PipelinesPage, SettingsPage, SnapshotsPage, TasksPage, TemplatesPage } from './ClusterPages'
import { ApiKeysPage, RoleMappingsPage, RolesPage, TenantsPage, UsersPage } from './SecurityPages'

type Page = 'users' | 'roles' | 'mappings' | 'apikeys' | 'tenants' | 'lifecycle' | 'snapshots' | 'pipelines' | 'templates' | 'nodes' | 'settings' | 'tasks'

/** Screen 6 — stack management: security (users, roles, mappings, keys/tenants), data and cluster pages. */
export function StackScreen({ conn }: { conn: ConnectionConfig }) {
  const [page, setPage] = useState<Page>('users')
  const status = useQuery({ queryKey: ['security', conn.id, 'status'], queryFn: () => api.security.status(conn.id) })
  const s = status.data
  const securityPages: Array<[Page, string]> = [
    ['users', 'Users'],
    ['roles', 'Roles'],
    ['mappings', 'Role mappings'],
    ...(s?.features.apiKeys ? ([['apikeys', 'API keys']] as Array<[Page, string]>) : []),
    ...(s?.features.tenants ? ([['tenants', 'Tenants']] as Array<[Page, string]>) : [])
  ]
  const groups: Array<{ name: string; items: Array<[Page, string]> }> = [
    { name: 'Security', items: securityPages },
    { name: 'Data', items: [['lifecycle', 'Index lifecycle'], ['snapshots', 'Snapshots'], ['pipelines', 'Ingest pipelines'], ['templates', 'Index templates']] },
    { name: 'Cluster', items: [['nodes', 'Nodes'], ['settings', 'Settings'], ['tasks', 'Tasks']] }
  ]
  const isSecurity = securityPages.some(([p]) => p === page)

  return (
    <>
      <aside className="sidebar stack-nav">
        <div className="tree-title" style={{ padding: '14px 16px 6px' }}>
          Stack management
        </div>
        {s?.enabled && s.user && <div className="hint" style={{ padding: '0 16px 10px' }}>signed in as <span className="mono">{s.user}</span></div>}
        {groups.map((g) => (
          <div key={g.name} className="stack-group">
            <div className="eyebrow" style={{ padding: '2px 16px 4px' }}>
              {g.name}
            </div>
            {g.items.map(([id, label]) => (
              <button key={id} className={`stack-item${page === id ? ' on' : ''}`} onClick={() => setPage(id)} aria-current={page === id ? 'page' : undefined}>
                {label}
              </button>
            ))}
          </div>
        ))}
      </aside>
      <main className="main stack-main">
        {isSecurity ? (
          <Async query={status}>
            {(st) =>
              !st.enabled ? (
                <div className="placeholder">
                  <h2>Security is not available</h2>
                  <div style={{ maxWidth: 460, textAlign: 'center' }}>{st.reason}</div>
                  <div className="hint">The Data and Cluster pages on the left still work.</div>
                </div>
              ) : page === 'users' ? (
                <UsersPage conn={conn} status={st} />
              ) : page === 'roles' ? (
                <RolesPage conn={conn} status={st} />
              ) : page === 'mappings' ? (
                <RoleMappingsPage conn={conn} status={st} />
              ) : page === 'apikeys' ? (
                <ApiKeysPage conn={conn} />
              ) : (
                <TenantsPage conn={conn} />
              )
            }
          </Async>
        ) : page === 'lifecycle' ? (
          <LifecyclePage conn={conn} />
        ) : page === 'snapshots' ? (
          <SnapshotsPage conn={conn} />
        ) : page === 'pipelines' ? (
          <PipelinesPage conn={conn} />
        ) : page === 'templates' ? (
          <TemplatesPage conn={conn} />
        ) : page === 'nodes' ? (
          <NodesPage conn={conn} />
        ) : page === 'settings' ? (
          <SettingsPage conn={conn} />
        ) : (
          <TasksPage conn={conn} />
        )}
      </main>
    </>
  )
}
