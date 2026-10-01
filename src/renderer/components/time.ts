/** "just now", "5m ago", "yesterday", "3d ago", or a date. */
export function relTime(iso: string | undefined): string {
  if (!iso) return 'never run'
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.round(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 30) return `${d}d ago`
  return new Date(iso).toISOString().slice(0, 10)
}
