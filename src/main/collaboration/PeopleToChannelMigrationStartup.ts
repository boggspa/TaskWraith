import type { ChannelProductionService, ChannelProductionStatus } from './ChannelProductionService'
import { PeopleToChannelMigrationAdmissionAuthority } from './PeopleToChannelMigrationAdmissionAuthority'
import { PeopleToChannelMigrationHandoffService } from './PeopleToChannelMigrationHandoffService'
import type {
  PeopleToChannelMigrationProductionRunResult,
  PeopleToChannelMigrationProductionRunner
} from './PeopleToChannelMigrationProductionRunner'

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
  /** The durable runner must settle before a Channel handler can begin serving. */
  runner: Pick<PeopleToChannelMigrationProductionRunner, 'runToSoak'>
  createBootstrap: (dependencies: PeopleToChannelMigrationStartupBootstrapDependencies) => Bootstrap
}

export interface PeopleToChannelMigrationStartupResult<
  Bootstrap extends PeopleToChannelMigrationStartupBootstrap =
    PeopleToChannelMigrationStartupBootstrap
> {
  migration: PeopleToChannelMigrationProductionRunResult
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
 * Main-process-only composition for the P4 additive migration. The durable
 * runner resolves any interrupted execution before a Channel bootstrap is
 * constructed, and the bootstrap cannot serve until the handoff authority has
 * been created from its verified live invite projection.
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
    typeof options.runner.runToSoak !== 'function' ||
    typeof options.createBootstrap !== 'function'
  ) {
    throw new Error('People migration startup requires a runner and bootstrap factory')
  }

  // This call is intentionally first: a failed or interrupted migration must
  // leave both Channel IPC and the legacy People runtime unavailable to serve.
  const migration = options.runner.runToSoak()
  const admissionAuthority = new PeopleToChannelMigrationAdmissionAuthority({
    migrationPlanId: migration.planId,
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
    return { migration, admissionAuthority, handoff, bootstrap, status }
  } catch (error) {
    void bootstrap.stop().catch(() => undefined)
    throw error
  }
}
