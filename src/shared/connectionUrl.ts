export interface ParsedConnectionUrl {
  scheme: 'http' | 'https'
  host: string
  /** Explicit port, or the scheme default when none was given. */
  port: number
  portExplicit: boolean
  /** Path prefix (for clusters behind a reverse proxy), without trailing slash. '' when none. */
  pathPrefix: string
  username?: string
  password?: string
  /** URL with credentials stripped — the only form ever persisted. */
  cleanUrl: string
}

export class ConnectionUrlError extends Error {}

/**
 * Parse `https://user:pa%40ss@host:9243/prefix`. Credentials are percent-decoded,
 * so encoded `@`, `:` and `/` in passwords round-trip correctly.
 * A bare `host:9200` is accepted and treated as https.
 */
export function parseConnectionUrl(input: string): ParsedConnectionUrl {
  const raw = input.trim()
  if (!raw) throw new ConnectionUrlError('URL is empty')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`

  let u: URL
  try {
    u = new URL(withScheme)
  } catch {
    throw new ConnectionUrlError('Not a valid URL')
  }
  const scheme = u.protocol.replace(':', '')
  if (scheme !== 'http' && scheme !== 'https') {
    throw new ConnectionUrlError(`Unsupported scheme "${scheme}" — use http or https`)
  }
  if (!u.hostname) throw new ConnectionUrlError('URL has no host')

  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }
  const username = u.username ? decode(u.username) : undefined
  const password = u.password ? decode(u.password) : undefined

  const portExplicit = u.port !== ''
  const port = portExplicit ? Number(u.port) : scheme === 'https' ? 443 : 80
  const pathPrefix = u.pathname.replace(/\/+$/, '')

  const clean = new URL(u.toString())
  clean.username = ''
  clean.password = ''
  clean.search = ''
  clean.hash = ''
  const cleanUrl = clean.toString().replace(/\/+$/, '')

  return { scheme, host: u.hostname, port, portExplicit, pathPrefix, username, password, cleanUrl }
}

/** Replace the password in a URL with bullets, for display. */
export function maskUrlPassword(input: string): string {
  return input.replace(/(\/\/[^:/@\s]+:)([^@\s]+)(@)/, (_m, a: string, _p: string, c: string) => `${a}••••••••${c}`)
}

export interface DecodedCloudId {
  deploymentName: string
  esUrl: string
  kibanaUrl?: string
}

/**
 * Elastic Cloud ID: `name:base64(host[:port]$es_uuid$kibana_uuid)`.
 * ES URL is `https://{es_uuid}.{host}:{port}` (port defaults to 443).
 */
export function decodeCloudId(cloudId: string): DecodedCloudId {
  const trimmed = cloudId.trim()
  const idx = trimmed.indexOf(':')
  if (idx <= 0) throw new ConnectionUrlError('Cloud ID must look like "name:base64…"')
  const deploymentName = trimmed.slice(0, idx)
  let decoded: string
  try {
    decoded = atob(trimmed.slice(idx + 1))
  } catch {
    throw new ConnectionUrlError('Cloud ID payload is not valid base64')
  }
  const [hostPart, esUuid, kibanaUuid] = decoded.split('$')
  if (!hostPart || !esUuid) throw new ConnectionUrlError('Cloud ID payload is missing host or Elasticsearch id')
  const [host, port] = hostPart.split(':')
  const portSuffix = port && port !== '443' ? `:${port}` : ''
  return {
    deploymentName,
    esUrl: `https://${esUuid}.${host}${portSuffix}`,
    kibanaUrl: kibanaUuid ? `https://${kibanaUuid}.${host}${portSuffix}` : undefined
  }
}

/** Normalise a SHA-256 fingerprint to lowercase hex without separators. */
export function normalizeFingerprint(fp: string): string {
  return fp.replace(/^sha256\s*fingerprint\s*=\s*/i, '').replace(/[^a-f0-9]/gi, '').toLowerCase()
}
