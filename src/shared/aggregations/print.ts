import type { StageInfo } from './compiler'

export type JsonPath = Array<string | number>

export interface PrintedLine {
  text: string
  path: JsonPath
  /** A closing `}` / `]` line. */
  closing?: boolean
}

const isContainer = (v: unknown): v is object => !!v && typeof v === 'object'

function compact(v: unknown): string {
  if (Array.isArray(v)) return v.length ? `[${v.map(compact).join(', ')}]` : '[]'
  if (isContainer(v)) {
    const e = Object.entries(v).filter(([, x]) => x !== undefined)
    return e.length ? `{ ${e.map(([k, x]) => `${JSON.stringify(k)}: ${compact(x)}`).join(', ')} }` : '{}'
  }
  return JSON.stringify(v) ?? 'null'
}

/**
 * Pretty-print JSON the way the mockup does: small objects stay on one line, big ones break.
 * Every line remembers the JSON path it prints, so the JSON view can show which stage produced it.
 */
export function printJson(value: unknown, width = 120): { text: string; lines: PrintedLine[] } {
  const lines: PrintedLine[] = []
  const rec = (v: unknown, indent: number, path: JsonPath, prefix: string, comma: string) => {
    const pad = ' '.repeat(indent)
    const c = compact(v)
    if (!isContainer(v) || pad.length + prefix.length + c.length + comma.length <= width || c === '{}' || c === '[]') {
      lines.push({ text: `${pad}${prefix}${c}${comma}`, path })
      return
    }
    if (Array.isArray(v)) {
      lines.push({ text: `${pad}${prefix}[`, path })
      v.forEach((x, i) => rec(x, indent + 2, [...path, i], '', i < v.length - 1 ? ',' : ''))
      lines.push({ text: `${pad}]${comma}`, path, closing: true })
      return
    }
    const entries = Object.entries(v).filter(([, x]) => x !== undefined)
    lines.push({ text: `${pad}${prefix}{`, path })
    entries.forEach(([k, x], i) => rec(x, indent + 2, [...path, k], `${JSON.stringify(k)}: `, i < entries.length - 1 ? ',' : ''))
    lines.push({ text: `${pad}}${comma}`, path, closing: true })
  }
  rec(value, 0, [], '', '')
  return { text: lines.map((l) => l.text).join('\n'), lines }
}

const isPrefix = (p: JsonPath, of: JsonPath) => p.length <= of.length && p.every((k, i) => k === of[i])

/** Which stage (index) a printed line belongs to: the deepest stage path containing it, else the only stage under it. */
export function stageOfPath(path: JsonPath, stages: StageInfo[]): number | undefined {
  // An `aggs` container holds the next stages, not the stage that owns it.
  if (path[path.length - 1] === 'aggs') return undefined
  let best: { index: number; depth: number } | undefined
  for (const s of stages)
    for (const p of s.paths) if (isPrefix(p, path) && (!best || p.length > best.depth)) best = { index: s.index, depth: p.length }
  if (best) return best.index
  const under = new Set(stages.filter((s) => s.paths.some((p) => path.length > 0 && isPrefix(path, p))).map((s) => s.index))
  return under.size === 1 ? [...under][0] : undefined
}
