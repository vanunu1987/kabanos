/**
 * Integration tests against docker-compose clusters. Run with:
 *   pnpm clusters:up && KABANOS_IT=1 pnpm test
 */
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { detectEngine } from '@shared/detectEngine'
import type { ConnectionConfig } from '@shared/types'
import { ClusterClient } from '../cluster/ClusterClient'

const enabled = process.env.KABANOS_IT === '1'

function cfg(url: string, over: Partial<ConnectionConfig>): ConnectionConfig {
  return {
    id: 'it',
    name: 'it',
    folder: 'Local',
    color: 'green',
    favorite: false,
    isProd: false,
    readOnly: false,
    engine: 'auto',
    url,
    authKind: 'basic',
    tls: { verify: true },
    timeoutMs: 10000,
    compression: true,
    headers: {},
    ...over
  }
}

async function root(client: ClusterClient) {
  const res = await client.request({ method: 'GET', path: '/' })
  expect(res.status).toBe(200)
  return detectEngine(JSON.parse(res.body), res.headers)
}

describe.skipIf(!enabled)('docker clusters', () => {
  it('es8: self-signed TLS trusted via CA fingerprint pin', async () => {
    const fp = execFileSync('docker', ['exec', 'kabanos-es8', 'openssl', 'x509', '-fingerprint', '-sha256', '-noout', '-in', '/usr/share/elasticsearch/config/certs/http_ca.crt']).toString()
    const client = new ClusterClient(cfg('https://localhost:9200', { username: 'elastic', tls: { verify: true, fingerprint: fp } }), { password: 'sift-dev-pass' })
    expect(await root(client)).toMatchObject({ engine: 'elasticsearch', major: 8 })
    const health = await client.request({ method: 'GET', path: '_cluster/health' })
    expect(JSON.parse(health.body).status).toMatch(/green|yellow/)
    await client.close()
  })

  it('es8: rejects the self-signed chain without a pin', async () => {
    const client = new ClusterClient(cfg('https://localhost:9200', { username: 'elastic' }), { password: 'sift-dev-pass' })
    await expect(client.request({ method: 'GET', path: '/' })).rejects.toMatchObject({ code: 'TLS' })
    await client.close()
  })

  it('es9: basic auth over http, wrong password → 401', async () => {
    const ok = new ClusterClient(cfg('http://localhost:9202', { username: 'elastic' }), { password: 'sift-dev-pass' })
    expect(await root(ok)).toMatchObject({ engine: 'elasticsearch', major: 9 })
    const bad = new ClusterClient(cfg('http://localhost:9202', { username: 'elastic' }), { password: 'nope' })
    expect((await bad.request({ method: 'GET', path: '/' })).status).toBe(401)
    await Promise.all([ok.close(), bad.close()])
  })

  it('es9: API key auth, GET-with-body search and gzip', async () => {
    const admin = new ClusterClient(cfg('http://localhost:9202', { username: 'elastic' }), { password: 'sift-dev-pass' })
    const key = JSON.parse((await admin.request({ method: 'POST', path: '_security/api_key', body: '{"name":"kabanos-it","expiration":"1h"}' })).body)
    const client = new ClusterClient(cfg('http://localhost:9202', { authKind: 'apikey' }), { apiKey: key.encoded })
    await client.request({ method: 'PUT', path: 'kabanos-it/_doc/1?refresh=true', body: '{"title":"hello"}' })
    const res = await client.request({ method: 'GET', path: 'kabanos-it/_search', body: '{"query":{"match":{"title":"hello"}}}' })
    expect(JSON.parse(res.body).hits.total.value).toBe(1)
    await client.request({ method: 'DELETE', path: 'kabanos-it' })
    await Promise.all([admin.close(), client.close()])
  })

  it('os2: detected as OpenSearch through the security plugin', async () => {
    const client = new ClusterClient(cfg('https://localhost:9201', { username: 'admin', tls: { verify: false } }), { password: 'Sift-dev-Pass_42' })
    expect(await root(client)).toMatchObject({ engine: 'opensearch', major: 2 })
    await client.close()
  })
})
