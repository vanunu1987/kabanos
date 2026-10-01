import type {
  ApiKey,
  BuiltinPrivileges,
  CreatedApiKey,
  IndexPrivilege,
  RoleMapping,
  SecRole,
  SecUser,
  SecUserInput,
  SecurityStatus,
  Tenant
} from '@shared/security'
import type { ClusterRequest, ClusterResponse, ConnectionConfig, HttpMethod } from '@shared/types'
import { KabanosError } from '../errors'
import { errorReason } from '../metadata/MetadataService'

type Requester = (req: ClusterRequest) => Promise<ClusterResponse>

const OS = '_plugins/_security/api'

/**
 * Users, roles, role mappings, API keys and tenants for both engines.
 * Writes go through ConnectionManager.request, so read-only and production confirmation apply.
 */
export class SecurityService {
  constructor(
    private readonly request: Requester,
    private readonly connection: (id: string) => ConnectionConfig
  ) {}

  private isOs(id: string): boolean {
    const c = this.connection(id)
    return (c.detected?.engine ?? (c.engine === 'auto' ? 'elasticsearch' : c.engine)) === 'opensearch'
  }

  async status(id: string): Promise<SecurityStatus> {
    const os = this.isOs(id)
    const engine = os ? 'opensearch' : 'elasticsearch'
    const features = { apiKeys: !os, tenants: os, enableDisable: !os }
    const res = await this.request({ connectionId: id, method: 'GET', path: os ? '_plugins/_security/authinfo' : '_security/_authenticate' })
    if (res.status < 400) {
      const j = JSON.parse(res.body) as { username?: string; user_name?: string; roles?: string[] }
      return { enabled: true, engine, user: j.username ?? j.user_name, roles: j.roles, features }
    }
    const reason = errorReason(res.body)
    if (/security.*(not enabled|disabled|must be explicitly enabled)/i.test(reason) || (os && res.status === 404)) {
      return { enabled: false, engine, reason: os ? 'The OpenSearch Security plugin is not installed or is disabled on this cluster.' : 'Security is not enabled on this cluster (xpack.security.enabled: false).', features }
    }
    return { enabled: false, engine, reason: `Security APIs unavailable (HTTP ${res.status}): ${reason}`, features }
  }

  // ---------- users ----------

  async users(id: string): Promise<SecUser[]> {
    if (this.isOs(id)) {
      const j = await this.get<Record<string, { reserved?: boolean; hidden?: boolean; static?: boolean; backend_roles?: string[]; opendistro_security_roles?: string[]; attributes?: Record<string, string>; description?: string }>>(id, `${OS}/internalusers`)
      return Object.entries(j)
        .filter(([, u]) => !u.hidden)
        .map(([username, u]) => ({
          username,
          fullName: u.attributes?.full_name ?? u.description ?? undefined,
          email: u.attributes?.email,
          roles: u.opendistro_security_roles ?? [],
          backendRoles: u.backend_roles ?? [],
          enabled: true,
          reserved: !!(u.reserved || u.static)
        }))
        .sort(byName((u) => u.username))
    }
    const j = await this.get<Record<string, { username: string; roles: string[]; full_name?: string | null; email?: string | null; enabled: boolean; metadata?: { _reserved?: boolean } }>>(id, '_security/user')
    return Object.values(j)
      .map((u) => ({ username: u.username, fullName: u.full_name ?? undefined, email: u.email ?? undefined, roles: u.roles, enabled: u.enabled, reserved: !!u.metadata?._reserved }))
      .sort(byName((u) => u.username))
  }

  async saveUser(id: string, u: SecUserInput, create: boolean): Promise<void> {
    if (create && !u.password) throw new KabanosError('VALIDATION', 'A password is required for new users')
    if (this.isOs(id)) {
      const attributes: Record<string, string> = {}
      if (u.fullName) attributes.full_name = u.fullName
      if (u.email) attributes.email = u.email
      if (create) {
        await this.write(id, 'PUT', `${OS}/internalusers/${enc(u.username)}`, { password: u.password, opendistro_security_roles: u.roles, backend_roles: u.backendRoles ?? [], attributes })
      } else {
        // PATCH keeps the stored password hash untouched unless a new password is given.
        const ops: Array<{ op: string; path: string; value: unknown }> = [
          { op: 'add', path: '/opendistro_security_roles', value: u.roles },
          { op: 'add', path: '/backend_roles', value: u.backendRoles ?? [] },
          { op: 'add', path: '/attributes', value: attributes }
        ]
        if (u.password) ops.push({ op: 'add', path: '/password', value: u.password })
        await this.write(id, 'PATCH', `${OS}/internalusers/${enc(u.username)}`, ops)
      }
      return
    }
    const body: Record<string, unknown> = { roles: u.roles, full_name: u.fullName ?? null, email: u.email ?? null, enabled: u.enabled ?? true }
    if (u.password) body.password = u.password
    await this.write(id, create ? 'POST' : 'PUT', `_security/user/${enc(u.username)}`, body)
  }

  async setPassword(id: string, username: string, password: string): Promise<void> {
    if (this.isOs(id)) return this.write(id, 'PATCH', `${OS}/internalusers/${enc(username)}`, [{ op: 'add', path: '/password', value: password }])
    return this.write(id, 'POST', `_security/user/${enc(username)}/_password`, { password })
  }

  async setEnabled(id: string, username: string, enabled: boolean): Promise<void> {
    if (this.isOs(id)) throw new KabanosError('UNSUPPORTED', 'OpenSearch internal users cannot be disabled — remove their roles instead')
    return this.write(id, 'PUT', `_security/user/${enc(username)}/${enabled ? '_enable' : '_disable'}`)
  }

  async deleteUser(id: string, username: string): Promise<void> {
    return this.write(id, 'DELETE', this.isOs(id) ? `${OS}/internalusers/${enc(username)}` : `_security/user/${enc(username)}`)
  }

  // ---------- roles ----------

  async roles(id: string): Promise<SecRole[]> {
    if (this.isOs(id)) {
      const j = await this.get<Record<string, OsRole>>(id, `${OS}/roles`)
      return Object.entries(j)
        .filter(([, r]) => !r.hidden)
        .map(([name, r]) => fromOsRole(name, r))
        .sort(byName((r) => r.name))
    }
    const j = await this.get<Record<string, EsRole>>(id, '_security/role')
    return Object.entries(j)
      .map(([name, r]) => fromEsRole(name, r))
      .sort(byName((r) => r.name))
  }

  async saveRole(id: string, role: SecRole): Promise<void> {
    for (const ip of role.indices) {
      if (ip.query?.trim()) {
        try {
          JSON.parse(ip.query)
        } catch {
          throw new KabanosError('VALIDATION', `Document-level query for ${ip.names.join(', ')} is not valid JSON`)
        }
      }
    }
    if (this.isOs(id)) return this.write(id, 'PUT', `${OS}/roles/${enc(role.name)}`, toOsRole(role))
    return this.write(id, 'PUT', `_security/role/${enc(role.name)}`, toEsRole(role))
  }

  async deleteRole(id: string, name: string): Promise<void> {
    return this.write(id, 'DELETE', this.isOs(id) ? `${OS}/roles/${enc(name)}` : `_security/role/${enc(name)}`)
  }

  async builtinPrivileges(id: string): Promise<BuiltinPrivileges | null> {
    if (this.isOs(id)) return null
    try {
      return await this.get<BuiltinPrivileges>(id, '_security/privilege/_builtin')
    } catch {
      return null
    }
  }

  // ---------- role mappings ----------

  async roleMappings(id: string): Promise<RoleMapping[]> {
    if (this.isOs(id)) {
      const j = await this.get<Record<string, { users?: string[]; backend_roles?: string[]; hosts?: string[]; reserved?: boolean; hidden?: boolean }>>(id, `${OS}/rolesmapping`)
      return Object.entries(j)
        .filter(([, m]) => !m.hidden)
        .map(([name, m]) => ({ name, roles: [name], enabled: true, users: m.users ?? [], backendRoles: m.backend_roles ?? [], hosts: m.hosts ?? [], reserved: !!m.reserved }))
        .sort(byName((m) => m.name))
    }
    const j = await this.get<Record<string, { roles?: string[]; enabled: boolean; rules?: unknown; metadata?: { _reserved?: boolean } }>>(id, '_security/role_mapping')
    return Object.entries(j)
      .map(([name, m]) => ({ name, roles: m.roles ?? [], enabled: m.enabled, rules: m.rules, reserved: !!m.metadata?._reserved }))
      .sort(byName((m) => m.name))
  }

  async saveRoleMapping(id: string, m: RoleMapping): Promise<void> {
    if (this.isOs(id)) return this.write(id, 'PUT', `${OS}/rolesmapping/${enc(m.name)}`, { users: m.users ?? [], backend_roles: m.backendRoles ?? [], hosts: m.hosts ?? [] })
    return this.write(id, 'PUT', `_security/role_mapping/${enc(m.name)}`, { roles: m.roles, enabled: m.enabled, rules: m.rules ?? { field: { username: '*' } } })
  }

  async deleteRoleMapping(id: string, name: string): Promise<void> {
    return this.write(id, 'DELETE', this.isOs(id) ? `${OS}/rolesmapping/${enc(name)}` : `_security/role_mapping/${enc(name)}`)
  }

  // ---------- API keys (Elasticsearch) ----------

  async apiKeys(id: string): Promise<ApiKey[]> {
    if (this.isOs(id)) return []
    const j = await this.get<{ api_keys: Array<{ id: string; name: string; username: string; realm?: string; creation?: number; expiration?: number; invalidated: boolean }> }>(id, '_security/api_key')
    return j.api_keys
      .map((k) => ({ id: k.id, name: k.name, username: k.username, realm: k.realm, created: k.creation ? new Date(k.creation).toISOString() : undefined, expires: k.expiration ? new Date(k.expiration).toISOString() : undefined, invalidated: k.invalidated }))
      .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
  }

  async createApiKey(id: string, name: string, expiration?: string, roleDescriptors?: unknown): Promise<CreatedApiKey> {
    if (this.isOs(id)) throw new KabanosError('UNSUPPORTED', 'OpenSearch has no API keys')
    const res = await this.send(id, 'POST', '_security/api_key', { name, ...(expiration ? { expiration } : {}), ...(roleDescriptors ? { role_descriptors: roleDescriptors } : {}) })
    const j = JSON.parse(res.body) as { id: string; name: string; api_key: string; encoded?: string }
    return { id: j.id, name: j.name, encoded: j.encoded ?? Buffer.from(`${j.id}:${j.api_key}`).toString('base64') }
  }

  async invalidateApiKey(id: string, keyId: string): Promise<void> {
    return this.write(id, 'DELETE', '_security/api_key', { ids: [keyId] })
  }

  // ---------- tenants (OpenSearch) ----------

  async tenants(id: string): Promise<Tenant[]> {
    if (!this.isOs(id)) return []
    const j = await this.get<Record<string, { description?: string; reserved?: boolean; hidden?: boolean }>>(id, `${OS}/tenants`)
    return Object.entries(j)
      .filter(([, t]) => !t.hidden)
      .map(([name, t]) => ({ name, description: t.description, reserved: !!t.reserved }))
      .sort(byName((t) => t.name))
  }

  async saveTenant(id: string, t: Tenant): Promise<void> {
    return this.write(id, 'PUT', `${OS}/tenants/${enc(t.name)}`, { description: t.description ?? '' })
  }

  async deleteTenant(id: string, name: string): Promise<void> {
    return this.write(id, 'DELETE', `${OS}/tenants/${enc(name)}`)
  }

  // ---------- plumbing ----------

  private async get<T>(id: string, path: string): Promise<T> {
    const res = await this.request({ connectionId: id, method: 'GET', path })
    if (res.status >= 400) throw new KabanosError(res.status === 403 ? 'VALIDATION' : 'NETWORK', `GET ${path} → HTTP ${res.status}: ${errorReason(res.body)}`)
    return JSON.parse(res.body) as T
  }

  private async send(id: string, method: HttpMethod, path: string, body?: unknown): Promise<ClusterResponse> {
    const res = await this.request({ connectionId: id, method, path, body: body === undefined ? undefined : JSON.stringify(body) })
    if (res.status >= 400) throw new KabanosError('VALIDATION', `${method} ${path} → HTTP ${res.status}: ${errorReason(res.body)}`)
    return res
  }

  private async write(id: string, method: HttpMethod, path: string, body?: unknown): Promise<void> {
    await this.send(id, method, path, body)
  }
}

interface EsRole {
  cluster?: string[]
  indices?: Array<{ names: string[] | string; privileges: string[]; field_security?: { grant?: string[]; except?: string[] }; query?: string | object; allow_restricted_indices?: boolean }>
  applications?: unknown[]
  run_as?: string[]
  remote_indices?: unknown[]
  metadata?: { _reserved?: boolean } & Record<string, unknown>
  description?: string
}

interface OsRole {
  reserved?: boolean
  hidden?: boolean
  static?: boolean
  cluster_permissions?: string[]
  index_permissions?: Array<{ index_patterns: string[]; fls?: string[]; masked_fields?: string[]; allowed_actions?: string[]; dls?: string }>
  tenant_permissions?: unknown[]
  description?: string
}

export function fromEsRole(name: string, r: EsRole): SecRole {
  const extra: Record<string, unknown> = {}
  if (r.applications?.length) extra.applications = r.applications
  if (r.run_as?.length) extra.run_as = r.run_as
  if (r.remote_indices?.length) extra.remote_indices = r.remote_indices
  if (r.description) extra.description = r.description
  return {
    name,
    cluster: r.cluster ?? [],
    indices: (r.indices ?? []).map((i) => ({
      names: Array.isArray(i.names) ? i.names : [i.names],
      privileges: i.privileges,
      grant: i.field_security?.grant,
      except: i.field_security?.except,
      query: i.query === undefined ? undefined : typeof i.query === 'string' ? i.query : JSON.stringify(i.query)
    })),
    extra: Object.keys(extra).length ? extra : undefined,
    reserved: !!r.metadata?._reserved
  }
}

export function toEsRole(r: SecRole): EsRole {
  return {
    cluster: r.cluster,
    indices: r.indices.map((i) => ({
      names: i.names,
      privileges: i.privileges,
      ...(i.grant?.length || i.except?.length ? { field_security: { grant: i.grant?.length ? i.grant : ['*'], ...(i.except?.length ? { except: i.except } : {}) } } : {}),
      ...(i.query?.trim() ? { query: i.query } : {})
    })),
    ...(r.extra as Partial<EsRole> | undefined)
  }
}

/** OpenSearch FLS: `field` grants, `~field` excludes (they can't be mixed). */
export function fromOsRole(name: string, r: OsRole): SecRole {
  return {
    name,
    cluster: r.cluster_permissions ?? [],
    indices: (r.index_permissions ?? []).map((i) => {
      const fls = i.fls ?? []
      const except = fls.filter((f) => f.startsWith('~')).map((f) => f.slice(1))
      const grant = fls.filter((f) => !f.startsWith('~'))
      return { names: i.index_patterns, privileges: i.allowed_actions ?? [], grant: grant.length ? grant : undefined, except: except.length ? except : undefined, query: i.dls || undefined, maskedFields: i.masked_fields?.length ? i.masked_fields : undefined }
    }),
    extra: r.tenant_permissions?.length ? { tenant_permissions: r.tenant_permissions } : undefined,
    reserved: !!(r.reserved || r.static)
  }
}

export function toOsRole(r: SecRole): OsRole {
  return {
    cluster_permissions: r.cluster,
    index_permissions: r.indices.map((i: IndexPrivilege) => ({
      index_patterns: i.names,
      allowed_actions: i.privileges,
      fls: i.except?.length ? i.except.map((f) => `~${f}`) : (i.grant?.filter((g) => g !== '*') ?? []),
      masked_fields: i.maskedFields ?? [],
      ...(i.query?.trim() ? { dls: i.query } : {})
    })),
    tenant_permissions: (r.extra?.tenant_permissions as unknown[] | undefined) ?? []
  }
}

function enc(s: string): string {
  return encodeURIComponent(s)
}

function byName<T>(get: (t: T) => string) {
  return (a: T, b: T) => get(a).localeCompare(get(b))
}
