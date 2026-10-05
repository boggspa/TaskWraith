import { describe, expect, it } from 'vitest'
import {
  ORPHAN_RETIREMENT_TOKEN,
  retireOrphanThreadAuthority,
  type ThreadAuthorityRetirementContext,
  type ThreadAuthorityRetirementObservation,
  type ThreadAuthorityRetirementOutcome,
  type ThreadAuthorityRetirementRemoveAndSync
} from './ThreadAuthorityRetirement'

const THREAD = 'thread-1'
const RESERVATION = { host: 'host-0', grant: 7 }

class TestFs {
  removeCalls = 0
  failNext = false

  removeAndSync: ThreadAuthorityRetirementRemoveAndSync = async () => {
    this.removeCalls += 1
    if (this.failNext) {
      this.failNext = false
      throw new Error('forced remove failure')
    }
  }
}

/**
 * A witness that mirrors the real `threadPublicationAuthorityWitness`:
 * returns true on its first call (file is present and unchanged from the
 * capture moment) and false thereafter (file is gone, or its identity
 * changed). Pass a different builder when a test needs a witness that
 * reports something other than the realistic unlink outcome.
 */
function realisticWitness(): () => boolean {
  let firstCall = true
  return () => {
    if (firstCall) {
      firstCall = false
      return true
    }
    return false
  }
}

function constantWitness(value: boolean): () => boolean {
  return () => value
}

function observation(
  witness: () => boolean = realisticWitness(),
  partial: Partial<Omit<ThreadAuthorityRetirementObservation, 'exactMarkWitness'>> = {}
): ThreadAuthorityRetirementObservation {
  return {
    reservation: RESERVATION,
    exactMarkWitness: witness,
    writerEnded: true,
    erasing: false,
    ...partial
  }
}

function context(
  removeAndSync: ThreadAuthorityRetirementRemoveAndSync,
  observationValue: ThreadAuthorityRetirementObservation
): ThreadAuthorityRetirementContext {
  return { reservation: RESERVATION, removeAndSync, observation: observationValue }
}

describe('ThreadAuthorityRetirement.orphan keep-custody policy', () => {
  it('exports an opaque orphan-token symbol distinct from any other token', () => {
    expect(typeof ORPHAN_RETIREMENT_TOKEN).toBe('symbol')
    expect(ORPHAN_RETIREMENT_TOKEN).not.toBe(Symbol.for('something-else'))
  })

  it('retires the mark when preconditions pass and remove+sync succeed', async () => {
    const fs = new TestFs()
    const obs = observation()
    const outcome: ThreadAuthorityRetirementOutcome = await retireOrphanThreadAuthority(
      THREAD,
      context(fs.removeAndSync, obs)
    )
    expect(outcome).toEqual({ kind: 'retired' })
    expect(fs.removeCalls).toBe(1)
  })

  it('refuses when the writer has not ended', async () => {
    const fs = new TestFs()
    const obs = observation(realisticWitness(), { writerEnded: false })
    const outcome = await retireOrphanThreadAuthority(THREAD, context(fs.removeAndSync, obs))
    expect(outcome).toEqual({ kind: 'busy', reason: 'live_writer' })
    expect(fs.removeCalls).toBe(0)
  })

  it('refuses when the catalogue is erasing this thread', async () => {
    const fs = new TestFs()
    const obs = observation(realisticWitness(), { erasing: true })
    const outcome = await retireOrphanThreadAuthority(THREAD, context(fs.removeAndSync, obs))
    expect(outcome).toEqual({ kind: 'busy', reason: 'erasing' })
    expect(fs.removeCalls).toBe(0)
  })

  it('refuses when the exact mark witness already shows damage', async () => {
    const fs = new TestFs()
    const obs = observation(constantWitness(false))
    const outcome = await retireOrphanThreadAuthority(THREAD, context(fs.removeAndSync, obs))
    expect(outcome).toEqual({ kind: 'busy', reason: 'damaged' })
    expect(fs.removeCalls).toBe(0)
  })

  it('refuses when the reservation does not match the captured observation', async () => {
    const fs = new TestFs()
    const obs = observation()
    const outcome = await retireOrphanThreadAuthority(THREAD, {
      reservation: { host: 'host-0', grant: 99 },
      removeAndSync: fs.removeAndSync,
      observation: obs
    })
    expect(outcome).toEqual({ kind: 'busy', reason: 'damaged' })
    expect(fs.removeCalls).toBe(0)
  })

  it('returns uncertain when remove+sync throws and the witness was healthy', async () => {
    const fs = new TestFs()
    fs.failNext = true
    const obs = observation()
    const outcome = await retireOrphanThreadAuthority(THREAD, context(fs.removeAndSync, obs))
    expect(outcome).toEqual({ kind: 'uncertain', reason: 'remove_failed' })
    expect(fs.removeCalls).toBe(1)
  })

  it('returns uncertain when the witness still reads the captured file after sync', async () => {
    const fs = new TestFs()
    // Witness always returns true: a successful remove would have changed
    // the file identity, so the post-sync check sees a race and refuses to
    // call the retirement durable.
    const obs = observation(constantWitness(true))
    const outcome = await retireOrphanThreadAuthority(THREAD, context(fs.removeAndSync, obs))
    expect(outcome).toEqual({ kind: 'uncertain', reason: 'witness_changed' })
    expect(fs.removeCalls).toBe(1)
  })

  it('refuses a thread id that escapes the chat-path safety check', async () => {
    const fs = new TestFs()
    const obs = observation()
    const outcome = await retireOrphanThreadAuthority('../escape', {
      reservation: RESERVATION,
      removeAndSync: fs.removeAndSync,
      observation: obs
    })
    expect(outcome).toEqual({ kind: 'busy', reason: 'damaged' })
    expect(fs.removeCalls).toBe(0)
  })
})
