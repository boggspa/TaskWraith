import type { ChatMessage, ToolActivity, ToolActivityDetailRef } from '../store/types'

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

export type ThreadHistoryDetailReader = (ref: ToolActivityDetailRef) => Promise<ToolActivity | null>

export const HISTORY_READ_MAX_BYTES = 8_192
export const HISTORY_SEARCH_MAX_ENTRIES = 200
export const HISTORY_SEARCH_DETAIL_SCAN_BYTES = 4 * 1024 * 1024

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, max) : fallback
}

/** Offsets address UTF-8 text bytes, not JSON envelopes or JavaScript characters. */
export function historyTextPage(text: string, offset = 0, maxBytes = 2_048) {
  const bytes = Buffer.from(text, 'utf8')
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > bytes.length ||
    (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)
  ) {
    throw new Error('History offset must address a UTF-8 character boundary in this record.')
  }
  const limit = Math.max(4, boundedInteger(maxBytes, 2_048, HISTORY_READ_MAX_BYTES))
  let end = Math.min(bytes.length, offset + limit)
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1
  return {
    text: bytes.subarray(offset, end).toString('utf8'),
    offset,
    totalBytes: bytes.length,
    ...(end < bytes.length ? { nextOffset: end } : {})
  }
}

/** Binary media and opaque reasoning are not useful transcript search material. */
export function historyValueText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  return (
    JSON.stringify(value, (key, item: unknown) => {
      if (['signature', 'encrypted_content', 'image_url', 'audio_url'].includes(key)) {
        return undefined
      }
      if (item && typeof item === 'object') {
        const type = (item as { type?: string }).type
        if (['image', 'audio', 'thinking', 'redacted_thinking'].includes(type || '')) {
          return { type, omitted: true }
        }
      }
      return item
    }) || ''
  )
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

function resultText(activity: ToolActivity): { text: string; representation: string } {
  if (activity.rawResultEvent !== undefined) {
    return { text: historyValueText(activity.rawResultEvent), representation: 'captured_result' }
  }
  return {
    text: activity.resultSummary || activity.outputSummary || activity.outputPreview || '',
    representation: 'stored_preview'
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
    return {
      available: true as const,
      source: { messageId: message.id, runId: message.runId, role: message.role },
      representation: 'stored_message',
      ...historyTextPage(message.content, request.offset, request.maxBytes)
    }
  }
  const inline = message.toolActivities?.find((activity) => activity.id === request.activityId)
  if (!inline) return { available: false as const, reason: 'activity_not_found' }
  let activity = inline
  if (inline.detailRef) {
    if (inline.detailRef.activityId !== inline.id || inline.detailRef.runId !== message.runId) {
      return { available: false as const, reason: 'detail_reference_mismatch' }
    }
    const archived = await readDetail?.(inline.detailRef)
    if (!archived || archived.id !== inline.id) {
      return { available: false as const, reason: 'archived_detail_unavailable' }
    }
    activity = archived
  }
  const field = request.field || 'result'
  if (field === 'message') throw new Error('Read the message without an activity reference.')
  const value =
    field === 'result'
      ? resultText(activity)
      : {
          text: historyValueText(
            field === 'arguments' ? activity.parameters : activity.diffSummary
          ),
          representation: field === 'arguments' ? 'captured_arguments' : 'stored_diff'
        }
  return {
    available: true as const,
    source: { messageId: message.id, activityId: activity.id, runId: message.runId },
    field,
    archived: Boolean(inline.detailRef),
    representation: value.representation,
    ...historyTextPage(value.text, request.offset, request.maxBytes)
  }
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
) {
  const query = (request.query || '').trim().toLowerCase()
  if (query.length > 200) throw new Error('History search queries are limited to 200 characters.')
  const limit = boundedInteger(request.limit, 5, 10)
  const matches: Array<ThreadHistorySource & { excerpt: string; archived: boolean }> = []
  let cursorFound = !request.before
  let scanned = 0
  let detailBytes = 0
  let skippedDetails = 0
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
    lastRef = { messageId: entry.source.messageId, activityId: entry.source.activityId }
    scanned += 1
    if (request.runId && request.runId !== entry.message.runId) continue
    if (request.kind === 'messages' && entry.activity) continue
    if (request.kind === 'tools' && !entry.activity) continue
    let body = entry.activity
      ? [
          entry.activity.toolName,
          entry.activity.filePath,
          entry.activity.status,
          entry.activity.resultSummary,
          entry.activity.outputPreview
        ]
          .filter(Boolean)
          .join('\n')
      : entry.message.content
    const ref = entry.activity?.detailRef
    if (query && !body.toLowerCase().includes(query) && request.searchDetails && entry.activity) {
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
          const detail = await readDetail(ref)
          if (detail?.id === entry.activity.id) {
            body += `\n${historyValueText(detail.parameters)}\n${resultText(detail).text}`
          } else skippedDetails += 1
        }
      } else {
        const text = `${historyValueText(entry.activity.parameters)}\n${resultText(entry.activity).text}`
        const size = Buffer.byteLength(text)
        if (size <= HISTORY_SEARCH_DETAIL_SCAN_BYTES - detailBytes) {
          detailBytes += size
          body += `\n${text}`
        } else skippedDetails += 1
      }
    }
    const position = query ? body.toLowerCase().indexOf(query) : 0
    if (position < 0) continue
    matches.push({
      ...entry.source,
      excerpt: historyTextPage(body.slice(Math.max(0, position - 80)), 0, 320).text,
      archived: Boolean(ref)
    })
  }
  if (!cursorFound) throw new Error('History cursor no longer exists in this task.')
  return {
    matches,
    scanned,
    skippedDetails,
    searchedDetailBytes: detailBytes,
    hasMore,
    ...(hasMore && lastRef ? { nextCursor: lastRef } : {})
  }
}
