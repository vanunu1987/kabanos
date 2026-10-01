import type { HttpMethod } from './types'

export interface ParsedRequest {
  title?: string
  method: HttpMethod
  path: string
  /** JSON body (pretty or as written). NDJSON bodies (_bulk, _msearch) keep one object per line. */
  body: string
}

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH'] as const
const REQUEST_LINE = /^\s*(GET|POST|PUT|DELETE|HEAD|PATCH)\s+(\S.*?)\s*$/i

/**
 * Split Kibana Dev Tools console text (an export or a copied buffer) into requests.
 * - A request starts at a `METHOD path` line; everything until the next request line is its body.
 * - `###` / `#` / `//` comment lines directly above a request become its title.
 * - Kibana's triple-quoted strings (`"""…"""`) are converted to JSON strings.
 */
export function parseConsole(text: string): ParsedRequest[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: ParsedRequest[] = []
  let current: { title?: string; method: HttpMethod; path: string; body: string[] } | undefined
  // Comment lines seen while not inside an open body: the next real line decides whether they are
  // the next request's title or part of the current body.
  let pending: string[] = []
  let inTriple = false

  const flush = () => {
    if (!current) return
    out.push({ title: current.title, method: current.method, path: current.path.replace(/^\/+/, ''), body: normaliseBody(current.body.join('\n')) })
    current = undefined
  }
  const insideBody = () => !!current && current.body.join('').trim() !== '' && !bodyComplete(current.body.join('\n'))

  for (const line of lines) {
    if (!inTriple && !insideBody()) {
      const m = REQUEST_LINE.exec(line)
      if (m) {
        flush()
        const title = pending.map((l) => COMMENT.exec(l)?.[1]?.trim() ?? '').filter(Boolean).join(' ')
        current = { title: title || undefined, method: m[1]!.toUpperCase() as HttpMethod, path: m[2]!, body: [] }
        pending = []
        continue
      }
      if (COMMENT.test(line)) {
        pending.push(line)
        continue
      }
      if (line.trim() === '') {
        if (pending.length && !current) pending = []
        if (current) current.body.push(line)
        continue
      }
      // Real body content: buffered comments belong to this body.
      if (current && pending.length) current.body.push(...pending)
      pending = []
    }
    if (current) {
      current.body.push(line)
      if ((line.match(/"""/g) ?? []).length % 2 === 1) inTriple = !inTriple
    }
  }
  flush()
  return out
}

const COMMENT = /^\s*(?:#+|\/\/)\s?(.*)$/

function bodyComplete(body: string): boolean {
  const t = stripComments(body).trim()
  if (!t) return false
  let depth = 0
  let inStr = false
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
  }
  return depth === 0
}

/** Convert `"""multi\nline"""` to a JSON string and trim surrounding blank lines. */
export function normaliseBody(body: string): string {
  const converted = body.replace(/"""([\s\S]*?)"""/g, (_m, inner: string) => JSON.stringify(inner))
  return converted.replace(/^\s*\n/, '').replace(/\s+$/, '')
}

function stripComments(s: string): string {
  return s.replace(/^\s*(#|\/\/).*$/gm, '')
}

/** One editor block's text ⇄ request: first line `METHOD path`, the rest is the body. */
export function parseBlock(text: string): { method: HttpMethod; path: string; body: string } | undefined {
  const nl = text.indexOf('\n')
  const first = (nl === -1 ? text : text.slice(0, nl)).trim()
  const m = REQUEST_LINE.exec(first)
  if (!m) return undefined
  return { method: m[1]!.toUpperCase() as HttpMethod, path: m[2]!.replace(/^\/+/, ''), body: nl === -1 ? '' : text.slice(nl + 1) }
}

export function blockText(r: { method: HttpMethod; path: string; body: string }): string {
  return r.body.trim() ? `${r.method} ${r.path}\n${r.body}` : `${r.method} ${r.path}`
}

/** Shell-style tokenizer for cURL commands (quotes, escapes, line continuations). */
function shellWords(cmd: string): string[] {
  const s = cmd.replace(/\\\r?\n/g, ' ')
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i]
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (c === '\\' && i + 1 < s.length) cur += s[++i]
    else if (/\s/.test(c)) {
      if (cur || has) out.push(cur)
      cur = ''
      has = false
    } else cur += c
  }
  if (cur || has) out.push(cur)
  return out
}

export interface ParsedCurl extends ParsedRequest {
  /** Host part of the URL, so the user can pick the matching connection. */
  baseUrl?: string
  hasCredentials: boolean
}

/** Parse `curl -X POST "https://host:9200/idx/_search?x=1" -H … -d '{…}'`. Credentials are reported, never kept. */
export function parseCurl(cmd: string): ParsedCurl | undefined {
  const w = shellWords(cmd.trim())
  if (w[0] !== 'curl') return undefined
  let method: string | undefined
  let url: string | undefined
  const data: string[] = []
  let creds = false
  for (let i = 1; i < w.length; i++) {
    const a = w[i]!
    if (a === '-X' || a === '--request') method = w[++i]
    else if (a.startsWith('-X') && a.length > 2) method = a.slice(2)
    else if (['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--json'].includes(a)) data.push(w[++i] ?? '')
    else if (a === '-u' || a === '--user') {
      creds = true
      i++
    } else if (a === '-H' || a === '--header') {
      if (/^authorization:/i.test(w[i + 1] ?? '')) creds = true
      i++
    } else if (['-k', '--insecure', '-s', '--silent', '-v', '-i', '--compressed', '-L'].includes(a)) continue
    else if (['-o', '--output', '--cacert', '--cert', '--key', '-E', '--connect-timeout', '-m', '--max-time'].includes(a)) i++
    else if (!a.startsWith('-') && !url) url = a
  }
  if (!url) return undefined
  let parsed: URL
  try {
    parsed = new URL(/^https?:\/\//.test(url) ? url : `http://${url}`)
  } catch {
    return undefined
  }
  if (parsed.username) creds = true
  const body = data.join('\n')
  const m = (method ?? (body ? 'POST' : 'GET')).toUpperCase()
  return {
    method: (METHODS as readonly string[]).includes(m) ? (m as HttpMethod) : 'GET',
    path: (parsed.pathname + parsed.search).replace(/^\/+/, ''),
    body: prettyIfJson(body),
    baseUrl: `${parsed.protocol}//${parsed.host}`,
    hasCredentials: creds
  }
}

function prettyIfJson(s: string): string {
  try {
    return s.trim() ? JSON.stringify(JSON.parse(s), null, 2) : ''
  } catch {
    return s
  }
}

/** Copy as cURL. Credentials are never included — a `-u` placeholder is added when the connection uses them. */
export function toCurl(baseUrl: string, method: HttpMethod, path: string, body: string, opts: { auth?: 'basic' | 'apikey'; username?: string } = {}): string {
  const url = `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
  const parts = [`curl -X${method} '${url.replace(/'/g, "'\\''")}'`]
  if (opts.auth === 'basic') parts.push(`-u '${opts.username ?? 'USER'}:$ES_PASSWORD'`)
  if (opts.auth === 'apikey') parts.push(`-H "Authorization: ApiKey $ES_API_KEY"`)
  if (body.trim()) {
    const ndjson = /(^|\/)(_bulk|_msearch)/.test(path)
    let b = body.trim()
    if (!ndjson) {
      try {
        b = JSON.stringify(JSON.parse(b))
      } catch {
        /* keep as written */
      }
    }
    parts.push(`-H 'Content-Type: application/${ndjson ? 'x-ndjson' : 'json'}'`)
    parts.push(`-d '${(ndjson ? `${b}\n` : b).replace(/'/g, "'\\''")}'`)
  }
  return parts.join(' \\\n  ')
}

/** Paths whose leading `_endpoint` takes an index: a block without an index inherits the default target. */
const INDEX_SCOPED = /^_(search|count|doc|create|update|mapping|settings|update_by_query|delete_by_query|field_caps|validate|explain|termvectors|mtermvectors|mget|msearch|bulk|refresh|flush|forcemerge|cache|alias|aliases|stats|segments|recovery|shard_stores|analyze|rank_eval|eql|pit|search_shards|open|close|rollover|ilm|_plugins)\b/

export function resolvePath(path: string, defaultTarget?: string): string {
  const p = path.replace(/^\/+/, '')
  if (!defaultTarget) return p
  return INDEX_SCOPED.test(p) && !/^_(alias|aliases)$/.test(p.split(/[/?]/)[0]!) ? `${defaultTarget}/${p}` : p
}
