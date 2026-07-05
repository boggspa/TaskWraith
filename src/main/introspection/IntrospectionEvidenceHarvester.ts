/*
 * Read-only evidence harvester for Thread Introspection.
 *
 * Converts persisted substrate (run events, approval ledger, message feedback,
 * chat messages) into normalized IntrospectionEvidenceItem records. Thread
 * content is untrusted evidence — summaries are bounded and never promoted
 * verbatim into durable memory.
 */

import { randomUUID } from 'crypto'
import { formatRecallCitation } from '../RecallCitationGuard'
import type {
  ApprovalLedgerRecord,
  ChatMessage,
  ChatRecord,
  IntrospectionEvidenceItem,
  MessageFeedbackReceipt,
  RunEventRecord
} from '../store/types'

export interface IntrospectionHarvestWindow {
  windowStart: string
  windowEnd: string
  workspaceId?: string
}

export interface IntrospectionHarvestSubstrate {
  chats?: ChatRecord[]
  runEvents?: RunEventRecord[]
  approvalRecords?: ApprovalLedgerRecord[]
  feedbackReceipts?: MessageFeedbackReceipt[]
}

export interface HarvestEvidenceOptions {
  window: IntrospectionHarvestWindow
  substrate: IntrospectionHarvestSubstrate
  idFactory?: () => string
}

const CORRECTION_PREFIXES = [
  /^no[,.! ]/i,
  /^don'?t\b/i,
  /^instead\b/i,
  /^actually\b/i,
  /^wrong\b/i,
  /^not what\b/i,
  /^please (use|don'?t|stop)\b/i,
  /^that('s| is) (wrong|incorrect|not)\b/i,
  /^fix\b/i,
  /^try again\b/i
]

const REPO_CONVENTION_PATTERNS = [
  /\bdo not run\b/i,
  /\bnever run\b/i,
  /\bconvention\b/i,
  /\balways use\b/i,
  /\bprefer\b.+\bover\b/i,
  /\bAGENTS\.md\b/i,
  /\bprettier\b/i
]

const SKILL_CANDIDATE_PATTERNS = [
  /\bremember (to|that)\b/i,
  /\badd (this )?to (the )?skill\b/i,
  /\bupdate (the )?skill\b/i,
  /\bmake (this )?reusable\b/i
]

export function timestampMs(value: string | number | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value.trim()) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

export function isTimestampInWindow(
  value: string | number | undefined,
  window: IntrospectionHarvestWindow
): boolean {
  const ms = timestampMs(value)
  const start = timestampMs(window.windowStart)
  const end = timestampMs(window.windowEnd)
  if (ms === null || start === null || end === null) return false
  return ms >= start && ms <= end
}

function compactSummary(value: string, max = 240): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`
}

function citationForRunEvent(event: RunEventRecord): string {
  return formatRecallCitation(`event:${event.runId}:${event.id}`)
}

function citationForFeedback(receipt: MessageFeedbackReceipt): string {
  return formatRecallCitation(`feedback:${receipt.chatId}:${receipt.messageId}`)
}

function citationForMessage(chatId: string, messageId: string): string {
  return formatRecallCitation(`message:${chatId}:${messageId}`)
}

function makeEvidenceItem(
  input: Omit<IntrospectionEvidenceItem, 'id'> & { id?: string },
  idFactory: () => string
): IntrospectionEvidenceItem {
  return { id: input.id ?? idFactory(), ...input }
}

function inferToolName(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const record = payload as Record<string, unknown>
  for (const key of ['toolName', 'tool_name', 'name', 'tool']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function isToolFailureEvent(event: RunEventRecord): boolean {
  if (event.kind !== 'tool') return false
  const payload = event.payload
  if (!payload || typeof payload !== 'object') return false
  const record = payload as Record<string, unknown>
  if (record.isError === true || record.is_error === true || record.ok === false) return true
  const status = String(record.status || record.subtype || '').toLowerCase()
  if (status.includes('fail') || status.includes('error')) return true
  const result = record.result
  if (result && typeof result === 'object') {
    const nested = result as Record<string, unknown>
    if (nested.isError === true || nested.ok === false) return true
  }
  return false
}

function isApprovalDeniedResponse(event: RunEventRecord): boolean {
  if (event.kind !== 'approval_response') return false
  const payload = event.payload
  if (!payload || typeof payload !== 'object') return false
  const action = String(
    (payload as Record<string, unknown>).action ||
      (payload as Record<string, unknown>).decision ||
      ''
  ).toLowerCase()
  return (
    action.includes('deny') ||
    action.includes('decline') ||
    action === 'cancel' ||
    action === 'cancelled'
  )
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

function harvestFromRunEvents(
  events: RunEventRecord[],
  window: IntrospectionHarvestWindow,
  idFactory: () => string
): IntrospectionEvidenceItem[] {
  const items: IntrospectionEvidenceItem[] = []
  const toolCountsByRun = new Map<string, Map<string, number>>()
  const toolFailuresByRun = new Map<string, Map<string, number>>()

  const inWindow = events.filter((event) => isTimestampInWindow(event.timestamp, window))

  for (const event of inWindow) {
    if (window.workspaceId && event.workspaceId && event.workspaceId !== window.workspaceId) {
      continue
    }

    const base = {
      chatId: event.chatId || 'unknown-chat',
      runId: event.runId,
      eventId: event.id,
      provider: event.provider,
      workspaceId: event.workspaceId,
      timestamp: event.timestamp,
      citationToken: citationForRunEvent(event)
    }

    if (isApprovalDeniedResponse(event)) {
      items.push(
        makeEvidenceItem(
          {
            source: 'run_event',
            signal: 'approval_denied',
            summary: compactSummary(event.summary || 'Approval denied'),
            detail: event.summary,
            ...base
          },
          idFactory
        )
      )
      continue
    }

    if (event.kind === 'approval_timer_timeout') {
      items.push(
        makeEvidenceItem(
          {
            source: 'run_event',
            signal: 'approval_timeout',
            summary: compactSummary(event.summary || 'Approval timed out'),
            detail: event.summary,
            ...base
          },
          idFactory
        )
      )
      continue
    }

    if (event.kind === 'provider_error') {
      items.push(
        makeEvidenceItem(
          {
            source: 'run_event',
            signal: 'provider_error',
            summary: compactSummary(event.summary || 'Provider error'),
            detail: event.summary,
            ...base
          },
          idFactory
        )
      )
      continue
    }

    if (event.kind === 'tool') {
      const toolName = inferToolName(event.payload) || event.toolCallId || 'tool'
      const runCounts = toolCountsByRun.get(event.runId) || new Map<string, number>()
      runCounts.set(toolName, (runCounts.get(toolName) || 0) + 1)
      toolCountsByRun.set(event.runId, runCounts)

      if (isToolFailureEvent(event)) {
        items.push(
          makeEvidenceItem(
            {
              source: 'run_event',
              signal: 'tool_failure',
              summary: compactSummary(event.summary || `Tool failure: ${toolName}`),
              detail: event.summary,
              ...base
            },
            idFactory
          )
        )
        const failCounts = toolFailuresByRun.get(event.runId) || new Map<string, number>()
        failCounts.set(toolName, (failCounts.get(toolName) || 0) + 1)
        toolFailuresByRun.set(event.runId, failCounts)
        if ((failCounts.get(toolName) || 0) >= 2) {
          items.push(
            makeEvidenceItem(
              {
                source: 'run_event',
                signal: 'repeated_retry',
                summary: compactSummary(`Repeated tool retries: ${toolName}`),
                detail: event.summary,
                ...base
              },
              idFactory
            )
          )
        }
      }

      if ((runCounts.get(toolName) || 0) >= 3) {
        items.push(
          makeEvidenceItem(
            {
              source: 'run_event',
              signal: 'tool_loop',
              summary: compactSummary(`Tool loop detected: ${toolName}`),
              detail: event.summary,
              ...base
            },
            idFactory
          )
        )
      }
    }
  }

  return items
}

function harvestFromApprovalLedger(
  records: ApprovalLedgerRecord[],
  window: IntrospectionHarvestWindow,
  idFactory: () => string
): IntrospectionEvidenceItem[] {
  const items: IntrospectionEvidenceItem[] = []

  for (const record of records) {
    const ts = record.respondedAt || record.requestedAt
    if (!isTimestampInWindow(ts, window)) continue
    if (window.workspaceId && record.workspaceId && record.workspaceId !== window.workspaceId) {
      continue
    }

    const base = {
      chatId: record.chatId || 'unknown-chat',
      runId: record.runId,
      provider: record.provider,
      workspaceId: record.workspaceId,
      timestamp: ts,
      citationToken: formatRecallCitation(`approval:${record.approvalId}`)
    }

    if (record.status === 'denied' || record.decision === 'autoDeny') {
      items.push(
        makeEvidenceItem(
          {
            source: 'approval_ledger',
            signal: 'approval_denied',
            summary: compactSummary(record.title || 'Approval denied'),
            detail: record.body,
            ...base
          },
          idFactory
        )
      )
      continue
    }

    if (record.status === 'expired' && record.decisionSource === 'system') {
      items.push(
        makeEvidenceItem(
          {
            source: 'approval_ledger',
            signal: 'approval_timeout',
            summary: compactSummary(record.title || 'Approval expired'),
            detail: record.body,
            ...base
          },
          idFactory
        )
      )
    }
  }

  return items
}

function harvestFromFeedback(
  receipts: MessageFeedbackReceipt[],
  window: IntrospectionHarvestWindow,
  idFactory: () => string
): IntrospectionEvidenceItem[] {
  const items: IntrospectionEvidenceItem[] = []

  for (const receipt of receipts) {
    if (!isTimestampInWindow(receipt.at, window)) continue
    if (window.workspaceId && receipt.workspaceId && receipt.workspaceId !== window.workspaceId) {
      continue
    }
    if (!receipt.vote && !receipt.note && !receipt.reason) continue

    const base = {
      chatId: receipt.chatId,
      runId: receipt.runId,
      messageId: receipt.messageId,
      provider: receipt.provider,
      workspaceId: receipt.workspaceId,
      timestamp: new Date(receipt.at).toISOString(),
      citationToken: citationForFeedback(receipt)
    }

    if (receipt.vote === 'down') {
      items.push(
        makeEvidenceItem(
          {
            source: 'message_feedback',
            signal: 'feedback_down',
            summary: compactSummary(receipt.reason || receipt.note || 'Negative feedback'),
            detail: receipt.note || receipt.reason,
            ...base
          },
          idFactory
        )
      )
    }

    if (receipt.note?.trim()) {
      items.push(
        makeEvidenceItem(
          {
            source: 'message_feedback',
            signal: 'feedback_correction',
            summary: compactSummary(receipt.note),
            detail: receipt.note,
            ...base
          },
          idFactory
        )
      )
    } else if (receipt.reason?.trim() && receipt.vote !== 'down') {
      items.push(
        makeEvidenceItem(
          {
            source: 'message_feedback',
            signal: 'user_correction',
            summary: compactSummary(receipt.reason),
            detail: receipt.reason,
            ...base
          },
          idFactory
        )
      )
    }
  }

  return items
}

function harvestFromChatMessages(
  chats: ChatRecord[],
  window: IntrospectionHarvestWindow,
  idFactory: () => string
): IntrospectionEvidenceItem[] {
  const items: IntrospectionEvidenceItem[] = []

  for (const chat of chats) {
    if (chat.archived) continue
    if (window.workspaceId && chat.workspaceId && chat.workspaceId !== window.workspaceId) {
      continue
    }

    const messages = chat.messages || []
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      if (!message || message.role !== 'user') continue
      if (!isTimestampInWindow(message.timestamp, window)) continue

      const content = message.content?.trim() || ''
      if (!content) continue

      const previous = index > 0 ? messages[index - 1] : undefined
      const followsAssistant = previous?.role === 'assistant'
      const base = {
        chatId: chat.appChatId,
        runId: message.runId,
        messageId: message.id,
        provider: chat.provider,
        workspaceId: chat.workspaceId,
        timestamp: message.timestamp,
        citationToken: citationForMessage(chat.appChatId, message.id)
      }

      if (
        followsAssistant &&
        content.length <= 800 &&
        matchesAny(content, CORRECTION_PREFIXES)
      ) {
        items.push(
          makeEvidenceItem(
            {
              source: 'chat_message',
              signal: 'user_correction',
              summary: compactSummary(content),
              detail: content.slice(0, 500),
              ...base
            },
            idFactory
          )
        )
      }

      if (matchesAny(content, REPO_CONVENTION_PATTERNS)) {
        items.push(
          makeEvidenceItem(
            {
              source: 'chat_message',
              signal: 'repo_convention_hint',
              summary: compactSummary(content),
              detail: content.slice(0, 500),
              ...base
            },
            idFactory
          )
        )
      }

      if (matchesAny(content, SKILL_CANDIDATE_PATTERNS)) {
        items.push(
          makeEvidenceItem(
            {
              source: 'chat_message',
              signal: 'skill_candidate',
              summary: compactSummary(content),
              detail: content.slice(0, 500),
              ...base
            },
            idFactory
          )
        )
      }
    }
  }

  return items
}

export function harvestIntrospectionEvidence(
  options: HarvestEvidenceOptions
): IntrospectionEvidenceItem[] {
  const idFactory = options.idFactory ?? randomUUID
  const { window, substrate } = options
  const chats = substrate.chats || []
  const runEvents = substrate.runEvents || []
  const approvalRecords = substrate.approvalRecords || []
  const feedbackReceipts = substrate.feedbackReceipts || []

  const harvested = [
    ...harvestFromRunEvents(runEvents, window, idFactory),
    ...harvestFromApprovalLedger(approvalRecords, window, idFactory),
    ...harvestFromFeedback(feedbackReceipts, window, idFactory),
    ...harvestFromChatMessages(chats, window, idFactory)
  ]

  return harvested.sort(
    (a, b) => (timestampMs(a.timestamp) || 0) - (timestampMs(b.timestamp) || 0)
  )
}

export function chatTouchesWindow(chat: ChatRecord, window: IntrospectionHarvestWindow): boolean {
  if (isTimestampInWindow(chat.updatedAt, window)) return true
  return (chat.messages || []).some(
    (message: ChatMessage) => message?.timestamp && isTimestampInWindow(message.timestamp, window)
  )
}