import { ConnectionUrlError, decodeCloudId, parseConnectionUrl, type ParsedConnectionUrl } from '@shared/connectionUrl'
import type { AuthKind, ColorTag, ConnectionConfig, ConnectionInput, EngineChoice } from '@shared/types'

/** Form state for the connection editor. Secrets live here only until Save. */
export interface Draft {
  id?: string
  name: string
  folder: string
  color: ColorTag
  favorite: boolean
  isProd: boolean
  prodTouched: boolean
  readOnly: boolean
  engine: EngineChoice
  url: string
  authKind: AuthKind
  username: string
  password: string
  apiKey: string
  cloudId: string
  awsRegion: string
  awsService: 'es' | 'aoss'
  awsProfile: string
  tlsVerify: boolean
  sshEnabled: boolean
  sshHost: string
  sshPort: number
  sshUser: string
  sshAuth: 'password' | 'key' | 'agent'
  sshKeyPath: string
  sshPassword: string
  sshPassphrase: string
  hasSshPassword: boolean
  hasSshPassphrase: boolean
  proxy: string
  caPath: string
  fingerprint: string
  timeoutSec: number
  compression: boolean
  headers: string
  hasPassword: boolean
  hasApiKey: boolean
}

export function emptyDraft(): Draft {
  return {
    name: '',
    folder: 'Local',
    color: 'amber',
    favorite: false,
    isProd: false,
    prodTouched: false,
    readOnly: false,
    engine: 'auto',
    url: '',
    authKind: 'url',
    username: '',
    password: '',
    apiKey: '',
    cloudId: '',
    awsRegion: '',
    awsService: 'es',
    awsProfile: '',
    tlsVerify: true,
    sshEnabled: false,
    sshHost: '',
    sshPort: 22,
    sshUser: '',
    sshAuth: 'key',
    sshKeyPath: '~/.ssh/id_ed25519',
    sshPassword: '',
    sshPassphrase: '',
    hasSshPassword: false,
    hasSshPassphrase: false,
    proxy: '',
    caPath: '',
    fingerprint: '',
    timeoutSec: 30,
    compression: true,
    headers: '',
    hasPassword: false,
    hasApiKey: false
  }
}

export function draftFrom(c: ConnectionConfig): Draft {
  return {
    id: c.id,
    name: c.name,
    folder: c.folder,
    color: c.color,
    favorite: c.favorite,
    isProd: c.isProd,
    prodTouched: true,
    readOnly: c.readOnly,
    engine: c.engine,
    // 'url' auth keeps the username in the URL field; the stored password is kept unless a new one is typed.
    url: c.authKind === 'url' && c.username ? withUsername(c.url, c.username) : c.url,
    authKind: c.authKind,
    username: c.username ?? '',
    password: '',
    apiKey: '',
    cloudId: c.cloudId ?? '',
    awsRegion: c.aws?.region ?? '',
    awsService: c.aws?.service ?? 'es',
    awsProfile: c.aws?.profile ?? '',
    tlsVerify: c.tls.verify,
    sshEnabled: !!c.ssh,
    sshHost: c.ssh?.host ?? '',
    sshPort: c.ssh?.port ?? 22,
    sshUser: c.ssh?.username ?? '',
    sshAuth: c.ssh?.auth ?? 'key',
    sshKeyPath: c.ssh?.keyPath ?? '~/.ssh/id_ed25519',
    sshPassword: '',
    sshPassphrase: '',
    hasSshPassword: !!c.hasSshPassword,
    hasSshPassphrase: !!c.hasSshPassphrase,
    proxy: c.proxy ?? '',
    caPath: c.tls.caPath ?? '',
    fingerprint: c.tls.fingerprint ?? '',
    timeoutSec: Math.round(c.timeoutMs / 1000),
    compression: c.compression,
    headers: Object.entries(c.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n'),
    hasPassword: !!c.hasPassword,
    hasApiKey: !!c.hasApiKey
  }
}

function withUsername(url: string, username: string): string {
  try {
    const u = new URL(url)
    u.username = encodeURIComponent(username)
    return u.toString().replace(/\/+$/, '')
  } catch {
    return url
  }
}

export function tryParseUrl(url: string): { parsed?: ParsedConnectionUrl; error?: string } {
  if (!url.trim()) return {}
  try {
    return { parsed: parseConnectionUrl(url) }
  } catch (e) {
    return { error: e instanceof ConnectionUrlError ? e.message : 'Invalid URL' }
  }
}

export function tryDecodeCloudId(cloudId: string): { esUrl?: string; name?: string; error?: string } {
  if (!cloudId.trim()) return {}
  try {
    const d = decodeCloudId(cloudId)
    return { esUrl: d.esUrl, name: d.deploymentName }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

/** A friendly default name from the host, e.g. `search-prod.internal` → `search-prod`. */
/** Region and service from an AWS endpoint, e.g. search-x.eu-west-1.es.amazonaws.com / x.us-east-1.aoss.amazonaws.com. */
export function awsFromHost(host: string): { region: string; service: 'es' | 'aoss' } | undefined {
  const m = /\.([a-z]{2}(?:-[a-z]+)+-\d)\.(es|aoss)\.amazonaws\.com$/.exec(host)
  return m ? { region: m[1]!, service: m[2] as 'es' | 'aoss' } : undefined
}

export function suggestName(d: Draft): string {
  if (d.authKind === 'cloudid') return tryDecodeCloudId(d.cloudId).name ?? ''
  const host = tryParseUrl(d.url).parsed?.host
  if (!host) return ''
  if (host === 'localhost' || host === '127.0.0.1') return 'Localhost'
  return host.split('.')[0] ?? host
}

export function toInput(d: Draft): ConnectionInput {
  const secrets: ConnectionInput['secrets'] = {}
  if (d.authKind === 'basic' && d.password) secrets.password = d.password
  if ((d.authKind === 'apikey' || d.authKind === 'cloudid') && d.apiKey) secrets.apiKey = d.apiKey
  if (d.authKind === 'cloudid' && d.password) secrets.password = d.password
  if (d.sshEnabled && d.sshAuth === 'password' && d.sshPassword) secrets.sshPassword = d.sshPassword
  if (d.sshEnabled && d.sshAuth === 'key' && d.sshPassphrase) secrets.sshPassphrase = d.sshPassphrase

  return {
    config: {
      id: d.id,
      name: d.name.trim() || suggestName(d) || 'Untitled connection',
      folder: d.folder,
      color: d.color,
      favorite: d.favorite,
      isProd: d.isProd,
      readOnly: d.readOnly,
      engine: d.engine,
      // For 'url' auth this still contains the credentials; main splits them out before persisting.
      url: d.authKind === 'cloudid' ? (tryDecodeCloudId(d.cloudId).esUrl ?? '') : d.url.trim(),
      authKind: d.authKind,
      username: d.authKind === 'basic' || d.authKind === 'cloudid' ? d.username.trim() || undefined : undefined,
      cloudId: d.authKind === 'cloudid' ? d.cloudId.trim() : undefined,
      aws: d.authKind === 'sigv4' ? { region: d.awsRegion.trim(), service: d.awsService, profile: d.awsProfile.trim() || undefined } : undefined,
      tls: { verify: d.tlsVerify, caPath: d.caPath || undefined, fingerprint: d.fingerprint.trim() || undefined },
      ssh: d.sshEnabled && d.sshHost.trim() ? { host: d.sshHost.trim(), port: d.sshPort || 22, username: d.sshUser.trim(), auth: d.sshAuth, keyPath: d.sshAuth === 'key' ? d.sshKeyPath.trim() || undefined : undefined } : undefined,
      proxy: d.proxy.trim() || undefined,
      timeoutMs: Math.max(1, d.timeoutSec) * 1000,
      compression: d.compression,
      headers: parseHeaders(d.headers)
    },
    secrets
  }
}
