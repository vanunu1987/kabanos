import { useEffect, type ReactNode } from 'react'

export function Modal({ title, children, onClose, actions, width = 460 }: { title: string; children: ReactNode; onClose(): void; actions: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal aria-label={title} style={{ width }}>
        <h2>{title}</h2>
        <div className="modal-body">{children}</div>
        <div className="actions">{actions}</div>
      </div>
    </div>
  )
}
