import type { DetectedEngine } from './types'

interface RootResponse {
  cluster_name?: string
  version?: {
    number?: string
    distribution?: string
    build_flavor?: string
  }
  tagline?: string
}

/**
 * Decide the engine from `GET /` and its response headers.
 * `version.distribution` is authoritative for OpenSearch; `version.number` alone is not,
 * because Amazon OpenSearch Service can be configured to report 7.10.2.
 */
export function detectEngine(root: unknown, headers: Record<string, string> = {}): DetectedEngine {
  const r = (root ?? {}) as RootResponse
  const version = r.version?.number ?? '0.0.0'
  const major = Number.parseInt(version.split('.')[0] ?? '0', 10) || 0
  const product = headerValue(headers, 'x-elastic-product')
  const clusterName = r.cluster_name

  if (r.version?.distribution === 'opensearch') {
    return { engine: 'opensearch', version, major, flavor: 'default', label: `OS ${shortVersion(version)}`, clusterName }
  }

  // AWS compatibility mode: OpenSearch pretending to be ES 7.10.2 has no Elastic product header.
  if (version === '7.10.2' && !product && !/elasticsearch/i.test(r.tagline ?? '')) {
    return { engine: 'opensearch', version, major, flavor: 'aws', label: 'OS (compat 7.10)', clusterName }
  }

  const flavor = r.version?.build_flavor === 'serverless' ? 'serverless' : 'default'
  const label = flavor === 'serverless' ? 'ES Serverless' : `ES ${shortVersion(version)}`
  return { engine: 'elasticsearch', version, major, flavor, label, clusterName }
}

function shortVersion(v: string): string {
  return v.split('.').slice(0, 2).join('.')
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  return key ? headers[key] : undefined
}
