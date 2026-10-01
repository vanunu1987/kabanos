/**
 * Auto-indent for request bodies (⌘I). Valid JSON is pretty-printed; NDJSON stays one object per line;
 * anything else (comments, Kibana triple-quoted strings, half-typed JSON) is re-indented line by line
 * without changing its content.
 */
export function formatBody(body: string, indent = '  '): string {
  const trimmed = body.trim()
  if (!trimmed) return ''
  try {
    return JSON.stringify(JSON.parse(trimmed), null, indent)
  } catch {
    /* not plain JSON */
  }
  const lines = trimmed.split('\n').filter((l) => l.trim())
  if (lines.length > 1 && lines.every((l) => isJson(l.trim()))) return lines.map((l) => JSON.stringify(JSON.parse(l))).join('\n')
  return reindent(trimmed, indent)
}

/** Format a console block: `METHOD path` line + body. */
export function formatBlock(text: string, indent = '  '): string {
  const nl = text.indexOf('\n')
  const first = (nl === -1 ? text : text.slice(0, nl)).trim().replace(/\s+/, ' ')
  const body = nl === -1 ? '' : formatBody(text.slice(nl + 1), indent)
  return body ? `${first}\n${body}` : first
}

function isJson(s: string): boolean {
  try {
    JSON.parse(s)
    return true
  } catch {
    return false
  }
}

/** Indent each line by bracket depth, leaving strings, triple-quoted blocks and comments alone. */
export function reindent(text: string, indent = '  '): string {
  const out: string[] = []
  let depth = 0
  let inTriple = false
  for (const raw of text.split('\n')) {
    if (inTriple) {
      out.push(raw)
      if (countTriples(raw) % 2 === 1) inTriple = false
      const after = raw.slice(raw.lastIndexOf('"""') + 3)
      depth = Math.max(0, depth + netDepth(after))
      continue
    }
    const line = raw.trim()
    if (!line) {
      out.push('')
      continue
    }
    const leadingClosers = /^[}\]]+/.exec(line)?.[0].length ?? 0
    out.push(indent.repeat(Math.max(0, depth - leadingClosers)) + line)
    const triples = countTriples(line)
    if (triples % 2 === 1) {
      inTriple = true
      depth = Math.max(0, depth + netDepth(line.slice(0, line.indexOf('"""'))))
      continue
    }
    depth = Math.max(0, depth + netDepth(line))
  }
  return out.join('\n')
}

function countTriples(s: string): number {
  return (s.match(/"""/g) ?? []).length
}

/** Net bracket depth change of a line, ignoring strings and trailing comments. */
function netDepth(line: string): number {
  let d = 0
  let inStr = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      if (line.startsWith('"""', i)) {
        const end = line.indexOf('"""', i + 3)
        if (end === -1) return d
        i = end + 2
        continue
      }
      inStr = true
    } else if (c === '/' && line[i + 1] === '/') break
    else if (c === '#') break
    else if (c === '{' || c === '[') d++
    else if (c === '}' || c === ']') d--
  }
  return d
}
