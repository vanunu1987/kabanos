export type ExportFormat = 'json' | 'ndjson' | 'csv'

export interface ExportRequest {
  connectionId: string
  target: string
  /** Search body (its query/sort/_source are used). Omit to export the whole index. */
  body?: string
  /** Environment whose {{variables}} the body may use. */
  envId?: string
  format: ExportFormat
  includeMeta: boolean
  limit?: number
  /** Also write `<file>.definition.json` with mapping, settings and aliases. */
  withDefinition?: boolean
  /** Client-chosen id, used for progress events and cancel. */
  exportId: string
}

export interface ExportProgress {
  exportId: string
  count: number
  total?: number
}

export const EXPORT_PROGRESS_CHANNEL = 'kabanos:export-progress'

export const FORMAT_LABEL: Record<ExportFormat, string> = { json: 'JSON (array)', ndjson: 'NDJSON (one doc per line, _bulk-friendly)', csv: 'CSV (flattened fields)' }

/** File name for an export: `listings-v7-2026-10-01.ndjson`. */
export function exportFileName(target: string, format: ExportFormat, suffix = ''): string {
  const day = new Date().toISOString().slice(0, 10)
  return `${target.replace(/[^\w.-]+/g, '_')}${suffix}-${day}.${format}`
}
