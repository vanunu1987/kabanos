import { readFile, writeFile } from 'node:fs/promises'
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { IPC_CHANNEL, type IpcResult } from '@shared/ipc'
import { classifyRequest } from '@shared/destructive'
import type { ConnectionManager } from '../connections/ConnectionManager'
import { exportDocuments, writeDefinition, writeHits } from '../export/exporter'
import { EXPORT_PROGRESS_CHANNEL, exportFileName } from '@shared/export'
import type { MetadataService } from '../metadata/MetadataService'
import type { LibraryStore } from '../store/LibraryStore'
import type { RoutineRunner } from '../routines/RoutineRunner'
import type { RoutineStore } from '../routines/RoutineStore'
import type { SecurityService } from '../security/SecurityService'
import { substituteVars } from '@shared/library'
import { KabanosError } from '../errors'
import * as s from './schemas'

type Handler = (args: unknown[], event: IpcMainInvokeEvent) => Promise<unknown> | unknown

/** Validate positional args with zod before they reach any main-process code. */
function typed<T extends z.ZodType[]>(schemas: [...T], fn: (...args: { [K in keyof T]: z.infer<T[K]> }) => unknown): Handler {
  return (args) => {
    const parsed = schemas.map((schema, i) => schema.parse(args[i]))
    return fn(...(parsed as { [K in keyof T]: z.infer<T[K]> }))
  }
}

export function registerIpc(connections: ConnectionManager, metadata: MetadataService, library: LibraryStore, routines: RoutineStore, runner: RoutineRunner, security: SecurityService): void {
  const exports = new Map<string, AbortController>()
  const handlers: Record<string, Handler> = {
    'connections.list': () => connections.list(),
    'connections.save': typed([s.connectionInput], (input) => connections.save(input)),
    'connections.remove': typed([z.string()], (id) => {
      metadata.invalidate(id)
      return connections.remove(id)
    }),
    'connections.test': typed([s.testTarget], (target) => connections.test(target)),
    'connections.connect': typed([z.string()], (id) => connections.connect(id)),

    'connections.pickCaFile': async (_args, event) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const res = await dialog.showOpenDialog(win!, {
        title: 'Choose CA certificate',
        properties: ['openFile'],
        filters: [{ name: 'Certificates', extensions: ['pem', 'crt', 'cer'] }, { name: 'All files', extensions: ['*'] }]
      })
      return res.canceled ? null : (res.filePaths[0] ?? null)
    },

    'connections.exportToFile': typed([z.array(z.string()).optional()], async (ids) => {
      const res = await dialog.showSaveDialog({ title: 'Export connections', defaultPath: 'kabanos-connections.json' })
      if (res.canceled || !res.filePath) return null
      const items = connections.exportConnections(ids)
      await writeFile(res.filePath, JSON.stringify({ kabanos: 'connections', version: 1, connections: items }, null, 2))
      return { count: items.length, path: res.filePath }
    }),

    'connections.importFromFile': async () => {
      const res = await dialog.showOpenDialog({ title: 'Import connections', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
      const file = res.filePaths[0]
      if (res.canceled || !file) return null
      const parsed = s.exportedConnections.safeParse(JSON.parse(await readFile(file, 'utf8')))
      if (!parsed.success) throw new KabanosError('VALIDATION', 'That file is not a kabanos (or Sift) connections export')
      return { imported: connections.importConnections(parsed.data.connections) }
    },

    'cluster.request': typed([s.clusterRequest], async (req) => {
      const res = await connections.request(req)
      // Any successful write may have changed indices, aliases or templates.
      if (res.status < 400 && classifyRequest(req.method, req.path, req.body).safety !== 'read') metadata.invalidate(req.connectionId)
      return res
    }),
    'cluster.cancel': typed([z.string()], (opaqueId) => connections.cancel(opaqueId)),

    /** Run a request from the workspace / index view: {{vars}} resolved here (secrets never reach the renderer), history recorded. */
    'cluster.run': typed([s.runRequest], async ({ queryId, envId, ...req }) => {
      const vars = library.resolveVars(envId)
      const resolved = { ...req, path: substituteVars(req.path, vars), body: req.body === undefined ? undefined : substituteVars(req.body, vars) }
      const unresolved = /\{\{\s*[\w.-]+\s*\}\}/.exec(`${resolved.path} ${resolved.body ?? ''}`)
      if (unresolved) throw new KabanosError('VALIDATION', `Unknown variable ${unresolved[0]} — define it in the active environment`)
      // History stores the request as written (with placeholders), never resolved secret values.
      const entry = { connectionId: req.connectionId, queryId, method: req.method, path: req.path, body: req.body ?? '' }
      try {
        const res = await connections.request(resolved)
        library.recordRun({ ...entry, status: res.status, ms: res.ms, bytes: res.bytes, response: res.body })
        if (res.status < 400 && classifyRequest(req.method, resolved.path, resolved.body).safety !== 'read') metadata.invalidate(req.connectionId)
        return { ...res, resolvedPath: resolved.path }
      } catch (err) {
        if (!(err instanceof KabanosError && (err.code === 'NOT_CONFIRMED' || err.code === 'CANCELLED'))) library.recordRun({ ...entry, error: (err as Error).message })
        throw err
      }
    }),

    'library.folders': () => library.folders(),
    'library.createFolder': typed([z.string().max(200), z.string().nullable().optional()], (name, parentId) => library.createFolder(name, parentId ?? null)),
    'library.updateFolder': typed([z.string(), z.object({ name: z.string().max(200).optional(), parentId: z.string().nullable().optional() })], (id, patch) => library.updateFolder(id, patch)),
    'library.removeFolder': typed([z.string()], (id) => library.removeFolder(id)),
    'library.queries': typed([s.libraryFilter.optional(), z.string().max(500).optional()], (filter, search) => library.queries(filter, search)),
    'library.query': typed([z.string()], (id) => library.query(id)),
    'library.createQuery': typed([s.queryPatch.extend({ method: s.queryPatch.shape.method.unwrap(), path: z.string().max(8192) })], (q) => library.createQuery(q)),
    'library.updateQuery': typed([z.string(), s.queryPatch], (id, patch) => library.updateQuery(id, patch)),
    'library.removeQuery': typed([z.string()], (id) => library.removeQuery(id)),
    'library.tags': () => library.tags(),
    'library.history': typed([z.string().max(500).optional(), z.number().int().max(2000).optional()], (search, limit) => library.history(search, limit)),
    'library.responses': typed([z.string()], (id) => library.responses(id)),

    'workspace.tabs': () => library.ensureTab(),
    'workspace.createTab': typed([z.string().max(100)], (name) => library.createTab(name)),
    'workspace.updateTab': typed([z.string(), z.object({ name: z.string().max(100).optional(), defaultTarget: z.string().nullable().optional(), envId: z.string().nullable().optional() })], (id, patch) => library.updateTab(id, patch)),
    'workspace.removeTab': typed([z.string()], (id) => library.removeTab(id)),
    'workspace.blocks': typed([z.string()], (tabId) => library.blocks(tabId)),
    'workspace.addBlock': typed([z.string(), z.string(), z.string().optional()], (tabId, queryId, after) => library.addBlock(tabId, queryId, after)),
    'workspace.removeBlock': typed([z.string(), z.string()], (tabId, queryId) => library.removeBlock(tabId, queryId)),
    'workspace.setCollapsed': typed([z.string(), z.array(z.string()), z.boolean()], (tabId, ids, c) => library.setCollapsed(tabId, ids, c)),
    'workspace.reorder': typed([z.string(), z.array(z.string())], (tabId, ids) => library.reorder(tabId, ids)),

    'routines.list': () => routines.list(),
    'routines.save': typed([s.routine], (r) => routines.save(r)),
    'routines.remove': typed([z.string()], (id) => routines.remove(id)),
    'routines.runs': typed([z.string()], (id) => routines.runs(id)),
    'routines.start': typed([z.string(), z.object({ dryRun: z.boolean().optional(), stepThrough: z.boolean().optional() })], (id, opts) => runner.start(routines.get(id), opts)),
    'routines.resume': typed([z.string()], (runId) => runner.resume(runId)),
    'routines.stop': typed([z.string()], (runId) => runner.stop(runId)),

    'security.status': typed([z.string()], (id) => security.status(id)),
    'security.users': typed([z.string()], (id) => security.users(id)),
    'security.saveUser': typed([z.string(), s.secUser, z.boolean()], (id, u, create) => security.saveUser(id, u, create)),
    'security.setPassword': typed([z.string(), z.string(), z.string().min(6).max(1000)], (id, u, p) => security.setPassword(id, u, p)),
    'security.setEnabled': typed([z.string(), z.string(), z.boolean()], (id, u, e) => security.setEnabled(id, u, e)),
    'security.deleteUser': typed([z.string(), z.string()], (id, u) => security.deleteUser(id, u)),
    'security.roles': typed([z.string()], (id) => security.roles(id)),
    'security.saveRole': typed([z.string(), s.secRole], (id, r) => security.saveRole(id, r)),
    'security.deleteRole': typed([z.string(), z.string()], (id, n) => security.deleteRole(id, n)),
    'security.builtinPrivileges': typed([z.string()], (id) => security.builtinPrivileges(id)),
    'security.roleMappings': typed([z.string()], (id) => security.roleMappings(id)),
    'security.saveRoleMapping': typed([z.string(), s.roleMapping], (id, m) => security.saveRoleMapping(id, m)),
    'security.deleteRoleMapping': typed([z.string(), z.string()], (id, n) => security.deleteRoleMapping(id, n)),
    'security.apiKeys': typed([z.string()], (id) => security.apiKeys(id)),
    'security.createApiKey': typed([z.string(), z.string().min(1).max(200), z.string().max(20).optional(), z.unknown().optional()], (id, n, e, rd) => security.createApiKey(id, n, e, rd)),
    'security.invalidateApiKey': typed([z.string(), z.string()], (id, k) => security.invalidateApiKey(id, k)),
    'security.tenants': typed([z.string()], (id) => security.tenants(id)),
    'security.saveTenant': typed([z.string(), z.object({ name: z.string().min(1).max(200), description: z.string().max(1000).optional(), reserved: z.boolean() })], (id, t) => security.saveTenant(id, t)),
    'security.deleteTenant': typed([z.string(), z.string()], (id, n) => security.deleteTenant(id, n)),

    'app.info': () => ({ version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, dataDir: app.getPath('userData'), historyCount: library.historyCount() }),
    'app.revealData': () => shell.openPath(app.getPath('userData')).then(() => undefined),
    'library.clearHistory': () => library.clearHistory(),

    'env.list': () => library.environments(),
    'env.save': typed([s.environment], (env) => library.saveEnvironment(env)),
    'env.remove': typed([z.string()], (id) => library.removeEnvironment(id)),

    /** Ask for a file, then stream every matching document to it; progress arrives as events. */
    'export.toFile': async (args, event) => {
      const opts = s.exportRequest.parse(args[0])
      const res = await dialog.showSaveDialog({ title: 'Export documents', defaultPath: exportFileName(opts.target, opts.format) })
      if (res.canceled || !res.filePath) return null
      const vars = library.resolveVars(opts.envId)
      const abort = new AbortController()
      exports.set(opts.exportId, abort)
      try {
        const out = await exportDocuments((req) => connections.request(req), {
          connectionId: opts.connectionId,
          target: opts.target,
          body: opts.body === undefined ? undefined : substituteVars(opts.body, vars),
          format: opts.format,
          includeMeta: opts.includeMeta,
          limit: opts.limit,
          file: res.filePath,
          signal: abort.signal,
          onProgress: (p) => event.sender.send(EXPORT_PROGRESS_CHANNEL, { exportId: opts.exportId, ...p })
        })
        let definitionPath: string | undefined
        if (opts.withDefinition) {
          definitionPath = res.filePath.replace(/\.(json|ndjson|csv)$/i, '') + '.definition.json'
          await writeDefinition((req) => connections.request(req), opts.connectionId, opts.target, definitionPath)
        }
        return { ...out, path: res.filePath, definitionPath }
      } finally {
        exports.delete(opts.exportId)
      }
    },
    'export.cancel': typed([z.string()], (exportId) => exports.get(exportId)?.abort()),
    /** The results page already in the renderer (no extra cluster round-trip). */
    'export.writeHits': typed(
      [z.object({ target: z.string(), hits: z.array(z.object({ _id: z.string(), _index: z.string(), _source: z.record(z.string(), z.unknown()).optional() })).max(100_000), format: z.enum(['json', 'ndjson', 'csv']), includeMeta: z.boolean() })],
      async ({ target, hits, format, includeMeta }) => {
        const res = await dialog.showSaveDialog({ title: 'Export results', defaultPath: exportFileName(target, format, '-page') })
        if (res.canceled || !res.filePath) return null
        return { count: await writeHits(res.filePath, hits, format, includeMeta), path: res.filePath }
      }
    ),

    'meta.tree': typed([z.string(), z.boolean().optional()], (id, force) => metadata.tree(id, force)),
    'meta.index': typed([z.string(), z.string().min(1)], (id, name) => metadata.index(id, name)),
    'meta.alias': typed([z.string(), z.string().min(1)], (id, name) => metadata.alias(id, name)),
    'meta.fields': typed([z.string(), z.string().min(1)], (id, target) => metadata.fields(id, target))
  }

  ipcMain.handle(IPC_CHANNEL, async (event, method: unknown, args: unknown): Promise<IpcResult<unknown>> => {
    const handler = typeof method === 'string' ? handlers[method] : undefined
    if (!handler) return { ok: false, error: { code: 'NOT_FOUND', message: `Unknown IPC method ${String(method)}` } }
    try {
      return { ok: true, value: await handler(Array.isArray(args) ? args : [], event) }
    } catch (err) {
      if (err instanceof z.ZodError) return { ok: false, error: { code: 'VALIDATION', message: z.prettifyError(err) } }
      const code = err instanceof KabanosError ? err.code : 'INTERNAL'
      return { ok: false, error: { code, message: (err as Error).message } }
    }
  })
}
