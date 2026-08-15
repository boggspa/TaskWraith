/**
 * In-process write latch used by terminal migration. New P5 captures close it
 * with an empty scope. A nonempty scope is accepted only when the coordinator
 * recovers exact compatibility ids from a sealed P4 finalization execution.
 */
export class PeopleToChannelMigrationLegacyWriteGateError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message = 'Ordinary People writes are quiesced for the Channels migration.') {
    super(message)
    this.name = 'PeopleToChannelMigrationLegacyWriteGateError'
  }
}

export interface PeopleToChannelMigrationLegacyWriteGateLike {
  isQuiesced(): boolean
  assertOrdinaryWriteAllowed(shareId?: string): void
  assertRetirementAllowed(shareId: string): void
}

export class PeopleToChannelMigrationLegacyWriteGate implements PeopleToChannelMigrationLegacyWriteGateLike {
  private quiesced = false
  private sealedWorkspaceBootstrapCompatibilityShareIds = new Set<string>()

  /**
   * The legacy property name is persisted in P4 schema v1. It does not grant
   * authority to create a producer; callers may supply nonempty ids only while
   * replaying the sealed compatibility scope.
   */
  quiesce(input: { retainedWorkspaceBootstrapShareIds?: readonly string[] } = {}): void {
    const retained = [...(input.retainedWorkspaceBootstrapShareIds ?? [])]
    if (
      retained.some(
        (shareId) =>
          typeof shareId !== 'string' ||
          !shareId ||
          shareId.trim() !== shareId ||
          shareId.length > 512
      ) ||
      new Set(retained).size !== retained.length
    ) {
      throw new Error('Sealed workspace-bootstrap compatibility share ids are invalid.')
    }
    const next = new Set(retained)
    if (
      this.quiesced &&
      (next.size !== this.sealedWorkspaceBootstrapCompatibilityShareIds.size ||
        [...next].some(
          (shareId) => !this.sealedWorkspaceBootstrapCompatibilityShareIds.has(shareId)
        ))
    ) {
      throw new PeopleToChannelMigrationLegacyWriteGateError(
        'People migration write scope cannot change after quiescence.'
      )
    }
    this.sealedWorkspaceBootstrapCompatibilityShareIds = next
    this.quiesced = true
  }

  isQuiesced(): boolean {
    return this.quiesced
  }

  assertOrdinaryWriteAllowed(shareId?: string): void {
    if (
      !this.quiesced ||
      (shareId && this.sealedWorkspaceBootstrapCompatibilityShareIds.has(shareId))
    ) {
      return
    }
    throw new PeopleToChannelMigrationLegacyWriteGateError()
  }

  assertRetirementAllowed(shareId: string): void {
    if (!this.quiesced) {
      throw new PeopleToChannelMigrationLegacyWriteGateError(
        'Migration retirement requires a quiesced legacy write gate.'
      )
    }
    if (this.sealedWorkspaceBootstrapCompatibilityShareIds.has(shareId)) {
      throw new PeopleToChannelMigrationLegacyWriteGateError(
        'The sealed P4 workspace-bootstrap compatibility share cannot be retired.'
      )
    }
  }
}

export function isPeopleToChannelMigrationLegacyWriteGateError(
  error: unknown
): error is PeopleToChannelMigrationLegacyWriteGateError {
  return (
    error instanceof PeopleToChannelMigrationLegacyWriteGateError &&
    error.code === 'recovery_blocked'
  )
}
