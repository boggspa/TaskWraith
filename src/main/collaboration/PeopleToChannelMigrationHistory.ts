import { createHash } from 'crypto'

import type { ChatMessage } from '../store/types'
import {
  MAX_CHANNEL_MESSAGE_BYTES,
  MAX_CLIENT_MESSAGE_ID_LENGTH,
  redactChannelContent,
  type ChannelMessage,
  type HumanChannelMessage
} from './ChannelMessageLog'
import type { HumanChannelMember } from './ChannelStore'
import {
  peopleToChannelLegacyContributionEvidence,
  peopleToChannelLegacyContributionEvidenceList,
  type PeopleToChannelInventoryChat
} from './PeopleToChannelMigrationInventory'
import {
  PEOPLE_TO_CHANNEL_MIGRATION_PLAN_VERSION,
  type PeopleToChannelLegacyContributionEvidence,
  type PeopleToChannelMigrationEntry,
  type PeopleToChannelMigrationHistorySummary,
  type PeopleToChannelMigrationPlan
} from './PeopleToChannelMigrationPlan'
import {
  PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION,
  type PeopleToChannelChannelMutation,
  type PeopleToChannelMigrationMaterialization
} from './PeopleToChannelMigrationMaterializer'

export const PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION = 1

export interface PeopleToChannelExistingLogSnapshot {
  channelId: string
  messages: readonly ChannelMessage[]
  digest: string
}

export interface PeopleToChannelHistoryLogMutation {
  channelId: string
  beforeDigest: string
  desiredDigest: string
  messages: ChannelMessage[]
  importedCount: number
}

export interface PeopleToChannelMigrationHistoryMaterialization {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION
  planId: string
  sourceDigest: string
  baseMaterializationDigest: string
  migrationAt: number
  metadataMutations: PeopleToChannelChannelMutation[]
  logMutations: PeopleToChannelHistoryLogMutation[]
  importedContributionCount: number
  executionDigest: string
}

export class PeopleToChannelMigrationHistoryError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'PeopleToChannelMigrationHistoryError'
  }
}

interface DonorRow {
  evidence: PeopleToChannelLegacyContributionEvidence
  message: ChatMessage
}

interface ImportedDraft {
  sourceKind: PeopleToChannelLegacyContributionEvidence['kind']
  sourceMessageId: string
  sourceSequence: number
  messageId: string
  authorMemberId: string
  clientMessageId: string
  content: string
  acceptedAt: number
  contentHash: string
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/

function blocked(message: string): never {
  throw new PeopleToChannelMigrationHistoryError(message)
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

function fingerprint(domain: string, value: string): string {
  return sha256(`${domain}\u0000${value}`)
}

function logDigest(messages: readonly ChannelMessage[]): string {
  return sha256(JSON.stringify(messages))
}

function validateBaseMaterialization(base: PeopleToChannelMigrationMaterialization): void {
  const { materializationDigest, ...withoutDigest } = base
  if (
    !SHA256_PATTERN.test(materializationDigest) ||
    sha256(canonicalJson(withoutDigest)) !== materializationDigest
  ) {
    blocked('Base migration materialization digest does not match')
  }
}

function expectedMutationTargets(
  plan: PeopleToChannelMigrationPlan
): Map<string, { chatId: string; ownerMemberId: string; mode: 'create' | 'merge' }> {
  const targets = new Map<
    string,
    { chatId: string; ownerMemberId: string; mode: 'create' | 'merge' }
  >()
  const add = (
    channelId: string,
    chatId: string,
    ownerMemberId: string,
    mode: 'create' | 'merge'
  ): void => {
    if (targets.has(channelId)) {
      blocked('Frozen migration plan targets a Channel more than once')
    }
    targets.set(channelId, { chatId, ownerMemberId, mode })
  }
  for (const entry of plan.entries) {
    if (entry.disposition === 'retain_legacy') continue
    if (entry.disposition === 'blocked' || !entry.target) {
      blocked('Blocked People migration entry cannot materialize history')
    }
    add(entry.target.channelId, entry.target.chatId, entry.target.ownerMemberId, entry.disposition)
  }
  for (const entry of plan.generalChats) {
    if (entry.disposition === 'blocked') {
      blocked('Blocked General migration entry cannot materialize history')
    }
    if (entry.disposition === 'create') {
      if (!entry.target) blocked('General migration target is missing')
      add(entry.target.channelId, entry.target.chatId, entry.target.ownerMemberId, 'create')
    }
  }
  return targets
}

function historySummary(
  shareId: string,
  evidence: readonly PeopleToChannelLegacyContributionEvidence[]
): PeopleToChannelMigrationHistorySummary {
  const selected = evidence
    .filter((entry) => entry.shareId === shareId)
    .sort((left, right) =>
      compareText(
        `${left.sequence}\u0000${left.messageId}`,
        `${right.sequence}\u0000${right.messageId}`
      )
    )
  return {
    commentCount: selected.filter((entry) => entry.kind === 'comment').length,
    externalSeatTurnCount: selected.filter((entry) => entry.kind === 'external-seat-turn').length,
    highestSequence: selected.reduce((highest, entry) => Math.max(highest, entry.sequence), 0),
    evidenceDigest: sha256(canonicalJson(selected))
  }
}

function donorRows(
  chat: PeopleToChannelInventoryChat,
  shareId: string,
  expected: PeopleToChannelMigrationHistorySummary
): DonorRow[] {
  const messages = chat.messages ?? []
  let evidence: PeopleToChannelLegacyContributionEvidence[]
  try {
    evidence = peopleToChannelLegacyContributionEvidenceList(messages)
  } catch (error) {
    blocked(
      error instanceof Error
        ? `Legacy People contribution inventory is invalid: ${error.message}`
        : 'Legacy People contribution inventory is invalid'
    )
  }
  if (canonicalJson(historySummary(shareId, evidence)) !== canonicalJson(expected)) {
    blocked('Legacy People contribution evidence no longer matches the frozen plan')
  }

  const rowsByMessageId = new Map<string, DonorRow>()
  for (const message of messages) {
    let entry: PeopleToChannelLegacyContributionEvidence | null
    try {
      entry = peopleToChannelLegacyContributionEvidence(message)
    } catch (error) {
      blocked(
        error instanceof Error
          ? `Legacy People contribution row is invalid: ${error.message}`
          : 'Legacy People contribution row is invalid'
      )
    }
    if (!entry || entry.shareId !== shareId) continue
    rowsByMessageId.set(entry.messageId, { evidence: entry, message })
  }
  return evidence
    .filter((entry) => entry.shareId === shareId)
    .map(
      (entry) => rowsByMessageId.get(entry.messageId) ?? blocked('Legacy People row disappeared')
    )
}

function selectedDonorRows(rows: readonly DonorRow[]): DonorRow[] {
  const bySequence = new Map<number, DonorRow[]>()
  const sequenceByClient = new Map<string, number>()
  for (const row of rows) {
    const group = bySequence.get(row.evidence.sequence) ?? []
    group.push(row)
    bySequence.set(row.evidence.sequence, group)
    const clientKey = `${row.evidence.collaboratorId}\u0000${row.evidence.clientMessageId}`
    const priorSequence = sequenceByClient.get(clientKey)
    if (priorSequence !== undefined && priorSequence !== row.evidence.sequence) {
      blocked('Legacy People client id maps to multiple contribution sequences')
    }
    sequenceByClient.set(clientKey, row.evidence.sequence)
  }

  const selected: DonorRow[] = []
  for (const group of bySequence.values()) {
    const first = group[0]
    if (
      group.some(
        (row) =>
          row.evidence.collaboratorId !== first.evidence.collaboratorId ||
          row.evidence.clientMessageId !== first.evidence.clientMessageId
      )
    ) {
      blocked('Legacy People contribution sequence has conflicting source identity')
    }
    if (group.some((row) => row.evidence.contentHash !== first.evidence.contentHash)) {
      blocked('Legacy People contribution duplicates carry different content')
    }
    if (group.length > 2) {
      blocked('Legacy People contribution sequence has too many persisted rows')
    }
    selected.push(group.find((row) => row.evidence.kind === 'external-seat-turn') ?? first)
  }
  return selected.sort(
    (left, right) =>
      left.evidence.acceptedAt - right.evidence.acceptedAt ||
      left.evidence.sequence - right.evidence.sequence ||
      compareText(left.evidence.kind, right.evidence.kind) ||
      compareText(left.evidence.messageId, right.evidence.messageId)
  )
}

function targetHumanMember(
  entry: PeopleToChannelMigrationEntry,
  mutation: PeopleToChannelChannelMutation,
  row: DonorRow
): HumanChannelMember {
  const mappings =
    entry.target?.memberMappings.filter(
      (mapping) => mapping.sourceCollaboratorId === row.evidence.collaboratorId
    ) ?? []
  if (mappings.length !== 1) {
    blocked('Legacy People contribution has no unique target member mapping')
  }
  const member = mutation.members.find(
    (candidate) => candidate.memberId === mappings[0].targetMemberId
  )
  if (!member || member.kind !== 'human' || member.status === 'pending') {
    blocked('Legacy People contribution target is not an admitted human member')
  }
  if (
    row.evidence.acceptedAt < member.joinedAt ||
    (member.status === 'revoked' &&
      (member.revokedAt === undefined || row.evidence.acceptedAt >= member.revokedAt))
  ) {
    blocked('Legacy People contribution falls outside target membership history')
  }
  return member
}

function importedDrafts(args: {
  plan: PeopleToChannelMigrationPlan
  base: PeopleToChannelMigrationMaterialization
  entry: PeopleToChannelMigrationEntry
  mutation: PeopleToChannelChannelMutation
  chat: PeopleToChannelInventoryChat
  importAcceptedAfter?: number
}): ImportedDraft[] {
  const { plan, base, entry, mutation, chat, importAcceptedAfter } = args
  return selectedDonorRows(donorRows(chat, entry.source.shareId, entry.source.history)).flatMap(
    (row) => {
      if (row.evidence.acceptedAt > base.migrationAt) {
        blocked('Legacy People contribution timestamp is after the migration boundary')
      }
      if (importAcceptedAfter !== undefined && row.evidence.acceptedAt <= importAcceptedAfter) {
        return []
      }
      const member = targetHumanMember(entry, mutation, row)
      const content = redactChannelContent(row.message.content).trim()
      if (!content) blocked('Legacy People contribution is empty after redaction')
      if (Buffer.byteLength(content, 'utf8') > MAX_CHANNEL_MESSAGE_BYTES) {
        blocked('Legacy People contribution exceeds the Channel message limit')
      }
      const identity = [
        plan.planId,
        mutation.channel.channelId,
        entry.source.shareId,
        row.evidence.collaboratorId,
        String(row.evidence.sequence),
        row.evidence.clientMessageId,
        row.evidence.messageId
      ].join('\u0000')
      return [
        {
          sourceKind: row.evidence.kind,
          sourceMessageId: row.evidence.messageId,
          sourceSequence: row.evidence.sequence,
          messageId: `migration_${fingerprint('people-to-channel-history-message', identity).slice(0, 40)}`,
          authorMemberId: member.memberId,
          clientMessageId: `migration_${fingerprint('people-to-channel-history-client', identity)}`,
          content,
          acceptedAt: row.evidence.acceptedAt,
          contentHash: sha256(content)
        }
      ]
    }
  )
}

function validateExistingMessages(
  channelId: string,
  messages: readonly ChannelMessage[]
): ChannelMessage[] {
  const seenMessageIds = new Set<string>()
  const seenClients = new Set<string>()
  return messages.map((message, index) => {
    if (
      message.channelId !== channelId ||
      message.sequence !== index + 1 ||
      !message.messageId ||
      !message.authorMemberId ||
      !message.clientMessageId ||
      message.clientMessageId.length > MAX_CLIENT_MESSAGE_ID_LENGTH ||
      (message.kind !== 'human.text' && message.kind !== 'agent.text') ||
      !message.content ||
      Buffer.byteLength(message.content, 'utf8') > MAX_CHANNEL_MESSAGE_BYTES ||
      !Number.isFinite(message.acceptedAt) ||
      !SHA256_PATTERN.test(message.contentHash) ||
      sha256(message.content) !== message.contentHash
    ) {
      blocked('Existing Channel log snapshot is invalid')
    }
    const clientKey = `${message.authorMemberId}\u0000${message.clientMessageId}`
    if (seenMessageIds.has(message.messageId) || seenClients.has(clientKey)) {
      blocked('Existing Channel log snapshot has duplicate idempotency evidence')
    }
    seenMessageIds.add(message.messageId)
    seenClients.add(clientKey)
    return clone(message)
  })
}

function exactImportedSuffix(
  messages: readonly ChannelMessage[],
  drafts: readonly ImportedDraft[]
): number | null {
  if (drafts.length === 0 || messages.length < drafts.length) return null
  const prefixLength = messages.length - drafts.length
  for (let index = 0; index < drafts.length; index += 1) {
    const message = messages[prefixLength + index]
    const draft = drafts[index]
    if (
      message.sequence !== prefixLength + index + 1 ||
      message.messageId !== draft.messageId ||
      message.authorMemberId !== draft.authorMemberId ||
      message.clientMessageId !== draft.clientMessageId ||
      message.kind !== 'human.text' ||
      message.content !== draft.content ||
      message.acceptedAt !== draft.acceptedAt ||
      message.contentHash !== draft.contentHash
    ) {
      return null
    }
  }
  return prefixLength
}

function desiredMessages(
  channelId: string,
  prefix: readonly ChannelMessage[],
  drafts: readonly ImportedDraft[]
): ChannelMessage[] {
  const messages = prefix.map(clone)
  const messageIds = new Set(messages.map((message) => message.messageId))
  const clients = new Set(
    messages.map((message) => `${message.authorMemberId}\u0000${message.clientMessageId}`)
  )
  for (const draft of drafts) {
    const clientKey = `${draft.authorMemberId}\u0000${draft.clientMessageId}`
    if (messageIds.has(draft.messageId) || clients.has(clientKey)) {
      blocked('Migrated People contribution collides with existing Channel history')
    }
    const message: HumanChannelMessage = {
      channelId,
      sequence: messages.length + 1,
      messageId: draft.messageId,
      authorMemberId: draft.authorMemberId,
      clientMessageId: draft.clientMessageId,
      kind: 'human.text',
      content: draft.content,
      acceptedAt: draft.acceptedAt,
      contentHash: draft.contentHash
    }
    messages.push(message)
    messageIds.add(message.messageId)
    clients.add(clientKey)
  }
  return messages
}

function executionDigest(
  value: Omit<PeopleToChannelMigrationHistoryMaterialization, 'executionDigest'>
): string {
  return sha256(canonicalJson(value))
}

/**
 * Reconstructs the exact content-bearing history execution from a frozen,
 * content-free plan. This result is ephemeral: recovery may persist only its
 * digest, never the donor or desired message bytes contained here.
 */
export function materializePeopleToChannelMigrationHistory(input: {
  plan: PeopleToChannelMigrationPlan
  base: PeopleToChannelMigrationMaterialization
  donorChats: readonly PeopleToChannelInventoryChat[]
  existingLogs: readonly PeopleToChannelExistingLogSnapshot[]
  legacyProjectionHistory: 'import-then-reset'
  /** Excludes rows at/before a prior durable migration boundary for terminal soak deltas. */
  importAcceptedAfter?: number
}): PeopleToChannelMigrationHistoryMaterialization {
  if (input.legacyProjectionHistory !== 'import-then-reset') {
    blocked('People migration history decision is not executable')
  }
  validateBaseMaterialization(input.base)
  if (
    input.plan.schemaVersion !== PEOPLE_TO_CHANNEL_MIGRATION_PLAN_VERSION ||
    input.base.schemaVersion !== PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION ||
    !SHA256_PATTERN.test(input.plan.planId) ||
    !SHA256_PATTERN.test(input.plan.sourceDigest) ||
    !Number.isSafeInteger(input.base.migrationAt) ||
    input.base.migrationAt < 0 ||
    (input.importAcceptedAfter !== undefined &&
      (!Number.isSafeInteger(input.importAcceptedAfter) ||
        input.importAcceptedAfter < 0 ||
        input.importAcceptedAfter > input.base.migrationAt)) ||
    input.base.planId !== input.plan.planId ||
    input.base.sourceDigest !== input.plan.sourceDigest
  ) {
    blocked('Base migration materialization does not match the frozen plan')
  }

  const chatsById = new Map<string, PeopleToChannelInventoryChat[]>()
  for (const chat of input.donorChats) {
    const rows = chatsById.get(chat.appChatId) ?? []
    rows.push(chat)
    chatsById.set(chat.appChatId, rows)
  }
  const logsByChannel = new Map<string, PeopleToChannelExistingLogSnapshot>()
  for (const snapshot of input.existingLogs) {
    if (logsByChannel.has(snapshot.channelId)) {
      blocked('Channel log snapshot inventory is duplicated')
    }
    if (!SHA256_PATTERN.test(snapshot.digest) || logDigest(snapshot.messages) !== snapshot.digest) {
      blocked('Channel log snapshot digest does not match')
    }
    logsByChannel.set(snapshot.channelId, snapshot)
  }

  const mutations = input.base.mutations.map(clone)
  const expectedTargets = expectedMutationTargets(input.plan)
  const mutationsByChannel = new Map<string, PeopleToChannelChannelMutation>()
  for (const mutation of mutations) {
    if (mutationsByChannel.has(mutation.channel.channelId)) {
      blocked('Base migration materialization targets a Channel more than once')
    }
    const expected = expectedTargets.get(mutation.channel.channelId)
    if (
      !expected ||
      mutation.mode !== expected.mode ||
      mutation.channel.chatId !== expected.chatId ||
      mutation.channel.ownerMemberId !== expected.ownerMemberId
    ) {
      blocked('Base migration metadata mutation does not match the frozen plan')
    }
    mutationsByChannel.set(mutation.channel.channelId, mutation)
  }
  if (mutationsByChannel.size !== expectedTargets.size) {
    blocked('Base migration metadata mutations are incomplete')
  }
  const allowedLogChannels = new Set<string>()
  const logMutations: PeopleToChannelHistoryLogMutation[] = []
  let importedContributionCount = 0

  for (const entry of input.plan.entries) {
    if (entry.disposition === 'retain_legacy') continue
    if (entry.disposition === 'blocked' || !entry.target) {
      blocked('Blocked People migration entry cannot materialize history')
    }
    const channelId = entry.target.channelId
    allowedLogChannels.add(channelId)
    const mutation = mutationsByChannel.get(channelId)
    if (!mutation) blocked('People migration history target has no metadata mutation')
    const chats = chatsById.get(entry.source.chatId) ?? []
    if (chats.length !== 1) {
      blocked('People migration history source chat is missing or duplicated')
    }
    const drafts = importedDrafts({
      plan: input.plan,
      base: input.base,
      entry,
      mutation,
      chat: chats[0],
      ...(input.importAcceptedAfter === undefined
        ? {}
        : { importAcceptedAfter: input.importAcceptedAfter })
    })
    const snapshot = logsByChannel.get(channelId)
    if (mutation.mode === 'merge' && !snapshot) {
      blocked('Existing Channel migration target has no log snapshot')
    }
    const current = snapshot ? validateExistingMessages(channelId, snapshot.messages) : []
    const importedSuffixStart = exactImportedSuffix(current, drafts)
    const prefix = importedSuffixStart === null ? current : current.slice(0, importedSuffixStart)
    if (prefix.length !== mutation.channel.messageCount) {
      blocked('Channel log prefix no longer matches frozen metadata')
    }
    const desired = desiredMessages(channelId, prefix, drafts)
    const desiredDigest = logDigest(desired)
    if (snapshot && snapshot.digest !== logDigest(prefix) && snapshot.digest !== desiredDigest) {
      blocked('Channel log is neither the frozen prefix nor the desired migration state')
    }
    if (drafts.length > 0) {
      mutation.channel.messageCount = desired.length
      mutation.channel.updatedAt = Math.max(mutation.channel.updatedAt, input.base.migrationAt)
      mutation.channel.display = {
        ...mutation.channel.display,
        messageCount: desired.length
      }
      logMutations.push({
        channelId,
        beforeDigest: logDigest(prefix),
        desiredDigest,
        messages: desired,
        importedCount: drafts.length
      })
      importedContributionCount += drafts.length
    }
  }

  for (const channelId of logsByChannel.keys()) {
    if (!allowedLogChannels.has(channelId)) {
      blocked('Channel log snapshot is outside the People migration plan')
    }
  }
  if (
    importedContributionCount !==
    logMutations.reduce((count, mutation) => count + mutation.importedCount, 0)
  ) {
    blocked('People migration history count is inconsistent')
  }

  const withoutDigest: Omit<PeopleToChannelMigrationHistoryMaterialization, 'executionDigest'> = {
    schemaVersion: PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION,
    planId: input.plan.planId,
    sourceDigest: input.plan.sourceDigest,
    baseMaterializationDigest: input.base.materializationDigest,
    migrationAt: input.base.migrationAt,
    metadataMutations: mutations.sort((left, right) =>
      compareText(left.channel.channelId, right.channel.channelId)
    ),
    logMutations: logMutations.sort((left, right) => compareText(left.channelId, right.channelId)),
    importedContributionCount
  }
  return { ...withoutDigest, executionDigest: executionDigest(withoutDigest) }
}
