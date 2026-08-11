import { describe, expect, it } from 'vitest'

import {
  PeopleToChannelMigrationLegacyWriteGate,
  PeopleToChannelMigrationLegacyWriteGateError,
  isPeopleToChannelMigrationLegacyWriteGateError
} from './PeopleToChannelMigrationLegacyWriteGate'

describe('PeopleToChannelMigrationLegacyWriteGate', () => {
  it('is open by default and becomes an irreversible in-process write latch', () => {
    const gate = new PeopleToChannelMigrationLegacyWriteGate()

    expect(gate.isQuiesced()).toBe(false)
    expect(() => gate.assertOrdinaryWriteAllowed()).not.toThrow()

    gate.quiesce()

    expect(gate.isQuiesced()).toBe(true)
    expect(() => gate.assertOrdinaryWriteAllowed()).toThrow(
      PeopleToChannelMigrationLegacyWriteGateError
    )
    expect(() => gate.assertOrdinaryWriteAllowed()).toThrow(/writes are quiesced/)
    try {
      gate.assertOrdinaryWriteAllowed()
    } catch (error) {
      expect(isPeopleToChannelMigrationLegacyWriteGateError(error)).toBe(true)
    }
  })
})
