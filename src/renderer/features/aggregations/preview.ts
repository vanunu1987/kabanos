import { useEffect, useMemo, useRef, useState } from 'react'
import { compile, fieldsUsed, type CompileOptions, type Compiled } from '@shared/aggregations/compiler'
import type { Stage } from '@shared/aggregations/model'
import type { FieldInfo } from '@shared/meta'
import type { ConnectionConfig } from '@shared/types'
import { api } from '../../api'
import { reason } from '../explorer/indexActions'

export interface Preview {
  status: 'loading' | 'done' | 'error' | 'off'
  compiled: Compiled
  response?: Record<string, unknown>
  error?: string
  ms?: number
  /** Numbers come from a sample (shown with ≈). */
  sampled?: boolean
}

const TTL = 60_000
const DEBOUNCE = 400
const CONCURRENCY = 2
const cache = new Map<string, { at: number; response: Record<string, unknown>; ms: number }>()

export type Sampling = CompileOptions['sample']

/** How to sample a fast preview: random_sampler on ES ≥ 8.2 (aiming at ~100k docs), sampler elsewhere. */
export function samplingFor(conn: ConnectionConfig, docs: number | undefined): { sample: Sampling; note: string } {
  const d = conn.detected
  const es = (d?.engine ?? conn.engine) !== 'opensearch'
  const [maj = 0, min = 0] = (d?.version ?? '').split('.').map(Number)
  if (es && (maj > 8 || (maj === 8 && min >= 2))) {
    if (!docs || docs <= 200_000) return { sample: undefined, note: 'Small index — previews are exact' }
    const p = Math.min(0.5, 100_000 / docs)
    return { sample: { kind: 'random', probability: Number(p.toPrecision(2)) }, note: `random_sampler · ${(p * 100).toPrecision(2)}% of documents` }
  }
  return { sample: { kind: 'sampler', shardSize: 10_000 }, note: `${es ? 'Elasticsearch < 8.2' : 'OpenSearch'}: sampler (top 10,000 docs per shard)` }
}

const hash = (connectionId: string, target: string, req: unknown) => `${connectionId}\u0000${target}\u0000${JSON.stringify(req)}`

/**
 * Per-stage live previews (AGGREGATIONS.md §6): each enabled stage runs `compile(pipeline, k)` with preview caps,
 * debounced 400 ms, two at a time, cancelling requests whose stage changed again, cached for 60 s.
 */
export function usePreviews(opts: { conn: ConnectionConfig; target: string; stages: Stage[]; fields?: FieldInfo[]; live: boolean; sample: Sampling; nonce: number }): Record<string, Preview> {
  const { conn, target, stages, fields, live, sample, nonce } = opts
  const [results, setResults] = useState<Record<string, Preview>>({})
  const inflight = useRef(new Map<string, string>()) // key → opaqueId
  const wanted = useRef(new Map<string, string>()) // stageId → key
  const ranNonce = useRef(live ? -1 : nonce)
  const sourceFields = useMemo(() => fieldsUsed(stages), [stages])

  // Compiling is cheap and synchronous; requests are what we debounce.
  const jobs = useMemo(
    () =>
      stages.map((s, k) => {
        const compiled = compile({ stages }, { upto: k, preview: true, sample, fields, sourceFields })
        return { id: s.id, enabled: s.enabled, compiled, errors: compiled.stages[k]!.errors, key: hash(conn.id, target, compiled.request) }
      }),
    [stages, sample, fields, sourceFields, conn.id, target]
  )

  useEffect(() => {
    const now = Date.now()
    // Show cached results and errors right away; mark the rest as loading (keeping the stale response visible).
    setResults((prev) => {
      const next: Record<string, Preview> = {}
      for (const j of jobs) {
        if (!j.enabled) continue
        const hit = cache.get(j.key)
        if (j.errors.length) next[j.id] = { status: 'error', compiled: j.compiled, error: j.errors.join(' ') }
        else if (hit && now - hit.at < TTL) next[j.id] = { status: 'done', compiled: j.compiled, response: hit.response, ms: hit.ms, sampled: !!sample }
        else next[j.id] = { ...(prev[j.id] ?? {}), status: live || prev[j.id]?.response ? 'loading' : 'off', compiled: j.compiled }
      }
      return next
    })
    wanted.current = new Map(jobs.filter((j) => j.enabled && !j.errors.length).map((j) => [j.id, j.key]))
    const live_ = new Set(wanted.current.values())
    for (const [key, opaqueId] of inflight.current) {
      if (!live_.has(key)) {
        void api.cluster.cancel(opaqueId).catch(() => undefined)
        inflight.current.delete(key)
      }
    }
    // With live preview off, only a Run (a new nonce) sends requests.
    if (!live && nonce === ranNonce.current) return
    ranNonce.current = nonce
    const timer = setTimeout(() => {
      const queue = [...new Map(jobs.filter((j) => j.enabled && !j.errors.length).map((j) => [j.key, j])).values()].filter((j) => {
        const hit = cache.get(j.key)
        return !(hit && Date.now() - hit.at < TTL) && !inflight.current.has(j.key)
      })
      const apply = (key: string, p: Partial<Preview>) =>
        setResults((prev) => {
          const next = { ...prev }
          for (const [id, k] of wanted.current) if (k === key && next[id]) next[id] = { ...next[id]!, ...p } as Preview
          return next
        })
      const worker = async () => {
        for (let j = queue.shift(); j; j = queue.shift()) {
          const opaqueId = `kabanos-${crypto.randomUUID()}`
          inflight.current.set(j.key, opaqueId)
          try {
            const res = await api.cluster.request({ connectionId: conn.id, method: 'POST', path: `${encodeURIComponent(target)}/_search`, body: JSON.stringify(j.compiled.request), opaqueId })
            if (inflight.current.get(j.key) !== opaqueId) continue
            if (res.status >= 400) apply(j.key, { status: 'error', error: reason(res.body), response: undefined })
            else {
              const response = JSON.parse(res.body) as Record<string, unknown>
              cache.set(j.key, { at: Date.now(), response, ms: res.ms })
              apply(j.key, { status: 'done', response, ms: res.ms, error: undefined, sampled: !!sample })
            }
          } catch (e) {
            if (inflight.current.get(j.key) === opaqueId) apply(j.key, { status: 'error', error: (e as Error).message })
          } finally {
            if (inflight.current.get(j.key) === opaqueId) inflight.current.delete(j.key)
          }
        }
      }
      for (let i = 0; i < CONCURRENCY; i++) void worker()
    }, DEBOUNCE)
    return () => clearTimeout(timer)
  }, [jobs, live, nonce, conn.id, target, sample])

  // Cancel everything still running when the tab goes away.
  useEffect(
    () => () => {
      for (const opaqueId of inflight.current.values()) void api.cluster.cancel(opaqueId).catch(() => undefined)
      inflight.current.clear()
    },
    []
  )
  return results
}
