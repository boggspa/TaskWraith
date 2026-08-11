import { describe, expect, it, vi } from 'vitest'
import {
  createBrokerSteerTransport,
  formatSteeringInjection,
  type BrokerSteerTransport
} from './BrokerSteerTransport'

describe('BrokerSteerTransport', () => {
  function makeTransport(initialPending: string | null = null): {
    transport: BrokerSteerTransport
    /** Read the live pending value (reads the getter, not a snapshot). */
    readPending: () => string | null
  } {
    let pending = initialPending
    const transport = createBrokerSteerTransport(
      (text) => {
        pending = text
      },
      () => pending
    )
    return { transport, readPending: () => pending }
  }

  it('sendSteer stores the steering text', () => {
    const { transport, readPending } = makeTransport()
    expect(transport.sendSteer('please stop')).toBe(true)
    expect(readPending()).toBe('please stop')
  })

  it('sendSteer replaces existing pending text (last write wins)', () => {
    const { transport, readPending } = makeTransport()
    transport.sendSteer('first message')
    transport.sendSteer('second message')
    expect(readPending()).toBe('second message')
  })

  it('sendSteer rejects empty/whitespace-only text', () => {
    const { transport, readPending } = makeTransport()
    expect(transport.sendSteer('')).toBe(false)
    expect(transport.sendSteer('   ')).toBe(false)
    expect(readPending()).toBeNull()
  })

  it('peek returns pending text without consuming it', () => {
    const { transport, readPending } = makeTransport('hello')
    expect(transport.peek()).toBe('hello')
    expect(readPending()).toBe('hello') // still there
  })

  it('drain returns and clears pending text', () => {
    const { transport, readPending } = makeTransport()
    const onDelivered = vi.fn()
    transport.sendSteer('hello', { entryId: 'entry-1', onDelivered })
    expect(transport.drain()).toBe('hello')
    expect(readPending()).toBeNull()
    expect(onDelivered).toHaveBeenCalledTimes(1)
    expect(transport.drain()).toBeNull()
    expect(onDelivered).toHaveBeenCalledTimes(1)
  })

  it('cancel clears pending text', () => {
    const { transport, readPending } = makeTransport()
    const onDelivered = vi.fn()
    transport.sendSteer('hello', { entryId: 'entry-1', onDelivered })
    transport.cancel()
    expect(readPending()).toBeNull()
    expect(transport.peek()).toBeNull()
    expect(onDelivered).not.toHaveBeenCalled()
  })

  it('cancel is a no-op when nothing is pending', () => {
    const { transport } = makeTransport()
    expect(() => transport.cancel()).not.toThrow()
  })
})

describe('formatSteeringInjection', () => {
  it('wraps text in a distinguishable prefix and suffix', () => {
    const result = formatSteeringInjection('Please review the tests.')
    expect(result).toContain('[TaskWraith Steering]')
    expect(result).toContain('Please review the tests.')
    expect(result).toContain('--- end steering ---')
  })

  it('preserves newlines in the steering text', () => {
    const result = formatSteeringInjection('Line 1\nLine 2')
    expect(result).toContain('Line 1\nLine 2')
  })
})
