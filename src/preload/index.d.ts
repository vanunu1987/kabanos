import type { IpcResult } from '../shared/ipc'
import type { RoutineEvent } from '../shared/routines'
import type { ExportProgress } from '../shared/export'

declare global {
  interface Window {
    kabanosIpc: { invoke(method: string, args: unknown[]): Promise<IpcResult<unknown>>; onRoutineEvent(cb: (e: RoutineEvent) => void): () => void; onExportProgress(cb: (p: ExportProgress) => void): () => void; onOpenConnection(cb: (id: string) => void): () => void }
  }
}

export {}
