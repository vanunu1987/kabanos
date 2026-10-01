/**
 * Kibana-style structure templates inserted after a key (Monaco snippet syntax: ${1:FIELD}, $0).
 * Placeholders named FIELD trigger field suggestions as soon as they're selected.
 */

export const QUERY_SNIPPETS: Record<string, string> = {
  term: '{\n\t"${1:FIELD}": {\n\t\t"value": "${2:VALUE}"\n\t}\n}',
  terms: '{\n\t"${1:FIELD}": [\n\t\t"${2:VALUE}"\n\t]\n}',
  match: '{\n\t"${1:FIELD}": "${2:TEXT}"\n}',
  match_phrase: '{\n\t"${1:FIELD}": "${2:TEXT}"\n}',
  match_phrase_prefix: '{\n\t"${1:FIELD}": "${2:TEXT}"\n}',
  match_bool_prefix: '{\n\t"${1:FIELD}": "${2:TEXT}"\n}',
  multi_match: '{\n\t"query": "${1:TEXT}",\n\t"fields": [\n\t\t"${2:FIELD}"\n\t]\n}',
  range: '{\n\t"${1:FIELD}": {\n\t\t"gte": ${2:10},\n\t\t"lte": ${3:20}\n\t}\n}',
  exists: '{\n\t"field": "${1:FIELD}"\n}',
  prefix: '{\n\t"${1:FIELD}": {\n\t\t"value": "${2:VALUE}"\n\t}\n}',
  wildcard: '{\n\t"${1:FIELD}": {\n\t\t"value": "${2:VALUE*}"\n\t}\n}',
  regexp: '{\n\t"${1:FIELD}": {\n\t\t"value": "${2:REGEX}"\n\t}\n}',
  fuzzy: '{\n\t"${1:FIELD}": {\n\t\t"value": "${2:VALUE}"\n\t}\n}',
  ids: '{\n\t"values": [\n\t\t"${1:ID}"\n\t]\n}',
  bool: '{\n\t"must": [\n\t\t$1\n\t],\n\t"filter": [],\n\t"should": [],\n\t"must_not": []\n}',
  match_all: '{}',
  match_none: '{}',
  nested: '{\n\t"path": "${1:PATH}",\n\t"query": {\n\t\t$2\n\t}\n}',
  query_string: '{\n\t"query": "${1:QUERY}",\n\t"default_field": "${2:FIELD}"\n}',
  simple_query_string: '{\n\t"query": "${1:QUERY}",\n\t"fields": [\n\t\t"${2:FIELD}"\n\t]\n}',
  constant_score: '{\n\t"filter": {\n\t\t$1\n\t}\n}',
  dis_max: '{\n\t"queries": [\n\t\t$1\n\t]\n}',
  boosting: '{\n\t"positive": {\n\t\t$1\n\t},\n\t"negative": {},\n\t"negative_boost": ${2:0.5}\n}',
  function_score: '{\n\t"query": {\n\t\t$1\n\t},\n\t"functions": []\n}',
  geo_distance: '{\n\t"distance": "${1:10km}",\n\t"${2:FIELD}": {\n\t\t"lat": ${3:0},\n\t\t"lon": ${4:0}\n\t}\n}',
  geo_bounding_box: '{\n\t"${1:FIELD}": {\n\t\t"top_left": { "lat": ${2:0}, "lon": ${3:0} },\n\t\t"bottom_right": { "lat": ${4:0}, "lon": ${5:0} }\n\t}\n}',
  script: '{\n\t"script": {\n\t\t"source": "${1:doc[\'FIELD\'].value > 0}",\n\t\t"lang": "painless"\n\t}\n}',
  more_like_this: '{\n\t"fields": [\n\t\t"${1:FIELD}"\n\t],\n\t"like": "${2:TEXT}",\n\t"min_term_freq": 1\n}'
}

export const AGG_SNIPPETS: Record<string, string> = {
  terms: '{\n\t"field": "${1:FIELD}",\n\t"size": ${2:10}\n}',
  date_histogram: '{\n\t"field": "${1:FIELD}",\n\t"calendar_interval": "${2:1d}"\n}',
  histogram: '{\n\t"field": "${1:FIELD}",\n\t"interval": ${2:10}\n}',
  range: '{\n\t"field": "${1:FIELD}",\n\t"ranges": [\n\t\t{ "to": ${2:100} },\n\t\t{ "from": ${2:100} }\n\t]\n}',
  date_range: '{\n\t"field": "${1:FIELD}",\n\t"ranges": [\n\t\t{ "from": "${2:now-7d/d}" }\n\t]\n}',
  filter: '{\n\t$1\n}',
  filters: '{\n\t"filters": {\n\t\t"${1:NAME}": {\n\t\t\t$2\n\t\t}\n\t}\n}',
  avg: '{\n\t"field": "${1:FIELD}"\n}',
  sum: '{\n\t"field": "${1:FIELD}"\n}',
  min: '{\n\t"field": "${1:FIELD}"\n}',
  max: '{\n\t"field": "${1:FIELD}"\n}',
  stats: '{\n\t"field": "${1:FIELD}"\n}',
  extended_stats: '{\n\t"field": "${1:FIELD}"\n}',
  cardinality: '{\n\t"field": "${1:FIELD}"\n}',
  value_count: '{\n\t"field": "${1:FIELD}"\n}',
  percentiles: '{\n\t"field": "${1:FIELD}",\n\t"percents": [\n\t\t50,\n\t\t95,\n\t\t99\n\t]\n}',
  top_hits: '{\n\t"size": ${1:3}\n}',
  nested: '{\n\t"path": "${1:PATH}"\n}',
  composite: '{\n\t"sources": [\n\t\t{ "${1:NAME}": { "terms": { "field": "${2:FIELD}" } } }\n\t]\n}',
  significant_terms: '{\n\t"field": "${1:FIELD}"\n}',
  aggs: '{\n\t"${1:NAME}": {\n\t\t"${2:terms}": {\n\t\t\t"field": "${3:FIELD}"\n\t\t}\n\t}\n}'
}

/** Top level of a search-like body. */
export const ROOT_SNIPPETS: Record<string, string> = {
  query: '{\n\t$0\n}',
  aggs: '{\n\t"${1:NAME}": {\n\t\t"${2:terms}": {\n\t\t\t"field": "${3:FIELD}"\n\t\t}\n\t}\n}',
  aggregations: '{\n\t"${1:NAME}": {\n\t\t"${2:terms}": {\n\t\t\t"field": "${3:FIELD}"\n\t\t}\n\t}\n}',
  sort: '[\n\t{\n\t\t"${1:FIELD}": {\n\t\t\t"order": "${2:desc}"\n\t\t}\n\t}\n]',
  _source: '[\n\t"${1:FIELD}"\n]',
  fields: '[\n\t"${1:FIELD}"\n]',
  highlight: '{\n\t"fields": {\n\t\t"${1:FIELD}": {}\n\t}\n}',
  collapse: '{\n\t"field": "${1:FIELD}"\n}',
  size: '${1:20}',
  from: '${1:0}',
  track_total_hits: '${1|true,false|}',
  search_after: '[\n\t$0\n]',
  post_filter: '{\n\t$0\n}',
  timeout: '"${1:30s}"'
}

/** Generic value skeleton from the spec's type for keys without a hand-written template. */
export function shapeSnippet(shape: KeyShape | undefined, values?: string[]): string | undefined {
  switch (shape) {
    case 'object':
      return '{\n\t$0\n}'
    case 'array':
      return '[\n\t$0\n]'
    case 'boolean':
      return '${1|true,false|}'
    case 'number':
      return '$0'
    case 'string':
    case 'field':
      return '"$0"'
    case 'enum':
      return values?.length ? `"\${1|${values.slice(0, 12).map((v) => v.replace(/[|,$}\\]/g, '')).join(',')}|}"` : '"$0"'
    default:
      return undefined
  }
}

export type KeyShape = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'field' | 'enum' | 'any'
