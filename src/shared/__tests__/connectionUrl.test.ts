import { describe, expect, it } from 'vitest'
import { decodeCloudId, maskUrlPassword, normalizeFingerprint, parseConnectionUrl } from '../connectionUrl'

describe('parseConnectionUrl', () => {
  it('splits credentials out and strips them from the clean URL', () => {
    const p = parseConnectionUrl('https://elastic:s3cret@search-prod.internal:9243')
    expect(p).toMatchObject({ scheme: 'https', host: 'search-prod.internal', port: 9243, portExplicit: true, username: 'elastic', password: 's3cret' })
    expect(p.cleanUrl).toBe('https://search-prod.internal:9243')
  })

  it('percent-decodes special characters in the password', () => {
    const p = parseConnectionUrl('https://user%40corp:p%40ss%3Aw%2Frd%23@host:9200')
    expect(p.username).toBe('user@corp')
    expect(p.password).toBe('p@ss:w/rd#')
    expect(p.cleanUrl).not.toContain('p%40ss')
  })

  it('defaults to https and the scheme port for bare hosts', () => {
    expect(parseConnectionUrl('localhost:9200')).toMatchObject({ scheme: 'https', port: 9200 })
    expect(parseConnectionUrl('https://es.example.com')).toMatchObject({ port: 443, portExplicit: false })
    expect(parseConnectionUrl('http://es.example.com')).toMatchObject({ port: 80 })
  })

  it('keeps a reverse-proxy path prefix and drops query/hash', () => {
    const p = parseConnectionUrl('https://u:p@gw.example.com/es/?x=1#y')
    expect(p.pathPrefix).toBe('/es')
    expect(p.cleanUrl).toBe('https://gw.example.com/es')
  })

  it('rejects unsupported schemes and garbage', () => {
    expect(() => parseConnectionUrl('ftp://host')).toThrow(/Unsupported scheme/)
    expect(() => parseConnectionUrl('')).toThrow(/empty/)
    expect(() => parseConnectionUrl('http://')).toThrow()
  })
})

describe('maskUrlPassword', () => {
  it('hides only the password', () => {
    expect(maskUrlPassword('https://elastic:s3cret@host:9200')).toBe('https://elastic:••••••••@host:9200')
    expect(maskUrlPassword('https://host:9200')).toBe('https://host:9200')
  })
})

describe('decodeCloudId', () => {
  const payload = (s: string) => Buffer.from(s).toString('base64')

  it('builds the ES and Kibana URLs', () => {
    const id = `my-deploy:${payload('us-central1.gcp.cloud.es.io$abc123$kib456')}`
    expect(decodeCloudId(id)).toEqual({
      deploymentName: 'my-deploy',
      esUrl: 'https://abc123.us-central1.gcp.cloud.es.io',
      kibanaUrl: 'https://kib456.us-central1.gcp.cloud.es.io'
    })
  })

  it('keeps a non-default port', () => {
    expect(decodeCloudId(`d:${payload('eu-west-1.aws.found.io:9243$es$kb')}`).esUrl).toBe('https://es.eu-west-1.aws.found.io:9243')
  })

  it('rejects malformed ids', () => {
    expect(() => decodeCloudId('no-colon')).toThrow()
    expect(() => decodeCloudId(`d:${payload('hostonly')}`)).toThrow(/missing/)
  })
})

describe('normalizeFingerprint', () => {
  it('accepts openssl output, colons and case', () => {
    expect(normalizeFingerprint('sha256 Fingerprint=AA:bb:0C')).toBe('aabb0c')
    expect(normalizeFingerprint('aa bb 0c')).toBe('aabb0c')
  })
})
