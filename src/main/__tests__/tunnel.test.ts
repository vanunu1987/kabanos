import { connect as netConnect, createServer as createNetServer, type AddressInfo } from 'node:net'
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Server as SshServer, utils } from 'ssh2'
import type { ConnectionConfig } from '@shared/types'
import { ClusterClient } from '../cluster/ClusterClient'

const listen = (s: { listen: (port: number, host: string, cb: () => void) => unknown; address(): unknown }) =>
  new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)))

function cfg(url: string, over: Partial<ConnectionConfig>): ConnectionConfig {
  return { id: 't', name: 't', folder: 'Local', color: 'green', favorite: false, isProd: false, readOnly: false, engine: 'auto', url, authKind: 'none', tls: { verify: true }, timeoutMs: 5000, compression: true, headers: {}, ...over }
}

describe('SSH tunnel', () => {
  let http: Server
  let httpPort: number
  let ssh: SshServer
  let sshPort: number
  const forwarded: string[] = []
  let lastHost: string | undefined

  beforeAll(async () => {
    http = createHttpServer((req: IncomingMessage, res) => {
      lastHost = req.headers.host
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"via":"tunnel"}')
    })
    httpPort = await listen(http)

    const hostKey = utils.generateKeyPairSync('ed25519').private
    ssh = new SshServer({ hostKeys: [hostKey] }, (client) => {
      client
        .on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === 'tunnel' && ctx.password === 'pw' ? ctx.accept() : ctx.reject(['password'])))
        .on('ready', () => {
          client.on('tcpip', (accept, _reject, info) => {
            forwarded.push(`${info.destIP}:${info.destPort}`)
            const stream = accept()
            // The "remote" network: everything resolves to this machine.
            const sock = netConnect(info.destPort, '127.0.0.1')
            stream.pipe(sock).pipe(stream)
          })
        })
        .on('error', () => undefined)
    })
    sshPort = await listen(ssh)
  })
  afterAll(() => {
    http.close()
    ssh.close()
  })

  it('forwards requests through the SSH server, keeping the real Host header', async () => {
    const c = new ClusterClient(cfg(`http://es-internal.corp:${httpPort}`, { ssh: { host: '127.0.0.1', port: sshPort, username: 'tunnel', auth: 'password' } }), { sshPassword: 'pw' })
    const res = await c.request({ method: 'GET', path: '/' })
    expect(JSON.parse(res.body)).toEqual({ via: 'tunnel' })
    expect(forwarded).toContain(`es-internal.corp:${httpPort}`)
    expect(lastHost).toBe(`es-internal.corp:${httpPort}`)
    // Second request reuses the open tunnel.
    await c.request({ method: 'GET', path: '/_cluster/health' })
    await c.close()
  })

  it('reports SSH authentication failures clearly', async () => {
    const c = new ClusterClient(cfg(`http://es-internal.corp:${httpPort}`, { ssh: { host: '127.0.0.1', port: sshPort, username: 'tunnel', auth: 'password' } }), { sshPassword: 'wrong' })
    await expect(c.request({ method: 'GET', path: '/' })).rejects.toMatchObject({ message: expect.stringMatching(/SSH tunnel to 127\.0\.0\.1/) })
    await c.close()
  })
})

describe('HTTP proxy', () => {
  it('sends requests through the proxy', async () => {
    const seen: string[] = []
    // A minimal forward proxy: absolute-form request lines for http targets.
    const proxy = createHttpServer((req, res) => {
      seen.push(`${req.method} ${req.url}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"via":"proxy"}')
    })
    // undici's ProxyAgent tunnels with CONNECT; answer it by piping to the target ourselves.
    proxy.on('connect', (req, sock) => {
      seen.push(`CONNECT ${req.url}`)
      const [host, port] = String(req.url).split(':')
      const upstream = netConnect(Number(port), host === 'cluster.local' ? '127.0.0.1' : host!, () => {
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.pipe(sock).pipe(upstream)
      })
    })
    const proxyPort = await listen(proxy)
    const target = createNetServer((s) => s.once('data', () => s.end('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 18\r\n\r\n{"via":"connect"}\n')))
    const targetPort = await listen(target)

    const c = new ClusterClient(cfg(`http://cluster.local:${targetPort}`, { proxy: `http://127.0.0.1:${proxyPort}` }), {})
    const res = await c.request({ method: 'GET', path: '/' })
    expect(res.status).toBe(200)
    expect(seen.join(' ')).toMatch(/cluster\.local/)
    await c.close()
    proxy.close()
    target.close()
  })

  it('rejects proxy + SSH and proxy + pinning', () => {
    expect(() => new ClusterClient(cfg('http://x', { proxy: 'http://p:1', ssh: { host: 'h', port: 22, username: 'u', auth: 'agent' } }), {})).toThrow(/either an SSH tunnel or a proxy/)
    expect(() => new ClusterClient(cfg('https://x', { proxy: 'http://p:1', tls: { verify: true, fingerprint: 'aa' } }), {})).toThrow(/pinning/)
  })
})
