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

  it('keeps the exact P5 workspace-bootstrap exception writable without reopening ordinary People', () => {
    const gate = new PeopleToChannelMigrationLegacyWriteGate()
    gate.quiesce({ retainedWorkspaceBootstrapShareIds: ['p5_workspace'] })

    expect(() => gate.assertOrdinaryWriteAllowed('p5_workspace')).not.toThrow()
    expect(() => gate.assertOrdinaryWriteAllowed('ordinary_share')).toThrow(
      PeopleToChannelMigrationLegacyWriteGateError
    )
    expect(() => gate.assertOrdinaryWriteAllowed()).toThrow(
      PeopleToChannelMigrationLegacyWriteGateError
    )
    expect(() => gate.assertRetirementAllowed('ordinary_share')).not.toThrow()
    expect(() => gate.assertRetirementAllowed('p5_workspace')).toThrow(/cannot be retired/)
    expect(() => gate.quiesce({ retainedWorkspaceBootstrapShareIds: [] })).toThrow(
      /scope cannot change/
    )
  })
})
