import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface MenuItem {
  label: string
  onSelect(): void
  danger?: boolean
  disabled?: boolean
}

/** A button that opens a small dropdown of actions. */
export function Menu({ items, label, children, buttonClass = 'square-btn tall', align = 'right' }: { items: Array<MenuItem | 'sep'>; label: string; children: ReactNode; buttonClass?: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [open])
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className={buttonClass} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {children}
      </button>
      {open && (
        <div className={`menu${align === 'left' ? ' left' : ''}`} role="menu">
          {items.map((it, i) =>
            it === 'sep' ? (
              <div key={i} className="menu-sep" />
            ) : (
              <button
                key={it.label}
                role="menuitem"
                className={it.danger ? 'danger' : ''}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false)
                  it.onSelect()
                }}
              >
                {it.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  )
}
