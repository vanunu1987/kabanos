/**
 * The kabanos mark: three sticks of kabanos, offset like a sorted result list in motion.
 * Small sizes use brand/kabanos-icon-small.svg geometry; `speedLines` adds the master icon's motion lines.
 */
export function BrandMark({ size = 22, speedLines = false }: { size?: number; speedLines?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" className="brand-mark">
      <rect x="6" y="6" width="88" height="88" rx={speedLines ? 20 : 22} fill="#16191F" stroke={speedLines ? '#2F3540' : 'none'} strokeWidth="0.5" />
      {speedLines ? (
        <g fill="none" strokeLinecap="round">
          <path d="M22 34h8M16 50h8M12 66h4" stroke="#5A6272" strokeWidth="3.5" />
          <path d="M40 34h38" stroke="#F2B544" strokeWidth="11" />
          <path d="M32 50h38" stroke="#F7CF7E" strokeWidth="11" />
          <path d="M24 66h38" stroke="#4DC4D6" strokeWidth="11" />
        </g>
      ) : (
        <g fill="none" strokeLinecap="round">
          <path d="M40 32h38" stroke="#F2B544" strokeWidth="14" />
          <path d="M32 50h38" stroke="#F7CF7E" strokeWidth="14" />
          <path d="M24 68h38" stroke="#4DC4D6" strokeWidth="14" />
        </g>
      )}
    </svg>
  )
}

/** Lowercase wordmark (SPEC §10: Bricolage Grotesque 800, tracking −0.8px). */
export function Wordmark({ size = 15 }: { size?: number }) {
  return (
    <span className="wordmark" style={{ fontSize: size }}>
      kabanos
    </span>
  )
}
