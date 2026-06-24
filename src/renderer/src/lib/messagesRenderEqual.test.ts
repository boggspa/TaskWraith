import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { deepEqual, messagesRenderEqual } from './messagesRenderEqual'

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: 'hello world',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides
  } as ChatMessage
}

describe('deepEqual', () => {
  it('treats identical references and equal primitives as equal', () => {
    const obj = { a: 1 }
    expect(deepEqual(obj, obj)).toBe(true)
    expect(deepEqual(1, 1)).toBe(true)
    expect(deepEqual('x', 'x')).toBe(true)
    expect(deepEqual(true, true)).toBe(true)
    expect(deepEqual(null, null)).toBe(true)
    expect(deepEqual(undefined, undefined)).toBe(true)
  })

  it('distinguishes primitives and types', () => {
    expect(deepEqual(1, 2)).toBe(false)
    expect(deepEqual('a', 'b')).toBe(false)
    expect(deepEqual(0, '0')).toBe(false)
    expect(deepEqual(false, 0)).toBe(false)
    expect(deepEqual(null, undefined)).toBe(false)
  })

  it('treats null vs object as unequal (the typeof-null trap)', () => {
    expect(deepEqual(null, {})).toBe(false)
    expect(deepEqual({}, null)).toBe(false)
    expect(deepEqual(null, { a: 1 })).toBe(false)
  })

  it('deep-compares nested objects and arrays structurally', () => {
    expect(deepEqual({ a: 1, b: { c: [1, 2, 3] } }, { a: 1, b: { c: [1, 2, 3] } })).toBe(true)
    expect(deepEqual({ a: 1, b: { c: [1, 2, 3] } }, { a: 1, b: { c: [1, 2, 4] } })).toBe(false)
  })

  it('is strict about key SETS (extra/missing keys ⇒ unequal)', () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(false)
    expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false)
  })

  it('distinguishes arrays from objects and respects length/order', () => {
    expect(deepEqual([1, 2], { 0: 1, 1: 2, length: 2 })).toBe(false)
    expect(deepEqual([1, 2, 3], [1, 2])).toBe(false)
    expect(deepEqual([1, 2, 3], [3, 2, 1])).toBe(false)
    expect(deepEqual([], [])).toBe(true)
  })

  it('treats NaN as unequal (a harmless false negative)', () => {
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(false)
  })
})

describe('messagesRenderEqual', () => {
  it('returns true for the same array reference', () => {
    const arr = [msg()]
    expect(messagesRenderEqual(arr, arr)).toBe(true)
  })

  it('returns true for distinct arrays of deeply-equal messages (the IPC re-deserialise case)', () => {
    const a = [msg({ id: 'a', content: 'one' }), msg({ id: 'b', content: 'two' })]
    const b = [msg({ id: 'a', content: 'one' }), msg({ id: 'b', content: 'two' })]
    expect(a).not.toBe(b)
    expect(messagesRenderEqual(a, b)).toBe(true)
  })

  it('returns false when any message content changed (a streamed token grew the tail)', () => {
    const a = [msg({ id: 'a', content: 'hello' })]
    const b = [msg({ id: 'a', content: 'hello world' })]
    expect(messagesRenderEqual(a, b)).toBe(false)
  })

  it('returns false when the message count changed (a new row arrived)', () => {
    const a = [msg({ id: 'a' })]
    const b = [msg({ id: 'a' }), msg({ id: 'b' })]
    expect(messagesRenderEqual(a, b)).toBe(false)
  })

  it('returns false when a render-affecting metadata field changed', () => {
    const a = [msg({ id: 'a', metadata: { kind: 'normal' } })]
    const b = [msg({ id: 'a', metadata: { kind: 'agentQuestion' } })]
    expect(messagesRenderEqual(a, b)).toBe(false)
  })

  it('returns false when tool activities changed (status flip / new activity)', () => {
    const a = [
      msg({ id: 't', role: 'tool', toolActivities: [{ id: 'x', status: 'running' } as never] })
    ]
    const b = [
      msg({ id: 't', role: 'tool', toolActivities: [{ id: 'x', status: 'success' } as never] })
    ]
    expect(messagesRenderEqual(a, b)).toBe(false)
  })

  it('returns false when only the ORDER changed', () => {
    const a = [msg({ id: 'a' }), msg({ id: 'b' })]
    const b = [msg({ id: 'b' }), msg({ id: 'a' })]
    expect(messagesRenderEqual(a, b)).toBe(false)
  })

  it('short-circuits cheaply on reference-equal elements', () => {
    const shared = msg({ id: 'shared', content: 'x'.repeat(10000) })
    const a = [shared, msg({ id: 'b', content: 'tail' })]
    const b = [shared, msg({ id: 'b', content: 'tail' })]
    expect(messagesRenderEqual(a, b)).toBe(true)
  })

  it('handles empty lists', () => {
    expect(messagesRenderEqual([], [])).toBe(true)
  })
})
