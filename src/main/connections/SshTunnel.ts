import { readFileSync } from 'node:fs'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { Client, type ConnectConfig } from 'ssh2'
import type { ConnectionSecrets, SshTunnelOptions } from '@shared/types'
import { KabanosError } from '../errors'

/**
 * Local port forward over SSH: 127.0.0.1:<random> → (ssh host) → target host:port.
 * Opened lazily on first use, re-opened after the SSH session drops.
 */
export class SshTunnel {
  private client?: Client
  private server?: Server
  private ready?: Promise<number>

  constructor(
    private readonly opts: SshTunnelOptions,
    private readonly secrets: Pick<ConnectionSecrets, 'sshPassword' | 'sshPassphrase'>,
    private readonly target: { host: string; port: number }
  ) {}

  /** Local port to connect to (opens the tunnel if needed). */
  port(): Promise<number> {
    this.ready ??= this.open().catch((err: unknown) => {
      this.ready = undefined
      throw err
    })
    return this.ready
  }

  private open(): Promise<number> {
    return new Promise((resolve, reject) => {
      const client = new Client()
      const cfg: ConnectConfig = { host: this.opts.host, port: this.opts.port, username: this.opts.username, readyTimeout: 15_000, keepaliveInterval: 15_000 }
      if (this.opts.auth === 'password') cfg.password = this.secrets.sshPassword
      if (this.opts.auth === 'agent') cfg.agent = process.env.SSH_AUTH_SOCK
      if (this.opts.auth === 'key') {
        const path = (this.opts.keyPath ?? '~/.ssh/id_ed25519').replace(/^~(?=\/)/, homedir())
        try {
          cfg.privateKey = readFileSync(path)
        } catch {
          return reject(new KabanosError('VALIDATION', `Can't read SSH key ${path}`))
        }
        if (this.secrets.sshPassphrase) cfg.passphrase = this.secrets.sshPassphrase
      }
      if (this.opts.auth === 'agent' && !cfg.agent) return reject(new KabanosError('VALIDATION', 'SSH agent auth needs SSH_AUTH_SOCK (start ssh-agent and add your key)'))

      client
        .on('ready', () => {
          const server = createServer((sock: Socket) => {
            client.forwardOut('127.0.0.1', sock.remotePort ?? 0, this.target.host, this.target.port, (err, stream) => {
              if (err) return sock.destroy(err)
              sock.pipe(stream).pipe(sock)
              stream.on('error', () => sock.destroy())
              sock.on('error', () => stream.destroy())
            })
          })
          server.on('error', reject)
          server.listen(0, '127.0.0.1', () => {
            this.client = client
            this.server = server
            resolve((server.address() as AddressInfo).port)
          })
        })
        .on('error', (err) => {
          this.teardown()
          reject(new KabanosError('NETWORK', `SSH tunnel to ${this.opts.host}: ${err.message}`))
        })
        .on('close', () => this.teardown())
        .connect(cfg)
    })
  }

  private teardown(): void {
    this.server?.close()
    this.server = undefined
    this.client = undefined
    this.ready = undefined
  }

  close(): void {
    this.client?.end()
    this.teardown()
  }
}
