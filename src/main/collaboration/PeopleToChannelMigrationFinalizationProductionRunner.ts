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
import { PeopleToChannelMigrationAdmissionReissue } from './PeopleToChannelMigrationAdmissionReissue'
import {
  PeopleToChannelMigrationFinalizationAdmissions,
  type PeopleToChannelMigrationFinalizationAdmissionsStage,
  type PeopleToChannelMigrationFinalizationAdmissionsResult
} from './PeopleToChannelMigrationFinalizationAdmissions'
import {
  PeopleToChannelMigrationFinalizationCoordinator,
  type PeopleToChannelMigrationFinalizationCoordinatorResult,
  type PeopleToChannelMigrationFinalizationCoordinatorStage
} from './PeopleToChannelMigrationFinalizationCoordinator'
import {
  PEOPLE_TO_CHANNEL_FINALIZATION_EXECUTION_VERSION,
  PeopleToChannelMigrationFinalizationExecutionStore,
  createPeopleToChannelMigrationFinalizationExecution,
  type PeopleToChannelMigrationFinalizationExecution
} from './PeopleToChannelMigrationFinalizationExecutionStore'
import { buildPeopleToChannelMigrationFinalizationDelta } from './PeopleToChannelMigrationFinalizationDelta'
import { PeopleToChannelMigrationFinalizationPolicyWriter } from './PeopleToChannelMigrationFinalizationPolicyWriter'
import { derivePeopleToChannelMigrationFinalizationScope } from './PeopleToChannelMigrationFinalizationScope'
import {
  PeopleToChannelMigrationExecutionStore,
  type PeopleToChannelMigrationExecution
} from './PeopleToChannelMigrationExecutionStore'
import type { PeopleToChannelExistingLogSnapshot } from './PeopleToChannelMigrationHistory'
import {
  readPeopleToChannelMigrationInventory,
  type PeopleToChannelInventoryChat
} from './PeopleToChannelMigrationInventory'
import {
  loadPeopleToChannelCutoverManifest,
  peopleToChannelCutoverManifestDigest
} from './PeopleToChannelMigrationCutoverCoordinator'
import { PeopleToChannelMigrationLegacyWriteGate } from './PeopleToChannelMigrationLegacyWriteGate'
import { PeopleToChannelMigrationLogWriter } from './PeopleToChannelMigrationLogWriter'
import { materializePeopleToChannels } from './PeopleToChannelMigrationMaterializer'
import {
  PEOPLE_TO_CHANNEL_ADMISSION_ESCROW_FILENAME,
  PEOPLE_TO_CHANNEL_PRODUCTION_RUNNER_VERSION,
  PeopleToChannelMigrationProductionRunner,
  type PeopleToChannelMigrationProductionRunResult
} from './PeopleToChannelMigrationProductionRunner'
import { PeopleToChannelMigrationRecoveryStore } from './PeopleToChannelMigrationRecoveryStore'
import { PeopleToChannelMigrationSource } from './PeopleToChannelMigrationSource'
import { HumanCollaborationStore } from './HumanCollaborationStore'

export const PEOPLE_TO_CHANNEL_FINALIZATION_PRODUCTION_RUNNER_VERSION = 1
export const PEOPLE_TO_CHANNEL_FINALIZATION_ADMISSION_ESCROW_FILENAME =
  'finalization-admission-escrow.json'

export type PeopleToChannelMigrationFinalizationProductionRunnerStage =
  | PeopleToChannelMigrationFinalizationCoordinatorStage
  | `admission:${PeopleToChannelMigrationFinalizationAdmissionsStage}`

export interface PeopleToChannelMigrationFinalizationProductionRunnerOptions {
  userDataPath: string
  safeStorage: HumanCollaborationSafeStorage
  loadIdentity: () => KeyPair
  hostDisplayName: string
  listChats: () => readonly PeopleToChannelInventoryChat[]
  listWorkflowChatIds?: () => readonly string[]
  now?: () => number
  /** Test/observability seam invoked only after the named durable transition. */
  afterStage?: (stage: PeopleToChannelMigrationFinalizationProductionRunnerStage) => void
}

export interface PeopleToChannelMigrationFinalizationProductionRunResult {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_FINALIZATION_PRODUCTION_RUNNER_VERSION
  /**
   * The startup-safe migration projection: it holds only terminal credentials,
   * never the additive-soak credentials that terminal cutover revoked.
   */
  migration: PeopleToChannelMigrationProductionRunResult
  /** The terminal policy/admission plan, bound to the initial migration below. */
  terminalPlanId: string
  finalization: PeopleToChannelMigrationFinalizationCoordinatorResult
  legacyWriteGate: PeopleToChannelMigrationLegacyWriteGate
}

interface Runtime {
  channels: ChannelStore
  messageLog: ChannelMessageLog
  source: PeopleToChannelMigrationSource
  people: HumanCollaborationStore
  recovery: PeopleToChannelMigrationRecoveryStore
  initialExecution: PeopleToChannelMigrationExecutionStore
  finalizationExecution: PeopleToChannelMigrationFinalizationExecutionStore
  initialAdmissions: PeopleToChannelMigrationAdmissionReissue
  finalizationAdmissions: PeopleToChannelMigrationFinalizationAdmissions
}

export class PeopleToChannelMigrationFinalizationProductionRunnerError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'PeopleToChannelMigrationFinalizationProductionRunnerError'
  }
}

function blocked(message: string): never {
  throw new PeopleToChannelMigrationFinalizationProductionRunnerError(message)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function safeTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    blocked('People migration terminal timestamp is invalid')
  }
  return value
}

function terminalMigrationAt(initialMigrationAt: number, now: number): number {
  const initial = safeTimestamp(initialMigrationAt)
  const current = safeTimestamp(now)
  const next = Math.max(current, initial + 1)
  if (!Number.isSafeInteger(next)) {
    blocked('People migration terminal timestamp cannot advance the additive boundary')
  }
  return next
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
      blocked('Channel log changed during People migration terminal inventory')
    }
    if (replay.records.length === 0 && records.length < highWaterSequence) {
      blocked('Channel log could not be fully inventoried for People migration terminal cutover')
    }
    records.push(...replay.records)
  }
  return records
}

function snapshotExistingLogs(args: {
  base: PeopleToChannelMigrationExecution['base']
  log: ChannelMessageLog
}): PeopleToChannelExistingLogSnapshot[] {
  return args.base.mutations
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

/**
 * Completes the formerly additive production runner before any Channel or
 * People handler can serve. It creates a fresh runtime on every call so a
 * process restart re-reads only durable checkpoints and the one sealed final
 * People generation.
 */
export class PeopleToChannelMigrationFinalizationProductionRunner {
  readonly legacyWriteGate = new PeopleToChannelMigrationLegacyWriteGate()

  private readonly now: () => number
  private readonly additiveRunner: PeopleToChannelMigrationProductionRunner

  constructor(
    private readonly options: PeopleToChannelMigrationFinalizationProductionRunnerOptions
  ) {
    if (
      !options ||
      typeof options !== 'object' ||
      typeof options.userDataPath !== 'string' ||
      !options.userDataPath.trim() ||
      options.userDataPath.trim() !== options.userDataPath ||
      !options.safeStorage ||
      typeof options.loadIdentity !== 'function' ||
      typeof options.hostDisplayName !== 'string' ||
      !options.hostDisplayName.trim() ||
      typeof options.listChats !== 'function' ||
      (options.listWorkflowChatIds !== undefined &&
        typeof options.listWorkflowChatIds !== 'function')
    ) {
      throw new Error('People migration terminal production runner options are invalid')
    }
    this.now = options.now ?? Date.now
    this.additiveRunner = new PeopleToChannelMigrationProductionRunner({
      userDataPath: options.userDataPath,
      safeStorage: options.safeStorage,
      loadIdentity: options.loadIdentity,
      hostDisplayName: options.hostDisplayName,
      listChats: options.listChats,
      ...(options.listWorkflowChatIds ? { listWorkflowChatIds: options.listWorkflowChatIds } : {}),
      now: this.now
    })
  }

  runToCompletion(): PeopleToChannelMigrationFinalizationProductionRunResult {
    const committed = this.recoverCommitted()
    if (committed) return committed

    const additive = this.additiveRunner.runToSoak()
    const runtime = this.runtime()
    const initial = runtime.initialExecution.load()
    const recovery = runtime.recovery.load()
    if (
      !initial ||
      !recovery ||
      initial.plan.planId !== additive.planId ||
      recovery.planId !== initial.plan.planId
    ) {
      blocked('People migration terminal runtime does not match its additive checkpoint')
    }

    const coordinator = this.coordinator(runtime)
    const finalization = coordinator.run(
      recovery.phase === 'cutover_applied'
        ? {
            retainedWorkspaceBootstrapShareIds: [],
            capture: () => this.capture({ runtime, initial })
          }
        : {}
    )
    const sealed = runtime.finalizationExecution.loadForRecoveryFence({
      initialPlanId: initial.plan.planId,
      initialPlanDigest: initial.planDigest,
      finalizationDigest: finalization.finalizationDigest
    })
    const initialInvitations = runtime.initialAdmissions.recoverEscrow({
      base: initial.base,
      history: initial.history
    }).invitations
    const terminal = runtime.finalizationAdmissions.recover({
      initial,
      finalization: sealed,
      initialInvitations
    })
    this.assertTerminalResult({ finalization, terminal, sealed })

    return {
      schemaVersion: PEOPLE_TO_CHANNEL_FINALIZATION_PRODUCTION_RUNNER_VERSION,
      migration: {
        ...clone(additive),
        schemaVersion: PEOPLE_TO_CHANNEL_PRODUCTION_RUNNER_VERSION,
        phase: 'committed',
        invitations: terminal.invitations.map(clone),
        recovery: clone(finalization.recovery)
      },
      terminalPlanId: sealed.delta.base.planId,
      finalization: clone(finalization),
      legacyWriteGate: this.legacyWriteGate
    }
  }

  /**
   * Fast recovery for startups whose receipt is already durable. The additive
   * runner re-derives its manifest from live Channel metadata, which is only
   * frozen until the receipt commits — after that, ordinary product activity
   * (messages, members, closures, history deletion) must not re-open the
   * migration, so this path verifies the immutable receipt chain instead and
   * rebuilds the startup projection from the durable manifest and escrow.
   */
  private recoverCommitted(): PeopleToChannelMigrationFinalizationProductionRunResult | null {
    const runtime = this.runtime()
    const recovery = runtime.recovery.load()
    if (!recovery || recovery.phase !== 'committed') return null
    const initial = runtime.initialExecution.load()
    if (!initial || recovery.planId !== initial.plan.planId) {
      blocked('People migration terminal runtime does not match its committed receipt')
    }
    const manifest = loadPeopleToChannelCutoverManifest(this.options.userDataPath)
    if (
      !manifest ||
      manifest.planId !== initial.plan.planId ||
      recovery.cutoverStateDigest !== peopleToChannelCutoverManifestDigest(manifest)
    ) {
      blocked('People migration cutover manifest does not match its committed receipt')
    }

    const finalization = this.coordinator(runtime).run()
    const sealed = runtime.finalizationExecution.loadForRecoveryFence({
      initialPlanId: initial.plan.planId,
      initialPlanDigest: initial.planDigest,
      finalizationDigest: finalization.finalizationDigest
    })
    const initialInvitations = runtime.initialAdmissions.recoverEscrow({
      base: initial.base,
      history: initial.history
    }).invitations
    const terminal = runtime.finalizationAdmissions.recoverCommitted({
      initial,
      finalization: sealed,
      initialInvitations
    })
    this.assertTerminalResult({ finalization, terminal, sealed })
    runtime.recovery.deleteBackupAfterCommit()

    return {
      schemaVersion: PEOPLE_TO_CHANNEL_FINALIZATION_PRODUCTION_RUNNER_VERSION,
      migration: {
        schemaVersion: PEOPLE_TO_CHANNEL_PRODUCTION_RUNNER_VERSION,
        planId: initial.plan.planId,
        phase: 'committed',
        executionCreatedThisRun: false,
        routes: manifest.routes.map(clone),
        invitations: terminal.invitations.map(clone),
        recovery: clone(finalization.recovery)
      },
      terminalPlanId: sealed.delta.base.planId,
      finalization: clone(finalization),
      legacyWriteGate: this.legacyWriteGate
    }
  }

  private coordinator(runtime: Runtime): PeopleToChannelMigrationFinalizationCoordinator {
    return new PeopleToChannelMigrationFinalizationCoordinator({
      recovery: runtime.recovery,
      initialExecution: runtime.initialExecution,
      finalizationExecution: runtime.finalizationExecution,
      legacyWriteGate: this.legacyWriteGate,
      logs: new PeopleToChannelMigrationLogWriter(runtime.messageLog),
      policies: new PeopleToChannelMigrationFinalizationPolicyWriter({
        policies: new ChannelHumanPolicyStore(
          channelProductionDataPaths(this.options.userDataPath).humanPolicies
        ),
        now: this.now
      }),
      initialAdmissions: runtime.initialAdmissions,
      admissions: runtime.finalizationAdmissions,
      people: runtime.people,
      now: this.now,
      afterStage: (stage) => this.options.afterStage?.(stage)
    })
  }

  private runtime(): Runtime {
    const paths = channelProductionDataPaths(this.options.userDataPath)
    const channels = new ChannelStore(paths.metadata)
    const recovery = new PeopleToChannelMigrationRecoveryStore({
      userDataPath: this.options.userDataPath,
      now: this.now
    })
    return {
      channels,
      messageLog: new ChannelMessageLog(paths.logs, channels),
      source: new PeopleToChannelMigrationSource(
        join(this.options.userDataPath, 'human-collaboration.json')
      ),
      people: new HumanCollaborationStore(
        join(this.options.userDataPath, 'human-collaboration.json'),
        {
          legacyWriteGate: this.legacyWriteGate
        }
      ),
      recovery,
      initialExecution: new PeopleToChannelMigrationExecutionStore({
        userDataPath: this.options.userDataPath,
        safeStorage: this.options.safeStorage
      }),
      finalizationExecution: new PeopleToChannelMigrationFinalizationExecutionStore({
        userDataPath: this.options.userDataPath,
        safeStorage: this.options.safeStorage
      }),
      initialAdmissions: new PeopleToChannelMigrationAdmissionReissue({
        storagePath: join(recovery.paths.root, PEOPLE_TO_CHANNEL_ADMISSION_ESCROW_FILENAME),
        safeStorage: this.options.safeStorage,
        channels,
        now: this.now
      }),
      finalizationAdmissions: new PeopleToChannelMigrationFinalizationAdmissions({
        storagePath: join(
          recovery.paths.root,
          PEOPLE_TO_CHANNEL_FINALIZATION_ADMISSION_ESCROW_FILENAME
        ),
        safeStorage: this.options.safeStorage,
        channels,
        afterStage: (stage) => this.options.afterStage?.(`admission:${stage}`)
      })
    }
  }

  private capture(args: {
    runtime: Runtime
    initial: PeopleToChannelMigrationExecution
  }): PeopleToChannelMigrationFinalizationExecution {
    const recovery = args.runtime.recovery.load()
    if (
      !recovery ||
      recovery.phase !== 'cutover_applied' ||
      !recovery.channelStateDigest ||
      !recovery.cutoverStateDigest
    ) {
      blocked('People migration terminal capture has no additive cutover evidence')
    }
    const sourceRead = args.runtime.source.read()
    const chats = this.options.listChats()
    const workflowChatIds = this.options.listWorkflowChatIds?.() ?? []
    if (!Array.isArray(chats) || !Array.isArray(workflowChatIds)) {
      blocked('People migration terminal inventory ports are invalid')
    }
    const identity = this.options.loadIdentity()
    const hostIdentityPublicKey = exportRawEd25519PublicKey(identity.publicKey).toString('base64')
    const inventory = readPeopleToChannelMigrationInventory({
      hostIdentityPublicKey,
      people: { readMigrationSnapshot: () => sourceRead.snapshot },
      channels: args.runtime.channels,
      chats,
      workflowChatIds
    })
    const migrationAt = terminalMigrationAt(args.initial.base.migrationAt, this.now())
    const previewBase = materializePeopleToChannels({
      plan: inventory.plan,
      source: inventory.source,
      hostDisplayName: this.options.hostDisplayName,
      migrationAt
    })
    const delta = buildPeopleToChannelMigrationFinalizationDelta({
      initial: args.initial,
      current: inventory.source,
      donorChats: chats,
      existingLogs: snapshotExistingLogs({ base: previewBase, log: args.runtime.messageLog }),
      hostDisplayName: this.options.hostDisplayName,
      migrationAt
    })
    return createPeopleToChannelMigrationFinalizationExecution({
      schemaVersion: PEOPLE_TO_CHANNEL_FINALIZATION_EXECUTION_VERSION,
      initialPlanId: args.initial.plan.planId,
      initialPlanDigest: args.initial.planDigest,
      channelStateDigest: recovery.channelStateDigest,
      cutoverStateDigest: recovery.cutoverStateDigest,
      scope: derivePeopleToChannelMigrationFinalizationScope({
        shares: sourceRead.snapshot.shares
      }),
      delta: delta.execution
    })
  }

  private assertTerminalResult(args: {
    finalization: PeopleToChannelMigrationFinalizationCoordinatorResult
    terminal: PeopleToChannelMigrationFinalizationAdmissionsResult
    sealed: PeopleToChannelMigrationFinalizationExecution
  }): void {
    if (
      args.finalization.phase !== 'committed' ||
      args.terminal.initialPlanId !== args.finalization.planId ||
      args.terminal.planId !== args.sealed.delta.base.planId ||
      args.terminal.invitations.length !== args.finalization.terminalInvitationCount ||
      args.terminal.terminalEscrowDigest !== args.finalization.terminalAdmissionEscrowDigest
    ) {
      blocked('People migration terminal admission recovery does not match its committed receipt')
    }
  }
}

export function isPeopleToChannelMigrationFinalizationProductionRunnerError(
  error: unknown
): error is PeopleToChannelMigrationFinalizationProductionRunnerError {
  return (
    error instanceof PeopleToChannelMigrationFinalizationProductionRunnerError &&
    error.code === 'recovery_blocked'
  )
}
