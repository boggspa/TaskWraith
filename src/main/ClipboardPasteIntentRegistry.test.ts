import { describe, expect, it } from 'vitest'
import { ClipboardPasteIntentRegistry } from './ClipboardPasteIntentRegistry'

describe('ClipboardPasteIntentRegistry', () => {
  it('binds an intent to one renderer and consumes it exactly once', () => {
    const registry = new ClipboardPasteIntentRegistry(1_500, () => 100)
    expect(registry.issue(11, 'opaque-token')).toBe(true)
    expect(registry.consume(12, 'opaque-token')).toBe(false)
    expect(registry.consume(11, 'opaque-token')).toBe(true)
    expect(registry.consume(11, 'opaque-token')).toBe(false)
  })

  it('expires quickly and consumes a failed attempt', () => {
    let now = 100
    const registry = new ClipboardPasteIntentRegistry(1_500, () => now)
    registry.issue(11, 'opaque-token')
    now = 1_601
    expect(registry.consume(11, 'opaque-token')).toBe(false)

    now = 2_000
    registry.issue(11, 'next-token')
    expect(registry.consume(11, 'guessed-token')).toBe(false)
    expect(registry.consume(11, 'next-token')).toBe(false)
  })

  it('replaces and revokes renderer intents without retaining arbitrary tokens', () => {
    const registry = new ClipboardPasteIntentRegistry()
    expect(registry.issue(11, '')).toBe(false)
    expect(registry.issue(11, 'first')).toBe(true)
    expect(registry.issue(11, 'second')).toBe(true)
    expect(registry.consume(11, 'first')).toBe(false)

    registry.issue(11, 'third')
    registry.revoke(11)
    expect(registry.consume(11, 'third')).toBe(false)
  })
})
