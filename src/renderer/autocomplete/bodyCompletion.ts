import type { languages, editor, Position } from 'monaco-editor'
import type { JsonCursorContext } from '@shared/jsonContext'
import type { HttpMethod } from '@shared/types'
import type { FieldInfo } from '@shared/meta'
import { monaco } from '../monaco/setup'

/**
 * Completion for standalone JSON body editors (Index view): each editor registers how to find its
 * request (method + path) and fields under its model URI; one provider serves them all.
 */
export interface JsonBodySource {
  request(): { method: HttpMethod; path: string }
  fields(target: string): Promise<FieldInfo[]>
}
const sources = new Map<string, JsonBodySource>()

export function registerBodySource(modelUri: string, source: JsonBodySource): () => void {
  sources.set(modelUri, source)
  return () => sources.delete(modelUri)
}

const TERM_LEVEL = new Set(['term', 'terms', 'range', 'prefix', 'wildcard', 'regexp', 'fuzzy', 'exists', 'ids', 'term_set'])
const FULL_TEXT = new Set(['match', 'match_phrase', 'match_phrase_prefix', 'match_bool_prefix', 'intervals', 'span_term'])
const GEO = new Set(['geo_distance', 'geo_bounding_box', 'geo_shape', 'geo_polygon'])
const FIELD_VALUE_KEYS = new Set(['field', 'fields', '_source', 'sort', 'docvalue_fields', 'stored_fields', 'includes', 'excludes', 'default_field', 'path'])
const QUERY_PARENTS = new Set(['query', 'must', 'filter', 'should', 'must_not', 'positive', 'negative', 'post_filter', 'constant_score', 'dis_max', 'queries'])

export const DSL_KEYS: Record<string, string[]> = {
  root: ['query', 'size', 'from', 'sort', '_source', 'aggs', 'track_total_hits', 'highlight', 'post_filter', 'search_after', 'fields', 'collapse', 'runtime_mappings', 'min_score', 'timeout', 'explain', 'profile', 'script_fields', 'suggest', 'pit', 'knn'],
  query: ['bool', 'match', 'match_all', 'match_none', 'match_phrase', 'match_phrase_prefix', 'multi_match', 'term', 'terms', 'range', 'exists', 'prefix', 'wildcard', 'regexp', 'fuzzy', 'ids', 'query_string', 'simple_query_string', 'nested', 'has_child', 'has_parent', 'function_score', 'constant_score', 'dis_max', 'boosting', 'geo_distance', 'geo_bounding_box', 'geo_shape', 'script', 'script_score', 'more_like_this', 'knn'],
  bool: ['must', 'filter', 'should', 'must_not', 'minimum_should_match', 'boost'],
  aggType: ['terms', 'date_histogram', 'histogram', 'range', 'date_range', 'filter', 'filters', 'avg', 'sum', 'min', 'max', 'stats', 'extended_stats', 'cardinality', 'value_count', 'percentiles', 'top_hits', 'nested', 'composite', 'significant_terms', 'geo_bounds', 'geotile_grid', 'aggs'],
  aggBody: ['field', 'size', 'order', 'min_doc_count', 'missing', 'script', 'calendar_interval', 'fixed_interval', 'interval', 'format', 'time_zone', 'ranges', 'keyed', 'precision_threshold', 'percents', 'shard_size', 'include', 'exclude', 'sources'],
  range: ['gte', 'gt', 'lte', 'lt', 'format', 'time_zone', 'boost'],
  match: ['query', 'operator', 'minimum_should_match', 'fuzziness', 'analyzer', 'boost', 'zero_terms_query'],
  multi_match: ['query', 'fields', 'type', 'operator', 'tie_breaker', 'fuzziness', 'minimum_should_match'],
  highlight: ['fields', 'pre_tags', 'post_tags', 'fragment_size', 'number_of_fragments', 'type', 'require_field_match'],
  sortField: ['order', 'mode', 'missing', 'unmapped_type', 'nested', 'format'],
  nested: ['path', 'query', 'score_mode', 'inner_hits', 'ignore_unmapped'],
  function_score: ['query', 'functions', 'score_mode', 'boost_mode', 'field_value_factor', 'random_score', 'gauss', 'linear', 'exp', 'script_score', 'min_score', 'max_boost'],
  collapse: ['field', 'inner_hits', 'max_concurrent_group_searches']
}

const KEYWORDISH = new Set(['keyword', 'constant_keyword', 'wildcard', 'long', 'integer', 'short', 'byte', 'double', 'float', 'half_float', 'scaled_float', 'unsigned_long', 'date', 'date_nanos', 'boolean', 'ip', 'version'])
const NUMERIC_DATE = new Set(['long', 'integer', 'short', 'byte', 'double', 'float', 'half_float', 'scaled_float', 'unsigned_long', 'date', 'date_nanos', 'ip'])
const TEXTISH = new Set(['text', 'match_only_text', 'search_as_you_type'])

type Want = { kind: 'fields'; rank?: (f: FieldInfo) => number } | { kind: 'keys'; keys: string[] } | null

/** What should be suggested at this cursor context. Exported for tests. */
export function decide(ctx: JsonCursorContext): Want {
  const parent = ctx.path.at(-1)
  const grand = ctx.path.at(-2)
  if (ctx.position === 'value') {
    if (ctx.key && FIELD_VALUE_KEYS.has(ctx.key)) {
      const rank = ctx.key === 'sort' || (grand && ['terms', 'histogram', 'date_histogram', 'cardinality', 'avg', 'sum', 'min', 'max', 'stats'].includes(parent ?? '')) ? termRank : undefined
      return { kind: 'fields', rank }
    }
    return null
  }
  // Key position.
  if (!parent) return ctx.container === 'object' ? { kind: 'keys', keys: DSL_KEYS.root! } : null
  if (TERM_LEVEL.has(parent)) return { kind: 'fields', rank: parent === 'range' ? rangeRank : termRank }
  if (FULL_TEXT.has(parent)) return { kind: 'fields', rank: textRank }
  if (GEO.has(parent)) return { kind: 'fields', rank: (f) => (f.type.startsWith('geo') ? 0 : 1) }
  if (parent === 'sort') return { kind: 'fields', rank: termRank }
  if (parent === 'fields' && grand === 'highlight') return { kind: 'fields', rank: textRank }
  if (QUERY_PARENTS.has(parent)) return { kind: 'keys', keys: DSL_KEYS.query! }
  if (parent === 'aggs' || parent === 'aggregations') return null // agg names are free-form
  if (grand === 'aggs' || grand === 'aggregations') return { kind: 'keys', keys: DSL_KEYS.aggType! }
  if (DSL_KEYS.aggType!.includes(parent) && (ctx.path.at(-3) === 'aggs' || ctx.path.at(-3) === 'aggregations')) return { kind: 'keys', keys: DSL_KEYS.aggBody! }
  if (grand && (TERM_LEVEL.has(grand) || FULL_TEXT.has(grand))) return { kind: 'keys', keys: grand === 'range' ? DSL_KEYS.range! : DSL_KEYS.match! }
  if (grand === 'sort') return { kind: 'keys', keys: DSL_KEYS.sortField! }
  const keys = DSL_KEYS[parent]
  return keys ? { kind: 'keys', keys } : null
}

/** Ordering of field suggestions for a cursor context: term-friendly first inside term/range, text first inside match. */
export function rankFor(ctx: JsonCursorContext): (f: FieldInfo) => number {
  const parent = ctx.position === 'key' ? ctx.path.at(-1) : ctx.key
  if (parent === 'range') return rangeRank
  if (parent && (FULL_TEXT.has(parent) || parent === 'multi_match' || parent === 'fields')) return textRank
  if (parent && GEO.has(parent)) return (f) => (f.type.startsWith('geo') ? 0 : 1)
  return termRank
}

const termRank = (f: FieldInfo) => (KEYWORDISH.has(f.type) ? 0 : TEXTISH.has(f.type) ? 2 : 1)
const rangeRank = (f: FieldInfo) => (NUMERIC_DATE.has(f.type) ? 0 : 2)
const textRank = (f: FieldInfo) => (TEXTISH.has(f.type) ? 0 : f.type === 'keyword' ? 1 : 2)

let registered = false

export function ensureBodyCompletion(): void {
  if (registered) return
  registered = true
  monaco.languages.registerCompletionItemProvider('json', {
    triggerCharacters: ['"', '.', '[', '{', ','],
    async provideCompletionItems(model: editor.ITextModel, position: Position): Promise<languages.CompletionList | undefined> {
      const source = sources.get(model.uri.toString())
      if (!source) return undefined
      const { bodyCompletions } = await import('./bodyCore')
      return bodyCompletions(model, position, 1, { ...source.request(), fields: (t) => source.fields(t) })
    }
  })
}
