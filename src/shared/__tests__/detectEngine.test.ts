import { describe, expect, it } from 'vitest'
import { detectEngine } from '../detectEngine'

describe('detectEngine', () => {
  it('detects Elasticsearch 8 and 9', () => {
    const es8 = detectEngine({ cluster_name: 'search-prod', version: { number: '8.15.2', build_flavor: 'default' }, tagline: 'You Know, for Search' }, { 'X-Elastic-Product': 'Elasticsearch' })
    expect(es8).toMatchObject({ engine: 'elasticsearch', major: 8, label: 'ES 8.15', clusterName: 'search-prod', flavor: 'default' })
    expect(detectEngine({ version: { number: '9.5.3' } }, { 'x-elastic-product': 'Elasticsearch' })).toMatchObject({ major: 9, label: 'ES 9.5' })
  })

  it('detects Elastic serverless', () => {
    expect(detectEngine({ version: { number: '8.11.0', build_flavor: 'serverless' } }, { 'x-elastic-product': 'Elasticsearch' })).toMatchObject({
      flavor: 'serverless',
      label: 'ES Serverless'
    })
  })

  it('detects OpenSearch by distribution, not version', () => {
    expect(detectEngine({ version: { distribution: 'opensearch', number: '2.17.1' } })).toMatchObject({ engine: 'opensearch', label: 'OS 2.17', major: 2 })
  })

  it('treats a header-less 7.10.2 as Amazon OpenSearch in compatibility mode', () => {
    expect(detectEngine({ version: { number: '7.10.2' }, tagline: 'The OpenSearch Project: https://opensearch.org/' })).toMatchObject({ engine: 'opensearch', flavor: 'aws' })
  })

  it('keeps real Elasticsearch 7.10.2 as Elasticsearch', () => {
    expect(detectEngine({ version: { number: '7.10.2' }, tagline: 'You Know, for Search' }, { 'x-elastic-product': 'Elasticsearch' })).toMatchObject({ engine: 'elasticsearch' })
  })
})
