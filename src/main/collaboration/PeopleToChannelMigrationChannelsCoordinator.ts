import { createHash } from 'crypto'

import {
  PeopleToChannelMigrationAdmissionReissue,
  PeopleToChannelMigrationAdmissionReissueError,
  type PeopleToChannelReissuedAdmission
} from './PeopleToChannelMigrationAdmissionReissue'
import {
  PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION,
  type PeopleToChannelMigrationHistoryMaterialization
} from './PeopleToChannelMigrationHistory'
import { PeopleToChannelMigrationLogWriter } from './PeopleToChannelMigrationLogWriter'
import {
  PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION,
  type PeopleToChannelMigrationMaterialization
} from './PeopleToChannelMigrationMaterializer'
import {
  PeopleToChannelMigrationPolicyWriter,
  PeopleToChannelMigrationPolicyWriterError,
  type PeopleToChannelMigrationPolicyWriteResult
} from './PeopleToChannelMigrationPolicyWriter'
import {
  PeopleToChannelMigrationRecoveryError,
  PeopleToChannelMigrationRecoveryStore,
  type PeopleToChannelMigrationRecoveryRecord
} from './PeopleToChannelMigrationRecoveryStore'
import { ChannelError, ChannelStore, type Channel } from './ChannelStore'
import { channelStoreSubsetDigest } from './ChannelStoreSubsetDigest'

export const PEOPLE_TO_CHANNEL_CHANNELS_COORDINATOR_VERSION = 1

export type PeopleToChannelChannelsCoordinatorStage =
  | 'logs_durable'
  | 'policies_durable'
  | 'metadata_durable'
  | 'recovery_durable'

export interface PeopleToChannelMigrationChannelsCoordinatorOptions {
  recovery: PeopleToChannelMigrationRecoveryStore
  logs: PeopleToChannelMigrationLogWriter
  policies: PeopleToChannelMigrationPolicyWriter
  admissions: PeopleToChannelMigrationAdmissionReissue
  channels: ChannelStore
  now?: () => number
  /** Test/observability seam invoked only after the named state is durable. */
  afterStage?: (stage: PeopleToChannelChannelsCoordinatorStage) => void
}

export interface PeopleToChannelMigrationChannelsAppliedResult {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_CHANNELS_COORDINATOR_VERSION
  phase: 'channels_applied'
  planId: string
  channelStateDigest: string
  channelIds: string[]
  invitations: PeopleToChannelReissuedAdmission[]
  recoveryAdvancedThisRun: boolean
  recovery: PeopleToChannelMigrationRecoveryRecord
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/

export class PeopleToChannelMigrationChannelsCoordinatorError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'PeopleToChannelMigrationChannelsCoordinatorError'
  }
}

function blocked(message: string): never {
  throw new PeopleToChannelMigrationChannelsCoordinatorError(message)
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

function materializationDigest(materialization: PeopleToChannelMigrationMaterialization): string {
  const { materializationDigest: _recorded, ...withoutDigest } = materialization
  return sha256(canonicalJson(withoutDigest))
}

function historyExecutionDigest(history: PeopleToChannelMigrationHistoryMaterialization): string {
  const { executionDigest: _recorded, ...withoutDigest } = history
  return sha256(canonicalJson(withoutDigest))
}

function channelIdentityForHistory(channel: Channel): unknown {
  const { updatedAt: _updatedAt, messageCount: _messageCount, display, ...stableChannel } = channel
  const { messageCount: _displayMessageCount, ...stableDisplay } = display
  return { ...stableChannel, display: stableDisplay }
}

function validateInputs(args: {
  base: PeopleToChannelMigrationMaterialization
  history: PeopleToChannelMigrationHistoryMaterialization
}): string[] {
  const { base, history } = args
  if (
    base.schemaVersion !== PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION ||
    history.schemaVersion !== PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION ||
    !SHA256_PATTERN.test(base.planId) ||
    !SHA256_PATTERN.test(base.sourceDigest) ||
    !SHA256_PATTERN.test(base.materializationDigest) ||
    materializationDigest(base) !== base.materializationDigest ||
    !SHA256_PATTERN.test(history.executionDigest) ||
    historyExecutionDigest(history) !== history.executionDigest ||
    history.planId !== base.planId ||
    history.sourceDigest !== base.sourceDigest ||
    history.baseMaterializationDigest !== base.materializationDigest ||
    history.migrationAt !== base.migrationAt ||
    !Array.isArray(base.mutations) ||
    !Array.isArray(history.metadataMutations) ||
    !Array.isArray(history.logMutations) ||
    base.mutations.length !== history.metadataMutations.length
  ) {
    blocked('People migration Channels inputs do not match')
  }
  const baseByChannel = new Map(
    base.mutations.map((mutation) => [mutation.channel.channelId, mutation] as const)
  )
  if (baseByChannel.size !== base.mutations.length) {
    blocked('People migration Channels target is duplicated')
  }
  const logByChannel = new Map(
    history.logMutations.map((mutation) => [mutation.channelId, mutation] as const)
  )
  if (logByChannel.size !== history.logMutations.length) {
    blocked('People migration Channel log target is invalid')
  }
  for (const logMutation of history.logMutations) {
    if (!baseByChannel.has(logMutation.channelId)) {
      blocked('People migration Channel log target is invalid')
    }
  }
  const channelIds = new Set<string>()
  for (const historyMutation of history.metadataMutations) {
    const channelId = historyMutation.channel.channelId
    const baseMutation = baseByChannel.get(channelId)
    const logMutation = logByChannel.get(channelId)
    if (
      channelIds.has(channelId) ||
      !baseMutation ||
      historyMutation.mode !== baseMutation.mode ||
      historyMutation.beforeDigest !== baseMutation.beforeDigest ||
      canonicalJson(historyMutation.members) !== canonicalJson(baseMutation.members) ||
      canonicalJson(historyMutation.invites) !== canonicalJson(baseMutation.invites) ||
      canonicalJson(channelIdentityForHistory(historyMutation.channel)) !==
        canonicalJson(channelIdentityForHistory(baseMutation.channel)) ||
      !Number.isSafeInteger(historyMutation.channel.updatedAt) ||
      historyMutation.channel.updatedAt < baseMutation.channel.updatedAt ||
      !Number.isSafeInteger(historyMutation.channel.messageCount) ||
      historyMutation.channel.messageCount < baseMutation.channel.messageCount ||
      historyMutation.channel.display.messageCount !== historyMutation.channel.messageCount ||
      (!logMutation &&
        (historyMutation.channel.messageCount !== baseMutation.channel.messageCount ||
          historyMutation.channel.updatedAt !== baseMutation.channel.updatedAt)) ||
      (logMutation &&
        (historyMutation.channel.messageCount !== logMutation.messages.length ||
          logMutation.messages.length - logMutation.importedCount !==
            baseMutation.channel.messageCount ||
          historyMutation.channel.updatedAt !==
            Math.max(baseMutation.channel.updatedAt, base.migrationAt)))
    ) {
      blocked('People migration Channels history changed frozen metadata authority')
    }
    channelIds.add(channelId)
  }
  return [...channelIds].sort(compareText)
}

function currentChannelSubsets(channels: ChannelStore, channelIds: readonly string[]): unknown[] {
  return channelIds.map((channelId) => {
    const channel = channels.getChannel(channelId)
    if (!channel) blocked('People migration Channel metadata is not durable')
    return {
      channelId,
      digest: channelStoreSubsetDigest(
        channel,
        channels.listMembers(channelId),
        channels.listInvites(channelId)
      )
    }
  })
}

function channelStateDigest(args: {
  recovery: PeopleToChannelMigrationRecoveryRecord
  base: PeopleToChannelMigrationMaterialization
  history: PeopleToChannelMigrationHistoryMaterialization
  policy: PeopleToChannelMigrationPolicyWriteResult
  escrowDigest: string | null
  channelSubsets: unknown[]
}): string {
  return sha256(
    canonicalJson({
      schemaVersion: PEOPLE_TO_CHANNEL_CHANNELS_COORDINATOR_VERSION,
      planId: args.base.planId,
      planDigest: args.recovery.planDigest,
      sourceDigest: args.base.sourceDigest,
      baseMaterializationDigest: args.base.materializationDigest,
      historyExecutionDigest: args.history.executionDigest,
      logTargets: args.history.logMutations.map((mutation) => ({
        channelId: mutation.channelId,
        desiredDigest: mutation.desiredDigest,
        importedCount: mutation.importedCount
      })),
      policyDigest: args.policy.policyDigest,
      policyCount: args.policy.policyCount,
      admissionEscrowDigest: args.escrowDigest,
      channelSubsets: args.channelSubsets
    })
  )
}

function assertChannelIds(actual: readonly string[], expected: readonly string[]): void {
  if (canonicalJson([...actual].sort(compareText)) !== canonicalJson(expected)) {
    blocked('People migration Channel metadata batch is incomplete')
  }
}

/**
 * The only P4 seam allowed to advance recovery to `channels_applied`. Content
 * logs and restrictive policy authority land first, encrypted pending
 * credentials land before one complete metadata batch, and the recovery
 * marker is last.
 */
export class PeopleToChannelMigrationChannelsCoordinator {
  private readonly now: () => number

  constructor(private readonly options: PeopleToChannelMigrationChannelsCoordinatorOptions) {
    this.now = options.now ?? Date.now
  }

  apply(args: {
    base: PeopleToChannelMigrationMaterialization
    history: PeopleToChannelMigrationHistoryMaterialization
  }): PeopleToChannelMigrationChannelsAppliedResult {
    const channelIds = validateInputs(args)
    const existingRecovery = this.options.recovery.load()
    if (
      !existingRecovery ||
      existingRecovery.planId !== args.base.planId ||
      existingRecovery.sourceDigest !== args.base.sourceDigest
    ) {
      blocked('People migration prepared recovery intent does not match')
    }

    if (existingRecovery.phase === 'channels_applied') {
      this.options.logs.apply(args.history)
      const policy = this.options.policies.apply(args)
      const escrow = this.options.admissions.recoverEscrow(args)
      const digest = channelStateDigest({
        recovery: existingRecovery,
        ...args,
        policy,
        escrowDigest: escrow.escrowDigest,
        channelSubsets: currentChannelSubsets(this.options.channels, channelIds)
      })
      if (digest !== existingRecovery.channelStateDigest) {
        blocked('People migration durable Channel evidence changed')
      }
      return {
        schemaVersion: PEOPLE_TO_CHANNEL_CHANNELS_COORDINATOR_VERSION,
        phase: 'channels_applied',
        planId: args.base.planId,
        channelStateDigest: digest,
        channelIds,
        invitations: escrow.invitations.map(clone),
        recoveryAdvancedThisRun: false,
        recovery: clone(existingRecovery)
      }
    }
    if (existingRecovery.phase !== 'prepared') {
      blocked('People migration Channels phase is out of order')
    }

    this.options.logs.apply(args.history)
    this.options.afterStage?.('logs_durable')
    const policy = this.options.policies.apply(args)
    this.options.afterStage?.('policies_durable')
    const admission = this.options.admissions.apply(args)
    let appliedChannelIds = admission.channelIds
    if (admission.escrowDigest === null) {
      appliedChannelIds = this.options.channels.applyMigrationBatch(
        args.history.metadataMutations
      ).channelIds
    }
    assertChannelIds(appliedChannelIds, channelIds)
    this.options.afterStage?.('metadata_durable')

    const digest = channelStateDigest({
      recovery: existingRecovery,
      ...args,
      policy,
      escrowDigest: admission.escrowDigest,
      channelSubsets: currentChannelSubsets(this.options.channels, channelIds)
    })
    const recovery = this.options.recovery.markChannelsApplied({
      planId: args.base.planId,
      channelStateDigest: digest,
      now: this.now()
    })
    this.options.afterStage?.('recovery_durable')
    return {
      schemaVersion: PEOPLE_TO_CHANNEL_CHANNELS_COORDINATOR_VERSION,
      phase: 'channels_applied',
      planId: args.base.planId,
      channelStateDigest: digest,
      channelIds,
      invitations: admission.invitations.map(clone),
      recoveryAdvancedThisRun: true,
      recovery
    }
  }
}

export function isPeopleToChannelMigrationChannelsCoordinatorError(
  error: unknown
): error is
  | PeopleToChannelMigrationChannelsCoordinatorError
  | PeopleToChannelMigrationRecoveryError
  | PeopleToChannelMigrationPolicyWriterError
  | PeopleToChannelMigrationAdmissionReissueError
  | ChannelError {
  return (
    (error instanceof PeopleToChannelMigrationChannelsCoordinatorError ||
      error instanceof PeopleToChannelMigrationRecoveryError ||
      error instanceof PeopleToChannelMigrationPolicyWriterError ||
      error instanceof PeopleToChannelMigrationAdmissionReissueError ||
      error instanceof ChannelError) &&
    error.code === 'recovery_blocked'
  )
}
