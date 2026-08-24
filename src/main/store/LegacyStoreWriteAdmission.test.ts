import { describe, expect, it } from 'vitest'

import { createLegacyStoreWriterGate } from './LegacyStoreWriterGate'
import {
  runLegacyStoreWriteAdmission,
  scheduleLegacyStoreDeferredWrite,
  type LegacyStoreDeferredSettlement
} from './LegacyStoreWriteAdmission'

describe('runLegacyStoreWriteAdmission', () => {
  it('settles synchronous and Promise work automatically', async () => {
    const gate = createLegacyStoreWriterGate()
    expect(
      runLegacyStoreWriteAdmission({ operation: 'sync', pathFamily: 'chats' }, () => 'done', gate)
    ).toBe('done')
    expect(gate.snapshot().inFlight).toBe(0)
    await expect(
      runLegacyStoreWriteAdmission(
        { operation: 'async', pathFamily: 'chats' },
        async () => 'done',
        gate
      )
    ).resolves.toBe('done')
    expect(gate.snapshot().inFlight).toBe(0)
  })

  it('keeps the caller admitted after synchronous coalescer settlement until work returns', () => {
    const gate = createLegacyStoreWriterGate()
    runLegacyStoreWriteAdmission(
      { operation: 'barrier', pathFamily: 'chats' },
      (scope) => {
        const deferred = scope.handoffDeferredSettlement()
        deferred.coalescerSettled()
        expect(gate.hasActiveAdmissionContext()).toBe(true)
        expect(gate.snapshot().inFlight).toBe(1)
      },
      gate
    )
    expect(gate.snapshot().inFlight).toBe(0)
  })

  it('holds drain through coalescer settlement and then a utility ACK continuation', async () => {
    const gate = createLegacyStoreWriterGate()
    let coalescerOnly!: LegacyStoreDeferredSettlement
    let utility!: LegacyStoreDeferredSettlement
    runLegacyStoreWriteAdmission(
      { operation: 'coalesced', pathFamily: 'chats' },
      (scope) => {
        coalescerOnly = scope.handoffDeferredSettlement()
        return undefined
      },
      gate
    )
    const first = coalescerOnly
    expect(gate.beginDrain()).toBe(true)
    let drained = false
    const waiting = gate.awaitDrained().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    first.coalescerSettled()
    await waiting
    expect(drained).toBe(true)

    const nestedGate = createLegacyStoreWriterGate()
    runLegacyStoreWriteAdmission(
      { operation: 'utility', pathFamily: 'chats' },
      (scope) => {
        utility = scope.handoffDeferredSettlement()
        return undefined
      },
      nestedGate
    )
    const second = utility
    second.markAsyncContinuation()
    expect(nestedGate.beginDrain()).toBe(true)
    second.coalescerSettled()
    expect(nestedGate.snapshot().inFlight).toBe(1)
    second.asyncSettled()
    await nestedGate.awaitDrained()
    expect(nestedGate.snapshot().inFlight).toBe(0)
  })

  it('retains a nested parent admission after the parent caller releases', async () => {
    const gate = createLegacyStoreWriterGate()
    let deferred!: LegacyStoreDeferredSettlement
    gate.runAdmitted({ operation: 'parent', pathFamily: 'chats' }, () => {
      runLegacyStoreWriteAdmission(
        { operation: 'child', pathFamily: 'chats' },
        (scope) => {
          deferred = scope.handoffDeferredSettlement()
        },
        gate
      )
    })
    const settlement = deferred
    expect(gate.snapshot().inFlight).toBe(1)
    expect(gate.beginDrain()).toBe(true)
    settlement.abort()
    await gate.awaitDrained()
    expect(gate.snapshot().inFlight).toBe(0)
  })

  it('releases the retained admission when coalescer scheduling throws', () => {
    const gate = createLegacyStoreWriterGate()
    expect(() =>
      runLegacyStoreWriteAdmission(
        { operation: 'schedule-failure', pathFamily: 'chats' },
        (scope) =>
          scheduleLegacyStoreDeferredWrite(
            scope,
            () => {
              throw new Error('schedule failed')
            },
            () => undefined
          ),
        gate
      )
    ).toThrow('schedule failed')
    expect(gate.snapshot().inFlight).toBe(0)
  })
})
