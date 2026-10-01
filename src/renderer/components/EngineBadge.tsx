import type { ConnectionConfig } from '@shared/types'

export function EngineBadge({ conn, large }: { conn: Pick<ConnectionConfig, 'detected' | 'engine'>; large?: boolean }) {
  const d = conn.detected
  const kind = d?.engine ?? (conn.engine === 'auto' ? undefined : conn.engine)
  const cls = kind === 'opensearch' ? 'os' : kind === 'elasticsearch' ? 'es' : 'unknown'
  const label = d?.label ?? (kind === 'opensearch' ? 'OS' : kind === 'elasticsearch' ? 'ES' : '—')
  return <span className={`badge ${cls}${large ? ' lg' : ''}`}>{label}</span>
}
