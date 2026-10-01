import type { ReactElement } from 'react'

const base = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export const Icon = {
  search: (s = 14): ReactElement => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base} strokeWidth={1.8}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  ),
  plus: (s = 16): ReactElement => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base} strokeWidth={1.8}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  close: (s = 10): ReactElement => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base} strokeWidth={2.2}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  chevronDown: (s = 12): ReactElement => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base} strokeWidth={2}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  ),
  chevronRight: (s = 12): ReactElement => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base} strokeWidth={2}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
  star: (s = 12, filled = false): ReactElement => (
    <svg width={s} height={s} viewBox="0 0 24 24" {...base} strokeWidth={1.8} fill={filled ? 'currentColor' : 'none'}>
      <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />
    </svg>
  ),
  connections: (): ReactElement => (
    <svg width="20" height="20" viewBox="0 0 24 24" {...base} strokeWidth={1.6}>
      <path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5" />
    </svg>
  ),
  explorer: (): ReactElement => (
    <svg width="20" height="20" viewBox="0 0 24 24" {...base} strokeWidth={1.6}>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </svg>
  ),
  workspace: (): ReactElement => (
    <svg width="20" height="20" viewBox="0 0 24 24" {...base} strokeWidth={1.6}>
      <path d="M8 6l-6 6 6 6M16 6l6 6-6 6" />
    </svg>
  ),
  routines: (): ReactElement => (
    <svg width="20" height="20" viewBox="0 0 24 24" {...base} strokeWidth={1.6}>
      <path d="M4 6h10M4 12h10M4 18h7" />
      <path d="M16 15l5 3-5 3z" />
    </svg>
  ),
  security: (): ReactElement => (
    <svg width="20" height="20" viewBox="0 0 24 24" {...base} strokeWidth={1.6}>
      <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  ),
  settings: (): ReactElement => (
    <svg width="20" height="20" viewBox="0 0 24 24" {...base} strokeWidth={1.6}>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </svg>
  )
}
