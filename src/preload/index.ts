import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNEL, type IpcResult } from '../shared/ipc'
import { ROUTINE_EVENT_CHANNEL, type RoutineEvent } from '../shared/routines'
import { EXPORT_PROGRESS_CHANNEL, type ExportProgress } from '../shared/export'

// Custom error properties don't survive contextBridge, so return the result envelope
// and let the renderer's typed client (src/renderer/api.ts) unwrap it.
contextBridge.exposeInMainWorld('kabanosIpc', {
  invoke: (method: string, args: unknown[]): Promise<IpcResult<unknown>> => ipcRenderer.invoke(IPC_CHANNEL, method, args),
  /** Routine progress pushed from main. Returns an unsubscribe function. */
  onRoutineEvent: (cb: (e: RoutineEvent) => void): (() => void) => {
    const listener = (_: unknown, e: RoutineEvent) => cb(e)
    ipcRenderer.on(ROUTINE_EVENT_CHANNEL, listener)
    return () => ipcRenderer.removeListener(ROUTINE_EVENT_CHANNEL, listener)
  },
  /** The app menu asked to show a screen (e.g. Settings… ⌘,). */
  onNavigate: (cb: (view: string) => void): (() => void) => {
    const listener = (_: unknown, view: string) => cb(view)
    ipcRenderer.on('kabanos:navigate', listener)
    return () => ipcRenderer.removeListener('kabanos:navigate', listener)
  },
  /** The menu-bar icon asked to open a connection. */
  onOpenConnection: (cb: (id: string) => void): (() => void) => {
    const listener = (_: unknown, id: string) => cb(id)
    ipcRenderer.on('kabanos:open-connection', listener)
    return () => ipcRenderer.removeListener('kabanos:open-connection', listener)
  },
  onExportProgress: (cb: (p: ExportProgress) => void): (() => void) => {
    const listener = (_: unknown, p: ExportProgress) => cb(p)
    ipcRenderer.on(EXPORT_PROGRESS_CHANNEL, listener)
    return () => ipcRenderer.removeListener(EXPORT_PROGRESS_CHANNEL, listener)
  }
})
