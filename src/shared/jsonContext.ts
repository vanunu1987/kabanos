/**
 * Where is the cursor inside a (possibly incomplete) JSON request body?
 * Error-tolerant: works on partial input like `{"query":{"term":{"ci`.
 */
export interface JsonCursorContext {
  /** Keys from the root down to the container holding the cursor, e.g. ['query','bool','filter','term']. */
  path: string[]
  /** 'key' — typing an object key; 'value' — a value after `:` or an array item. */
  position: 'key' | 'value'
  /** For 'value': the key whose value is being typed (or the array's key for array items). */
  key?: string
  /** True when the cursor is inside an open string literal. */
  inString: boolean
  /** Text typed so far for the current token (without the opening quote). */
  partial: string
  /** The container type around the cursor. */
  container: 'object' | 'array' | 'root'
}

interface Frame {
  type: 'object' | 'array'
  key?: string
  pendingKey?: string
  expectingKey: boolean
}

export function jsonContextAt(textBefore: string): JsonCursorContext {
  const stack: Frame[] = []
  let inString = false
  let current = ''
  let lastString: string | undefined
  let i = 0
  const n = textBefore.length

  while (i < n) {
    const ch = textBefore[i]!
    if (inString) {
      if (ch === '\\') {
        current += textBefore[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === '"') {
        inString = false
        lastString = current
      } else current += ch
      i++
      continue
    }
    // Comments (Kibana console bodies allow them).
    if (ch === '/' && textBefore[i + 1] === '/') {
      while (i < n && textBefore[i] !== '\n') i++
      continue
    }
    if (ch === '/' && textBefore[i + 1] === '*') {
      const end = textBefore.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    const top = stack[stack.length - 1]
    switch (ch) {
      case '"':
        inString = true
        current = ''
        break
      case ':':
        if (top?.type === 'object') {
          top.pendingKey = lastString
          top.expectingKey = false
        }
        lastString = undefined
        break
      case ',':
        if (top?.type === 'object') {
          top.expectingKey = true
          top.pendingKey = undefined
        }
        lastString = undefined
        break
      case '{':
      case '[': {
        // Containers inside arrays have no key of their own: `filter: [ {term…} ]` → path …filter, term.
        const key = top?.type === 'object' ? top.pendingKey : undefined
        stack.push({ type: ch === '{' ? 'object' : 'array', key, expectingKey: ch === '{' })
        lastString = undefined
        break
      }
      case '}':
      case ']':
        stack.pop()
        lastString = undefined
        break
    }
    i++
  }

  const top = stack[stack.length - 1]
  const path = stack.map((f) => f.key).filter((k): k is string => k !== undefined)
  // `path` includes the key of the top container itself; for value positions inside an object the key is pendingKey.
  const partial = inString ? current : (/[\w.@-]*$/.exec(textBefore)?.[0] ?? '')
  if (!top) return { path: [], position: 'value', inString, partial, container: 'root' }
  if (top.type === 'array') return { path, position: 'value', key: top.key, inString, partial, container: 'array' }
  if (top.expectingKey) return { path, position: 'key', inString, partial, container: 'object' }
  return { path, position: 'value', key: top.pendingKey, inString, partial, container: 'object' }
}
