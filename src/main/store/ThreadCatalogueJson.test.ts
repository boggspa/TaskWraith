import { describe, expect, it } from 'vitest'
import { encodeThreadJsonChunks } from './ThreadCatalogueJson'

describe('bounded history JSON encoding', () => {
  it.each([
    null,
    true,
    3.2,
    -0,
    'text',
    '',
    '\ud800',
    '\udc00',
    '😀'.repeat(9000),
    { content: '\n\t"\\\u0000'.repeat(20000), nested: [null, { x: 1, empty: undefined }] },
    [undefined, Number.NaN, Number.POSITIVE_INFINITY, { integer: 1 }]
  ])('matches ordinary JSON serialization for persisted JSON values', (value) => {
    const chunks = [...encodeThreadJsonChunks(value, 997)]
    expect(chunks.every((chunk) => chunk.byteLength <= 997)).toBe(true)
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')).toBe(
      JSON.stringify(value)
    )
  })

  it('does not reuse a transferred buffer', () => {
    const iterator = encodeThreadJsonChunks({ content: 'x'.repeat(1000) }, 100)
    const first = iterator.next().value!
    const transferred = structuredClone(first, { transfer: [first.buffer] })
    expect(first.byteLength).toBe(0)
    const remaining = [...iterator]
    const all = [transferred, ...remaining]
    expect(
      JSON.parse(Buffer.concat(all.map((chunk) => Buffer.from(chunk))).toString('utf8')).content
    ).toHaveLength(1000)
  })

  it('rejects cyclic input without following it indefinitely', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => [...encodeThreadJsonChunks(cyclic)]).toThrow('cyclic')
  })
})
