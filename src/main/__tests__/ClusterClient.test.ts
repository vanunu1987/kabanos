import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '@shared/types'
import { buildAuthHeader, ClusterClient } from '../cluster/ClusterClient'

type Seen = { method?: string; url?: string; headers: IncomingMessage['headers']; body: string }

function config(url: string, over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: 't',
    name: 't',
    folder: 'Local',
    color: 'amber',
    favorite: false,
    isProd: false,
    readOnly: false,
    engine: 'auto',
    url,
    authKind: 'none',
    tls: { verify: true },
    timeoutMs: 5000,
    compression: true,
    headers: {},
    ...over
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
}

describe('ClusterClient over HTTP', () => {
  let server: Server
  let base: string
  let last: Seen

  beforeAll(async () => {
    server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        last = { method: req.method, url: req.url, headers: req.headers, body }
        if (req.url === '/slow') return // never answers — used for cancel
        if (req.url === '/gz') {
          res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
          return res.end(gzipSync(JSON.stringify({ zipped: true })))
        }
        res.writeHead(200, { 'content-type': 'application/json', 'x-elastic-product': 'Elasticsearch' })
        res.end(JSON.stringify({ ok: true }))
      })
    })
    base = `http://127.0.0.1:${await listen(server)}`
  })
  afterAll(() => server.close())

  it('sends GET with a body as-is (Kibana console semantics)', async () => {
    const c = new ClusterClient(config(base), {})
    const res = await c.request({ method: 'GET', path: '/listings/_search', body: '{"size":0}' })
    expect(res.status).toBe(200)
    expect(last).toMatchObject({ method: 'GET', url: '/listings/_search', body: '{"size":0}' })
    expect(last.headers['content-type']).toBe('application/json')
    expect(res.opaqueId).toMatch(/^kabanos-/)
    expect(last.headers['x-opaque-id']).toBe(res.opaqueId)
    expect(res.headers['x-elastic-product']).toBe('Elasticsearch')
    await c.close()
  })

  it('uses NDJSON for _bulk and appends the trailing newline', async () => {
    const c = new ClusterClient(config(base), {})
    await c.request({ method: 'POST', path: '_bulk', body: '{"index":{"_index":"a"}}\n{"x":1}' })
    expect(last.headers['content-type']).toBe('application/x-ndjson')
    expect(last.body.endsWith('\n')).toBe(true)
    await c.close()
  })

  it('decompresses gzip responses', async () => {
    const c = new ClusterClient(config(base), {})
    const res = await c.request({ method: 'GET', path: 'gz' })
    expect(JSON.parse(res.body)).toEqual({ zipped: true })
    await c.close()
  })

  it('sends basic auth and custom headers, keeping a path prefix', async () => {
    const c = new ClusterClient(config(`${base}/es`, { authKind: 'url', username: 'elastic', headers: { 'X-Tenant': 'search' } }), { password: 'p@ss' })
    await c.request({ method: 'GET', path: '_cluster/health' })
    expect(last.url).toBe('/es/_cluster/health')
    expect(last.headers.authorization).toBe(`Basic ${Buffer.from('elastic:p@ss').toString('base64')}`)
    expect(last.headers['x-tenant']).toBe('search')
    await c.close()
  })

  it('cancels an in-flight request', async () => {
    const c = new ClusterClient(config(base), {})
    const ctrl = new AbortController()
    const p = c.request({ method: 'GET', path: 'slow', signal: ctrl.signal })
    setTimeout(() => ctrl.abort(), 50)
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' })
    await c.close()
  })

  it('reports connection refused clearly', async () => {
    const c = new ClusterClient(config('http://127.0.0.1:1'), {})
    await expect(c.request({ method: 'GET', path: '/' })).rejects.toMatchObject({ code: 'NETWORK', message: expect.stringMatching(/refused/) })
    await c.close()
  })
})

describe('buildAuthHeader', () => {
  const cfg = (over: Partial<ConnectionConfig>) => config('http://x', over)
  it('encodes id:key API keys and passes pre-encoded keys through', () => {
    expect(buildAuthHeader(cfg({ authKind: 'apikey' }), { apiKey: 'id1:key1' })).toBe(`ApiKey ${Buffer.from('id1:key1').toString('base64')}`)
    expect(buildAuthHeader(cfg({ authKind: 'apikey' }), { apiKey: 'aWQxOmtleTE=' })).toBe('ApiKey aWQxOmtleTE=')
  })
  it('prefers the API key for Cloud ID and falls back to basic', () => {
    expect(buildAuthHeader(cfg({ authKind: 'cloudid', username: 'u' }), { apiKey: 'k', password: 'p' })).toBe('ApiKey k')
    expect(buildAuthHeader(cfg({ authKind: 'cloudid', username: 'u' }), { password: 'p' })).toMatch(/^Basic /)
  })
  it('sends nothing for none', () => {
    expect(buildAuthHeader(cfg({ authKind: 'none', username: 'u' }), { password: 'p' })).toBeUndefined()
  })
})

describe('ClusterClient TLS', () => {
  let server: Server
  let base: string
  let caPath: string
  let caFingerprint: string

  beforeAll(async () => {
    // A throwaway CA + server cert, like Elasticsearch 8's auto-generated http_ca.crt.
    const dir = mkdtempSync(join(tmpdir(), 'kabanos-tls-'))
    const run = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' })
    run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=kabanos Test CA'])
    run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=localhost'])
    writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n')
    run(['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.crt', '-days', '1', '-extfile', 'ext.cnf'])
    caPath = join(dir, 'ca.crt')
    caFingerprint = new X509Certificate(readFileSync(caPath)).fingerprint256

    server = createHttpsServer(
      { key: readFileSync(join(dir, 'srv.key')), cert: Buffer.concat([readFileSync(join(dir, 'srv.crt')), readFileSync(caPath)]) },
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"tls":true}')
      }
    )
    base = `https://127.0.0.1:${await listen(server)}`
  })
  afterAll(() => server.close())

  it('rejects an untrusted self-signed chain by default', async () => {
    const c = new ClusterClient(config(base), {})
    await expect(c.request({ method: 'GET', path: '/' })).rejects.toMatchObject({ code: 'TLS' })
    await c.close()
  })

  it('trusts the chain with a custom CA file', async () => {
    const c = new ClusterClient(config(base, { tls: { verify: true, caPath } }), {})
    expect((await c.request({ method: 'GET', path: '/' })).status).toBe(200)
    await c.close()
  })

  it('accepts a matching CA fingerprint pin without a CA file', async () => {
    const c = new ClusterClient(config(base, { tls: { verify: true, fingerprint: caFingerprint } }), {})
    expect((await c.request({ method: 'GET', path: '/' })).status).toBe(200)
    await c.close()
  })

  it('rejects a wrong fingerprint even with verification off', async () => {
    const wrong = createHash('sha256').update('nope').digest('hex')
    const c = new ClusterClient(config(base, { tls: { verify: false, fingerprint: wrong } }), {})
    await expect(c.request({ method: 'GET', path: '/' })).rejects.toMatchObject({ code: 'TLS', message: expect.stringMatching(/fingerprint/) })
    await c.close()
  })

  it('allows self-signed when verification is off', async () => {
    const c = new ClusterClient(config(base, { tls: { verify: false } }), {})
    expect((await c.request({ method: 'GET', path: '/' })).status).toBe(200)
    await c.close()
  })
})

describe('ClusterClient with AWS SigV4', () => {
  it('signs every request (Authorization, x-amz-date, payload hash) without storing credentials', async () => {
    let seen: IncomingMessage['headers'] = {}
    const server = createHttpServer((req, res) => {
      seen = req.headers
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    const port = await listen(server)
    const { SigV4Signer } = await import('../cluster/sigv4')
    const signer = new SigV4Signer({ region: 'eu-west-1', service: 'aoss', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' } })
    const c = new ClusterClient(config(`http://127.0.0.1:${port}`, { authKind: 'sigv4', aws: { region: 'eu-west-1', service: 'aoss' } }), {}, signer)
    await c.request({ method: 'POST', path: 'logs/_search?size=1', body: '{"query":{"match_all":{}}}' })
    expect(seen.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/aoss\/aws4_request, SignedHeaders=[^,]*host[^,]*, Signature=[0-9a-f]{64}$/)
    expect(seen['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/)
    expect(seen['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/)
    await c.close()
    server.close()
  })
})
