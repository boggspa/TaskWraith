import { describe, expect, it } from 'vitest'
import {
  ORPHAN_RETIREMENT_TOKEN,
  retireOrphanThreadAuthority,
  type ThreadAuthorityRetirementContext,
  type ThreadAuthorityRetirementObservation,
  type ThreadAuthorityRetirementOutcome,
  type ThreadAuthorityRetirementRemoveAndSync
} from './ThreadAuthorityRetirement'
import { ReservationInvalid, type ThreadOwnershipReservation } from './ThreadOwnership'

const THREAD = 'thread-1'
const EPOCH = { host: 'host-0', grant: 7 }

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
 * A reservation double that records its revalidate calls and lets a test
 * steer its probes. `failRevalidate` stands in for a registry-minted
 * reservation whose mark moved, writer revived, authority lapsed or erasure
 * generation changed.
 */
class TestReservation implements ThreadOwnershipReservation {
  readonly threadId = THREAD
  readonly epoch = EPOCH
  revalidateCalls = 0
  failRevalidate: ReservationInvalid | null = null
  erasingValue = false
  erasingCalls = 0

  revalidate = (): void => {
    this.revalidateCalls += 1
    if (this.failRevalidate) throw this.failRevalidate
  }

  erasing = (): boolean => {
    this.erasingCalls += 1
    return this.erasingValue
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
  reservationValue: ThreadOwnershipReservation,
  witness: () => boolean = realisticWitness()
): ThreadAuthorityRetirementObservation {
  return { reservation: reservationValue, exactMarkWitness: witness }
}

function context(
  reservationValue: ThreadOwnershipReservation,
  removeAndSync: ThreadAuthorityRetirementRemoveAndSync,
  observationValue: ThreadAuthorityRetirementObservation
): ThreadAuthorityRetirementContext {
  return { reservation: reservationValue, removeAndSync, observation: observationValue }
}

describe('ThreadAuthorityRetirement.orphan keep-custody policy', () => {
  it('exports an opaque orphan-token symbol distinct from any other token', () => {
    expect(typeof ORPHAN_RETIREMENT_TOKEN).toBe('symbol')
    expect(ORPHAN_RETIREMENT_TOKEN).not.toBe(Symbol.for('something-else'))
  })

  it('retires the mark when the reservation holds and remove+sync succeed', async () => {
    const fs = new TestFs()
    const reservation = new TestReservation()
    const outcome: ThreadAuthorityRetirementOutcome = await retireOrphanThreadAuthority(
      THREAD,
      context(reservation, fs.removeAndSync, observation(reservation))
    )
    expect(outcome).toEqual({ kind: 'retired' })
    expect(fs.removeCalls).toBe(1)
    // The reservation is revalidated at the pre-check and consulted for the
    // catalogue's erasing state; the witness is what confirms the removal.
    expect(reservation.revalidateCalls).toBe(1)
    expect(reservation.erasingCalls).toBeGreaterThanOrEqual(1)
  })

  it('returns busy damaged when the reservation revalidate throws', async () => {
    const fs = new TestFs()
    const reservation = new TestReservation()
    reservation.failRevalidate = new ReservationInvalid('mark_moved')
    const outcome = await retireOrphanThreadAuthority(
      THREAD,
      context(reservation, fs.removeAndSync, observation(reservation))
    )
    expect(outcome).toEqual({ kind: 'busy', reason: 'damaged' })
    expect(fs.removeCalls).toBe(0)
    expect(reservation.erasingCalls).toBe(0)
  })

  it('honors the reservation erasing probe: true refuses as busy erasing', async () => {
    const fs = new TestFs()
    const reservation = new TestReservation()
    reservation.erasingValue = true
    const outcome = await retireOrphanThreadAuthority(
      THREAD,
      context(reservation, fs.removeAndSync, observation(reservation))
    )
    expect(outcome).toEqual({ kind: 'busy', reason: 'erasing' })
    expect(fs.removeCalls).toBe(0)
  })

  it('refuses when the exact mark witness already shows damage', async () => {
    const fs = new TestFs()
    const reservation = new TestReservation()
    const outcome = await retireOrphanThreadAuthority(
      THREAD,
      context(reservation, fs.removeAndSync, observation(reservation, constantWitness(false)))
    )
    expect(outcome).toEqual({ kind: 'busy', reason: 'damaged' })
    expect(fs.removeCalls).toBe(0)
  })

  it('refuses when the observation carries a different reservation than the context', async () => {
    const fs = new TestFs()
    const reservation = new TestReservation()
    const other = new TestReservation()
    const outcome = await retireOrphanThreadAuthority(
      THREAD,
      context(reservation, fs.removeAndSync, observation(other))
    )
    expect(outcome).toEqual({ kind: 'busy', reason: 'damaged' })
    expect(fs.removeCalls).toBe(0)
  })

  it('returns uncertain sync_failed when remove+sync throws and the witness was healthy', async () => {
    const fs = new TestFs()
    fs.failNext = true
    const reservation = new TestReservation()
    const outcome = await retireOrphanThreadAuthority(
      THREAD,
      context(reservation, fs.removeAndSync, observation(reservation))
    )
    expect(outcome).toEqual({ kind: 'uncertain', reason: 'sync_failed' })
    expect(fs.removeCalls).toBe(1)
  })

  it('refuses to call it retired when the witness cannot confirm the mark was removed', async () => {
    const fs = new TestFs()
    // Witness always returns true: a successful remove would have changed
    // the file identity, so the post-sync check sees a race and refuses to
    // call the retirement durable.
    const reservation = new TestReservation()
    const outcome = await retireOrphanThreadAuthority(
      THREAD,
      context(reservation, fs.removeAndSync, observation(reservation, constantWitness(true)))
    )
    expect(outcome).toEqual({ kind: 'uncertain', reason: 'witness_changed' })
    expect(outcome).not.toEqual({ kind: 'retired' })
    expect(fs.removeCalls).toBe(1)
  })

  it('refuses a thread id that escapes the chat-path safety check', async () => {
    const fs = new TestFs()
    const reservation = new TestReservation()
    const outcome = await retireOrphanThreadAuthority(
      '../escape',
      context(reservation, fs.removeAndSync, observation(reservation))
    )
    expect(outcome).toEqual({ kind: 'busy', reason: 'damaged' })
    expect(fs.removeCalls).toBe(0)
    expect(reservation.revalidateCalls).toBe(0)
  })
})
