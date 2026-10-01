export type AuthKind = 'url' | 'basic' | 'apikey' | 'sigv4' | 'cloudid' | 'none'
export type EngineChoice = 'auto' | 'elasticsearch' | 'opensearch'
export type EngineKind = 'elasticsearch' | 'opensearch'
export type ColorTag = 'amber' | 'red' | 'teal' | 'blue' | 'green' | 'grey'
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'HEAD' | 'DELETE' | 'PATCH'

export interface SshTunnelOptions {
  host: string
  port: number
  username: string
  auth: 'password' | 'key' | 'agent'
  /** Private key file for `key` auth (its passphrase, if any, is a secret). */
  keyPath?: string
}

export interface TlsOptions {
  verify: boolean
  caPath?: string
  /** SHA-256 fingerprint of the server or CA certificate (hex, with or without colons). */
  fingerprint?: string
}

export interface DetectedEngine {
  engine: EngineKind
  version: string
  major: number
  /** 'default' | 'serverless' for ES; 'aws' when the Amazon compatibility override is suspected. */
  flavor: 'default' | 'serverless' | 'aws'
  label: string
  clusterName?: string
}

/** Everything about a connection except secrets. Safe to send to the renderer. */
export interface ConnectionConfig {
  id: string
  name: string
  folder: string
  color: ColorTag
  favorite: boolean
  isProd: boolean
  readOnly: boolean
  engine: EngineChoice
  /** Base URL without credentials. For Cloud ID connections it's derived from the Cloud ID. */
  url: string
  authKind: AuthKind
  username?: string
  cloudId?: string
  aws?: { region: string; service: 'es' | 'aoss'; profile?: string }
  tls: TlsOptions
  /** Reach the cluster through an SSH local port forward. */
  ssh?: SshTunnelOptions
  /** HTTP(S) proxy URL, e.g. http://proxy.corp:3128 */
  proxy?: string
  timeoutMs: number
  compression: boolean
  headers: Record<string, string>
  detected?: DetectedEngine
  /** Which secrets exist in the store — the values themselves never leave main. */
  hasPassword?: boolean
  hasApiKey?: boolean
  hasSshPassword?: boolean
  hasSshPassphrase?: boolean
  createdAt?: string
  updatedAt?: string
}

export interface ConnectionSecrets {
  password?: string
  apiKey?: string
  sshPassword?: string
  sshPassphrase?: string
}

export interface ConnectionInput {
  config: Omit<ConnectionConfig, 'id' | 'hasPassword' | 'hasApiKey' | 'createdAt' | 'updatedAt'> & { id?: string }
  /** Omitted fields keep the stored value; empty string clears it. */
  secrets?: ConnectionSecrets
}

export interface ClusterRequest {
  connectionId: string
  method: HttpMethod
  path: string
  body?: string
  opaqueId?: string
}

export interface ClusterResponse {
  status: number
  headers: Record<string, string>
  body: string
  ms: number
  bytes: number
  opaqueId: string
}

export interface ClusterHealthSummary {
  status: 'green' | 'yellow' | 'red' | 'unknown'
  nodes: number
  indices?: number
  aliases?: number
  templates?: number
}

export interface TestResult {
  ok: boolean
  error?: string
  detected?: DetectedEngine
  health?: ClusterHealthSummary
  ms?: number
}

export type KabanosErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CANCELLED'
  | 'READ_ONLY'
  | 'NOT_CONFIRMED'
  | 'NETWORK'
  | 'TLS'
  | 'UNSUPPORTED'
