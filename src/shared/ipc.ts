import type { ExportFormat, ExportRequest } from './export'
import type { Block, Environment, Folder, HistoryEntry, LibraryFilter, Query, QueryPatch, WorkspaceTab } from './library'
import type { AliasDetail, ClusterTree, FieldInfo, IndexDetail } from './meta'
import type { Routine, RoutineRun, RoutineStep } from './routines'
import type { ApiKey, BuiltinPrivileges, CreatedApiKey, RoleMapping, SecRole, SecUser, SecUserInput, SecurityStatus, Tenant } from './security'
import type {
  ClusterRequest,
  ClusterResponse,
  ConnectionConfig,
  ConnectionInput,
  DetectedEngine,
  TestResult
} from './types'

/**
 * The whole renderer ↔ main surface. The preload forwards every call over a single
 * `kabanos:invoke` channel; main validates arguments with zod before dispatching.
 */
export interface KabanosApi {
  connections: {
    list(): Promise<ConnectionConfig[]>
    save(input: ConnectionInput): Promise<ConnectionConfig>
    remove(id: string): Promise<void>
    /** Test an unsaved form (input) or a saved connection (id). */
    test(target: { input: ConnectionInput } | { id: string }): Promise<TestResult>
    connect(id: string): Promise<DetectedEngine>
    pickCaFile(): Promise<string | null>
    exportToFile(ids?: string[]): Promise<{ count: number; path: string } | null>
    importFromFile(): Promise<{ imported: number } | null>
  }
  cluster: {
    request(req: ClusterRequest): Promise<ClusterResponse>
    cancel(opaqueId: string): Promise<void>
    /** Workspace / index view run: resolves {{vars}} from the environment in main and records history. */
    run(req: ClusterRequest & { queryId?: string; envId?: string }): Promise<ClusterResponse & { resolvedPath: string }>
  }
  library: {
    folders(connectionId: string | null): Promise<Folder[]>
    createFolder(connectionId: string, name: string, parentId?: string | null): Promise<Folder>
    updateFolder(id: string, patch: { name?: string; parentId?: string | null }): Promise<void>
    removeFolder(id: string): Promise<void>
    /** Queries of one cluster; `'*'` lists every cluster's (routine pickers, import dialog). */
    queries(connectionId: string | null, filter?: LibraryFilter, search?: string): Promise<Query[]>
    query(id: string): Promise<Query>
    createQuery(q: QueryPatch & Pick<Query, 'method' | 'path'> & { connectionId: string }): Promise<Query>
    /** Copy queries from other clusters into `connectionId` (originals stay where they are). */
    importQueries(connectionId: string, queryIds: string[]): Promise<{ imported: number }>
    updateQuery(id: string, patch: QueryPatch): Promise<Query>
    removeQuery(id: string): Promise<void>
    tags(connectionId: string): Promise<Array<{ tag: string; count: number }>>
    history(connectionId: string, search?: string, limit?: number): Promise<HistoryEntry[]>
    responses(queryId: string): Promise<HistoryEntry[]>
    clearHistory(): Promise<void>
  }
  app: {
    info(): Promise<{ version: string; electron: string; chrome: string; node: string; dataDir: string; historyCount: number }>
    revealData(): Promise<void>
    setTheme(pref: 'dark' | 'light' | 'system'): Promise<void>
  }
  workspace: {
    tabs(connectionId: string): Promise<WorkspaceTab[]>
    createTab(connectionId: string, name: string): Promise<WorkspaceTab>
    updateTab(id: string, patch: { name?: string; defaultTarget?: string | null; envId?: string | null }): Promise<void>
    removeTab(id: string): Promise<void>
    blocks(tabId: string): Promise<Array<Block & { query: Query }>>
    addBlock(tabId: string, queryId: string, afterQueryId?: string): Promise<void>
    removeBlock(tabId: string, queryId: string): Promise<void>
    setCollapsed(tabId: string, queryIds: string[], collapsed: boolean): Promise<void>
    reorder(tabId: string, queryIds: string[]): Promise<void>
  }
  routines: {
    list(): Promise<Routine[]>
    save(r: { id?: string; name: string; defaultConnectionId?: string; variables: Record<string, string>; steps: RoutineStep[] }): Promise<Routine>
    remove(id: string): Promise<void>
    runs(id: string): Promise<RoutineRun[]>
    /** Returns the run id; progress arrives through window.kabanosIpc.onRoutineEvent. */
    start(id: string, opts: { dryRun?: boolean; stepThrough?: boolean }): Promise<string>
    resume(runId: string): Promise<void>
    stop(runId: string): Promise<void>
  }
  security: {
    status(connectionId: string): Promise<SecurityStatus>
    users(connectionId: string): Promise<SecUser[]>
    saveUser(connectionId: string, user: SecUserInput, create: boolean): Promise<void>
    setPassword(connectionId: string, username: string, password: string): Promise<void>
    setEnabled(connectionId: string, username: string, enabled: boolean): Promise<void>
    deleteUser(connectionId: string, username: string): Promise<void>
    roles(connectionId: string): Promise<SecRole[]>
    saveRole(connectionId: string, role: SecRole): Promise<void>
    deleteRole(connectionId: string, name: string): Promise<void>
    builtinPrivileges(connectionId: string): Promise<BuiltinPrivileges | null>
    roleMappings(connectionId: string): Promise<RoleMapping[]>
    saveRoleMapping(connectionId: string, mapping: RoleMapping): Promise<void>
    deleteRoleMapping(connectionId: string, name: string): Promise<void>
    apiKeys(connectionId: string): Promise<ApiKey[]>
    createApiKey(connectionId: string, name: string, expiration?: string, roleDescriptors?: unknown): Promise<CreatedApiKey>
    invalidateApiKey(connectionId: string, keyId: string): Promise<void>
    tenants(connectionId: string): Promise<Tenant[]>
    saveTenant(connectionId: string, tenant: Tenant): Promise<void>
    deleteTenant(connectionId: string, name: string): Promise<void>
  }
  env: {
    list(): Promise<Environment[]>
    save(env: { id?: string; name: string; vars: Environment['vars'] }): Promise<Environment>
    remove(id: string): Promise<void>
  }
  export: {
    /** Asks for a file, then streams matching documents to it (progress via onExportProgress). null when cancelled at the dialog. */
    toFile(opts: ExportRequest): Promise<{ count: number; total?: number; cancelled: boolean; path: string; definitionPath?: string } | null>
    cancel(exportId: string): Promise<void>
    writeHits(opts: { target: string; hits: Array<{ _id: string; _index: string; _source?: Record<string, unknown> }>; format: ExportFormat; includeMeta: boolean }): Promise<{ count: number; path: string } | null>
  }
  meta: {
    tree(connectionId: string, force?: boolean): Promise<ClusterTree>
    index(connectionId: string, name: string): Promise<IndexDetail>
    alias(connectionId: string, name: string): Promise<AliasDetail>
    fields(connectionId: string, target: string): Promise<FieldInfo[]>
  }
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

export const IPC_CHANNEL = 'kabanos:invoke'
