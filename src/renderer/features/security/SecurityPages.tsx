import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { COMMON_CLUSTER_PRIVILEGES, COMMON_INDEX_PRIVILEGES, type IndexPrivilege, type RoleMapping, type SecRole, type SecUser, type SecurityStatus } from '@shared/security'
import type { ConnectionConfig } from '@shared/types'
import { api, KabanosError } from '../../api'
import { Async } from '../../components/Async'
import { ChipInput } from '../../components/ChipInput'
import { CodeEditor } from '../../components/CodeEditor'
import { Modal } from '../../components/Modal'
import { relTime } from '../../components/time'
import { Icon } from '../../shell/icons'
import { useTree } from '../../queries'
import { useApp } from '../../store'

const k = (id: string, what: string) => ['security', id, what]

/** Run a security write; production confirmation happens in main. Returns true on success. */
async function act(fn: () => Promise<unknown>, ok: string): Promise<boolean> {
  try {
    await fn()
    useApp.getState().showToast(ok)
    return true
  } catch (e) {
    if (!(e instanceof KabanosError && e.code === 'NOT_CONFIRMED')) useApp.getState().showToast((e as Error).message)
    return false
  }
}

function PageHead({ title, sub, search, onSearch, action }: { title: string; sub?: string; search?: string; onSearch?(v: string): void; action?: React.ReactNode }) {
  return (
    <div className="sec-head">
      <h1>{title}</h1>
      {sub && <span className="hint">{sub}</span>}
      <div className="spacer" />
      {onSearch && (
        <label className="filter small" style={{ width: 260 }}>
          {Icon.search()}
          <input aria-label={`Search ${title.toLowerCase()}`} placeholder="Search" value={search} onChange={(e) => onSearch(e.target.value)} />
        </label>
      )}
      {action}
    </div>
  )
}

// ---------------- users ----------------

export function UsersPage({ conn, status }: { conn: ConnectionConfig; status: SecurityStatus }) {
  const qc = useQueryClient()
  const users = useQuery({ queryKey: k(conn.id, 'users'), queryFn: () => api.security.users(conn.id) })
  const roles = useQuery({ queryKey: k(conn.id, 'roles'), queryFn: () => api.security.roles(conn.id) })
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<SecUser | 'new' | null>(null)
  const shown = (users.data ?? []).filter((u) => !search || [u.username, u.fullName, u.email, ...u.roles].some((x) => x?.toLowerCase().includes(search.toLowerCase())))
  const reload = () => qc.invalidateQueries({ queryKey: k(conn.id, 'users') })

  return (
    <div className="sec-page">
      <PageHead
        title="Users"
        sub={`${status.engine === 'opensearch' ? 'internal users' : 'native realm'} · ${users.data?.length ?? '…'} users`}
        search={search}
        onSearch={setSearch}
        action={
          <button className="btn md primary" onClick={() => setEditing('new')}>
            Create user
          </button>
        }
      />
      <div className="sec-split">
        <div className="sec-table">
          <div className="sec-row head users">
            <span>Username</span>
            <span>Full name</span>
            <span>Roles</span>
            <span>Status</span>
          </div>
          <Async query={users}>
            {() => (
              <>
                {shown.map((u) => (
                  <button key={u.username} className={`sec-row users${editing !== 'new' && editing?.username === u.username ? ' sel' : ''}`} onClick={() => setEditing(u)}>
                    <span className="cell-main">
                      <span className="mono ellipsis">{u.username}</span>
                      {u.reserved && <span className="pill tiny">reserved</span>}
                    </span>
                    <span className="muted ellipsis">{u.fullName ?? ''}</span>
                    <span className="tags">
                      {u.roles.map((r) => (
                        <span key={r} className="role-tag mono">
                          {r}
                        </span>
                      ))}
                      {u.backendRoles?.map((r) => (
                        <span key={`b-${r}`} className="role-tag mono backend" title="backend role">
                          {r}
                        </span>
                      ))}
                    </span>
                    <span style={{ color: u.enabled ? 'var(--green)' : 'var(--faint)', fontSize: 12 }}>{u.enabled ? 'Enabled' : 'Disabled'}</span>
                  </button>
                ))}
                {shown.length === 0 && <div className="empty">No users match.</div>}
              </>
            )}
          </Async>
        </div>
        {editing && (
          <UserEditor
            key={editing === 'new' ? 'new' : editing.username}
            conn={conn}
            status={status}
            user={editing === 'new' ? undefined : editing}
            roleNames={(roles.data ?? []).map((r) => r.name)}
            onClose={() => setEditing(null)}
            onSaved={async () => {
              await reload()
              setEditing(null)
            }}
          />
        )}
      </div>
    </div>
  )
}

function UserEditor({ conn, status, user, roleNames, onClose, onSaved }: { conn: ConnectionConfig; status: SecurityStatus; user?: SecUser; roleNames: string[]; onClose(): void; onSaved(): void }) {
  const [username, setUsername] = useState(user?.username ?? '')
  const [fullName, setFullName] = useState(user?.fullName ?? '')
  const [email, setEmail] = useState(user?.email ?? '')
  const [roles, setRoles] = useState(user?.roles ?? [])
  const [backendRoles, setBackendRoles] = useState(user?.backendRoles ?? [])
  const [password, setPassword] = useState('')
  const create = !user
  const os = status.engine === 'opensearch'

  const save = async () => {
    const ok = await act(() => api.security.saveUser(conn.id, { username, password: password || undefined, fullName: fullName || undefined, email: email || undefined, roles, backendRoles: os ? backendRoles : undefined, enabled: user?.enabled ?? true }, create), create ? `Created ${username}` : `Saved ${username}`)
    if (ok) onSaved()
  }

  return (
    <section className="sec-editor">
      <div className="sec-editor-head">
        <div className="eyebrow">{create ? 'Create user' : 'Edit user'}</div>
        <div className="mono" style={{ fontSize: 16 }}>
          {create ? username || 'new user' : user.username}
        </div>
        {user?.reserved && <span className="hint">Built-in user — some changes are rejected by the cluster.</span>}
      </div>
      <div className="sec-editor-body">
        {create && (
          <div className="field">
            <label htmlFor="u-name">Username</label>
            <input id="u-name" className="input sm mono" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          </div>
        )}
        <div className="field">
          <label htmlFor="u-pass">{create ? 'Password' : 'New password'}</label>
          <input id="u-pass" className="input sm" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={create ? '' : 'leave blank to keep'} autoComplete="new-password" />
        </div>
        <div className="field">
          <label htmlFor="u-full">Full name</label>
          <input id="u-full" className="input sm" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="u-email">Email</label>
          <input id="u-email" className="input sm" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label>Roles</label>
          <ChipInput label="Roles" value={roles} onChange={setRoles} suggestions={roleNames} placeholder="Add role…" tone="index" />
        </div>
        {os && (
          <div className="field">
            <label>Backend roles</label>
            <ChipInput label="Backend roles" value={backendRoles} onChange={setBackendRoles} placeholder="Add backend role…" />
          </div>
        )}
      </div>
      <div className="sec-editor-foot">
        {!create && status.features.enableDisable && (
          <button className="btn md left" onClick={async () => (await act(() => api.security.setEnabled(conn.id, user.username, !user.enabled), `${user.enabled ? 'Disabled' : 'Enabled'} ${user.username}`)) && onSaved()}>
            {user.enabled ? 'Disable' : 'Enable'}
          </button>
        )}
        {!create && !user.reserved && (
          <button className="btn md danger" onClick={async () => confirm(`Delete user ${user.username}?`) && (await act(() => api.security.deleteUser(conn.id, user.username), `Deleted ${user.username}`)) && onSaved()}>
            Delete
          </button>
        )}
        <button className="btn md" onClick={onClose}>
          Cancel
        </button>
        <button className="btn md primary" disabled={!username.trim() || (create && password.length < 6)} onClick={save}>
          {create ? 'Create user' : 'Save user'}
        </button>
      </div>
    </section>
  )
}

// ---------------- roles ----------------

export function RolesPage({ conn, status }: { conn: ConnectionConfig; status: SecurityStatus }) {
  const qc = useQueryClient()
  const roles = useQuery({ queryKey: k(conn.id, 'roles'), queryFn: () => api.security.roles(conn.id) })
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<SecRole | 'new' | null>(null)
  const [hideReserved, setHideReserved] = useState(true)
  const shown = (roles.data ?? []).filter((r) => (!hideReserved || !r.reserved) && (!search || r.name.includes(search) || r.indices.some((i) => i.names.some((n) => n.includes(search)))))
  return (
    <div className="sec-page">
      <PageHead
        title="Roles"
        sub={`${roles.data?.length ?? '…'} roles`}
        search={search}
        onSearch={setSearch}
        action={
          <>
            <button className={`chip${hideReserved ? ' on' : ''}`} onClick={() => setHideReserved((v) => !v)}>
              Hide built-in
            </button>
            <button className="btn md primary" onClick={() => setEditing('new')}>
              Create role
            </button>
          </>
        }
      />
      <div className="sec-split">
        <div className="sec-table">
          <div className="sec-row head roles">
            <span>Role</span>
            <span>Cluster</span>
            <span>Indices</span>
          </div>
          <Async query={roles}>
            {() => (
              <>
                {shown.map((r) => (
                  <button key={r.name} className={`sec-row roles${editing !== 'new' && editing?.name === r.name ? ' sel' : ''}`} onClick={() => setEditing(r)}>
                    <span className="cell-main">
                      <span className="mono ellipsis">{r.name}</span>
                      {r.reserved && <span className="pill tiny">reserved</span>}
                    </span>
                    <span className="mono muted ellipsis">{r.cluster.join(', ') || '—'}</span>
                    <span className="tags">
                      {r.indices.flatMap((i) => i.names).slice(0, 4).map((n, j) => (
                        <span key={`${n}${j}`} className="role-tag mono">
                          {n}
                        </span>
                      ))}
                      {r.indices.some((i) => i.except?.length || i.grant?.length) && <span className="pill tiny">FLS</span>}
                      {r.indices.some((i) => i.query) && <span className="pill tiny">DLS</span>}
                    </span>
                  </button>
                ))}
                {shown.length === 0 && <div className="empty">No roles match.</div>}
              </>
            )}
          </Async>
        </div>
        {editing && (
          <RoleEditor
            key={editing === 'new' ? 'new' : editing.name}
            conn={conn}
            status={status}
            role={editing === 'new' ? undefined : editing}
            onClose={() => setEditing(null)}
            onSaved={async () => {
              await qc.invalidateQueries({ queryKey: k(conn.id, 'roles') })
              setEditing(null)
            }}
          />
        )}
      </div>
    </div>
  )
}

function RoleEditor({ conn, status, role, onClose, onSaved }: { conn: ConnectionConfig; status: SecurityStatus; role?: SecRole; onClose(): void; onSaved(): void }) {
  const [draft, setDraft] = useState<SecRole>(role ?? { name: '', cluster: [], indices: [{ names: [], privileges: ['read'] }], reserved: false })
  const [asJson, setAsJson] = useState(false)
  const [json, setJson] = useState('')
  const builtin = useQuery({ queryKey: k(conn.id, 'builtin'), queryFn: () => api.security.builtinPrivileges(conn.id), staleTime: Infinity })
  const tree = useTree(conn.id)
  const patterns = useMemo(() => [...(tree.data?.indices.filter((i) => !i.hidden).map((i) => i.name) ?? []), ...(tree.data?.aliases.map((a) => a.name) ?? []), '*'], [tree.data])
  const create = !role
  const setIdx = (i: number, p: Partial<IndexPrivilege>) => setDraft((d) => ({ ...d, indices: d.indices.map((x, j) => (j === i ? { ...x, ...p } : x)) }))

  const toggleJson = () => {
    if (!asJson) setJson(JSON.stringify({ cluster: draft.cluster, indices: draft.indices, ...draft.extra }, null, 2))
    else {
      try {
        const j = JSON.parse(json) as Partial<SecRole> & Record<string, unknown>
        const { cluster, indices, ...extra } = j
        setDraft((d) => ({ ...d, cluster: (cluster as string[]) ?? [], indices: (indices as IndexPrivilege[]) ?? [], extra: Object.keys(extra).length ? extra : undefined }))
      } catch {
        return useApp.getState().showToast('Role JSON is not valid')
      }
    }
    setAsJson((v) => !v)
  }
  const save = async () => {
    let r = draft
    if (asJson) {
      try {
        const j = JSON.parse(json) as Record<string, unknown>
        const { cluster, indices, ...extra } = j
        r = { ...draft, cluster: (cluster as string[]) ?? [], indices: (indices as IndexPrivilege[]) ?? [], extra: Object.keys(extra).length ? extra : undefined }
      } catch {
        return useApp.getState().showToast('Role JSON is not valid')
      }
    }
    const clean = { ...r, indices: r.indices.filter((i) => i.names.length) }
    if (await act(() => api.security.saveRole(conn.id, clean), `Saved role ${r.name}`)) onSaved()
  }

  return (
    <section className="sec-editor">
      <div className="sec-editor-head">
        <div className="eyebrow">{create ? 'Create role' : 'Edit role'}</div>
        {create ? (
          <input className="input sm mono" placeholder="role_name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Role name" autoFocus />
        ) : (
          <div className="mono" style={{ fontSize: 16 }}>
            {draft.name}
          </div>
        )}
        {role?.reserved && <span className="hint">Built-in role — read-only on most clusters.</span>}
      </div>
      <div className="sec-editor-body">
        {asJson ? (
          <div className="editor-box" style={{ height: 420 }}>
            <CodeEditor value={json} onChange={setJson} path={`role://${conn.id}/${draft.name || 'new'}`} />
          </div>
        ) : (
          <>
            <div className="field">
              <label>Cluster privileges</label>
              <ChipInput label="Cluster privileges" value={draft.cluster} onChange={(cluster) => setDraft({ ...draft, cluster })} suggestions={builtin.data?.cluster ?? COMMON_CLUSTER_PRIVILEGES} placeholder="Add privilege…" disabled={role?.reserved} />
            </div>
            {draft.indices.map((ip, i) => (
              <div key={i} className="idx-priv">
                <div className="inline-row between">
                  <b>Index privileges</b>
                  {!role?.reserved && (
                    <button className="link danger-text" onClick={() => setDraft({ ...draft, indices: draft.indices.filter((_, j) => j !== i) })}>
                      Remove
                    </button>
                  )}
                </div>
                <div className="field">
                  <label>Indices</label>
                  <ChipInput label="Indices" value={ip.names} onChange={(names) => setIdx(i, { names })} suggestions={patterns} placeholder="listings*" tone="index" disabled={role?.reserved} />
                </div>
                <div className="field">
                  <label>Privileges</label>
                  <ChipInput label="Index privileges" value={ip.privileges} onChange={(privileges) => setIdx(i, { privileges })} suggestions={builtin.data?.index ?? COMMON_INDEX_PRIVILEGES} disabled={role?.reserved} />
                </div>
                <div className="field">
                  <label>Field-level security</label>
                  <div className="row">
                    <ChipInput label="Granted fields" value={ip.grant ?? []} onChange={(grant) => setIdx(i, { grant: grant.length ? grant : undefined })} placeholder="grant: *" disabled={role?.reserved || (status.engine === 'opensearch' && !!ip.except?.length)} />
                    <ChipInput label="Excluded fields" value={ip.except ?? []} onChange={(except) => setIdx(i, { except: except.length ? except : undefined })} placeholder="except: …" tone="danger" disabled={role?.reserved || (status.engine === 'opensearch' && !!ip.grant?.length)} />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor={`dls-${i}`}>Document-level query</label>
                  <textarea id={`dls-${i}`} className="input sm mono dls" rows={2} value={ip.query ?? ''} onChange={(e) => setIdx(i, { query: e.target.value || undefined })} placeholder='{ "term": { "status": "active" } }' disabled={role?.reserved} spellCheck={false} />
                </div>
                {status.engine === 'opensearch' && (
                  <div className="field">
                    <label>Masked fields</label>
                    <ChipInput label="Masked fields" value={ip.maskedFields ?? []} onChange={(maskedFields) => setIdx(i, { maskedFields })} placeholder="hash these fields" disabled={role?.reserved} />
                  </div>
                )}
              </div>
            ))}
            {!role?.reserved && (
              <button className="dashed-btn tall" onClick={() => setDraft({ ...draft, indices: [...draft.indices, { names: [], privileges: ['read'] }] })}>
                + Add index privilege
              </button>
            )}
            {status.engine === 'elasticsearch' && <span className="hint">Field- and document-level security need a Platinum/Enterprise license (or a trial) on Elasticsearch.</span>}
          </>
        )}
        {status.engine === 'opensearch' && (
          <div className="os-note">
            <span className="badge os">OS</span>
            <span>This screen reads and writes the OpenSearch Security plugin (internal users, roles, role mappings, tenants).</span>
          </div>
        )}
      </div>
      <div className="sec-editor-foot">
        {!create && !role.reserved && (
          <button className="btn md danger left" onClick={async () => confirm(`Delete role ${role.name}?`) && (await act(() => api.security.deleteRole(conn.id, role.name), `Deleted ${role.name}`)) && onSaved()}>
            Delete
          </button>
        )}
        <button className="btn md" onClick={toggleJson}>
          {asJson ? 'Form view' : 'View as JSON'}
        </button>
        <button className="btn md" onClick={onClose}>
          Cancel
        </button>
        <button className="btn md primary" disabled={!draft.name.trim() || role?.reserved} onClick={save}>
          Save role
        </button>
      </div>
    </section>
  )
}

// ---------------- role mappings ----------------

export function RoleMappingsPage({ conn, status }: { conn: ConnectionConfig; status: SecurityStatus }) {
  const qc = useQueryClient()
  const os = status.engine === 'opensearch'
  const maps = useQuery({ queryKey: k(conn.id, 'mappings'), queryFn: () => api.security.roleMappings(conn.id) })
  const roles = useQuery({ queryKey: k(conn.id, 'roles'), queryFn: () => api.security.roles(conn.id) })
  const [editing, setEditing] = useState<RoleMapping | 'new' | null>(null)
  return (
    <div className="sec-page">
      <PageHead
        title="Role mappings"
        sub={os ? 'users, backend roles and hosts per role' : 'map realm users (SAML, LDAP, OIDC…) to roles'}
        action={
          <button className="btn md primary" onClick={() => setEditing('new')}>
            Create mapping
          </button>
        }
      />
      <div className="sec-split">
        <div className="sec-table">
          <div className="sec-row head maps">
            <span>{os ? 'Role' : 'Mapping'}</span>
            <span>{os ? 'Users' : 'Roles'}</span>
            <span>{os ? 'Backend roles' : 'Rules'}</span>
            <span>{os ? 'Hosts' : 'Status'}</span>
          </div>
          <Async query={maps}>
            {(list) => (
              <>
                {list.map((m) => (
                  <button key={m.name} className={`sec-row maps${editing !== 'new' && editing?.name === m.name ? ' sel' : ''}`} onClick={() => setEditing(m)}>
                    <span className="cell-main">
                      <span className="mono ellipsis">{m.name}</span>
                      {m.reserved && <span className="pill tiny">reserved</span>}
                    </span>
                    <span className="tags">{(os ? (m.users ?? []) : m.roles).map((r) => <span key={r} className="role-tag mono">{r}</span>)}</span>
                    <span className="mono muted ellipsis">{os ? (m.backendRoles ?? []).join(', ') : JSON.stringify(m.rules)}</span>
                    <span className="muted ellipsis" style={{ fontSize: 12 }}>{os ? (m.hosts ?? []).join(', ') : m.enabled ? 'Enabled' : 'Disabled'}</span>
                  </button>
                ))}
                {list.length === 0 && <div className="empty">No role mappings.</div>}
              </>
            )}
          </Async>
        </div>
        {editing && (
          <MappingEditor
            key={editing === 'new' ? 'new' : editing.name}
            conn={conn}
            os={os}
            mapping={editing === 'new' ? undefined : editing}
            roleNames={(roles.data ?? []).map((r) => r.name)}
            onClose={() => setEditing(null)}
            onSaved={async () => {
              await qc.invalidateQueries({ queryKey: k(conn.id, 'mappings') })
              setEditing(null)
            }}
          />
        )}
      </div>
    </div>
  )
}

function MappingEditor({ conn, os, mapping, roleNames, onClose, onSaved }: { conn: ConnectionConfig; os: boolean; mapping?: RoleMapping; roleNames: string[]; onClose(): void; onSaved(): void }) {
  const [m, setM] = useState<RoleMapping>(mapping ?? { name: '', roles: [], enabled: true, rules: { field: { 'realm.name': 'saml1' } }, users: [], backendRoles: [], hosts: [], reserved: false })
  const [rules, setRules] = useState(JSON.stringify(m.rules ?? {}, null, 2))
  const save = async () => {
    let parsed: unknown = m.rules
    if (!os) {
      try {
        parsed = JSON.parse(rules)
      } catch {
        return useApp.getState().showToast('Rules must be valid JSON')
      }
    }
    if (await act(() => api.security.saveRoleMapping(conn.id, { ...m, rules: parsed, roles: os ? [m.name] : m.roles }), `Saved mapping ${m.name}`)) onSaved()
  }
  return (
    <section className="sec-editor">
      <div className="sec-editor-head">
        <div className="eyebrow">{mapping ? 'Edit role mapping' : 'Create role mapping'}</div>
        {mapping ? (
          <div className="mono" style={{ fontSize: 16 }}>{m.name}</div>
        ) : os ? (
          <select className="select sm" value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} aria-label="Role to map">
            <option value="">Pick a role…</option>
            {roleNames.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        ) : (
          <input className="input sm mono" placeholder="mapping_name" value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} aria-label="Mapping name" autoFocus />
        )}
      </div>
      <div className="sec-editor-body">
        {os ? (
          <>
            <div className="field"><label>Users</label><ChipInput label="Mapped users" value={m.users ?? []} onChange={(users) => setM({ ...m, users })} /></div>
            <div className="field"><label>Backend roles</label><ChipInput label="Mapped backend roles" value={m.backendRoles ?? []} onChange={(backendRoles) => setM({ ...m, backendRoles })} /></div>
            <div className="field"><label>Hosts</label><ChipInput label="Mapped hosts" value={m.hosts ?? []} onChange={(hosts) => setM({ ...m, hosts })} /></div>
          </>
        ) : (
          <>
            <div className="field"><label>Roles</label><ChipInput label="Mapped roles" value={m.roles} onChange={(roles) => setM({ ...m, roles })} suggestions={roleNames} tone="index" /></div>
            <label className="check"><input type="checkbox" checked={m.enabled} onChange={(e) => setM({ ...m, enabled: e.target.checked })} /> Enabled</label>
            <div className="field">
              <label>Rules</label>
              <div className="editor-box" style={{ height: 200 }}>
                <CodeEditor value={rules} onChange={setRules} path={`mapping://${conn.id}/${m.name || 'new'}`} />
              </div>
            </div>
          </>
        )}
      </div>
      <div className="sec-editor-foot">
        {mapping && !mapping.reserved && (
          <button className="btn md danger left" onClick={async () => confirm(`Delete mapping ${mapping.name}?`) && (await act(() => api.security.deleteRoleMapping(conn.id, mapping.name), `Deleted ${mapping.name}`)) && onSaved()}>
            Delete
          </button>
        )}
        <button className="btn md" onClick={onClose}>Cancel</button>
        <button className="btn md primary" disabled={!m.name.trim()} onClick={save}>Save mapping</button>
      </div>
    </section>
  )
}

// ---------------- API keys (Elasticsearch) ----------------

export function ApiKeysPage({ conn }: { conn: ConnectionConfig }) {
  const qc = useQueryClient()
  const keys = useQuery({ queryKey: k(conn.id, 'apikeys'), queryFn: () => api.security.apiKeys(conn.id) })
  const [showInvalid, setShowInvalid] = useState(false)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<{ name: string; encoded: string } | null>(null)
  const [name, setName] = useState('')
  const [exp, setExp] = useState('30d')
  const list = (keys.data ?? []).filter((x) => showInvalid || !x.invalidated)
  return (
    <div className="sec-page">
      <PageHead
        title="API keys"
        sub={`${keys.data?.filter((x) => !x.invalidated).length ?? '…'} active`}
        action={
          <>
            <button className={`chip${showInvalid ? ' on' : ''}`} onClick={() => setShowInvalid((v) => !v)}>Show invalidated</button>
            <button className="btn md primary" onClick={() => setCreating(true)}>Create API key</button>
          </>
        }
      />
      <div className="sec-table">
        <div className="sec-row head keys"><span>Name</span><span>Owner</span><span>Created</span><span>Expires</span><span /></div>
        <Async query={keys}>
          {() => (
            <>
              {list.map((x) => (
                <div key={x.id} className="sec-row keys static">
                  <span className="cell-main"><span className="mono ellipsis">{x.name}</span>{x.invalidated && <span className="pill tiny">invalidated</span>}</span>
                  <span className="mono muted ellipsis">{x.username}{x.realm ? ` · ${x.realm}` : ''}</span>
                  <span className="muted">{relTime(x.created)}</span>
                  <span className="muted">{x.expires ? new Date(x.expires).toISOString().slice(0, 10) : 'never'}</span>
                  <span>{!x.invalidated && <button className="link danger-text" onClick={async () => confirm(`Invalidate API key "${x.name}"? Clients using it stop working.`) && (await act(() => api.security.invalidateApiKey(conn.id, x.id), `Invalidated ${x.name}`)) && qc.invalidateQueries({ queryKey: k(conn.id, 'apikeys') })}>Invalidate</button>}</span>
                </div>
              ))}
              {list.length === 0 && <div className="empty">No API keys.</div>}
            </>
          )}
        </Async>
      </div>
      {creating && (
        <Modal title="Create API key" onClose={() => setCreating(false)} actions={<>
          <button className="btn md" onClick={() => setCreating(false)}>Cancel</button>
          <button className="btn md primary" disabled={!name.trim()} onClick={async () => {
            try {
              const key = await api.security.createApiKey(conn.id, name.trim(), exp || undefined)
              setCreating(false)
              setCreated({ name: key.name, encoded: key.encoded })
              setName('')
              void qc.invalidateQueries({ queryKey: k(conn.id, 'apikeys') })
            } catch (e) {
              if (!(e instanceof KabanosError && e.code === 'NOT_CONFIRMED')) useApp.getState().showToast((e as Error).message)
            }
          }}>Create</button>
        </>}>
          <div className="field"><label htmlFor="k-name">Name</label><input id="k-name" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label htmlFor="k-exp">Expiration</label><input id="k-exp" className="input mono" value={exp} onChange={(e) => setExp(e.target.value)} placeholder="30d · empty = never" /></div>
          <span className="hint">The key inherits the privileges of {conn.username ?? 'the connection user'}.</span>
        </Modal>
      )}
      {created && (
        <Modal title={`API key “${created.name}”`} onClose={() => setCreated(null)} actions={<>
          <button className="btn md" onClick={() => { void navigator.clipboard.writeText(created.encoded); useApp.getState().showToast('Copied') }}>Copy</button>
          <button className="btn md primary" onClick={() => setCreated(null)}>Done</button>
        </>}>
          <span>Copy it now — Elasticsearch never shows it again. Use it as <span className="mono">Authorization: ApiKey …</span> or paste it into a kabanos connection.</span>
          <code className="mono key-box" aria-label="Encoded API key">{created.encoded}</code>
        </Modal>
      )}
    </div>
  )
}

// ---------------- tenants (OpenSearch) ----------------

export function TenantsPage({ conn }: { conn: ConnectionConfig }) {
  const qc = useQueryClient()
  const tenants = useQuery({ queryKey: k(conn.id, 'tenants'), queryFn: () => api.security.tenants(conn.id) })
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  return (
    <div className="sec-page">
      <PageHead title="Tenants" sub="OpenSearch Dashboards tenants" />
      <div className="sec-table">
        <div className="sec-row head tenants"><span>Tenant</span><span>Description</span><span /></div>
        <Async query={tenants}>
          {(list) => (
            <>
              {list.map((t) => (
                <div key={t.name} className="sec-row tenants static">
                  <span className="cell-main"><span className="mono">{t.name}</span>{t.reserved && <span className="pill tiny">reserved</span>}</span>
                  <span className="muted">{t.description}</span>
                  <span>{!t.reserved && <button className="link danger-text" onClick={async () => confirm(`Delete tenant ${t.name}?`) && (await act(() => api.security.deleteTenant(conn.id, t.name), `Deleted ${t.name}`)) && qc.invalidateQueries({ queryKey: k(conn.id, 'tenants') })}>Delete</button>}</span>
                </div>
              ))}
            </>
          )}
        </Async>
        <div className="sec-row tenants static">
          <input className="input sm mono" placeholder="new_tenant" value={name} onChange={(e) => setName(e.target.value)} aria-label="Tenant name" />
          <input className="input sm" placeholder="Description" value={desc} onChange={(e) => setDesc(e.target.value)} aria-label="Tenant description" />
          <button className="btn xs primary" disabled={!name.trim()} onClick={async () => { if (await act(() => api.security.saveTenant(conn.id, { name: name.trim(), description: desc, reserved: false }), `Created ${name}`)) { setName(''); setDesc(''); void qc.invalidateQueries({ queryKey: k(conn.id, 'tenants') }) } }}>Add tenant</button>
        </div>
      </div>
    </div>
  )
}
