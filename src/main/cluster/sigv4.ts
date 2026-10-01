import { Sha256 } from '@aws-crypto/sha256-js'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types'

export interface SigV4Options {
  region: string
  /** `es` for Amazon OpenSearch Service domains, `aoss` for OpenSearch Serverless. */
  service: 'es' | 'aoss'
  /** Named profile from ~/.aws (SSO, assume-role and env vars are handled by the default chain). */
  profile?: string
  /** Injected in tests. */
  credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider
}

/**
 * Signs requests for Amazon OpenSearch. Credentials come from the standard AWS chain
 * (env, ~/.aws profile, SSO, instance role) and are never stored by kabanos.
 */
export class SigV4Signer {
  private readonly signer: SignatureV4

  constructor(opts: SigV4Options) {
    this.signer = new SignatureV4({
      region: opts.region,
      service: opts.service,
      sha256: Sha256,
      credentials: opts.credentials ?? fromNodeProviderChain(opts.profile ? { profile: opts.profile } : {}),
      // Serverless requires the payload hash header; it's harmless for managed domains.
      applyChecksum: true
    })
  }

  async sign(url: string, method: string, headers: Record<string, string>, body?: string): Promise<Record<string, string>> {
    const u = new URL(url)
    const query: Record<string, string | string[]> = {}
    for (const [k, v] of u.searchParams) {
      const prev = query[k]
      query[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v]
    }
    // accept-encoding and the opaque id may be altered by intermediaries — leave them unsigned.
    const signedHeaders = Object.fromEntries(Object.entries(headers).filter(([k]) => !['accept-encoding', 'x-opaque-id'].includes(k.toLowerCase())))
    const req = new HttpRequest({
      method,
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port ? Number(u.port) : undefined,
      path: u.pathname,
      query,
      headers: { ...signedHeaders, host: u.host },
      body
    })
    const signed = await this.signer.sign(req, { unsignableHeaders: new Set(['accept-encoding', 'x-opaque-id']) })
    return { ...headers, ...(signed.headers as Record<string, string>) }
  }
}
