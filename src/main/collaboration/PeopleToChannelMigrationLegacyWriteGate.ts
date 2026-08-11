/**
 * In-process write latch used by terminal P4 migration. The coordinator closes
 * it before it captures a final People generation; startup must close a fresh
 * instance again whenever durable recovery is `finalizing` or `committed`.
 */
export class PeopleToChannelMigrationLegacyWriteGateError extends Error {
  readonly code = 'recovery_blocked'

  constructor() {
    super('Ordinary People writes are quiesced for the Channels migration.')
    this.name = 'PeopleToChannelMigrationLegacyWriteGateError'
  }
}

export interface PeopleToChannelMigrationLegacyWriteGateLike {
  isQuiesced(): boolean
  assertOrdinaryWriteAllowed(): void
}

export class PeopleToChannelMigrationLegacyWriteGate implements PeopleToChannelMigrationLegacyWriteGateLike {
  private quiesced = false

  quiesce(): void {
    this.quiesced = true
  }

  isQuiesced(): boolean {
    return this.quiesced
  }

  assertOrdinaryWriteAllowed(): void {
    if (this.quiesced) throw new PeopleToChannelMigrationLegacyWriteGateError()
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
