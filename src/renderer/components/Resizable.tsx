import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Width of a resizable pane, persisted per key. `side` is the edge the handle sits on:
 * 'right' for a left pane (drag right = wider), 'left' for a right pane (drag left = wider).
 */
export function usePaneWidth(key: string, initial: number, min = 240, max = 1200): [number, (w: number) => void] {
  const storageKey = `kabanos.pane.${key}`
  const [width, setWidth] = useState(() => {
    try {
      // Fall back to the key saved before the Sift → kabanos rename.
      const v = Number(localStorage.getItem(storageKey) ?? localStorage.getItem(`sift.pane.${key}`))
      return v >= min && v <= max ? v : initial
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (w: number) => {
      const c = Math.round(Math.min(max, Math.max(min, w)))
      setWidth(c)
      try {
        localStorage.setItem(storageKey, String(c))
      } catch {
        /* not persisted */
      }
    },
    [storageKey, min, max]
  )
  return [width, set]
}

export function ResizeHandle({ width, onResize, side, label }: { width: number; onResize(w: number): void; side: 'left' | 'right'; label: string }) {
  const start = useRef<{ x: number; w: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    if (!dragging) return
    const move = (e: MouseEvent) => {
      if (!start.current) return
      const dx = e.clientX - start.current.x
      onResize(start.current.w + (side === 'right' ? dx : -dx))
    }
    const up = () => {
      setDragging(false)
      start.current = null
      document.body.classList.remove('resizing')
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [dragging, onResize, side])
  return (
    <div
      className={`resize-handle${dragging ? ' on' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      tabIndex={0}
      onMouseDown={(e) => {
        e.preventDefault()
        start.current = { x: e.clientX, w: width }
        setDragging(true)
        document.body.classList.add('resizing')
      }}
      onDoubleClick={() => onResize(Number.NaN)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 60 : 20
        if (e.key === 'ArrowLeft') onResize(width + (side === 'right' ? -step : step))
        if (e.key === 'ArrowRight') onResize(width + (side === 'right' ? step : -step))
      }}
    />
  )
}
