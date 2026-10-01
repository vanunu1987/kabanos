/**
 * SecurityService against the docker clusters (ES 9 + OpenSearch 2). Run with KABANOS_IT=1.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { detectEngine } from '@shared/detectEngine'
import type { ConnectionConfig } from '@shared/types'
import { ClusterClient } from '../cluster/ClusterClient'
import { SecurityService } from '../security/SecurityService'

const enabled = process.env.KABANOS_IT === '1'

function cfg(id: string, url: string, username: string, verify = true): ConnectionConfig {
  return { id, name: id, folder: 'Local', color: 'green', favorite: false, isProd: false, readOnly: false, engine: 'auto', url, authKind: 'basic', username, tls: { verify }, timeoutMs: 10000, compression: true, headers: {} }
}

describe.skipIf(!enabled)('SecurityService on docker clusters', () => {
  const clients = new Map<string, ClusterClient>()
  const configs = new Map<string, ConnectionConfig>()
  const svc = new SecurityService(
    (req) => clients.get(req.connectionId)!.request(req),
    (id) => configs.get(id)!
  )
  const add = async (c: ConnectionConfig, password: string) => {
    const client = new ClusterClient(c, { password })
    const root = await client.request({ method: 'GET', path: '/' })
    configs.set(c.id, { ...c, detected: detectEngine(JSON.parse(root.body), root.headers) })
    clients.set(c.id, client)
  }
  afterAll(async () => {
    await Promise.all([...clients.values()].map((c) => c.close()))
  })

  for (const [id, url, user, pass, verify] of [
    ['es9', 'http://localhost:9202', 'elastic', 'sift-dev-pass', true],
    ['os2', 'https://localhost:9201', 'admin', 'Sift-dev-Pass_42', false]
  ] as const) {
    it(`${id}: status, role + user lifecycle with FLS/DLS`, async () => {
      await add(cfg(id, url, user, verify), pass)
      expect(await svc.status(id)).toMatchObject({ enabled: true, user })

      const flsRole = {
        name: 'kabanos_it_reader',
        cluster: [id === 'es9' ? 'monitor' : 'cluster_monitor'],
        indices: [{ names: ['listings*'], privileges: ['read'], except: ['seller_phone'], query: '{"term":{"status":"active"}}' }],
        reserved: false
      }
      if (id === 'es9') {
        // FLS/DLS needs a Platinum/Enterprise license on Elasticsearch; the cluster's reason is surfaced as-is.
        await expect(svc.saveRole(id, flsRole)).rejects.toThrow(/license is non-compliant for \[field and document level security\]/)
        await svc.saveRole(id, { ...flsRole, indices: [{ names: ['listings*'], privileges: ['read'] }] })
      } else {
        await svc.saveRole(id, flsRole)
      }
      const roles = await svc.roles(id)
      const saved = roles.find((r) => r.name === 'kabanos_it_reader')!
      expect(saved.indices[0]).toMatchObject({ names: ['listings*'], privileges: ['read'] })
      if (id === 'os2') {
        expect(saved.indices[0]).toMatchObject({ except: ['seller_phone'] })
        expect(JSON.parse(saved.indices[0]!.query!)).toEqual({ term: { status: 'active' } })
      }
      expect(roles.some((r) => r.reserved)).toBe(true)

      await svc.saveUser(id, { username: 'kabanos_it_user', password: 'kabanos-it-Pass_77!', fullName: 'kabanos IT', roles: ['kabanos_it_reader'] }, true)
      const u = (await svc.users(id)).find((x) => x.username === 'kabanos_it_user')!
      expect(u).toMatchObject({ roles: ['kabanos_it_reader'], fullName: 'kabanos IT', enabled: true, reserved: false })

      // Editing without a password keeps it — the user can still authenticate.
      await svc.saveUser(id, { username: 'kabanos_it_user', fullName: 'kabanos IT 2', roles: ['kabanos_it_reader'] }, false)
      const asUser = new ClusterClient(cfg('tmp', url, 'kabanos_it_user', verify), { password: 'kabanos-it-Pass_77!' })
      expect((await asUser.request({ method: 'GET', path: id === 'es9' ? '_security/_authenticate' : '_plugins/_security/authinfo' })).status).toBe(200)
      await svc.setPassword(id, 'kabanos_it_user', 'kabanos-it-Pass_88!')
      expect((await asUser.request({ method: 'GET', path: '/' })).status).toBe(401)
      await asUser.close()

      if (id === 'es9') {
        await svc.setEnabled(id, 'kabanos_it_user', false)
        expect((await svc.users(id)).find((x) => x.username === 'kabanos_it_user')?.enabled).toBe(false)
      }
      await svc.deleteUser(id, 'kabanos_it_user')
      await svc.deleteRole(id, 'kabanos_it_reader')
      expect((await svc.users(id)).some((x) => x.username === 'kabanos_it_user')).toBe(false)
    })
  }

  it('es9: role mappings and API keys', async () => {
    await svc.saveRoleMapping('es9', { name: 'kabanos_it_map', roles: ['viewer'], enabled: true, rules: { field: { 'realm.name': 'saml1' } }, reserved: false })
    expect((await svc.roleMappings('es9')).find((m) => m.name === 'kabanos_it_map')).toMatchObject({ roles: ['viewer'], enabled: true })
    await svc.deleteRoleMapping('es9', 'kabanos_it_map')

    const key = await svc.createApiKey('es9', 'kabanos-it-key', '1h')
    expect(key.encoded.length).toBeGreaterThan(20)
    expect((await svc.apiKeys('es9')).find((k) => k.id === key.id)).toMatchObject({ name: 'kabanos-it-key', invalidated: false })
    await svc.invalidateApiKey('es9', key.id)
    expect((await svc.apiKeys('es9')).find((k) => k.id === key.id)?.invalidated).toBe(true)
    expect((await svc.builtinPrivileges('es9'))?.index).toContain('read')
  })

  it('os2: role mappings and tenants', async () => {
    await svc.saveTenant('os2', { name: 'kabanos_it_tenant', description: 'e2e', reserved: false })
    expect((await svc.tenants('os2')).find((t) => t.name === 'kabanos_it_tenant')).toMatchObject({ description: 'e2e' })
    await svc.deleteTenant('os2', 'kabanos_it_tenant')
    await svc.saveRole('os2', { name: 'kabanos_it_map_role', cluster: [], indices: [], reserved: false })
    await svc.saveRoleMapping('os2', { name: 'kabanos_it_map_role', roles: ['kabanos_it_map_role'], enabled: true, users: ['bob'], backendRoles: ['devs'], reserved: false })
    expect((await svc.roleMappings('os2')).find((m) => m.name === 'kabanos_it_map_role')).toMatchObject({ users: ['bob'], backendRoles: ['devs'] })
    await svc.deleteRoleMapping('os2', 'kabanos_it_map_role')
    await svc.deleteRole('os2', 'kabanos_it_map_role')
  })
})
