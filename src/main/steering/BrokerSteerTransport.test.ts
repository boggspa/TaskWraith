import { describe, expect, it, vi } from 'vitest'
import {
  createBrokerSteerTransport,
  drainPendingSteerTextFromSession,
  formatBrokerSteeringElement,
  formatSteeringInjection,
  reservePendingSteerTextFromSession,
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
    const onRejected = vi.fn()
    transport.sendSteer('hello', { entryId: 'entry-1', onDelivered, onRejected })
    transport.cancel()
    expect(readPending()).toBeNull()
    expect(transport.peek()).toBeNull()
    expect(onDelivered).not.toHaveBeenCalled()
    expect(onRejected).toHaveBeenCalledOnce()
  })

  it('commits delivery evidence only after a reserved batch is accepted', () => {
    const { transport, readPending } = makeTransport()
    const onDelivered = vi.fn()
    transport.sendSteer('hello', { entryId: 'entry-1', onDelivered })

    const reservation = transport.reserve()
    expect(reservation?.text).toBe('hello')
    expect(readPending()).toBeNull()
    expect(onDelivered).not.toHaveBeenCalled()

    reservation?.commit()
    expect(onDelivered).toHaveBeenCalledOnce()
  })

  it('rolls a refused reservation back ahead of later steering text', () => {
    const { transport, readPending } = makeTransport()
    const firstDelivered = vi.fn()
    const secondDelivered = vi.fn()
    transport.sendSteer('first', { entryId: 'entry-1', onDelivered: firstDelivered })
    const reservation = transport.reserve()
    transport.sendSteer('second', { entryId: 'entry-2', onDelivered: secondDelivered })

    reservation?.rollback()

    expect(readPending()).toContain('first')
    expect(readPending()).toContain('second')
    expect(readPending()!.indexOf('first')).toBeLessThan(readPending()!.indexOf('second'))
    transport.drain()
    expect(firstDelivered).toHaveBeenCalledOnce()
    expect(secondDelivered).toHaveBeenCalledOnce()
  })

  it('allows only one open reservation so rollback order cannot invert', () => {
    const { transport, readPending } = makeTransport()
    transport.sendSteer('first')
    const firstReservation = transport.reserve()
    transport.sendSteer('second')

    expect(transport.reserve()).toBeNull()
    expect(readPending()).toBe('second')

    firstReservation?.rollback()
    expect(readPending()).toContain('first')
    expect(readPending()).toContain('second')
    expect(readPending()!.indexOf('first')).toBeLessThan(readPending()!.indexOf('second'))
  })

  it('does not bypass an open transport reservation through the session fallback', () => {
    let pendingSteerText: string | null = null
    const transport = createBrokerSteerTransport(
      (text) => {
        pendingSteerText = text
      },
      () => pendingSteerText
    )
    const session = {
      liveSteerTransport: transport,
      get pendingSteerText(): string | null {
        return pendingSteerText
      },
      set pendingSteerText(text: string | null) {
        pendingSteerText = text
      }
    }
    transport.sendSteer('first')
    const firstReservation = reservePendingSteerTextFromSession(session)
    transport.sendSteer('second')

    expect(reservePendingSteerTextFromSession(session)).toBeNull()
    expect(drainPendingSteerTextFromSession(session)).toBeNull()
    expect(pendingSteerText).toBe('second')

    firstReservation?.rollback()
    expect(pendingSteerText).toContain('first')
    expect(pendingSteerText).toContain('second')
  })

  it('marks an in-flight reservation ambiguous when cancellation overlaps admission', () => {
    const { transport } = makeTransport()
    const onDelivered = vi.fn()
    const onAmbiguous = vi.fn()
    transport.sendSteer('hello', { entryId: 'entry-1', onDelivered, onAmbiguous })
    const reservation = transport.reserve()

    transport.cancel()
    reservation?.commit()

    expect(onAmbiguous).toHaveBeenCalledOnce()
    expect(onDelivered).not.toHaveBeenCalled()
  })

  it('does not re-arm a cancelled open reservation after late rollback', () => {
    const { transport, readPending } = makeTransport()
    const onAmbiguous = vi.fn()
    transport.sendSteer('hello', {
      entryId: 'entry-1',
      onDelivered: vi.fn(),
      onAmbiguous
    })
    const reservation = transport.reserve()

    transport.cancel()
    reservation?.rollback()

    expect(readPending()).toBeNull()
    expect(onAmbiguous).toHaveBeenCalledOnce()
  })

  it('cancel is a no-op when nothing is pending', () => {
    const { transport } = makeTransport()
    expect(() => transport.cancel()).not.toThrow()
  })

  it('settles a bare-session fallback reservation only once', () => {
    const session = {
      liveSteerTransport: undefined,
      pendingSteerText: 'once' as string | null
    }
    const reservation = reservePendingSteerTextFromSession(session)

    reservation?.rollback()
    reservation?.rollback()

    expect(session.pendingSteerText).toBe('once')
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
