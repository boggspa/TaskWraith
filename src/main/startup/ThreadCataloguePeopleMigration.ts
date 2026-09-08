import {
  PeopleToChannelMigrationLegacyWriteGateError,
  type PeopleToChannelMigrationLegacyWriteGateLike
} from '../collaboration/PeopleToChannelMigrationLegacyWriteGate'

export function forwardingPeopleMigrationGate() {
  let target: PeopleToChannelMigrationLegacyWriteGateLike | null = null
  const requireTarget = (): PeopleToChannelMigrationLegacyWriteGateLike => {
    if (!target)
      throw new PeopleToChannelMigrationLegacyWriteGateError(
        'Collaboration history is still loading.'
      )
    return target
  }
  return {
    gate: {
      isQuiesced: () => target?.isQuiesced() ?? true,
      assertOrdinaryWriteAllowed: (id?: string) => requireTarget().assertOrdinaryWriteAllowed(id),
      assertRetirementAllowed: (id: string) => requireTarget().assertRetirementAllowed(id)
    } satisfies PeopleToChannelMigrationLegacyWriteGateLike,
    set(next: PeopleToChannelMigrationLegacyWriteGateLike) {
      target = next
    }
  }
}
