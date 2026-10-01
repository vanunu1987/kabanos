import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { checkServerIdentity, type PeerCertificate, type TLSSocket } from 'node:tls'
import { promisify } from 'node:util'
import { brotliDecompress, gunzip, inflate } from 'node:zlib'
import { Agent, buildConnector, ProxyAgent, request, type Dispatcher } from 'undici'
import { decodeCloudId, normalizeFingerprint } from '@shared/connectionUrl'
import type { ClusterResponse, ConnectionConfig, ConnectionSecrets, HttpMethod } from '@shared/types'
import { KabanosError } from '../errors'
import { SigV4Signer } from './sigv4'
import { SshTunnel } from '../connections/SshTunnel'

export interface RequestOptions {
  method: HttpMethod
  path: string
  body?: string
  opaqueId?: string
  signal?: AbortSignal
}

/**
 * One HTTP agent per connection. All cluster traffic in the app goes through here —
 * the renderer never talks to a cluster directly and never sees credentials.
 */
export class ClusterClient {
  readonly baseUrl: string
  private readonly agent: Dispatcher
  private readonly tunnel?: SshTunnel
  private readonly authHeader?: string
  private readonly signer?: SigV4Signer

  constructor(
    private readonly config: ConnectionConfig,
    secrets: ConnectionSecrets,
    signer?: SigV4Signer
  ) {
    this.baseUrl = resolveBaseUrl(config)
    if (config.authKind === 'sigv4') {
      if (!config.aws?.region) throw new KabanosError('VALIDATION', 'AWS region is required for SigV4')
      this.signer = signer ?? new SigV4Signer({ region: config.aws.region, service: config.aws.service, profile: config.aws.profile })
    } else {
      this.authHeader = buildAuthHeader(config, secrets)
    }
    if (config.ssh) {
      const u = new URL(this.baseUrl)
      const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
      this.tunnel = new SshTunnel(config.ssh, secrets, { host: u.hostname, port })
    }
    if (config.proxy?.trim()) {
      if (config.ssh) throw new KabanosError('VALIDATION', 'Use either an SSH tunnel or a proxy, not both')
      if (config.tls.fingerprint) throw new KabanosError('VALIDATION', 'Fingerprint pinning is not supported through a proxy — use a CA file instead')
      this.agent = new ProxyAgent({
        uri: config.proxy.trim(),
        requestTls: { ca: readCa(config), rejectUnauthorized: config.tls.verify },
        headersTimeout: config.timeoutMs,
        bodyTimeout: config.timeoutMs
      })
    } else {
      this.agent = new Agent({
        connect: buildTlsConnector(config, this.tunnel),
        headersTimeout: config.timeoutMs,
        bodyTimeout: config.timeoutMs
      })
    }
  }

  async request(opts: RequestOptions): Promise<ClusterResponse> {
    const opaqueId = opts.opaqueId ?? `kabanos-${randomUUID()}`
    const url = joinUrl(this.baseUrl, opts.path)
    const sendBody = opts.body !== undefined && opts.body.trim() !== '' && opts.method !== 'HEAD'

    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-opaque-id': opaqueId,
      'accept-encoding': this.config.compression ? 'gzip, deflate' : 'identity',
      ...this.config.headers
    }
    if (this.authHeader) headers.authorization = this.authHeader
    if (sendBody) headers['content-type'] = isNdjsonPath(opts.path) ? 'application/x-ndjson' : 'application/json'
    const payload = sendBody ? ensureTrailingNewline(opts.body!, opts.path) : undefined
    let finalHeaders = headers
    if (this.signer) {
      try {
        finalHeaders = await this.signer.sign(url, opts.method, headers, payload)
      } catch (err) {
        throw new KabanosError('VALIDATION', `AWS credentials: ${(err as Error).message}. Configure ~/.aws or run \`aws sso login\`.`)
      }
    }

    const signals = [AbortSignal.timeout(this.config.timeoutMs)]
    if (opts.signal) signals.push(opts.signal)

    const started = performance.now()
    let status: number
    let rawHeaders: Record<string, string | string[] | undefined>
    let buf: Buffer
    try {
      // undici.request (not fetch) so GET-with-body is sent as-is, like Kibana's console does.
      const res = await request(url, {
        method: opts.method,
        headers: finalHeaders,
        body: payload,
        dispatcher: this.agent,
        signal: AbortSignal.any(signals)
      })
      status = res.statusCode
      rawHeaders = res.headers
      buf = await decompress(Buffer.from(await res.body.arrayBuffer()), String(res.headers['content-encoding'] ?? ''))
    } catch (err) {
      throw toKabanosError(err, opts.signal)
    }
    const body = buf.toString('utf8')
    const ms = Math.round(performance.now() - started)
    const outHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(rawHeaders)) if (v !== undefined) outHeaders[k] = Array.isArray(v) ? v.join(', ') : v
    return { status, headers: outHeaders, body, ms, bytes: buf.length, opaqueId }
  }

  /** Best-effort server-side cancel of tasks started by a given request. */
  async cancelTasks(opaqueId: string): Promise<void> {
    try {
      const res = await this.request({ method: 'GET', path: '_tasks?detailed=true&actions=*search*' })
      if (res.status !== 200) return
      const parsed = JSON.parse(res.body) as { nodes?: Record<string, { tasks?: Record<string, { headers?: Record<string, string> }> }> }
      const ids: string[] = []
      for (const node of Object.values(parsed.nodes ?? {})) {
        for (const [taskId, task] of Object.entries(node.tasks ?? {})) {
          if (task.headers?.['X-Opaque-Id'] === opaqueId || task.headers?.['x-opaque-id'] === opaqueId) ids.push(taskId)
        }
      }
      await Promise.all(ids.map((id) => this.request({ method: 'POST', path: `_tasks/${encodeURIComponent(id)}/_cancel` })))
    } catch {
      // The client-side abort already closed the connection, which ES treats as a cancel for searches.
    }
  }

  async close(): Promise<void> {
    this.tunnel?.close()
    await this.agent.close()
  }
}

export function resolveBaseUrl(config: ConnectionConfig): string {
  if (config.authKind === 'cloudid') {
    if (!config.cloudId) throw new KabanosError('VALIDATION', 'Cloud ID is required')
    return decodeCloudId(config.cloudId).esUrl
  }
  if (!config.url) throw new KabanosError('VALIDATION', 'Connection URL is required')
  return config.url.replace(/\/+$/, '')
}

export function buildAuthHeader(config: ConnectionConfig, secrets: ConnectionSecrets): string | undefined {
  const basic = (): string | undefined =>
    config.username ? `Basic ${Buffer.from(`${config.username}:${secrets.password ?? ''}`).toString('base64')}` : undefined
  const apiKey = (): string | undefined => {
    const key = secrets.apiKey?.trim()
    if (!key) return undefined
    // Accept both `id:key` and the already-encoded form returned by ES as `encoded`.
    return `ApiKey ${key.includes(':') ? Buffer.from(key).toString('base64') : key}`
  }
  switch (config.authKind) {
    case 'url':
    case 'basic':
      return basic()
    case 'apikey':
      return apiKey()
    case 'cloudid':
      return apiKey() ?? basic()
    case 'sigv4':
      return undefined // signed per request
    case 'none':
      return undefined
  }
}

function readCa(config: ConnectionConfig): Buffer | undefined {
  if (!config.tls.caPath) return undefined
  try {
    return readFileSync(config.tls.caPath)
  } catch {
    throw new KabanosError('TLS', `Can't read CA certificate at ${config.tls.caPath}`)
  }
}

function buildTlsConnector(config: ConnectionConfig, tunnel?: SshTunnel): buildConnector.connector {
  const pin = config.tls.fingerprint ? normalizeFingerprint(config.tls.fingerprint) : undefined
  const ca = readCa(config)
  const realHost = new URL(resolveBaseUrl(config)).hostname
  // Through a tunnel the socket goes to 127.0.0.1, but SNI and the certificate check must use the real host.
  const base = buildConnector({
    ca,
    rejectUnauthorized: config.tls.verify && !pin,
    ...(tunnel ? { checkServerIdentity: (_h: string, cert: PeerCertificate) => checkServerIdentity(realHost, cert) } : {})
  })
  const direct: buildConnector.connector = tunnel
    ? (opts, cb) => {
        tunnel.port().then(
          (port) => base({ ...opts, hostname: '127.0.0.1', port: String(port), servername: isIp(realHost) ? undefined : realHost }, cb),
          (err: Error) => cb(err, null as never)
        )
      }
    : base
  // With a pin we verify the chain ourselves (Node skips checkServerIdentity when chain verification is off).
  if (!pin) return direct

  return (opts, cb) =>
    direct(opts, (err, socket) => {
      if (err || !socket || opts.protocol !== 'https:') return cb(err as Error, null as never)
      const cert = (socket as TLSSocket).getPeerCertificate(true)
      if (!chainHasFingerprint(cert, pin)) {
        socket.destroy()
        return cb(new KabanosError('TLS', 'Server certificate does not match the pinned SHA-256 fingerprint'), null as never)
      }
      cb(null, socket)
    })
}

export function chainHasFingerprint(cert: PeerCertificate | undefined, pin: string): boolean {
  const seen = new Set<PeerCertificate>()
  let c: PeerCertificate | undefined = cert
  while (c && Object.keys(c).length > 0 && !seen.has(c)) {
    seen.add(c)
    if (c.fingerprint256 && normalizeFingerprint(c.fingerprint256) === pin) return true
    c = (c as PeerCertificate & { issuerCertificate?: PeerCertificate }).issuerCertificate
  }
  return false
}

function joinUrl(base: string, path: string): string {
  return `${base}/${path.trim().replace(/^\/+/, '')}`
}

function isNdjsonPath(path: string): boolean {
  return /(^|\/)(_bulk|_msearch(\/template)?)(\?|$)/.test(path.replace(/^\/+/, ''))
}

function ensureTrailingNewline(body: string, path: string): string {
  return isNdjsonPath(path) && !body.endsWith('\n') ? `${body}\n` : body
}

const gunzipAsync = promisify(gunzip)
const inflateAsync = promisify(inflate)
const brotliAsync = promisify(brotliDecompress)

async function decompress(buf: Buffer, encoding: string): Promise<Buffer> {
  switch (encoding.trim().toLowerCase()) {
    case 'gzip':
      return gunzipAsync(buf)
    case 'deflate':
      return inflateAsync(buf)
    case 'br':
      return brotliAsync(buf)
    default:
      return buf
  }
}

function toKabanosError(err: unknown, userSignal?: AbortSignal): KabanosError {
  if (err instanceof KabanosError) return err
  if (userSignal?.aborted) return new KabanosError('CANCELLED', 'Request cancelled')
  const e = err as Error & { code?: string; cause?: Error & { code?: string } }
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return new KabanosError('NETWORK', 'Request timed out')
  if (e.cause instanceof KabanosError) return e.cause
  // undici.request throws socket errors directly; fetch-style errors wrap them in `cause`.
  const root = e.code ? e : (e.cause ?? e)
  const code = root.code ?? ''
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) {
    return new KabanosError('TLS', `TLS error (${code}): ${root.message}. Add the cluster CA or its fingerprint, or turn off verification.`)
  }
  if (code === 'ECONNREFUSED') return new KabanosError('NETWORK', 'Connection refused — is the cluster running at that address?')
  if (code === 'ENOTFOUND') return new KabanosError('NETWORK', 'Host not found')
  if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') return new KabanosError('NETWORK', 'Request timed out')
  return new KabanosError('NETWORK', root.message)
}

function isIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
}
