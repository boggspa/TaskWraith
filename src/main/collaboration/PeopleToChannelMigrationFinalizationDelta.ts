import { createHash } from 'crypto'

import {
  PEOPLE_TO_CHANNEL_EXECUTION_STORE_VERSION,
  type PeopleToChannelMigrationExecution
} from './PeopleToChannelMigrationExecutionStore'
import {
  PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION,
  materializePeopleToChannelMigrationHistory,
  type PeopleToChannelExistingLogSnapshot
} from './PeopleToChannelMigrationHistory'
import type { PeopleToChannelInventoryChat } from './PeopleToChannelMigrationInventory'
import {
  PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION,
  materializePeopleToChannels
} from './PeopleToChannelMigrationMaterializer'
import {
  PEOPLE_TO_CHANNEL_MIGRATION_PLAN_VERSION,
  createPeopleToChannelMigrationPlan,
  type PeopleToChannelMigrationPlanInput
} from './PeopleToChannelMigrationPlan'

export const PEOPLE_TO_CHANNEL_FINALIZATION_DELTA_VERSION = 1

export interface PeopleToChannelMigrationFinalizationDelta {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_FINALIZATION_DELTA_VERSION
  initialPlanId: string
  initialPlanDigest: string
  initialMigrationAt: number
  execution: PeopleToChannelMigrationExecution
}

export class PeopleToChannelMigrationFinalizationDeltaError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'PeopleToChannelMigrationFinalizationDeltaError'
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/

function blocked(message: string): never {
  throw new PeopleToChannelMigrationFinalizationDeltaError(message)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalize(entry)])
  )
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

function materializationDigest(value: PeopleToChannelMigrationExecution['base']): string {
  const { materializationDigest: _recorded, ...withoutDigest } = value
  return sha256(canonicalJson(withoutDigest))
}

function historyExecutionDigest(value: PeopleToChannelMigrationExecution['history']): string {
  const { executionDigest: _recorded, ...withoutDigest } = value
  return sha256(canonicalJson(withoutDigest))
}

function assertInitialExecution(value: PeopleToChannelMigrationExecution): void {
  const plan = value?.plan
  const base = value?.base
  const history = value?.history
  if (
    !value ||
    value.schemaVersion !== PEOPLE_TO_CHANNEL_EXECUTION_STORE_VERSION ||
    !digest(value.planDigest) ||
    !plan ||
    plan.schemaVersion !== PEOPLE_TO_CHANNEL_MIGRATION_PLAN_VERSION ||
    !digest(plan.planId) ||
    !digest(plan.sourceDigest) ||
    sha256(canonicalJson(plan)) !== value.planDigest ||
    !base ||
    base.schemaVersion !== PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION ||
    base.planId !== plan.planId ||
    base.sourceDigest !== plan.sourceDigest ||
    !Number.isSafeInteger(base.migrationAt) ||
    base.migrationAt < 0 ||
    !digest(base.materializationDigest) ||
    materializationDigest(base) !== base.materializationDigest ||
    !history ||
    history.schemaVersion !== PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION ||
    history.planId !== plan.planId ||
    history.sourceDigest !== plan.sourceDigest ||
    history.baseMaterializationDigest !== base.materializationDigest ||
    history.migrationAt !== base.migrationAt ||
    !digest(history.executionDigest) ||
    historyExecutionDigest(history) !== history.executionDigest
  ) {
    blocked('Initial People migration execution does not match its authority digests')
  }
}

/**
 * No post-soak legacy contribution may be dropped merely because its source
 * share became disabled, disappeared, or is otherwise no longer executable.
 */
function assertPostSoakRowsAreExecutable(args: {
  plan: ReturnType<typeof createPeopleToChannelMigrationPlan>
  source: PeopleToChannelMigrationPlanInput
  acceptedAfter: number
}): void {
  const entriesByShareId = new Map(args.plan.entries.map((entry) => [entry.source.shareId, entry]))
  for (const chat of args.source.chats) {
    for (const evidence of chat.legacyContributions ?? []) {
      if (evidence.acceptedAt <= args.acceptedAfter) continue
      const entry = entriesByShareId.get(evidence.shareId)
      if (
        !entry ||
        entry.disposition === 'retain_legacy' ||
        entry.disposition === 'blocked' ||
        entry.blockers.length > 0 ||
        !entry.target
      ) {
        blocked('Post-soak People contribution has no executable Channel target')
      }
    }
  }
}

/**
 * Rebuilds a terminal, content-bearing execution from one quiesced source
 * generation. The fresh plan carries any executable membership/policy/invite
 * delta, while the history leg imports only rows after the original boundary.
 * It writes nothing: callers persist the result encrypted, then fence it in
 * recovery before changing People state.
 */
export function buildPeopleToChannelMigrationFinalizationDelta(input: {
  initial: PeopleToChannelMigrationExecution
  current: PeopleToChannelMigrationPlanInput
  donorChats: readonly PeopleToChannelInventoryChat[]
  existingLogs: readonly PeopleToChannelExistingLogSnapshot[]
  hostDisplayName: string
  migrationAt: number
}): PeopleToChannelMigrationFinalizationDelta {
  assertInitialExecution(input.initial)
  if (
    !Number.isSafeInteger(input.migrationAt) ||
    input.migrationAt <= input.initial.base.migrationAt ||
    typeof input.hostDisplayName !== 'string' ||
    !input.hostDisplayName ||
    input.hostDisplayName.trim() !== input.hostDisplayName ||
    input.hostDisplayName.length > 120 ||
    !Array.isArray(input.donorChats) ||
    !Array.isArray(input.existingLogs)
  ) {
    blocked('People migration finalization inputs are invalid')
  }

  const plan = createPeopleToChannelMigrationPlan(input.current)
  assertPostSoakRowsAreExecutable({
    plan,
    source: input.current,
    acceptedAfter: input.initial.base.migrationAt
  })
  const base = materializePeopleToChannels({
    plan,
    source: input.current,
    hostDisplayName: input.hostDisplayName,
    migrationAt: input.migrationAt
  })
  const history = materializePeopleToChannelMigrationHistory({
    plan,
    base,
    donorChats: input.donorChats,
    existingLogs: input.existingLogs,
    legacyProjectionHistory: 'import-then-reset',
    importAcceptedAfter: input.initial.base.migrationAt
  })
  const execution: PeopleToChannelMigrationExecution = {
    schemaVersion: PEOPLE_TO_CHANNEL_EXECUTION_STORE_VERSION,
    planDigest: sha256(canonicalJson(plan)),
    hostDisplayName: input.hostDisplayName,
    plan,
    base,
    history
  }
  return {
    schemaVersion: PEOPLE_TO_CHANNEL_FINALIZATION_DELTA_VERSION,
    initialPlanId: input.initial.plan.planId,
    initialPlanDigest: input.initial.planDigest,
    initialMigrationAt: input.initial.base.migrationAt,
    execution: clone(execution)
  }
}

export function isPeopleToChannelMigrationFinalizationDeltaError(
  error: unknown
): error is PeopleToChannelMigrationFinalizationDeltaError {
  return (
    error instanceof PeopleToChannelMigrationFinalizationDeltaError &&
    error.code === 'recovery_blocked'
  )
}
