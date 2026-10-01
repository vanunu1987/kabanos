import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import { ConnectionManager, type ConfirmWrite } from '../connections/ConnectionManager'
import { SecretStore, type Cipher } from '../connections/secrets'
import { openDb, type Db } from '../store/db'

/** Reversible stand-in for safeStorage, so tests can prove nothing is stored in plain text. */
const fakeCipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decrypt: (b) => Buffer.from(b.toString().slice(4), 'base64').toString()
}

function input(over: Partial<ConnectionInput['config']> = {}, secrets?: ConnectionInput['secrets']): ConnectionInput {
  return {
    config: {
      name: 'Search · Production',
      folder: 'Production',
      color: 'red',
      favorite: false,
      isProd: true,
      readOnly: false,
      engine: 'auto',
      url: 'https://elastic:s3cr%40t@127.0.0.1:1',
      authKind: 'url',
      tls: { verify: true },
      timeoutMs: 2000,
      compression: true,
      headers: {},
      ...over
    },
    secrets
  }
}

describe('ConnectionManager', () => {
  let db: Db
  let secrets: SecretStore
  let confirm: ReturnType<typeof vi.fn<ConfirmWrite>>
  let mgr: ConnectionManager

  beforeEach(() => {
    db = openDb(':memory:')
    secrets = new SecretStore(db, fakeCipher)
    confirm = vi.fn<ConfirmWrite>(async () => false)
    mgr = new ConnectionManager(db, secrets, confirm)
  })

  it('stores the URL without credentials and the password only encrypted', () => {
    const saved = mgr.save(input())
    expect(saved.url).toBe('https://127.0.0.1:1')
    expect(saved.username).toBe('elastic')
    expect(saved.hasPassword).toBe(true)
    expect(JSON.stringify(saved)).not.toContain('s3cr')

    const row = db.prepare('SELECT * FROM connections').get()
    expect(JSON.stringify(row)).not.toContain('s3cr')
    const blob = (db.prepare('SELECT blob FROM secrets').get() as { blob: Buffer }).blob
    expect(blob.toString()).not.toContain('s3cr@t')
    expect(secrets.get(saved.id)).toEqual({ password: 's3cr@t' })
  })

  it('keeps the stored secret when an edit omits it, and clears it on empty string', () => {
    const saved = mgr.save(input())
    mgr.save(input({ id: saved.id, url: 'https://elastic@127.0.0.1:1', name: 'Renamed' }))
    expect(secrets.get(saved.id).password).toBe('s3cr@t')
    expect(mgr.get(saved.id).name).toBe('Renamed')
    mgr.save(input({ id: saved.id, url: 'https://127.0.0.1:1', authKind: 'basic', username: 'elastic' }, { password: '' }))
    expect(secrets.get(saved.id).password).toBeUndefined()
  })

  it('refuses to store secrets when the keychain is unavailable', () => {
    const noKeychain = new ConnectionManager(db, new SecretStore(db, { ...fakeCipher, isAvailable: () => false }), confirm)
    expect(() => noKeychain.save(input())).toThrow(/Keychain/)
    expect(noKeychain.list()).toHaveLength(0)
  })

  it('exports without ids, secrets or detection data', () => {
    mgr.save(input({ detected: { engine: 'elasticsearch', version: '8.15.2', major: 8, flavor: 'default', label: 'ES 8.15' } }))
    const [exported] = mgr.exportConnections()
    expect(exported).not.toHaveProperty('id')
    expect(exported).not.toHaveProperty('hasPassword')
    expect(exported).not.toHaveProperty('detected')
    expect(JSON.stringify(exported)).not.toContain('s3cr')
    expect(mgr.importConnections([exported!])).toBe(1)
    expect(mgr.list()).toHaveLength(2)
  })

  it('blocks writes on read-only connections without asking', async () => {
    const saved = mgr.save(input({ readOnly: true }))
    await expect(mgr.request({ connectionId: saved.id, method: 'DELETE', path: 'listings' })).rejects.toMatchObject({ code: 'READ_ONLY' })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('asks before writes on production and stops when declined', async () => {
    const saved = mgr.save(input())
    await expect(mgr.request({ connectionId: saved.id, method: 'POST', path: 'listings/_delete_by_query', body: '{}' })).rejects.toMatchObject({
      code: 'NOT_CONFIRMED'
    })
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0]![2]).toMatchObject({ safety: 'danger' })
  })

  it('does not ask for reads on production', async () => {
    const saved = mgr.save(input())
    // Port 1 refuses connections, so a read gets as far as the network.
    await expect(mgr.request({ connectionId: saved.id, method: 'POST', path: 'listings/_search', body: '{}' })).rejects.toMatchObject({ code: 'NETWORK' })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('removes secrets together with the connection', () => {
    const saved = mgr.save(input())
    mgr.remove(saved.id)
    expect(db.prepare('SELECT COUNT(*) AS n FROM secrets').get()).toEqual({ n: 0 })
  })
})
