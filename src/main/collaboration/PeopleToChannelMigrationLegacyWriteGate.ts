/**
 * In-process write latch used by terminal P4 migration. The coordinator closes
 * it before it captures a final People generation; startup must close a fresh
 * instance again whenever durable recovery is `finalizing` or `committed`.
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
  private retainedWorkspaceBootstrapShareIds = new Set<string>()

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
      throw new Error('Retained workspace-bootstrap share ids are invalid.')
    }
    const next = new Set(retained)
    if (
      this.quiesced &&
      (next.size !== this.retainedWorkspaceBootstrapShareIds.size ||
        [...next].some((shareId) => !this.retainedWorkspaceBootstrapShareIds.has(shareId)))
    ) {
      throw new PeopleToChannelMigrationLegacyWriteGateError(
        'People migration write scope cannot change after quiescence.'
      )
    }
    this.retainedWorkspaceBootstrapShareIds = next
    this.quiesced = true
  }

  isQuiesced(): boolean {
    return this.quiesced
  }

  assertOrdinaryWriteAllowed(shareId?: string): void {
    if (!this.quiesced || (shareId && this.retainedWorkspaceBootstrapShareIds.has(shareId))) {
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
    if (this.retainedWorkspaceBootstrapShareIds.has(shareId)) {
      throw new PeopleToChannelMigrationLegacyWriteGateError(
        'The retained workspace-bootstrap People share cannot be retired by P4.'
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
