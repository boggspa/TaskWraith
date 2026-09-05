import type { ChatMessage, ToolActivity, ToolActivityDetailRef } from '../store/types'
import { historyTextPage, historyValuePage, HISTORY_READ_MAX_BYTES } from './HistoryText'
export { historyTextPage, historyValueText, HISTORY_READ_MAX_BYTES } from './HistoryText'

export interface ThreadHistoryRef {
  messageId: string
  activityId?: string
}

export interface ThreadHistorySource extends ThreadHistoryRef {
  runId?: string
  role: ChatMessage['role']
  timestamp: string
  toolName?: string
  filePath?: string
  status?: ToolActivity['status']
}

export interface ThreadHistorySearchResult {
  matches: Array<ThreadHistorySource & { excerpt: string; archived: boolean }>
  scanned: number
  skippedDetails: number
  searchedDetailBytes?: number
  partialTextRecords: number
  partialSources: ThreadHistoryRef[]
  complete: boolean
  hasMore: boolean
  nextCursor?: ThreadHistoryRef
  available?: boolean
  reason?: string
}

function boundedSearchReply(reply: ThreadHistorySearchResult): ThreadHistorySearchResult {
  const bounded = boundedReply(reply)
  return 'matches' in bounded
    ? bounded
    : {
        matches: [],
        scanned: 0,
        skippedDetails: 0,
        partialTextRecords: 1,
        partialSources: [],
        complete: false,
        hasMore: false,
        ...bounded
      }
}

export type ThreadHistoryDetailReader = (ref: ToolActivityDetailRef) => Promise<ToolActivity | null>

export const HISTORY_SEARCH_MAX_ENTRIES = 200
export const HISTORY_SEARCH_DETAIL_SCAN_BYTES = 4 * 1024 * 1024
export const HISTORY_RESPONSE_MAX_BYTES = 16_384

/** Bound the whole JSON response, including escaped text and reference metadata. */
function boundedReply<T extends object>(reply: T): T | { available: false; reason: string } {
  if (Buffer.byteLength(JSON.stringify(reply)) <= HISTORY_RESPONSE_MAX_BYTES) return reply
  const page = reply as T & {
    text?: string
    offset?: number
    nextOffset?: number
    totalBytes?: number
  }
  if (typeof page.text === 'string' && typeof page.offset === 'number') {
    let text = page.text
    while (text.length > 0) {
      text = historyTextPage(text, 0, Math.max(4, Math.floor(Buffer.byteLength(text) / 2))).text
      const candidate = { ...page, text, nextOffset: page.offset + Buffer.byteLength(text) }
      delete candidate.totalBytes
      if (Buffer.byteLength(JSON.stringify(candidate)) <= HISTORY_RESPONSE_MAX_BYTES)
        return candidate
      if (Buffer.byteLength(text) <= 4) break
    }
  }
  return { available: false, reason: 'history_reference_exceeds_response_budget' }
}

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, max) : fallback
}

interface Entry {
  message: ChatMessage
  activity?: ToolActivity
  source: ThreadHistorySource
}

function* historyEntries(messages: readonly ChatMessage[]): Generator<Entry> {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const source = {
      messageId: message.id,
      runId: message.runId,
      role: message.role,
      timestamp: message.timestamp
    }
    const activities = message.toolActivities || []
    for (let activityIndex = activities.length - 1; activityIndex >= 0; activityIndex -= 1) {
      const activity = activities[activityIndex]
      yield {
        message,
        activity,
        source: {
          ...source,
          activityId: activity.id,
          toolName: activity.toolName,
          filePath: activity.filePath,
          status: activity.status
        }
      }
    }
    if (message.content) yield { message, source }
  }
}

function sameRef(left: ThreadHistoryRef, right: ThreadHistoryRef): boolean {
  return left.messageId === right.messageId && left.activityId === right.activityId
}

function resultValue(activity: ToolActivity): { value: unknown; representation: string } {
  if (activity.rawResultEvent !== undefined) {
    return { value: activity.rawResultEvent, representation: 'captured_result' }
  }
  return {
    value: activity.resultSummary ?? activity.outputSummary ?? activity.outputPreview,
    representation: 'stored_preview'
  }
}

async function safeReadDetail(
  read: ThreadHistoryDetailReader | undefined,
  ref: ToolActivityDetailRef
) {
  try {
    return (await read?.(ref)) ?? null
  } catch {
    return null
  }
}

function preview(text: string | undefined, maxBytes = 320): string {
  return historyTextPage(text || '', 0, maxBytes).text
}

function displaySource(source: ThreadHistorySource): ThreadHistorySource {
  return {
    ...source,
    timestamp: preview(source.timestamp, 64),
    ...(source.toolName ? { toolName: preview(source.toolName, 128) } : {}),
    ...(source.filePath ? { filePath: preview(source.filePath, 256) } : {})
  }
}

export async function readThreadHistory(
  messages: readonly ChatMessage[],
  request: ThreadHistoryRef & {
    field?: 'message' | 'arguments' | 'result' | 'diff'
    offset?: number
    maxBytes?: number
  },
  readDetail?: ThreadHistoryDetailReader
) {
  const message = messages.find((candidate) => candidate.id === request.messageId)
  if (!message) return { available: false as const, reason: 'message_not_found' }
  if (!request.activityId) {
    if (request.field && request.field !== 'message') {
      throw new Error('A tool activity reference is required for that field.')
    }
    return boundedReply({
      available: true as const,
      source: { messageId: message.id, runId: message.runId, role: message.role },
      representation: 'stored_message',
      ...historyTextPage(message.content, request.offset, request.maxBytes)
    })
  }
  const inline = message.toolActivities?.find((activity) => activity.id === request.activityId)
  if (!inline) return { available: false as const, reason: 'activity_not_found' }
  let activity = inline
  if (inline.detailRef) {
    if (inline.detailRef.activityId !== inline.id || inline.detailRef.runId !== message.runId) {
      return { available: false as const, reason: 'detail_reference_mismatch' }
    }
    const archived = await safeReadDetail(readDetail, inline.detailRef)
    if (!archived || archived.id !== inline.id) {
      return { available: false as const, reason: 'archived_detail_unavailable' }
    }
    activity = archived
  }
  const field = request.field || 'result'
  if (field === 'message') throw new Error('Read the message without an activity reference.')
  const value =
    field === 'result'
      ? resultValue(activity)
      : {
          value: field === 'arguments' ? activity.parameters : activity.diffSummary,
          representation: field === 'arguments' ? 'captured_arguments' : 'stored_diff'
        }
  if (value.value === undefined) return { available: false as const, reason: 'field_not_captured' }
  return boundedReply({
    available: true as const,
    source: { messageId: message.id, activityId: activity.id, runId: message.runId },
    field,
    archived: Boolean(inline.detailRef),
    representation: value.representation,
    ...historyValuePage(value.value, request.offset, request.maxBytes)
  })
}

export async function searchThreadHistory(
  messages: readonly ChatMessage[],
  request: {
    query?: string
    before?: ThreadHistoryRef
    kind?: 'messages' | 'tools'
    runId?: string
    limit?: number
    searchDetails?: boolean
  },
  readDetail?: ThreadHistoryDetailReader
): Promise<ThreadHistorySearchResult> {
  const query = (request.query || '').trim()
  if (query.length > 200) throw new Error('History search queries are limited to 200 characters.')
  const matcher = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu') : null
  const limit = boundedInteger(request.limit, 5, 10)
  const matches: Array<ThreadHistorySource & { excerpt: string; archived: boolean }> = []
  let cursorFound = !request.before
  let scanned = 0
  let detailBytes = 0
  let skippedDetails = 0
  let partialTextRecords = 0
  const partialSources: ThreadHistoryRef[] = []
  let matchBytes = 2
  let lastRef: ThreadHistoryRef | undefined
  let hasMore = false
  for (const entry of historyEntries(messages)) {
    if (!cursorFound) {
      cursorFound = sameRef(entry.source, request.before!)
      continue
    }
    if (scanned >= HISTORY_SEARCH_MAX_ENTRIES || matches.length >= limit) {
      hasMore = true
      break
    }
    const previousRef = lastRef
    lastRef = { messageId: entry.source.messageId, activityId: entry.source.activityId }
    scanned += 1
    if (request.runId && request.runId !== entry.message.runId) continue
    if (request.kind === 'messages' && entry.activity) continue
    if (request.kind === 'tools' && !entry.activity) continue
    let body = entry.activity
      ? [
          preview(entry.activity.toolName, 128),
          preview(entry.activity.filePath, 256),
          entry.activity.status,
          preview(entry.activity.resultSummary, 1024),
          preview(entry.activity.outputPreview, 1024)
        ]
          .filter(Boolean)
          .join('\n')
      : preview(entry.message.content, HISTORY_READ_MAX_BYTES)
    if (!entry.activity && body.length < entry.message.content.length) {
      partialTextRecords += 1
      if (partialSources.length < 5) partialSources.push(lastRef)
    }
    if (
      entry.activity &&
      [
        [entry.activity.toolName, 128],
        [entry.activity.filePath, 256],
        [entry.activity.resultSummary, 1024],
        [entry.activity.outputPreview, 1024]
      ].some(
        ([value, limit]) =>
          typeof value === 'string' && preview(value, limit as number).length < value.length
      )
    ) {
      partialTextRecords += 1
      if (partialSources.length < 5) partialSources.push(lastRef)
    }
    const ref = entry.activity?.detailRef
    if (matcher && !matcher.test(body) && request.searchDetails && entry.activity) {
      if (ref) {
        if (
          !readDetail ||
          ref.activityId !== entry.activity.id ||
          ref.runId !== entry.message.runId ||
          ref.byteLength > HISTORY_SEARCH_DETAIL_SCAN_BYTES - detailBytes
        ) {
          skippedDetails += 1
        } else {
          detailBytes += ref.byteLength
          const detail = await safeReadDetail(readDetail, ref)
          if (detail?.id === entry.activity.id) {
            const args = historyValuePage(detail.parameters, 0, 2048)
            const result = historyValuePage(resultValue(detail).value, 0, HISTORY_READ_MAX_BYTES)
            body += `\n${args.text}\n${result.text}`
            if (
              args.nextOffset !== undefined ||
              result.nextOffset !== undefined ||
              args.omittedContent ||
              result.omittedContent
            ) {
              partialTextRecords += 1
              if (partialSources.length < 5) partialSources.push(lastRef)
            }
          } else skippedDetails += 1
        }
      } else {
        const args = historyValuePage(entry.activity.parameters, 0, 2048)
        const result = historyValuePage(
          resultValue(entry.activity).value,
          0,
          HISTORY_READ_MAX_BYTES
        )
        const text = `${args.text}\n${result.text}`
        const size = Buffer.byteLength(text)
        if (size <= HISTORY_SEARCH_DETAIL_SCAN_BYTES - detailBytes) {
          detailBytes += size
          body += `\n${text}`
          if (
            args.nextOffset !== undefined ||
            result.nextOffset !== undefined ||
            args.omittedContent ||
            result.omittedContent
          ) {
            partialTextRecords += 1
            if (partialSources.length < 5) partialSources.push(lastRef)
          }
        } else skippedDetails += 1
      }
    }
    const position = matcher ? (matcher.exec(body)?.index ?? -1) : 0
    if (position < 0) continue
    let start = Math.max(0, position - 80)
    const code = body.charCodeAt(start)
    if (code >= 0xdc00 && code <= 0xdfff) start -= 1
    const match = {
      ...displaySource(entry.source),
      excerpt: preview(body.slice(start)),
      archived: Boolean(ref)
    }
    const bytes = Buffer.byteLength(JSON.stringify(match)) + 1
    if (matchBytes + bytes > 7_168) {
      if (matches.length === 0)
        return boundedSearchReply({
          matches,
          scanned,
          skippedDetails,
          partialTextRecords: partialTextRecords + 1,
          partialSources: [lastRef],
          complete: false,
          hasMore: false
        })
      lastRef = previousRef
      hasMore = true
      scanned -= 1
      break
    }
    matchBytes += bytes
    matches.push(match)
  }
  if (!cursorFound) throw new Error('History cursor no longer exists in this task.')
  return boundedSearchReply({
    matches,
    scanned,
    skippedDetails,
    partialTextRecords,
    partialSources,
    complete: !hasMore && skippedDetails === 0 && partialTextRecords === 0,
    searchedDetailBytes: detailBytes,
    hasMore,
    ...(hasMore && lastRef ? { nextCursor: lastRef } : {})
  })
}
