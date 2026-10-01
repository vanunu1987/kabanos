// Seeds the docker-compose clusters with realistic sample data for development.
//   pnpm clusters:seed            → all three clusters
//   pnpm clusters:seed es9        → just one (es8 | es9 | os2)
// Re-running is safe: indices are recreated.
import { Agent, request } from 'undici'

const CLUSTERS = {
  es8: { url: 'https://localhost:9200', auth: 'elastic:sift-dev-pass' },
  es9: { url: 'http://localhost:9202', auth: 'elastic:sift-dev-pass' },
  os2: { url: 'https://localhost:9201', auth: 'admin:Sift-dev-Pass_42' }
}
const dispatcher = new Agent({ connect: { rejectUnauthorized: false } })

const CITIES = [
  { id: 5000, name: 'Tel Aviv', loc: [34.78, 32.08] },
  { id: 3000, name: 'Jerusalem', loc: [35.21, 31.77] },
  { id: 4000, name: 'Haifa', loc: [34.99, 32.79] },
  { id: 8300, name: "Rishon LeZion", loc: [34.79, 31.97] },
  { id: 7900, name: 'Petah Tikva', loc: [34.88, 32.09] },
  { id: 6200, name: "Be'er Sheva", loc: [34.79, 31.25] }
]
const TYPES = ['apartment', 'garden apartment', 'penthouse', 'duplex', 'house', 'studio']
const STATUSES = ['active', 'active', 'active', 'sold', 'expired']
const TAGS = ['parking', 'elevator', 'balcony', 'renovated', 'safe room', 'storage', 'sea view', 'pets allowed']

let seed = 42
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
const pick = (a) => a[Math.floor(rand() * a.length)]

function listing(i) {
  const city = pick(CITIES)
  const rooms = 1 + Math.floor(rand() * 6)
  const type = pick(TYPES)
  const created = new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 270) * 86400000)
  return {
    id: `L${100000 + i}`,
    title: `${rooms} room ${type} in ${city.name}`,
    description: `Bright ${type} with ${rooms} rooms, ${pick(TAGS)} and ${pick(TAGS)}.`,
    price: Math.round((800 + rand() * 6000) * rooms) * 100,
    price_currency: 'ILS',
    rooms,
    status: pick(STATUSES),
    location: { lon: city.loc[0] + (rand() - 0.5) / 20, lat: city.loc[1] + (rand() - 0.5) / 20 },
    city: { id: city.id, name: city.name },
    created_at: created.toISOString(),
    is_promoted: rand() < 0.15,
    tags: [...new Set([pick(TAGS), pick(TAGS), pick(TAGS)])]
  }
}

const LISTING_MAPPING = {
  properties: {
    id: { type: 'keyword' },
    title: { type: 'text', fields: { raw: { type: 'keyword' } } },
    description: { type: 'text' },
    price: { type: 'long' },
    price_currency: { type: 'keyword' },
    rooms: { type: 'integer' },
    status: { type: 'keyword' },
    location: { type: 'geo_point' },
    city: { properties: { id: { type: 'integer' }, name: { type: 'keyword' } } },
    created_at: { type: 'date' },
    is_promoted: { type: 'boolean' },
    tags: { type: 'keyword' }
  }
}

async function call(cluster, method, path, body) {
  const headers = { authorization: `Basic ${Buffer.from(cluster.auth).toString('base64')}` }
  let payload
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body)
    headers['content-type'] = typeof body === 'string' ? 'application/x-ndjson' : 'application/json'
  }
  const res = await request(`${cluster.url}/${path}`, { method, headers, body: payload, dispatcher })
  const text = await res.body.text()
  if (res.statusCode >= 400 && !(method === 'DELETE' && res.statusCode === 404)) {
    throw new Error(`${method} ${path} → ${res.statusCode}: ${text.slice(0, 300)}`)
  }
  return text ? JSON.parse(text) : {}
}

async function bulk(cluster, index, docs) {
  const lines = docs.flatMap((d) => [JSON.stringify({ create: { _index: index } }), JSON.stringify(d)])
  const res = await call(cluster, 'POST', '_bulk?refresh=true', `${lines.join('\n')}\n`)
  if (res.errors) throw new Error(`bulk into ${index} had errors: ${JSON.stringify(res.items.find((i) => i.create?.error)).slice(0, 300)}`)
}

async function seedCluster(name, cluster) {
  const isOs = (await call(cluster, 'GET', '')).version?.distribution === 'opensearch'
  console.log(`→ ${name} (${isOs ? 'OpenSearch' : 'Elasticsearch'})`)

  for (const idx of ['listings-v6', 'listings-v7', 'users-2026.09', 'geo-areas', 'archive-2025']) await call(cluster, 'DELETE', idx)
  await call(cluster, 'DELETE', '_data_stream/search-logs')

  await call(cluster, 'PUT', '_component_template/base-settings', {
    template: { settings: { number_of_shards: 1, number_of_replicas: 0, refresh_interval: '1s' } }
  })
  await call(cluster, 'PUT', '_index_template/listings-template', {
    index_patterns: ['listings-*'],
    priority: 200,
    composed_of: ['base-settings'],
    template: { mappings: LISTING_MAPPING }
  })
  await call(cluster, 'PUT', '_index_template/users-template', {
    index_patterns: ['users-*'],
    priority: 100,
    composed_of: ['base-settings'],
    template: {
      mappings: {
        properties: {
          user_id: { type: 'keyword' },
          email: { type: 'keyword' },
          name: { type: 'text', fields: { raw: { type: 'keyword' } } },
          plan: { type: 'keyword' },
          signed_up: { type: 'date' },
          listings_count: { type: 'integer' }
        }
      }
    }
  })
  await call(cluster, 'PUT', '_index_template/search-logs-template', {
    index_patterns: ['search-logs*'],
    priority: 100,
    data_stream: {},
    composed_of: ['base-settings'],
    template: {
      mappings: {
        properties: {
          '@timestamp': { type: 'date' },
          query: { type: 'text', fields: { raw: { type: 'keyword', ignore_above: 256 } } },
          results: { type: 'integer' },
          took_ms: { type: 'integer' },
          user_id: { type: 'keyword' },
          city: { type: 'keyword' }
        }
      }
    }
  })

  await bulk(cluster, 'listings-v6', Array.from({ length: 150 }, (_, i) => listing(i)))
  await bulk(cluster, 'listings-v7', Array.from({ length: 400 }, (_, i) => listing(i + 1000)))
  await bulk(
    cluster,
    'users-2026.09',
    Array.from({ length: 80 }, (_, i) => ({
      user_id: `U${5000 + i}`,
      email: `user${i}@example.com`,
      name: `User ${i}`,
      plan: pick(['free', 'free', 'pro', 'agency']),
      signed_up: new Date(Date.UTC(2025, 6, 1) + Math.floor(rand() * 400) * 86400000).toISOString(),
      listings_count: Math.floor(rand() * 30)
    }))
  )
  await bulk(
    cluster,
    'search-logs',
    Array.from({ length: 300 }, (_, i) => ({
      '@timestamp': new Date(Date.now() - i * 60000 * 7).toISOString(),
      query: pick(['3 rooms tel aviv', 'penthouse', 'garden apartment haifa', 'parking', 'sea view', 'studio jerusalem']),
      results: Math.floor(rand() * 400),
      took_ms: 3 + Math.floor(rand() * 120),
      user_id: `U${5000 + Math.floor(rand() * 80)}`,
      city: pick(CITIES).name
    }))
  )
  await call(cluster, 'PUT', 'geo-areas', {
    settings: { number_of_shards: 1, number_of_replicas: 0 },
    mappings: { properties: { name: { type: 'keyword' }, area: { type: 'geo_shape' }, population: { type: 'long' } } }
  })
  await bulk(cluster, 'geo-areas', CITIES.map((c) => ({ name: c.name, area: { type: 'point', coordinates: c.loc }, population: Math.round(rand() * 900000) })))
  await call(cluster, 'PUT', 'archive-2025', { settings: { number_of_shards: 1, number_of_replicas: 0 } })
  await call(cluster, 'POST', 'archive-2025/_close')

  await call(cluster, 'POST', '_aliases', {
    actions: [
      { add: { index: 'listings-v7', alias: 'listings', is_write_index: true } },
      { add: { index: 'listings-v7', alias: 'listings-read', filter: { term: { status: 'active' } } } },
      { add: { index: 'users-2026.09', alias: 'users' } }
    ]
  })
  console.log(`  ✓ listings-v6/v7, users-2026.09, search-logs (data stream), geo-areas, archive-2025 (closed), 3 aliases, 3 templates`)
}

const only = process.argv[2]
for (const [name, cluster] of Object.entries(CLUSTERS)) {
  if (only && only !== name) continue
  try {
    await seedCluster(name, cluster)
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`)
    process.exitCode = 1
  }
}
