import { randomUUID } from 'node:crypto'
import { parseConnectionUrl } from '@shared/connectionUrl'
import { classifyRequest, type Classification } from '@shared/destructive'
import { detectEngine } from '@shared/detectEngine'
import type {
  ClusterHealthSummary,
  ClusterRequest,
  ClusterResponse,
  ConnectionConfig,
  ConnectionInput,
  ConnectionSecrets,
  DetectedEngine,
  TestResult
} from '@shared/types'
import { ClusterClient } from '../cluster/ClusterClient'
import { KabanosError } from '../errors'
import type { Db } from '../store/db'
import type { SecretStore } from './secrets'

/** Asks the user to confirm a non-read request on a production connection. Returns true to proceed. */
export type ConfirmWrite = (conn: ConnectionConfig, req: ClusterRequest, c: Classification) => Promise<boolean>

interface Row {
  id: string
  name: string
  folder: string
  color: string
  favorite: number
  is_prod: number
  read_only: number
  engine: string
  url: string
  auth_kind: string
  username: string | null
  cloud_id: string | null
  aws_json: string | null
  tls_json: string
  timeout_ms: number
  compression: number
  headers_json: string
  detected_json: string | null
  ssh_json: string | null
  proxy: string | null
  created_at: string
  updated_at: string
}

/** Portable form used by import/export. Never contains secrets. */
export type ExportedConnection = Omit<ConnectionConfig, 'id' | 'hasPassword' | 'hasApiKey' | 'hasSshPassword' | 'hasSshPassphrase' | 'detected' | 'createdAt' | 'updatedAt'>

export class ConnectionManager {
  private readonly clients = new Map<string, ClusterClient>()
  private readonly inflight = new Map<string, { controller: AbortController; connectionId: string }>()

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly confirmWrite: ConfirmWrite
  ) {}

  list(): ConnectionConfig[] {
    const rows = this.db.prepare('SELECT * FROM connections ORDER BY folder, sort, name').all() as Row[]
    return rows.map((r) => this.fromRow(r))
  }

  get(id: string): ConnectionConfig {
    const row = this.db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new KabanosError('NOT_FOUND', `Connection ${id} not found`)
    return this.fromRow(row)
  }

  save(input: ConnectionInput): ConnectionConfig {
    const { config, secrets } = normaliseInput(input)
    const id = config.id ?? randomUUID()
    const existing = config.id ? (this.db.prepare('SELECT id FROM connections WHERE id = ?').get(id) as { id: string } | undefined) : undefined

    const values = {
      id,
      name: config.name.trim() || 'Untitled connection',
      folder: config.folder.trim() || 'Local',
      color: config.color,
      favorite: config.favorite ? 1 : 0,
      is_prod: config.isProd ? 1 : 0,
      read_only: config.readOnly ? 1 : 0,
      engine: config.engine,
      url: config.url,
      auth_kind: config.authKind,
      username: config.username ?? null,
      cloud_id: config.cloudId ?? null,
      aws_json: config.aws ? JSON.stringify(config.aws) : null,
      tls_json: JSON.stringify(config.tls),
      timeout_ms: config.timeoutMs,
      compression: config.compression ? 1 : 0,
      headers_json: JSON.stringify(config.headers ?? {}),
      detected_json: config.detected ? JSON.stringify(config.detected) : null,
      ssh_json: config.ssh ? JSON.stringify(config.ssh) : null,
      proxy: config.proxy?.trim() || null
    }

    this.db.transaction(() => {
      if (existing) {
        this.db
          .prepare(
            `UPDATE connections SET name=@name, folder=@folder, color=@color, favorite=@favorite, is_prod=@is_prod,
             read_only=@read_only, engine=@engine, url=@url, auth_kind=@auth_kind, username=@username, cloud_id=@cloud_id,
             aws_json=@aws_json, tls_json=@tls_json, timeout_ms=@timeout_ms, compression=@compression,
             headers_json=@headers_json, detected_json=COALESCE(@detected_json, detected_json), ssh_json=@ssh_json, proxy=@proxy,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=@id`
          )
          .run(values)
      } else {
        this.db
          .prepare(
            `INSERT INTO connections (id, name, folder, color, favorite, is_prod, read_only, engine, url, auth_kind, username,
             cloud_id, aws_json, tls_json, timeout_ms, compression, headers_json, detected_json, ssh_json, proxy)
             VALUES (@id, @name, @folder, @color, @favorite, @is_prod, @read_only, @engine, @url, @auth_kind, @username,
             @cloud_id, @aws_json, @tls_json, @timeout_ms, @compression, @headers_json, @detected_json, @ssh_json, @proxy)`
          )
          .run(values)
      }
      this.secrets.apply(id, secrets)
    })()

    void this.dropClient(id)
    return this.get(id)
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM connections WHERE id = ?').run(id)
    void this.dropClient(id)
  }

  /** Probe `GET /` + `_cluster/health` (+ counts) for an unsaved form or a saved connection. */
  async test(target: { input: ConnectionInput } | { id: string }): Promise<TestResult> {
    let client: ClusterClient
    let temporary = false
    try {
      if ('id' in target) {
        client = this.client(target.id)
      } else {
        const { config, secrets } = normaliseInput(target.input)
        const stored = config.id ? this.secrets.get(config.id) : {}
        client = new ClusterClient({ ...config, id: config.id ?? 'test' } as ConnectionConfig, mergeSecrets(stored, secrets))
        temporary = true
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }

    const started = performance.now()
    try {
      const detected = await probe(client, 'id' in target ? this.get(target.id) : normaliseInput(target.input).config)
      const health = await healthSummary(client)
      if ('id' in target) this.storeDetected(target.id, detected)
      return { ok: true, detected, health, ms: Math.round(performance.now() - started) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    } finally {
      if (temporary) void client.close()
    }
  }

  async connect(id: string): Promise<DetectedEngine> {
    const detected = await probe(this.client(id), this.get(id))
    this.storeDetected(id, detected)
    return detected
  }

  async request(req: ClusterRequest): Promise<ClusterResponse> {
    const conn = this.get(req.connectionId)
    const classification = classifyRequest(req.method, req.path, req.body)
    if (classification.safety !== 'read') {
      if (conn.readOnly) {
        throw new KabanosError('READ_ONLY', `"${conn.name}" is read-only — ${req.method} ${req.path} was blocked (${classification.reason})`)
      }
      if (conn.isProd && !(await this.confirmWrite(conn, req, classification))) {
        throw new KabanosError('NOT_CONFIRMED', 'Request not sent — confirmation declined')
      }
    }

    const opaqueId = req.opaqueId ?? `kabanos-${randomUUID()}`
    const controller = new AbortController()
    this.inflight.set(opaqueId, { controller, connectionId: conn.id })
    try {
      return await this.client(conn.id).request({ ...req, opaqueId, signal: controller.signal })
    } finally {
      this.inflight.delete(opaqueId)
    }
  }

  async cancel(opaqueId: string): Promise<void> {
    const entry = this.inflight.get(opaqueId)
    if (!entry) return
    entry.controller.abort()
    await this.client(entry.connectionId).cancelTasks(opaqueId)
  }

  exportConnections(ids?: string[]): ExportedConnection[] {
    return this.list()
      .filter((c) => !ids || ids.includes(c.id))
      .map(({ id: _id, hasPassword: _p, hasApiKey: _k, hasSshPassword: _sp, hasSshPassphrase: _spp, detected: _d, createdAt: _c, updatedAt: _u, ...rest }) => rest)
  }

  importConnections(items: ExportedConnection[]): number {
    let n = 0
    for (const item of items) {
      this.save({ config: { ...item, id: undefined } })
      n++
    }
    return n
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.keys()].map((id) => this.dropClient(id)))
  }

  private client(id: string): ClusterClient {
    let c = this.clients.get(id)
    if (!c) {
      c = new ClusterClient(this.get(id), this.secrets.get(id))
      this.clients.set(id, c)
    }
    return c
  }

  private async dropClient(id: string): Promise<void> {
    const c = this.clients.get(id)
    this.clients.delete(id)
    await c?.close()
  }

  private storeDetected(id: string, detected: DetectedEngine): void {
    this.db.prepare('UPDATE connections SET detected_json = ? WHERE id = ?').run(JSON.stringify(detected), id)
  }

  private fromRow(r: Row): ConnectionConfig {
    return {
      id: r.id,
      name: r.name,
      folder: r.folder,
      color: r.color as ConnectionConfig['color'],
      favorite: !!r.favorite,
      isProd: !!r.is_prod,
      readOnly: !!r.read_only,
      engine: r.engine as ConnectionConfig['engine'],
      url: r.url,
      authKind: r.auth_kind as ConnectionConfig['authKind'],
      username: r.username ?? undefined,
      cloudId: r.cloud_id ?? undefined,
      aws: r.aws_json ? JSON.parse(r.aws_json) : undefined,
      tls: JSON.parse(r.tls_json),
      ssh: r.ssh_json ? JSON.parse(r.ssh_json) : undefined,
      proxy: r.proxy ?? undefined,
      timeoutMs: r.timeout_ms,
      compression: !!r.compression,
      headers: JSON.parse(r.headers_json),
      detected: r.detected_json ? JSON.parse(r.detected_json) : undefined,
      ...this.secrets.has(r.id),
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }
  }
}

/**
 * For `authKind: 'url'` the renderer may send the raw URL with credentials in it.
 * Split them out here so only the clean URL is ever persisted.
 */
export function normaliseInput(input: ConnectionInput): { config: ConnectionInput['config']; secrets?: ConnectionSecrets } {
  const config = { ...input.config }
  let secrets = input.secrets ? { ...input.secrets } : undefined
  if (config.authKind !== 'cloudid' && config.url) {
    const parsed = parseConnectionUrl(config.url)
    config.url = parsed.cleanUrl
    if (parsed.username) {
      if (config.authKind === 'url' || !config.username) config.username = parsed.username
      if (parsed.password !== undefined) secrets = { ...secrets, password: parsed.password }
    }
  }
  if (config.authKind === 'none') config.username = undefined
  return { config, secrets }
}

function mergeSecrets(stored: ConnectionSecrets, incoming?: ConnectionSecrets): ConnectionSecrets {
  if (!incoming) return stored
  const pick = (k: keyof ConnectionSecrets) => (incoming[k] === undefined ? stored[k] : incoming[k] || undefined)
  return { password: pick('password'), apiKey: pick('apiKey'), sshPassword: pick('sshPassword'), sshPassphrase: pick('sshPassphrase') }
}

async function probe(client: ClusterClient, config?: Pick<ConnectionConfig, 'authKind' | 'aws'>): Promise<DetectedEngine> {
  // OpenSearch Serverless has no `GET /`; a signed _cat call proves access instead.
  if (config?.authKind === 'sigv4' && config.aws?.service === 'aoss') {
    const res = await client.request({ method: 'GET', path: '_cat/indices?format=json&h=index' })
    if (res.status === 401 || res.status === 403) throw new KabanosError('NETWORK', `AWS rejected the signed request (${res.status}) — check the data access policy for this principal`)
    return { engine: 'opensearch', version: 'serverless', major: 2, flavor: 'aws', label: 'AOSS' }
  }
  const res = await client.request({ method: 'GET', path: '/' })
  if (res.status === 401) throw new KabanosError('NETWORK', 'Authentication failed (401) — check the username/password or API key')
  if (res.status === 403) throw new KabanosError('NETWORK', 'Authenticated but not allowed to read cluster info (403)')
  if (res.status >= 400) throw new KabanosError('NETWORK', `GET / returned HTTP ${res.status}: ${res.body.slice(0, 200)}`)
  let json: unknown
  try {
    json = JSON.parse(res.body)
  } catch {
    throw new KabanosError('NETWORK', 'The server did not answer with JSON — is this an Elasticsearch/OpenSearch endpoint?')
  }
  return detectEngine(json, res.headers)
}

async function healthSummary(client: ClusterClient): Promise<ClusterHealthSummary> {
  const summary: ClusterHealthSummary = { status: 'unknown', nodes: 0 }
  const [health, indices, aliases, templates] = await Promise.allSettled([
    client.request({ method: 'GET', path: '_cluster/health' }),
    client.request({ method: 'GET', path: '_cat/indices?format=json&h=index' }),
    client.request({ method: 'GET', path: '_cat/aliases?format=json&h=alias' }),
    client.request({ method: 'GET', path: '_index_template' })
  ])
  const json = (r: PromiseSettledResult<ClusterResponse>): unknown =>
    r.status === 'fulfilled' && r.value.status === 200 ? JSON.parse(r.value.body) : undefined

  const h = json(health) as { status?: ClusterHealthSummary['status']; number_of_nodes?: number } | undefined
  if (h) {
    summary.status = h.status ?? 'unknown'
    summary.nodes = h.number_of_nodes ?? 0
  }
  const i = json(indices) as unknown[] | undefined
  if (i) summary.indices = i.length
  const a = json(aliases) as Array<{ alias: string }> | undefined
  if (a) summary.aliases = new Set(a.map((x) => x.alias)).size
  const t = json(templates) as { index_templates?: unknown[] } | undefined
  if (t?.index_templates) summary.templates = t.index_templates.length
  return summary
}
