import { createHash } from 'crypto'
import { join } from 'path'

import { exportRawEd25519PublicKey, type KeyPair } from '../../shared/e2ee/keys'
import type { HumanCollaborationSafeStorage } from './HumanCollaborationIdentityStore'
import { ChannelHumanPolicyStore } from './ChannelHumanPolicyStore'
import {
  ChannelMessageLog,
  MAX_REPLAY_BYTES,
  MAX_REPLAY_RECORDS,
  type ChannelMessage
} from './ChannelMessageLog'
import { channelProductionDataPaths } from './ChannelProductionService'
import { ChannelStore } from './ChannelStore'
import {
  PeopleToChannelMigrationAdmissionReissue,
  type PeopleToChannelReissuedAdmission
} from './PeopleToChannelMigrationAdmissionReissue'
import {
  PeopleToChannelMigrationChannelsCoordinator,
  type PeopleToChannelMigrationChannelsAppliedResult
} from './PeopleToChannelMigrationChannelsCoordinator'
import {
  PeopleToChannelMigrationCutoverCoordinator,
  type PeopleToChannelCutoverRoute
} from './PeopleToChannelMigrationCutoverCoordinator'
import {
  PEOPLE_TO_CHANNEL_EXECUTION_STORE_VERSION,
  PeopleToChannelMigrationExecutionStore,
  type PeopleToChannelMigrationExecution,
  type PeopleToChannelMigrationExecutionDurablePublish
} from './PeopleToChannelMigrationExecutionStore'
import {
  materializePeopleToChannelMigrationHistory,
  type PeopleToChannelExistingLogSnapshot
} from './PeopleToChannelMigrationHistory'
import {
  readPeopleToChannelMigrationInventory,
  type PeopleToChannelInventoryChat
} from './PeopleToChannelMigrationInventory'
import { PeopleToChannelMigrationLogWriter } from './PeopleToChannelMigrationLogWriter'
import { materializePeopleToChannels } from './PeopleToChannelMigrationMaterializer'
import { PeopleToChannelMigrationPolicyWriter } from './PeopleToChannelMigrationPolicyWriter'
import { RECORDED_PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS } from './PeopleToChannelMigrationRecordedDecisions'
import {
  PeopleToChannelMigrationRecoveryStore,
  type PeopleToChannelMigrationRecoveryPhase,
  type PeopleToChannelMigrationRecoveryRecord
} from './PeopleToChannelMigrationRecoveryStore'
import {
  PeopleToChannelMigrationSource,
  type PeopleToChannelMigrationSourceRead
} from './PeopleToChannelMigrationSource'

export const PEOPLE_TO_CHANNEL_PRODUCTION_RUNNER_VERSION = 1
export const PEOPLE_TO_CHANNEL_ADMISSION_ESCROW_FILENAME = 'admission-escrow.json'

export type PeopleToChannelMigrationProductionRunnerStage =
  | 'execution_durable'
  | 'recovery_prepared'
  | 'channels_applied'
  | 'cutover_applied'

export interface PeopleToChannelMigrationProductionRunnerOptions {
  userDataPath: string
  safeStorage: HumanCollaborationSafeStorage
  loadIdentity: () => KeyPair
  hostDisplayName: string
  listChats: () => readonly PeopleToChannelInventoryChat[]
  listWorkflowChatIds?: () => readonly string[]
  now?: () => number
  /** Observability rendezvous inside the immutable execution write window. */
  beforeDurablePublish?: (event: PeopleToChannelMigrationExecutionDurablePublish) => void
  /** Test/observability seam invoked only after the named state is durable. */
  afterStage?: (stage: PeopleToChannelMigrationProductionRunnerStage) => void
}

export interface PeopleToChannelMigrationProductionPreflight {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_PRODUCTION_RUNNER_VERSION
  planId: string
  sourceDigest: string
  phase: 'ready' | PeopleToChannelMigrationRecoveryPhase
  executionDurable: boolean
  summary: PeopleToChannelMigrationExecution['plan']['summary']
}

export interface PeopleToChannelMigrationProductionRunResult {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_PRODUCTION_RUNNER_VERSION
  planId: string
  phase: Extract<
    PeopleToChannelMigrationRecoveryPhase,
    'cutover_applied' | 'finalizing' | 'committed'
  >
  executionCreatedThisRun: boolean
  routes: PeopleToChannelCutoverRoute[]
  invitations: PeopleToChannelReissuedAdmission[]
  recovery: PeopleToChannelMigrationRecoveryRecord
}

interface BuiltExecution {
  execution: PeopleToChannelMigrationExecution
  sourceRead: PeopleToChannelMigrationSourceRead
}

interface Runtime {
  channels: ChannelStore
  messageLog: ChannelMessageLog
  source: PeopleToChannelMigrationSource
  execution: PeopleToChannelMigrationExecutionStore
  recovery: PeopleToChannelMigrationRecoveryStore
  admissions: PeopleToChannelMigrationAdmissionReissue
  channelsCoordinator: PeopleToChannelMigrationChannelsCoordinator
  cutoverCoordinator: PeopleToChannelMigrationCutoverCoordinator
}

export class PeopleToChannelMigrationProductionRunnerError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'PeopleToChannelMigrationProductionRunnerError'
  }
}

function blocked(message: string): never {
  throw new PeopleToChannelMigrationProductionRunnerError(message)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  )
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function safeMigrationAt(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    blocked('People migration production timestamp is invalid')
  }
  return value
}

function readAllMessages(log: ChannelMessageLog, channelId: string): ChannelMessage[] {
  const records: ChannelMessage[] = []
  let highWaterSequence: number | null = null
  while (highWaterSequence === null || records.length < highWaterSequence) {
    const replay = log.replay({
      channelId,
      resumeAfter: records.length,
      maxRecords: MAX_REPLAY_RECORDS,
      maxBytes: MAX_REPLAY_BYTES
    })
    if (highWaterSequence === null) highWaterSequence = replay.highWaterSequence
    if (replay.highWaterSequence !== highWaterSequence) {
      blocked('Channel log changed during People migration inventory')
    }
    if (replay.records.length === 0 && records.length < highWaterSequence) {
      blocked('Channel log could not be fully inventoried for People migration')
    }
    records.push(...replay.records)
  }
  return records
}

function snapshotExistingLogs(args: {
  executionBase: PeopleToChannelMigrationExecution['base']
  log: ChannelMessageLog
}): PeopleToChannelExistingLogSnapshot[] {
  return args.executionBase.mutations
    .filter((mutation) => mutation.mode === 'merge')
    .map((mutation) => {
      const channelId = mutation.channel.channelId
      return {
        channelId,
        messages: readAllMessages(args.log, channelId),
        digest: args.log.digest(channelId)
      }
    })
}

function assertRecoveryMatchesExecution(
  recovery: PeopleToChannelMigrationRecoveryRecord,
  execution: PeopleToChannelMigrationExecution
): void {
  if (
    recovery.planId !== execution.plan.planId ||
    recovery.planDigest !== execution.planDigest ||
    recovery.sourceDigest !== execution.plan.sourceDigest ||
    canonicalJson(recovery.decisions) !==
      canonicalJson(RECORDED_PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS)
  ) {
    blocked('People migration recovery intent does not match its execution checkpoint')
  }
}

function assertSameExecution(
  expected: PeopleToChannelMigrationExecution,
  actual: PeopleToChannelMigrationExecution
): void {
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    blocked('People or Channel source changed after the orphan execution checkpoint')
  }
}

function phaseAfterCutover(
  recovery: PeopleToChannelMigrationRecoveryRecord
): PeopleToChannelMigrationProductionRunResult['phase'] {
  if (
    recovery.phase !== 'cutover_applied' &&
    recovery.phase !== 'finalizing' &&
    recovery.phase !== 'committed'
  ) {
    blocked('People migration did not reach its additive cutover boundary')
  }
  return recovery.phase
}

/**
 * Production P4 runner through the additive soak boundary only. Its first
 * durable write is the encrypted frozen execution; People remains writable
 * and is neither opened through the permissive legacy store nor mutated here.
 */
export class PeopleToChannelMigrationProductionRunner {
  private readonly now: () => number

  constructor(private readonly options: PeopleToChannelMigrationProductionRunnerOptions) {
    if (!options || typeof options !== 'object') {
      throw new Error('People migration production runner requires options')
    }
    if (
      typeof options.userDataPath !== 'string' ||
      !options.userDataPath.trim() ||
      options.userDataPath.trim() !== options.userDataPath ||
      !options.safeStorage ||
      typeof options.loadIdentity !== 'function' ||
      typeof options.listChats !== 'function' ||
      (options.listWorkflowChatIds !== undefined &&
        typeof options.listWorkflowChatIds !== 'function') ||
      typeof options.hostDisplayName !== 'string'
    ) {
      throw new Error('People migration production runner options are invalid')
    }
    this.now = options.now ?? Date.now
  }

  preflight(): PeopleToChannelMigrationProductionPreflight {
    const runtime = this.runtime()
    const recovery = runtime.recovery.load()
    const checkpoint = runtime.execution.load()
    if (recovery) {
      if (!checkpoint) blocked('People migration recovery has no execution checkpoint')
      assertRecoveryMatchesExecution(recovery, checkpoint)
      return this.preflightResult(checkpoint, recovery.phase, true)
    }
    if (checkpoint) {
      const fresh = this.buildExecution(runtime, {
        migrationAt: checkpoint.base.migrationAt,
        hostDisplayName: checkpoint.hostDisplayName
      })
      assertSameExecution(checkpoint, fresh.execution)
      return this.preflightResult(checkpoint, 'ready', true)
    }
    const fresh = this.buildExecution(runtime, {
      migrationAt: safeMigrationAt(this.now()),
      hostDisplayName: this.options.hostDisplayName
    })
    return this.preflightResult(fresh.execution, 'ready', false)
  }

  runToSoak(): PeopleToChannelMigrationProductionRunResult {
    const runtime = this.runtime()
    let recovery = runtime.recovery.load()
    let execution = runtime.execution.load()
    let executionCreatedThisRun = false

    if (!recovery) {
      let built: BuiltExecution
      if (execution) {
        built = this.buildExecution(runtime, {
          migrationAt: execution.base.migrationAt,
          hostDisplayName: execution.hostDisplayName
        })
        assertSameExecution(execution, built.execution)
      } else {
        built = this.buildExecution(runtime, {
          migrationAt: safeMigrationAt(this.now()),
          hostDisplayName: this.options.hostDisplayName
        })
        const persisted = runtime.execution.persist(built.execution)
        executionCreatedThisRun = persisted.created
        execution = built.execution
      }
      execution ??= built.execution
      recovery = runtime.recovery.prepare({
        plan: execution.plan,
        source: built.sourceRead,
        decisions: RECORDED_PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS,
        now: execution.base.migrationAt
      })
    }

    if (!execution) blocked('People migration recovery has no execution checkpoint')
    assertRecoveryMatchesExecution(recovery, execution)

    let invitations: PeopleToChannelReissuedAdmission[]
    if (recovery.phase === 'prepared' || recovery.phase === 'channels_applied') {
      const channelsResult: PeopleToChannelMigrationChannelsAppliedResult =
        runtime.channelsCoordinator.apply({ base: execution.base, history: execution.history })
      recovery = channelsResult.recovery
      invitations = channelsResult.invitations.map(clone)
    } else {
      invitations = runtime.admissions
        .recoverEscrow({ base: execution.base, history: execution.history })
        .invitations.map(clone)
    }

    const cutover = runtime.cutoverCoordinator.apply({ plan: execution.plan })
    recovery = cutover.recovery
    return {
      schemaVersion: PEOPLE_TO_CHANNEL_PRODUCTION_RUNNER_VERSION,
      planId: execution.plan.planId,
      phase: phaseAfterCutover(recovery),
      executionCreatedThisRun,
      routes: cutover.routes.map(clone),
      invitations,
      recovery: clone(recovery)
    }
  }

  private runtime(): Runtime {
    const paths = channelProductionDataPaths(this.options.userDataPath)
    const channels = new ChannelStore(paths.metadata)
    const messageLog = new ChannelMessageLog(paths.logs, channels)
    const recovery = new PeopleToChannelMigrationRecoveryStore({
      userDataPath: this.options.userDataPath,
      now: this.now,
      afterDurableWrite: (stage) => {
        if (stage === 'intent:prepared') this.options.afterStage?.('recovery_prepared')
      }
    })
    const execution = new PeopleToChannelMigrationExecutionStore({
      userDataPath: this.options.userDataPath,
      safeStorage: this.options.safeStorage,
      beforeDurablePublish: this.options.beforeDurablePublish,
      afterDurableWrite: () => this.options.afterStage?.('execution_durable')
    })
    const admissions = new PeopleToChannelMigrationAdmissionReissue({
      storagePath: join(recovery.paths.root, PEOPLE_TO_CHANNEL_ADMISSION_ESCROW_FILENAME),
      safeStorage: this.options.safeStorage,
      channels,
      now: this.now
    })
    const channelsCoordinator = new PeopleToChannelMigrationChannelsCoordinator({
      recovery,
      logs: new PeopleToChannelMigrationLogWriter(messageLog),
      policies: new PeopleToChannelMigrationPolicyWriter({
        policies: new ChannelHumanPolicyStore(paths.humanPolicies),
        now: this.now
      }),
      admissions,
      channels,
      now: this.now,
      afterStage: (stage) => {
        if (stage === 'recovery_durable') this.options.afterStage?.('channels_applied')
      }
    })
    const cutoverCoordinator = new PeopleToChannelMigrationCutoverCoordinator({
      userDataPath: this.options.userDataPath,
      recovery,
      channels,
      now: this.now,
      afterStage: (stage) => {
        if (stage === 'recovery_durable') this.options.afterStage?.('cutover_applied')
      }
    })
    return {
      channels,
      messageLog,
      source: new PeopleToChannelMigrationSource(
        join(this.options.userDataPath, 'human-collaboration.json')
      ),
      execution,
      recovery,
      admissions,
      channelsCoordinator,
      cutoverCoordinator
    }
  }

  private buildExecution(
    runtime: Runtime,
    fixed: { migrationAt: number; hostDisplayName: string }
  ): BuiltExecution {
    const sourceRead = runtime.source.read()
    const chats = this.options.listChats()
    const workflowChatIds = this.options.listWorkflowChatIds?.() ?? []
    if (!Array.isArray(chats) || !Array.isArray(workflowChatIds)) {
      blocked('People migration production inventory ports are invalid')
    }
    const identity = this.options.loadIdentity()
    const hostIdentityPublicKey = exportRawEd25519PublicKey(identity.publicKey).toString('base64')
    const inventory = readPeopleToChannelMigrationInventory({
      hostIdentityPublicKey,
      people: { readMigrationSnapshot: () => sourceRead.snapshot },
      channels: runtime.channels,
      chats,
      workflowChatIds
    })
    const base = materializePeopleToChannels({
      plan: inventory.plan,
      source: inventory.source,
      hostDisplayName: fixed.hostDisplayName,
      migrationAt: safeMigrationAt(fixed.migrationAt)
    })
    const history = materializePeopleToChannelMigrationHistory({
      plan: inventory.plan,
      base,
      donorChats: chats,
      existingLogs: snapshotExistingLogs({ executionBase: base, log: runtime.messageLog }),
      legacyProjectionHistory: RECORDED_PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS.legacyProjectionHistory
    })
    const execution: PeopleToChannelMigrationExecution = {
      schemaVersion: PEOPLE_TO_CHANNEL_EXECUTION_STORE_VERSION,
      planDigest: sha256(canonicalJson(inventory.plan)),
      hostDisplayName: fixed.hostDisplayName,
      plan: inventory.plan,
      base,
      history
    }
    return { execution, sourceRead }
  }

  private preflightResult(
    execution: PeopleToChannelMigrationExecution,
    phase: PeopleToChannelMigrationProductionPreflight['phase'],
    executionDurable: boolean
  ): PeopleToChannelMigrationProductionPreflight {
    return {
      schemaVersion: PEOPLE_TO_CHANNEL_PRODUCTION_RUNNER_VERSION,
      planId: execution.plan.planId,
      sourceDigest: execution.plan.sourceDigest,
      phase,
      executionDurable,
      summary: clone(execution.plan.summary)
    }
  }
}

export function isPeopleToChannelMigrationProductionRunnerError(
  error: unknown
): error is PeopleToChannelMigrationProductionRunnerError | { code: 'recovery_blocked' } {
  return (
    (error instanceof PeopleToChannelMigrationProductionRunnerError ||
      (error !== null && typeof error === 'object' && 'code' in error)) &&
    (error as { code?: unknown }).code === 'recovery_blocked'
  )
}
