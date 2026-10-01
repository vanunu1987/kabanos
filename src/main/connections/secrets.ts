import type { ConnectionSecrets } from '@shared/types'
import type { Db } from '../store/db'

/** Symmetric encryption backed by the OS keychain (Electron safeStorage in the app, a fake in tests). */
export interface Cipher {
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(blob: Buffer): string
}

type SecretKind = keyof ConnectionSecrets

export class SecretStore {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher
  ) {}

  get(connectionId: string): ConnectionSecrets {
    const rows = this.db
      .prepare('SELECT kind, blob FROM secrets WHERE connection_id = ?')
      .all(connectionId) as Array<{ kind: SecretKind; blob: Buffer }>
    const out: ConnectionSecrets = {}
    for (const r of rows) out[r.kind] = this.cipher.decrypt(r.blob)
    return out
  }

  has(connectionId: string): { hasPassword: boolean; hasApiKey: boolean; hasSshPassword: boolean; hasSshPassphrase: boolean } {
    const kinds = (
      this.db.prepare('SELECT kind FROM secrets WHERE connection_id = ?').all(connectionId) as Array<{ kind: SecretKind }>
    ).map((r) => r.kind)
    return { hasPassword: kinds.includes('password'), hasApiKey: kinds.includes('apiKey'), hasSshPassword: kinds.includes('sshPassword'), hasSshPassphrase: kinds.includes('sshPassphrase') }
  }

  /** `undefined` keeps the stored value, `''` deletes it. */
  apply(connectionId: string, secrets: ConnectionSecrets | undefined): void {
    if (!secrets) return
    for (const kind of ['password', 'apiKey', 'sshPassword', 'sshPassphrase'] as const) {
      const value = secrets[kind]
      if (value === undefined) continue
      if (value === '') {
        this.db.prepare('DELETE FROM secrets WHERE connection_id = ? AND kind = ?').run(connectionId, kind)
        continue
      }
      if (!this.cipher.isAvailable()) {
        throw new Error('The macOS Keychain is not available — refusing to store credentials unencrypted')
      }
      this.db
        .prepare(
          `INSERT INTO secrets (connection_id, kind, blob) VALUES (?, ?, ?)
           ON CONFLICT(connection_id, kind) DO UPDATE SET blob = excluded.blob`
        )
        .run(connectionId, kind, this.cipher.encrypt(value))
    }
  }
}
