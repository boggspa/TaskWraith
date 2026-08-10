import { createHash } from 'crypto'

import {
  ChannelMessageLog,
  type ChannelMessageLogMigrationMutation,
  type ChannelMessageLogMigrationResult
} from './ChannelMessageLog'
import { ChannelError } from './ChannelStore'
import {
  PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION,
  type PeopleToChannelMigrationHistoryMaterialization
} from './PeopleToChannelMigrationHistory'

const SHA256_PATTERN = /^[a-f0-9]{64}$/

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

function executionDigest(
  value: Omit<PeopleToChannelMigrationHistoryMaterialization, 'executionDigest'>
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)), 'utf8')
    .digest('hex')
}

function mutationsFrom(
  history: PeopleToChannelMigrationHistoryMaterialization
): ChannelMessageLogMigrationMutation[] {
  const { executionDigest: recordedDigest, ...withoutDigest } = history
  if (
    history.schemaVersion !== PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION ||
    !Array.isArray(history.metadataMutations) ||
    !Array.isArray(history.logMutations) ||
    !SHA256_PATTERN.test(history.planId) ||
    !SHA256_PATTERN.test(history.sourceDigest) ||
    !SHA256_PATTERN.test(history.baseMaterializationDigest) ||
    !SHA256_PATTERN.test(recordedDigest) ||
    !Number.isSafeInteger(history.migrationAt) ||
    history.migrationAt < 0 ||
    !Number.isSafeInteger(history.importedContributionCount) ||
    history.importedContributionCount < 0 ||
    executionDigest(withoutDigest) !== recordedDigest
  ) {
    throw new ChannelError('recovery_blocked', 'People migration history digest does not match')
  }

  const metadataByChannel = new Map(
    history.metadataMutations.map((mutation) => [mutation.channel.channelId, mutation] as const)
  )
  if (metadataByChannel.size !== history.metadataMutations.length) {
    throw new ChannelError('recovery_blocked', 'People migration metadata target is duplicated')
  }
  if (
    history.importedContributionCount !==
    history.logMutations.reduce((count, mutation) => count + mutation.importedCount, 0)
  ) {
    throw new ChannelError('recovery_blocked', 'People migration history count is inconsistent')
  }
  return history.logMutations.map((logMutation) => {
    const metadata = metadataByChannel.get(logMutation.channelId)
    if (
      !metadata ||
      metadata.channel.messageCount !== logMutation.messages.length ||
      metadata.channel.display.messageCount !== logMutation.messages.length
    ) {
      throw new ChannelError(
        'recovery_blocked',
        'People migration log has no matching metadata target'
      )
    }
    return {
      channel: metadata.channel,
      members: metadata.members,
      beforeDigest: logMutation.beforeDigest,
      desiredDigest: logMutation.desiredDigest,
      messages: logMutation.messages,
      importedCount: logMutation.importedCount
    }
  })
}

/** Applies only the durable-log phase; metadata and recovery state remain untouched. */
export class PeopleToChannelMigrationLogWriter {
  constructor(private readonly logs: ChannelMessageLog) {}

  apply(history: PeopleToChannelMigrationHistoryMaterialization): ChannelMessageLogMigrationResult {
    return this.logs.applyMigrationBatch(mutationsFrom(history))
  }
}
