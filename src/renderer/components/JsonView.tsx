import { Fragment, useMemo, type ReactNode } from 'react'

/** Pretty-printed, syntax-coloured JSON (read-only). Large payloads use Monaco from milestone 4. */
export function JsonView({ value, className, maxHeight }: { value: unknown; className?: string; maxHeight?: number | string }) {
  const nodes = useMemo(() => highlight(typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'undefined'), [value])
  return (
    <pre className={`json-view mono${className ? ` ${className}` : ''}`} style={{ maxHeight }}>
      {nodes}
    </pre>
  )
}

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],])/g

export function highlight(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(TOKEN)) {
    if (m.index! > last) out.push(text.slice(last, m.index))
    const [all, str, colon, number, literal, punct] = m
    if (str) {
      out.push(
        <span key={i++} className={colon ? 'tk' : 'ts'}>
          {str}
        </span>
      )
      if (colon) out.push(<Fragment key={i++}>{colon}</Fragment>)
    } else if (number) out.push(<span key={i++} className="tn">{number}</span>)
    else if (literal) out.push(<span key={i++} className="tl">{literal}</span>)
    else if (punct) out.push(<span key={i++} className="tp">{punct}</span>)
    else out.push(all)
    last = m.index! + all.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
