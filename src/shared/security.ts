/** Engine-neutral security model: Elasticsearch `_security/*` and the OpenSearch Security plugin map onto it. */

export interface SecurityStatus {
  enabled: boolean
  engine: 'elasticsearch' | 'opensearch'
  /** Who the connection is authenticated as. */
  user?: string
  roles?: string[]
  /** Why security APIs are unavailable (disabled, missing privileges, AOSS…). */
  reason?: string
  features: { apiKeys: boolean; tenants: boolean; enableDisable: boolean }
}

export interface SecUser {
  username: string
  fullName?: string
  email?: string
  roles: string[]
  /** OpenSearch backend roles (from LDAP/SAML mapping). */
  backendRoles?: string[]
  enabled: boolean
  reserved: boolean
}

export interface SecUserInput {
  username: string
  /** Required when creating; omitted keeps the current password. */
  password?: string
  fullName?: string
  email?: string
  roles: string[]
  backendRoles?: string[]
  enabled?: boolean
}

export interface IndexPrivilege {
  names: string[]
  privileges: string[]
  /** Field-level security. Empty grant = all fields. */
  grant?: string[]
  except?: string[]
  /** Document-level security query (JSON string). */
  query?: string
  /** OpenSearch field masking. */
  maskedFields?: string[]
}

export interface SecRole {
  name: string
  cluster: string[]
  indices: IndexPrivilege[]
  /** OpenSearch tenant permissions, ES run_as/applications — kept verbatim. */
  extra?: Record<string, unknown>
  reserved: boolean
}

export interface RoleMapping {
  name: string
  roles: string[]
  enabled: boolean
  /** ES: role-mapping rules (JSON). */
  rules?: unknown
  /** OpenSearch: users / backend roles / hosts mapped to the role named `name`. */
  users?: string[]
  backendRoles?: string[]
  hosts?: string[]
  reserved: boolean
}

export interface ApiKey {
  id: string
  name: string
  username: string
  realm?: string
  created?: string
  expires?: string
  invalidated: boolean
}

export interface CreatedApiKey {
  id: string
  name: string
  /** Shown once. */
  encoded: string
}

export interface Tenant {
  name: string
  description?: string
  reserved: boolean
}

export interface BuiltinPrivileges {
  cluster: string[]
  index: string[]
}

/** Fallback lists when the cluster can't tell us (OpenSearch, older ES). */
export const COMMON_CLUSTER_PRIVILEGES = ['all', 'monitor', 'manage', 'manage_index_templates', 'manage_ilm', 'manage_pipeline', 'manage_security', 'manage_api_key', 'read_ilm', 'transport_client', 'cluster:monitor/main', 'cluster_composite_ops', 'cluster_monitor', 'cluster_all', 'indices_monitor']
export const COMMON_INDEX_PRIVILEGES = ['all', 'read', 'write', 'index', 'create', 'create_doc', 'delete', 'delete_index', 'create_index', 'view_index_metadata', 'manage', 'monitor', 'maintenance', 'auto_configure', 'crud', 'search', 'indices_all', 'get', 'indices:data/read/*', 'indices:data/write/*']
