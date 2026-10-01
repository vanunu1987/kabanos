import { describe, expect, it } from 'vitest'
import { addField, copyableSettings, diffMappings, nextIndexName, reindexRoutine, replaceField, type Mapping, removeField } from '../mappingEdit'

const base: Mapping = {
  properties: {
    title: { type: 'text', fields: { raw: { type: 'keyword' } } },
    price: { type: 'long' },
    city: { properties: { name: { type: 'keyword' } } }
  }
}

describe('addField', () => {
  it('adds top-level, nested-path and multi-fields', () => {
    const a = addField(base, 'rooms', { type: 'integer' })
    expect(a.properties!.rooms).toEqual({ type: 'integer' })
    const b = addField(base, 'city.zip', { type: 'keyword' })
    expect(b.properties!.city!.properties!.zip).toEqual({ type: 'keyword' })
    const c = addField(base, 'seller.phone', { type: 'keyword' })
    expect(c.properties!.seller).toEqual({ properties: { phone: { type: 'keyword' } } })
    const d = addField(base, 'title.english', { type: 'text', analyzer: 'english' }, true)
    expect(d.properties!.title!.fields!.english).toEqual({ type: 'text', analyzer: 'english' })
    expect(base.properties!.rooms).toBeUndefined() // input untouched
  })

  it('rejects duplicates and children of leaf fields', () => {
    expect(() => addField(base, 'price', { type: 'long' })).toThrow(/already exists/)
    expect(() => addField(base, 'price.x', { type: 'long' })).toThrow(/not an object/)
    expect(() => addField(base, 'city.x', { type: 'keyword' }, true)).toThrow(/not a leaf/)
  })
})

describe('diffMappings', () => {
  it('separates in-place additions from changes and removals', () => {
    expect(diffMappings(base, addField(base, 'title.english', { type: 'text' }, true))).toEqual({ added: ['title.english'], changed: [], removed: [] })
    expect(diffMappings(base, replaceField(base, 'price', { type: 'keyword' }))).toEqual({ added: [], changed: ['price'], removed: [] })
    const { price: _p, ...rest } = base.properties!
    expect(diffMappings(base, { properties: rest })).toEqual({ added: [], changed: [], removed: ['price'] })
  })

  it('ignores key order', () => {
    const a: Mapping = { properties: { d: { type: 'date', format: 'x' } } }
    const b: Mapping = { properties: { d: { format: 'x', type: 'date' } } }
    expect(diffMappings(a, b)).toEqual({ added: [], changed: [], removed: [] })
  })
})

describe('replaceField', () => {
  it('keeps children when replacing an object or text field', () => {
    const r = replaceField(base, 'title', { type: 'text', analyzer: 'english' })
    expect(r.properties!.title).toEqual({ type: 'text', analyzer: 'english', fields: { raw: { type: 'keyword' } } })
    expect(replaceField(base, 'title.raw', { type: 'keyword', ignore_above: 256 }).properties!.title!.fields!.raw).toEqual({ type: 'keyword', ignore_above: 256 })
  })
})

describe('reindex routine', () => {
  it('names the next index and copies only portable settings', () => {
    expect(nextIndexName('listings-v7')).toBe('listings-v8')
    expect(nextIndexName('users')).toBe('users-v2')
    expect(nextIndexName('listings-v6', ['listings-v7', 'listings-v8'])).toBe('listings-v9')
    expect(copyableSettings({ 'index.number_of_shards': '1', 'index.uuid': 'x', 'index.creation_date': '1', 'index.analysis.analyzer.a.type': 'custom', 'index.provided_name': 'p' })).toEqual({
      'index.number_of_shards': '1',
      'index.analysis.analyzer.a.type': 'custom'
    })
  })

  it('creates, reindexes, polls, verifies and swaps aliases with confirmation', () => {
    const r = reindexRoutine({ source: 'listings-v7', target: 'listings-v8', mapping: base, settings: {}, aliases: [{ name: 'listings', isWriteIndex: true }] })
    expect(r.steps.map((s) => s.id)).toEqual(['health', 'count_source', 'create_target', 'start_reindex', 'wait', 'verify', 'swap_aliases'])
    expect(r.variables).toEqual({ source: 'listings-v7', target: 'listings-v8' })
    expect(r.steps.at(-1)).toMatchObject({ confirm: true })
    expect(JSON.parse(r.steps.at(-1)!.body!).actions).toEqual([
      { remove: { index: '{{source}}', alias: 'listings' } },
      { add: { index: '{{target}}', alias: 'listings', is_write_index: true } }
    ])
  })
})

describe('removeField', () => {
  const m = { properties: { title: { type: 'text', fields: { raw: { type: 'keyword' } } }, seller: { properties: { name: { type: 'keyword' }, phone: { type: 'keyword' } } } } }
  it('removes top-level, nested and multi-fields without touching the input', () => {
    expect(removeField(m, 'seller.phone').properties!.seller!.properties).toEqual({ name: { type: 'keyword' } })
    expect(removeField(m, 'title.raw').properties!.title).toEqual({ type: 'text' })
    expect(Object.keys(removeField(m, 'seller').properties!)).toEqual(['title'])
    expect(m.properties.seller.properties.phone).toBeDefined()
    // An object left empty goes too.
    const lone = { properties: { a: { properties: { b: { properties: { c: { type: 'keyword' } } } } }, d: { type: 'long' } } }
    expect(removeField(lone, 'a.b.c')).toEqual({ properties: { d: { type: 'long' } } })
  })
  it('throws for unknown fields', () => {
    expect(() => removeField(m, 'nope')).toThrow('nope not found')
    expect(() => removeField(m, 'seller.nope')).toThrow('seller.nope not found')
  })
})
