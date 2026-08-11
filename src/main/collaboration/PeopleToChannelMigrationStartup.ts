import type { ChannelProductionService, ChannelProductionStatus } from './ChannelProductionService'
import { PeopleToChannelMigrationAdmissionAuthority } from './PeopleToChannelMigrationAdmissionAuthority'
import type { PeopleToChannelMigrationLegacyWriteGate } from './PeopleToChannelMigrationLegacyWriteGate'
import { PeopleToChannelMigrationHandoffService } from './PeopleToChannelMigrationHandoffService'
import type {
  PeopleToChannelMigrationFinalizationProductionRunResult,
  PeopleToChannelMigrationFinalizationProductionRunner
} from './PeopleToChannelMigrationFinalizationProductionRunner'
import type { PeopleToChannelMigrationProductionRunResult } from './PeopleToChannelMigrationProductionRunner'

export interface PeopleToChannelMigrationStartupBootstrap {
  readonly service: Pick<ChannelProductionService, 'describeExistingInvite'>
  start(): ChannelProductionStatus
  stop(): Promise<void>
}

export interface PeopleToChannelMigrationStartupBootstrapDependencies {
  migratedAdmissionAuthority: PeopleToChannelMigrationAdmissionAuthority
  migrationHandoff: Pick<PeopleToChannelMigrationHandoffService, 'snapshot'>
}

export interface PeopleToChannelMigrationStartupOptions<
  Bootstrap extends PeopleToChannelMigrationStartupBootstrap =
    PeopleToChannelMigrationStartupBootstrap
> {
  /** The durable terminal runner must settle before either service can begin serving. */
  runner: Pick<PeopleToChannelMigrationFinalizationProductionRunner, 'runToCompletion'>
  createBootstrap: (dependencies: PeopleToChannelMigrationStartupBootstrapDependencies) => Bootstrap
}

export interface PeopleToChannelMigrationStartupResult<
  Bootstrap extends PeopleToChannelMigrationStartupBootstrap =
    PeopleToChannelMigrationStartupBootstrap
> {
  migration: PeopleToChannelMigrationProductionRunResult
  terminalPlanId: string
  /** The exact P4 latch must be reused when the lazy People runtime is built. */
  legacyWriteGate: PeopleToChannelMigrationLegacyWriteGate
  admissionAuthority: PeopleToChannelMigrationAdmissionAuthority
  handoff: PeopleToChannelMigrationHandoffService
  bootstrap: Bootstrap
  status: ChannelProductionStatus
}

export class PeopleToChannelMigrationStartupError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'PeopleToChannelMigrationStartupError'
  }
}

function blocked(message: string): never {
  throw new PeopleToChannelMigrationStartupError(message)
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function assertBootstrap(
  value: unknown
): asserts value is PeopleToChannelMigrationStartupBootstrap {
  const bootstrap = record(value)
  const service = bootstrap ? record(bootstrap.service) : null
  if (
    !bootstrap ||
    !service ||
    typeof service.describeExistingInvite !== 'function' ||
    typeof bootstrap.start !== 'function' ||
    typeof bootstrap.stop !== 'function'
  ) {
    blocked('People migration startup bootstrap is invalid')
  }
}

/**
 * Main-process-only composition for terminal P4 migration. The durable runner
 * resolves any interrupted execution before either runtime is constructed, and
 * the Channel bootstrap cannot serve until it receives terminal-only admission
 * and handoff authority from the committed migration receipt.
 */
export function startPeopleToChannelMigrationBootstrap<
  Bootstrap extends PeopleToChannelMigrationStartupBootstrap
>(
  options: PeopleToChannelMigrationStartupOptions<Bootstrap>
): PeopleToChannelMigrationStartupResult<Bootstrap> {
  if (
    !options ||
    typeof options !== 'object' ||
    !options.runner ||
    typeof options.runner.runToCompletion !== 'function' ||
    typeof options.createBootstrap !== 'function'
  ) {
    throw new Error('People migration startup requires a runner and bootstrap factory')
  }

  // This call is intentionally first: a failed or interrupted migration must
  // leave both Channel IPC and the legacy People runtime unavailable to serve.
  const completed: PeopleToChannelMigrationFinalizationProductionRunResult =
    options.runner.runToCompletion()
  const migration = completed.migration
  const admissionAuthority = new PeopleToChannelMigrationAdmissionAuthority({
    migrationPlanId: completed.terminalPlanId,
    initialMigrationPlanId: migration.planId,
    invitations: migration.invitations
  })

  let handoff: PeopleToChannelMigrationHandoffService | null = null
  const migrationHandoff: Pick<PeopleToChannelMigrationHandoffService, 'snapshot'> = {
    snapshot(input = {}) {
      if (!handoff) {
        blocked('People migration handoff was requested before startup completed')
      }
      return handoff.snapshot(input)
    }
  }
  const bootstrap = options.createBootstrap({
    migratedAdmissionAuthority: admissionAuthority,
    migrationHandoff
  })
  assertBootstrap(bootstrap)

  try {
    handoff = new PeopleToChannelMigrationHandoffService({
      migration,
      channels: bootstrap.service
    })
    const status = bootstrap.start()
    return {
      migration,
      terminalPlanId: completed.terminalPlanId,
      legacyWriteGate: completed.legacyWriteGate,
      admissionAuthority,
      handoff,
      bootstrap,
      status
    }
  } catch (error) {
    void bootstrap.stop().catch(() => undefined)
    throw error
  }
}
