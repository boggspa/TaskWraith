import type { ChatMessage, RunRecoveryRecord } from '../../../main/store/types'
import { getProviderLabel } from './providerLabels'

const recoveryMessageId = (record: RunRecoveryRecord): string => `recovery-${record.id}`

export const recoveryBatchMessageId = (chatId: string, recoveredAt: string): string =>
  `recovery-batch-${chatId}-${recoveredAt}`

const formatProcessText = (record: RunRecoveryRecord): string => {
  if (record.process?.alive) {
    return ` A process with PID ${record.process.pid}${
      record.process.command ? ` (${record.process.command})` : ''
    } may still be running outside TaskWraith.`
  }
  if (record.process) {
    return ` No live process was found for the recorded PID ${record.process.pid}.`
  }
  return ''
}

const formatSessionText = (record: RunRecoveryRecord): string =>
  record.jobSnapshot.providerSessionId
    ? ` Provider session ID: ${record.jobSnapshot.providerSessionId}.`
    : ''

const laneLabel = (record: RunRecoveryRecord): string => {
  const parts = [record.ensembleRole, record.ensembleParticipantId].filter(
    (value): value is string => Boolean(value && value.trim())
  )
  return parts.length > 0 ? ` (${parts.join(' / ')})` : ''
}

const hasEnsembleIdentity = (record: RunRecoveryRecord): boolean =>
  Boolean(record.ensembleRole?.trim() || record.ensembleParticipantId?.trim())

/** Ensemble identity re-derived from the chat's persisted `runs[]` by runId. */
export interface RecoveryEnsembleIdentity {
  ensembleParticipantId?: string
  ensembleRole?: string
}

/**
 * A recovered RunQueueJob can lose its ensemble identity (the job was registered
 * before its ChatRun was persisted, so `lookupEnsembleQueueMetadata` found no
 * match), leaving the recovery record with empty `ensembleRole`/
 * `ensembleParticipantId`. The message then reads as a solo provider run
 * ("Recovered interrupted Claude run …") with no lane label, and same-pass
 * participants aren't batched. The chat's persisted `runs[]` DO carry the
 * identity (EnsembleOrchestrator writes it on every seeded run and it survives
 * restart), so re-derive it by runId when the record itself is unlabelled.
 */
const enrichRecordWithEnsembleIdentity = (
  record: RunRecoveryRecord,
  resolveEnsembleIdentity?: (runId: string | undefined) => RecoveryEnsembleIdentity | undefined
): RunRecoveryRecord => {
  if (record.ensembleRole?.trim() || record.ensembleParticipantId?.trim()) return record
  const identity = resolveEnsembleIdentity?.(record.runId)
  if (!identity || (!identity.ensembleParticipantId?.trim() && !identity.ensembleRole?.trim())) {
    return record
  }
  return {
    ...record,
    ...(identity.ensembleParticipantId?.trim()
      ? { ensembleParticipantId: identity.ensembleParticipantId }
      : {}),
    ...(identity.ensembleRole?.trim() ? { ensembleRole: identity.ensembleRole } : {})
  }
}

const formatRecoveryLineForRecord = (record: RunRecoveryRecord): string => {
  const providerLabel = getProviderLabel(record.provider)
  const detailsText = `${record.reason} TaskWraith marked the run as ${record.recoveredStatus}.`
  const runIdText = record.runId ? ` Run ID ${record.runId}.` : ''
  return `- ${providerLabel}${laneLabel(record)} run${runIdText} ${detailsText}${formatProcessText(
    record
  )}${formatSessionText(record)} ${record.resumeHint}`
}

export const formatRecoveryMessage = (record: RunRecoveryRecord): string => {
  const providerLabel = getProviderLabel(record.provider)
  const detailsText = `${record.reason} TaskWraith marked the run as ${record.recoveredStatus}.`
  const runIdText = record.runId ? ` (${record.runId})` : ''
  return `Recovered interrupted ${providerLabel}${laneLabel(record)} run${runIdText} after app restart. ${detailsText}${formatProcessText(record)}${formatSessionText(record)} ${record.resumeHint}`
}

export const buildRecoveryMessagesForChat = (
  chatId: string,
  records: RunRecoveryRecord[],
  existingMessageIds: Set<string>,
  resolveEnsembleIdentity?: (runId: string | undefined) => RecoveryEnsembleIdentity | undefined
): ChatMessage[] => {
  // Re-derive ensemble identity from the chat's persisted runs BEFORE grouping,
  // so both the batch decision (`hasEnsembleIdentity`) and the lane label see it.
  const enrichedRecords = resolveEnsembleIdentity
    ? records.map((record) => enrichRecordWithEnsembleIdentity(record, resolveEnsembleIdentity))
    : records
  const recordsByRecoveredAt = new Map<string, RunRecoveryRecord[]>()
  for (const record of enrichedRecords) {
    const recoveredAt = record.recoveredAt
    const existing = recordsByRecoveredAt.get(recoveredAt)
    if (existing) existing.push(record)
    else recordsByRecoveredAt.set(recoveredAt, [record])
  }

  const messages: ChatMessage[] = []
  const pushSingleMessage = (record: RunRecoveryRecord): void => {
    const messageId = recoveryMessageId(record)
    if (existingMessageIds.has(messageId)) return
    messages.push({
      id: messageId,
      role: 'system',
      content: formatRecoveryMessage(record),
      timestamp: record.recoveredAt,
      runId: record.runId
    })
  }

  for (const batch of recordsByRecoveredAt.values()) {
    if (batch.length === 1 || !batch.some(hasEnsembleIdentity)) {
      for (const record of batch) pushSingleMessage(record)
      continue
    }

    const representative = batch[0]!
    const batchMessageId = recoveryBatchMessageId(chatId, representative.recoveredAt)
    if (existingMessageIds.has(batchMessageId)) continue
    const legacyMessageIds = batch.map((record) => recoveryMessageId(record))
    if (legacyMessageIds.every((messageId) => existingMessageIds.has(messageId))) continue

    const entries = batch.map(formatRecoveryLineForRecord).join('\n')
    messages.push({
      id: batchMessageId,
      role: 'system',
      content: `Recovered interrupted ${batch.length} runs after app restart.\n${entries}`,
      timestamp: representative.recoveredAt,
      runId: representative.runId
    })
  }

  return messages
}
