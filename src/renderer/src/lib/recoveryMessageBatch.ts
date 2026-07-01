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
  existingMessageIds: Set<string>
): ChatMessage[] => {
  const recordsByRecoveredAt = new Map<string, RunRecoveryRecord[]>()
  for (const record of records) {
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
