import type { ChatMessage, ChatRecord, ChatRun, MessageFeedbackReceipt } from './store/types'

export const MESSAGE_FEEDBACK_LEDGER_SCHEMA_VERSION = 1
export const MESSAGE_FEEDBACK_LEDGER_CAP = 5000

type FeedbackVote = 'up' | 'down'

interface FeedbackState {
  vote: FeedbackVote
  at: number
  reason?: string
  note?: string
}

interface ReceiptState {
  vote: FeedbackVote
  reason?: string
  note?: string
}

export interface BuildMessageFeedbackReceiptOptions {
  now: () => number
  idFactory: () => string
}

export interface MessageFeedbackReceiptFilter {
  chatId?: string
  messageId?: string
  runId?: string
  provider?: string
  limit?: number
}

function text(value: unknown, max = 500): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function stageRole(value: unknown): 'scout' | 'worker' | 'reviewer' | undefined {
  return value === 'scout' || value === 'worker' || value === 'reviewer' ? value : undefined
}

function feedbackState(message: ChatMessage | null | undefined): FeedbackState | null {
  const feedback = message?.metadata?.feedback
  if (!feedback || (feedback.vote !== 'up' && feedback.vote !== 'down')) return null
  const at = Number(feedback.at)
  return {
    vote: feedback.vote,
    at: Number.isFinite(at) && at > 0 ? Math.floor(at) : Date.parse(message?.timestamp || '') || 0,
    ...(text(feedback.reason, 80) ? { reason: text(feedback.reason, 80) } : {}),
    ...(text(feedback.note, 1000) ? { note: text(feedback.note, 1000) } : {})
  }
}

function sameState(a: FeedbackState | ReceiptState | null, b: FeedbackState | ReceiptState | null): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.vote === b.vote && (a.reason || '') === (b.reason || '') && (a.note || '') === (b.note || '')
}

function latestLedgerState(records: MessageFeedbackReceipt[]): Map<string, ReceiptState | null> {
  const states = new Map<string, ReceiptState | null>()
  for (const record of records) {
    if (!record.chatId || !record.messageId) continue
    const key = `${record.chatId}:${record.messageId}`
    if (record.action === 'clear') {
      states.set(key, null)
    } else if (record.vote === 'up' || record.vote === 'down') {
      states.set(key, {
        vote: record.vote,
        ...(text(record.reason, 80) ? { reason: text(record.reason, 80) } : {}),
        ...(text(record.note, 1000) ? { note: text(record.note, 1000) } : {})
      })
    }
  }
  return states
}

function runById(chat: ChatRecord): Map<string, ChatRun> {
  const runs = new Map<string, ChatRun>()
  for (const run of Array.isArray(chat.runs) ? chat.runs : []) {
    if (run?.runId) runs.set(run.runId, run)
  }
  return runs
}

function participantRoleById(chat: ChatRecord): Map<string, string> {
  const roles = new Map<string, string>()
  for (const participant of chat.ensemble?.participants || []) {
    if (participant?.id && typeof participant.role === 'string' && participant.role.trim()) {
      roles.set(participant.id, participant.role.trim())
    }
  }
  return roles
}

function receiptForTransition(
  chat: ChatRecord,
  message: ChatMessage,
  previous: FeedbackState | ReceiptState | null,
  current: FeedbackState | null,
  runs: Map<string, ChatRun>,
  participantRoles: Map<string, string>,
  options: BuildMessageFeedbackReceiptOptions
): MessageFeedbackReceipt | null {
  if (!previous && !current) return null
  const runId =
    message.runId ||
    (typeof message.metadata?.guestRunId === 'string' ? message.metadata.guestRunId : undefined)
  const run = runId ? runs.get(runId) : undefined
  const provider = run?.provider || message.metadata?.guestProvider
  const model =
    run?.actualModel ||
    run?.requestedModel ||
    (typeof message.metadata?.guestModel === 'string' ? message.metadata.guestModel : undefined)
  const ensembleParticipantId = run?.ensembleParticipantId
  const role =
    run?.ensembleRole ||
    (ensembleParticipantId ? participantRoles.get(ensembleParticipantId) : undefined) ||
    (typeof message.metadata?.guestRole === 'string' ? message.metadata.guestRole : undefined)
  const now = options.now()
  const action = current
    ? previous
      ? previous.vote === current.vote
        ? 'update'
        : 'flip'
      : 'set'
    : 'clear'
  return {
    schemaVersion: MESSAGE_FEEDBACK_LEDGER_SCHEMA_VERSION,
    id: options.idFactory(),
    source: 'message_metadata',
    action,
    chatId: chat.appChatId,
    ...(chat.workspaceId ? { workspaceId: chat.workspaceId } : {}),
    ...(chat.workspacePath ? { workspacePath: chat.workspacePath } : {}),
    messageId: message.id,
    ...(runId ? { runId } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(role ? { role } : {}),
    ...(ensembleParticipantId ? { ensembleParticipantId } : {}),
    ...(run?.ensembleLaneId ? { ensembleLaneId: run.ensembleLaneId } : {}),
    ...(run?.ensembleRole ? { ensembleRole: run.ensembleRole } : {}),
    ...(run?.ensembleStageRole ? { ensembleStageRole: run.ensembleStageRole } : {}),
    ...(current ? { vote: current.vote } : {}),
    ...(previous ? { previousVote: previous.vote } : {}),
    at: current?.at || now,
    recordedAt: now,
    ...(current?.reason ? { reason: current.reason } : {}),
    ...(current?.note ? { note: current.note, noteSensitive: true } : {})
  }
}

/**
 * Build receipt records for feedback-state changes in a single chat save.
 *
 * The existing ledger is the primary baseline, so repeated saveChat calls are
 * idempotent. If the ledger has no state yet, current message metadata is
 * backfilled as a `set`; previous persisted-chat metadata is used only to
 * distinguish first clear/flip transitions after upgrading from the UI-only
 * capture layer.
 */
export function buildMessageFeedbackReceipts(
  previousChat: ChatRecord | null | undefined,
  nextChat: ChatRecord,
  existingLedger: MessageFeedbackReceipt[],
  options: BuildMessageFeedbackReceiptOptions
): MessageFeedbackReceipt[] {
  const previousMessages = new Map<string, ChatMessage>()
  for (const message of previousChat?.messages || []) previousMessages.set(message.id, message)
  const ledgerStates = latestLedgerState(existingLedger)
  const runs = runById(nextChat)
  const participantRoles = participantRoleById(nextChat)
  const receipts: MessageFeedbackReceipt[] = []
  for (const message of nextChat.messages || []) {
    if (message.role !== 'assistant' || !message.id) continue
    const current = feedbackState(message)
    const previous = feedbackState(previousMessages.get(message.id))
    const key = `${nextChat.appChatId}:${message.id}`
    const ledgerState = ledgerStates.has(key) ? ledgerStates.get(key) || null : undefined
    const baseline =
      ledgerState !== undefined
        ? ledgerState
        : previous && (!current || !sameState(previous, current))
          ? previous
          : null
    if (sameState(baseline, current)) continue
    const receipt = receiptForTransition(
      nextChat,
      message,
      baseline,
      current,
      runs,
      participantRoles,
      options
    )
    if (receipt) receipts.push(receipt)
  }
  return receipts
}

export function capMessageFeedbackReceipts(
  records: MessageFeedbackReceipt[],
  cap = MESSAGE_FEEDBACK_LEDGER_CAP
): MessageFeedbackReceipt[] {
  if (!Array.isArray(records)) return []
  const normalized = records.filter(normalizeMessageFeedbackReceipt)
  if (normalized.length <= cap) return normalized
  return normalized.slice(normalized.length - cap)
}

export function normalizeMessageFeedbackReceipt(
  value: unknown
): MessageFeedbackReceipt | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<MessageFeedbackReceipt>
  if (!input.id || typeof input.id !== 'string') return null
  if (!input.chatId || typeof input.chatId !== 'string') return null
  if (!input.messageId || typeof input.messageId !== 'string') return null
  if (input.action !== 'set' && input.action !== 'flip' && input.action !== 'clear' && input.action !== 'update') {
    return null
  }
  const vote = input.vote === 'up' || input.vote === 'down' ? input.vote : undefined
  const previousVote =
    input.previousVote === 'up' || input.previousVote === 'down' ? input.previousVote : undefined
  if (input.action !== 'clear' && !vote) return null
  const at = Number(input.at)
  const recordedAt = Number(input.recordedAt)
  const ensembleStageRole = stageRole(input.ensembleStageRole)
  return {
    schemaVersion: MESSAGE_FEEDBACK_LEDGER_SCHEMA_VERSION,
    id: input.id,
    source: input.source === 'message_metadata' ? 'message_metadata' : 'message_metadata',
    action: input.action,
    chatId: input.chatId,
    ...(text(input.workspaceId, 160) ? { workspaceId: text(input.workspaceId, 160) } : {}),
    ...(text(input.workspacePath, 1000) ? { workspacePath: text(input.workspacePath, 1000) } : {}),
    messageId: input.messageId,
    ...(text(input.runId, 160) ? { runId: text(input.runId, 160) } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(text(input.model, 240) ? { model: text(input.model, 240) } : {}),
    ...(text(input.role, 160) ? { role: text(input.role, 160) } : {}),
    ...(text(input.ensembleParticipantId, 160)
      ? { ensembleParticipantId: text(input.ensembleParticipantId, 160) }
      : {}),
    ...(text(input.ensembleLaneId, 160) ? { ensembleLaneId: text(input.ensembleLaneId, 160) } : {}),
    ...(text(input.ensembleRole, 160) ? { ensembleRole: text(input.ensembleRole, 160) } : {}),
    ...(ensembleStageRole ? { ensembleStageRole } : {}),
    ...(vote ? { vote } : {}),
    ...(previousVote ? { previousVote } : {}),
    at: Number.isFinite(at) && at > 0 ? Math.floor(at) : Date.now(),
    recordedAt: Number.isFinite(recordedAt) && recordedAt > 0 ? Math.floor(recordedAt) : Date.now(),
    ...(text(input.reason, 80) ? { reason: text(input.reason, 80) } : {}),
    ...(text(input.note, 1000) ? { note: text(input.note, 1000), noteSensitive: true } : {})
  }
}

export function filterMessageFeedbackReceipts(
  records: MessageFeedbackReceipt[],
  filter: MessageFeedbackReceiptFilter = {}
): MessageFeedbackReceipt[] {
  let out = records
  if (filter.chatId) out = out.filter((record) => record.chatId === filter.chatId)
  if (filter.messageId) out = out.filter((record) => record.messageId === filter.messageId)
  if (filter.runId) out = out.filter((record) => record.runId === filter.runId)
  if (filter.provider) out = out.filter((record) => record.provider === filter.provider)
  const limit =
    typeof filter.limit === 'number' && Number.isFinite(filter.limit)
      ? Math.max(0, Math.floor(filter.limit))
      : 0
  return limit > 0 ? out.slice(Math.max(0, out.length - limit)) : out
}
