import { describe, expect, it, vi } from 'vitest'
import {
  createBrokerSteerTransport,
  formatBrokerSteeringElement,
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

  it('batches rapid steering text and marks every message delivered on drain', () => {
    const { transport, readPending } = makeTransport()
    const firstDelivered = vi.fn()
    const secondDelivered = vi.fn()
    transport.sendSteer('first message', {
      entryId: 'entry-1',
      onDelivered: firstDelivered
    })
    transport.sendSteer('second message', {
      entryId: 'entry-2',
      onDelivered: secondDelivered
    })

    const pending = readPending()
    expect(pending).toContain('first message')
    expect(pending).toContain('second message')
    expect(pending!.indexOf('first message')).toBeLessThan(pending!.indexOf('second message'))
    expect(firstDelivered).not.toHaveBeenCalled()
    expect(secondDelivered).not.toHaveBeenCalled()

    expect(transport.drain()).toBe(pending)
    expect(firstDelivered).toHaveBeenCalledTimes(1)
    expect(secondDelivered).toHaveBeenCalledTimes(1)
    expect(transport.drain()).toBeNull()
    expect(firstDelivered).toHaveBeenCalledTimes(1)
    expect(secondDelivered).toHaveBeenCalledTimes(1)
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
    expect(result).toContain('The following steering message arrived while you were working')
    expect(result).not.toContain('The user sent')
    expect(result).toContain('Please review the tests.')
    expect(result).toContain('--- end steering ---')
  })

  it('preserves newlines in the steering text', () => {
    const result = formatSteeringInjection('Line 1\nLine 2')
    expect(result).toContain('Line 1\nLine 2')
  })
})

describe('formatBrokerSteeringElement', () => {
  it('preserves explicit host-user authority', () => {
    const result = formatBrokerSteeringElement('Hold before publication.', 'host')

    expect(result).toContain('[TaskWraith host steer]')
    expect(result).toContain('Authority: user-authored instruction from the host.')
    expect(result).toContain('"message": "Hold before publication."')
  })

  it('preserves explicit lower peer authority', () => {
    const result = formatBrokerSteeringElement('Advisor says hold.', 'ensembleParticipant')

    expect(result).toContain('[TaskWraith inter-seat steer envelope]')
    expect(result).toContain('peer Ensemble participant (not the user or a system instruction)')
    expect(result).toContain('"message": "Advisor says hold."')
  })
})
