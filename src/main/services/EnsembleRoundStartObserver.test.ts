import { describe, expect, it, vi } from 'vitest'
import {
  createEnsembleRoundStartObservation,
  type EnsembleRoundStartObserver
} from './EnsembleRoundStartObserver'

function observer() {
  return {
    onRoundReserved: vi.fn<EnsembleRoundStartObserver['onRoundReserved']>(),
    onRoundPersistedBeforeParticipants: vi
      .fn<EnsembleRoundStartObserver['onRoundPersistedBeforeParticipants']>()
      .mockResolvedValue(undefined),
    onRoundStartUnproven: vi.fn<EnsembleRoundStartObserver['onRoundStartUnproven']>()
  }
}

describe('createEnsembleRoundStartObservation', () => {
  it('leaves ordinary unobserved round work available', async () => {
    const observation = createEnsembleRoundStartObservation(undefined, 'round-a')
    observation.reserved()
    await observation.beforeParticipants()
    observation.unproven()
    await observation.beforeParticipants()
  })

  it('captures reservation synchronously and awaits evidence before continuing', async () => {
    const callbacks = observer()
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    callbacks.onRoundReserved.mockImplementation(() => events.push('reserved'))
    callbacks.onRoundPersistedBeforeParticipants.mockImplementation(async () => {
      events.push('barrier')
      await gate
      events.push('durable')
    })
    const observation = createEnsembleRoundStartObservation(callbacks, 'round-a')
    observation.reserved()
    expect(events).toEqual(['reserved'])
    const start = observation.beforeParticipants().then(() => events.push('participants'))
    await Promise.resolve()
    expect(events).toEqual(['reserved', 'barrier'])
    release()
    await start
    expect(events).toEqual(['reserved', 'barrier', 'durable', 'participants'])
    expect(callbacks.onRoundReserved).toHaveBeenCalledWith('round-a')
    expect(callbacks.onRoundPersistedBeforeParticipants).toHaveBeenCalledWith('round-a')
    expect(callbacks.onRoundStartUnproven).not.toHaveBeenCalled()
  })

  it('reuses one observation across duplicate and continuation callbacks for the same round', async () => {
    const callbacks = observer()
    const first = createEnsembleRoundStartObservation(callbacks, 'round-a')
    const continuation = createEnsembleRoundStartObservation(callbacks, 'round-a')
    expect(continuation).toBe(first)
    first.reserved()
    continuation.reserved()
    const initial = first.beforeParticipants()
    expect(continuation.beforeParticipants()).toBe(initial)
    await initial
    await continuation.beforeParticipants()
    expect(callbacks.onRoundReserved).toHaveBeenCalledTimes(1)
    expect(callbacks.onRoundPersistedBeforeParticipants).toHaveBeenCalledTimes(1)
    first.unproven()
    continuation.unproven()
    expect(callbacks.onRoundStartUnproven).toHaveBeenCalledTimes(1)
  })

  it('does not conflate separate rounds or observers', async () => {
    const callbacks = observer()
    const other = observer()
    for (const [target, roundId] of [
      [callbacks, 'round-a'],
      [callbacks, 'round-b'],
      [other, 'round-a']
    ] as const) {
      const observation = createEnsembleRoundStartObservation(target, roundId)
      observation.reserved()
      await observation.beforeParticipants()
    }
    expect(callbacks.onRoundPersistedBeforeParticipants.mock.calls).toEqual([
      ['round-a'],
      ['round-b']
    ])
    expect(other.onRoundPersistedBeforeParticipants).toHaveBeenCalledExactlyOnceWith('round-a')
  })

  it('contains reservation failure and permanently prevents later publication', async () => {
    const callbacks = observer()
    callbacks.onRoundReserved.mockImplementation(() => {
      throw new Error('capture failed')
    })
    const observation = createEnsembleRoundStartObservation(callbacks, 'round-a')
    expect(() => observation.reserved()).not.toThrow()
    observation.reserved()
    await observation.beforeParticipants()
    observation.unproven()
    expect(callbacks.onRoundReserved).toHaveBeenCalledTimes(1)
    expect(callbacks.onRoundPersistedBeforeParticipants).not.toHaveBeenCalled()
    expect(callbacks.onRoundStartUnproven).toHaveBeenCalledExactlyOnceWith('round-a')
  })

  it.each(['throw', 'reject'] as const)(
    'contains a %s before participants, signalling uncertainty once',
    async (failure) => {
      const callbacks = observer()
      callbacks.onRoundPersistedBeforeParticipants.mockImplementation(() => {
        if (failure === 'throw') throw new Error('observer threw')
        return Promise.reject(new Error('observer rejected'))
      })
      const observation = createEnsembleRoundStartObservation(callbacks, 'round-a')
      const participantWork = vi.fn()
      observation.reserved()
      await observation.beforeParticipants().then(participantWork)
      await observation.beforeParticipants()
      observation.unproven()
      expect(participantWork).toHaveBeenCalledTimes(1)
      expect(callbacks.onRoundPersistedBeforeParticipants).toHaveBeenCalledTimes(1)
      expect(callbacks.onRoundStartUnproven).toHaveBeenCalledExactlyOnceWith('round-a')
    }
  )

  it('contains an uncertainty callback that throws after mutating', async () => {
    const callbacks = observer()
    let mutations = 0
    callbacks.onRoundStartUnproven.mockImplementation(() => {
      mutations += 1
      throw new Error('after mutation')
    })
    const observation = createEnsembleRoundStartObservation(callbacks, 'round-a')
    expect(() => observation.unproven()).not.toThrow()
    observation.unproven()
    observation.reserved()
    await observation.beforeParticipants()
    expect(mutations).toBe(1)
    expect(callbacks.onRoundReserved).not.toHaveBeenCalled()
    expect(callbacks.onRoundPersistedBeforeParticipants).not.toHaveBeenCalled()
  })

  it('abandons a before-participants observation which has no reservation', async () => {
    const callbacks = observer()
    const observation = createEnsembleRoundStartObservation(callbacks, 'round-a')
    await observation.beforeParticipants()
    observation.reserved()
    expect(callbacks.onRoundStartUnproven).toHaveBeenCalledExactlyOnceWith('round-a')
    expect(callbacks.onRoundReserved).not.toHaveBeenCalled()
    expect(callbacks.onRoundPersistedBeforeParticipants).not.toHaveBeenCalled()
  })

  it('fences reentrant reservation and uncertainty callbacks', async () => {
    const callbacks = observer()
    const observation = createEnsembleRoundStartObservation(callbacks, 'round-a')
    callbacks.onRoundReserved.mockImplementation(() => observation.reserved())
    callbacks.onRoundStartUnproven.mockImplementation(() => observation.unproven())
    observation.reserved()
    observation.unproven()
    await observation.beforeParticipants()
    expect(callbacks.onRoundReserved).toHaveBeenCalledTimes(1)
    expect(callbacks.onRoundStartUnproven).toHaveBeenCalledTimes(1)
    expect(callbacks.onRoundPersistedBeforeParticipants).not.toHaveBeenCalled()
  })

  it('fences a queued before-participants callback when uncertainty arrives first', async () => {
    const callbacks = observer()
    const observation = createEnsembleRoundStartObservation(callbacks, 'round-a')
    observation.reserved()
    const pending = observation.beforeParticipants()
    observation.unproven()
    await pending
    expect(callbacks.onRoundPersistedBeforeParticipants).not.toHaveBeenCalled()
    expect(callbacks.onRoundStartUnproven).toHaveBeenCalledTimes(1)
  })
})
