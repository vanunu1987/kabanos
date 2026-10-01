import { z } from 'zod'

const color = z.enum(['amber', 'red', 'teal', 'blue', 'green', 'grey'])
const method = z.enum(['GET', 'POST', 'PUT', 'HEAD', 'DELETE', 'PATCH'])

const detected = z.object({
  engine: z.enum(['elasticsearch', 'opensearch']),
  version: z.string(),
  major: z.number(),
  flavor: z.enum(['default', 'serverless', 'aws']),
  label: z.string(),
  clusterName: z.string().optional()
})

export const connectionConfig = z.object({
  id: z.string().optional(),
  name: z.string().max(200),
  folder: z.string().max(100),
  color,
  favorite: z.boolean(),
  isProd: z.boolean(),
  readOnly: z.boolean(),
  engine: z.enum(['auto', 'elasticsearch', 'opensearch']),
  url: z.string().max(2048),
  authKind: z.enum(['url', 'basic', 'apikey', 'sigv4', 'cloudid', 'none']),
  username: z.string().max(256).optional(),
  cloudId: z.string().max(4096).optional(),
  aws: z.object({ region: z.string(), service: z.enum(['es', 'aoss']), profile: z.string().optional() }).optional(),
  tls: z.object({ verify: z.boolean(), caPath: z.string().optional(), fingerprint: z.string().optional() }),
  ssh: z.object({ host: z.string().min(1).max(500), port: z.number().int().min(1).max(65535), username: z.string().min(1).max(200), auth: z.enum(['password', 'key', 'agent']), keyPath: z.string().max(2000).optional() }).optional(),
  proxy: z.string().max(2000).optional(),
  timeoutMs: z.number().int().min(1000).max(3_600_000),
  compression: z.boolean(),
  headers: z.record(z.string(), z.string()),
  detected: detected.optional()
})

export const connectionInput = z.object({
  config: connectionConfig,
  secrets: z.object({ password: z.string().optional(), apiKey: z.string().optional(), sshPassword: z.string().optional(), sshPassphrase: z.string().optional() }).optional()
})

export const testTarget = z.union([z.object({ input: connectionInput }), z.object({ id: z.string() })])

export const clusterRequest = z.object({
  connectionId: z.string(),
  method,
  path: z.string().max(8192),
  body: z.string().optional(),
  opaqueId: z.string().max(128).optional()
})

// Exports from before the rename carry `sift: 'connections'`.
export const exportedConnections = z.object({
  kabanos: z.literal('connections').optional(),
  sift: z.literal('connections').optional(),
  version: z.literal(1),
  connections: z.array(connectionConfig.omit({ id: true, detected: true }))
})

export const runRequest = clusterRequest.extend({
  queryId: z.string().optional(),
  envId: z.string().optional()
})

export const queryPatch = z.object({
  folderId: z.string().nullable().optional(),
  title: z.string().max(500).optional(),
  method: method.optional(),
  path: z.string().max(8192).optional(),
  body: z.string().max(5_000_000).optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
  pinned: z.boolean().optional(),
  pipeline: z.string().max(2_000_000).optional()
})

export const libraryFilter = z.union([
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('pinned') }),
  z.object({ kind: z.literal('recent') }),
  z.object({ kind: z.literal('tag'), tag: z.string() })
])

export const environment = z.object({
  id: z.string().optional(),
  name: z.string().max(100),
  vars: z.array(z.object({ key: z.string().max(200), value: z.string().max(100_000), secret: z.boolean() })).max(500)
})

const step = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(200),
  method,
  path: z.string().max(8192),
  body: z.string().max(5_000_000).optional(),
  queryRef: z.string().optional(),
  connectionId: z.string().optional(),
  capture: z.record(z.string(), z.string().max(2000)).optional(),
  assert: z.string().max(2000).optional(),
  onFail: z.enum(['stop', 'continue']),
  when: z.string().max(2000).optional(),
  repeat: z.object({ until: z.string().max(2000), everySec: z.number().min(0).max(3600), timeoutMin: z.number().min(0).max(24 * 60) }).optional(),
  confirm: z.boolean().optional()
})

export const routine = z.object({
  id: z.string().optional(),
  name: z.string().max(200),
  defaultConnectionId: z.string().optional(),
  variables: z.record(z.string(), z.string().max(100_000)),
  steps: z.array(step).max(200)
})

const nameList = z.array(z.string().max(500)).max(500)

export const secUser = z.object({
  username: z.string().min(1).max(500),
  password: z.string().max(1000).optional(),
  fullName: z.string().max(500).optional(),
  email: z.string().max(500).optional(),
  roles: nameList,
  backendRoles: nameList.optional(),
  enabled: z.boolean().optional()
})

export const secRole = z.object({
  name: z.string().min(1).max(500),
  cluster: nameList,
  indices: z
    .array(
      z.object({
        names: nameList.min(1),
        privileges: nameList,
        grant: nameList.optional(),
        except: nameList.optional(),
        query: z.string().max(100_000).optional(),
        maskedFields: nameList.optional()
      })
    )
    .max(200),
  extra: z.record(z.string(), z.unknown()).optional(),
  reserved: z.boolean()
})

export const roleMapping = z.object({
  name: z.string().min(1).max(500),
  roles: nameList,
  enabled: z.boolean(),
  rules: z.unknown().optional(),
  users: nameList.optional(),
  backendRoles: nameList.optional(),
  hosts: nameList.optional(),
  reserved: z.boolean()
})

export const exportRequest = z.object({
  connectionId: z.string(),
  target: z.string().min(1).max(2000),
  body: z.string().max(5_000_000).optional(),
  envId: z.string().optional(),
  format: z.enum(['json', 'ndjson', 'csv']),
  includeMeta: z.boolean(),
  limit: z.number().int().positive().optional(),
  withDefinition: z.boolean().optional(),
  exportId: z.string().min(1).max(100)
})
