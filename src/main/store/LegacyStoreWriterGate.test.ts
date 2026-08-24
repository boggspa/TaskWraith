import { describe, expect, it } from 'vitest'

import { createLegacyStoreWriterGate, legacyStoreWriterGate } from './LegacyStoreWriterGate'

describe('LegacyStoreWriterGate', () => {
  it('starts open in the exported compatibility singleton without importing AppStore/index', () => {
    expect(legacyStoreWriterGate.snapshot()).toEqual({
      state: 'open',
      inFlight: 0,
      hostOwned: false
    })
  })

  it('atomically drains admissions while existing work releases exactly once and wakes all waiters', async () => {
    const gate = createLegacyStoreWriterGate()
    const first = gate.admit({ operation: 'save', pathFamily: 'chats' })!
    const second = gate.admit({ operation: 'save', pathFamily: 'workspaces' })!
    expect(gate.beginDrain()).toBe(true)
    expect(gate.admit({ operation: 'late', pathFamily: 'chats' })).toBeNull()
    const one = gate.awaitDrained()
    const two = gate.awaitDrained()
    expect(first.release()).toBe(true)
    expect(first.release()).toBe(false)
    expect(second.release()).toBe(true)
    await Promise.all([one, two])
    expect(gate.snapshot().inFlight).toBe(0)
  })

  it('rejects invalid transitions, retains exact ownership proof, and stays permanent after host-owned', () => {
    const gate = createLegacyStoreWriterGate()
    expect(gate.admit({ operation: '', pathFamily: 'x' })).toBeNull()
    expect(gate.markHostOwned({ hostId: 'h', generation: 0, cutoverId: 'c' })).toBe(false)
    expect(gate.beginDrain()).toBe(true)
    expect(gate.rollbackDrain()).toBe(true)
    expect(gate.beginDrain()).toBe(true)
    expect(
      gate.markHostOwned({ hostId: 'bad\u0007', generation: -1, cutoverId: 'cutover-1' })
    ).toBe(false)
    expect(gate.markHostOwned({ hostId: 'host-1', generation: 1, cutoverId: 'cutover-1' })).toBe(
      true
    )
    expect(gate.rollbackDrain()).toBe(false)
    expect(gate.beginDrain()).toBe(false)
    expect(gate.snapshot()).toEqual({
      state: 'host-owned',
      inFlight: 0,
      hostOwned: true,
      ownership: { hostId: 'host-1', generation: 1, cutoverId: 'cutover-1' }
    })
    expect(gate.close()).toBe(true)
    expect(gate.snapshot()).toMatchObject({
      state: 'closed',
      hostOwned: true,
      ownership: {
        hostId: 'host-1',
        generation: 1,
        cutoverId: 'cutover-1'
      }
    })
  })

  it('close fails closed from any state without exposing admission metadata', () => {
    const gate = createLegacyStoreWriterGate()
    const lease = gate.admit({ operation: 'save', pathFamily: 'chats' })!
    expect(gate.close()).toBe(true)
    expect(gate.admit({ operation: 'save', pathFamily: 'chats' })).toBeNull()
    expect(gate.snapshot()).not.toHaveProperty('pathFamily')
    expect(lease.release()).toBe(true)
    expect(gate.close()).toBe(false)
  })

  it('releases drain waiters after close once existing admitted work finishes', async () => {
    const gate = createLegacyStoreWriterGate()
    const lease = gate.admit({ operation: 'save', pathFamily: 'chats' })!
    const drained = gate.awaitDrained()
    gate.close()
    lease.release()
    await drained
  })

  it('propagates exact nested admission context through async work and auto-releases runAdmitted', async () => {
    const gate = createLegacyStoreWriterGate()
    const lease = gate.admit({ operation: 'save', pathFamily: 'chats' })!
    await lease.run(async () => {
      expect(gate.hasActiveAdmissionContext()).toBe(true)
      await Promise.resolve()
      expect(gate.hasActiveAdmissionContext()).toBe(true)
    })
    await gate.runAdmitted({ operation: 'save', pathFamily: 'chats' }, async () => {
      expect(gate.hasActiveAdmissionContext()).toBe(true)
    })
    const nested = gate.admit({ operation: 'save', pathFamily: 'chats' })!
    nested.run(() => {
      expect(gate.beginDrain()).toBe(true)
      expect(gate.runAdmitted({ operation: 'deferred', pathFamily: 'chats' }, () => 'kept')).toBe(
        'kept'
      )
    })
    nested.release()
    lease.release()
    expect(() => lease.run(() => undefined)).toThrow()
    expect(gate.snapshot().inFlight).toBe(0)
    gate.beginDrain()
    expect(() =>
      gate.runAdmitted({ operation: 'save', pathFamily: 'chats' }, () => undefined)
    ).toThrow()
  })
})
