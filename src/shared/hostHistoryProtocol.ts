/** Bounded, read-only transcript history projections for Host v2. */

export const HOST_HISTORY_MAX_PAGE_SIZE = 100
export const HOST_HISTORY_DEFAULT_PAGE_SIZE = 50
export const HOST_HISTORY_MAX_ENTRY_TEXT = 16_000
export const HOST_HISTORY_MAX_ENTRY_LABEL = 200

export type HostHistoryDecodeResult<T> = { ok: true; value: T } | { ok: false; error: string }
export type HostTranscriptRole = 'user' | 'assistant' | 'system' | 'tool'

export interface HostHistoryCursor {
  readonly generation: number
  readonly cursor: number
}

export interface HostThreadHistoryRequest {
  readonly threadId: string
  readonly before?: HostHistoryCursor
  readonly limit: number
}

export interface HostTranscriptHistoryEntry {
  readonly entryId: string
  readonly role: HostTranscriptRole
  readonly createdAt: number
  readonly text: string
  readonly label?: string
}

export interface HostThreadHistoryPage {
  readonly threadId: string
  readonly generation: number
  readonly cursor: number
  readonly entries: readonly HostTranscriptHistoryEntry[]
  readonly nextBefore?: HostHistoryCursor
}

export interface HostHistorySinceRequest {
  readonly threadId: string
  readonly since: HostHistoryCursor
}

export type HostHistoryDelta =
  | { readonly kind: 'append' | 'replace'; readonly entry: HostTranscriptHistoryEntry }
  | { readonly kind: 'remove'; readonly entryId: string }

export type HostHistorySinceResult =
  | {
      readonly kind: 'deltas'
      readonly threadId: string
      readonly generation: number
      readonly fromCursor: number
      readonly toCursor: number
      readonly deltas: readonly HostHistoryDelta[]
    }
  | {
      readonly kind: 'full_resnapshot_required'
      readonly threadId: string
      readonly generation: number
      readonly cursor: number
      readonly clientGeneration: number
      readonly clientCursor: number
      readonly reason: 'generation_mismatch' | 'retention_gap' | 'cursor_mismatch'
    }

export interface HostHistoryDeltasFrame {
  readonly type: 'host.history'
  readonly protocolVersion: 2
  readonly threadId: string
  readonly result: HostHistorySinceResult
}

const MAX_ID = 512

function fail<T>(error: string): HostHistoryDecodeResult<T> {
  return { ok: false, error }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isCanonicalString(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- transcript metadata rejects C0 controls on the wire.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPageSize(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= HOST_HISTORY_MAX_PAGE_SIZE
  )
}

/** Preserve ordinary transcript formatting while rejecting terminal-control bytes. */
function isSafeTranscriptText(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > HOST_HISTORY_MAX_ENTRY_TEXT) return false
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue
    if (code <= 0x1f || code === 0x7f) return false
  }
  return true
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

export function decodeHostHistoryCursor(
  value: unknown
): HostHistoryDecodeResult<HostHistoryCursor> {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['generation', 'cursor']) ||
    !isNonNegativeInt(value.generation) ||
    !isNonNegativeInt(value.cursor)
  ) {
    return fail('history cursor is invalid')
  }
  return { ok: true, value: { generation: value.generation, cursor: value.cursor } }
}

export function decodeHostThreadHistoryRequest(
  value: unknown
): HostHistoryDecodeResult<HostThreadHistoryRequest> {
  if (!isRecord(value) || !exactKeys(value, ['threadId', 'before', 'limit'])) {
    return fail('thread history request is invalid')
  }
  if (!isCanonicalString(value.threadId, MAX_ID)) return fail('thread history request is invalid')
  if (!isPageSize(value.limit)) {
    return fail('thread history request is invalid')
  }
  let before: HostHistoryCursor | undefined
  if (value.before !== undefined) {
    const decoded = decodeHostHistoryCursor(value.before)
    if (!decoded.ok) return fail('thread history request is invalid')
    before = decoded.value
  }
  return {
    ok: true,
    value: { threadId: value.threadId, limit: value.limit, ...(before ? { before } : {}) }
  }
}

export function decodeHostHistorySinceRequest(
  value: unknown
): HostHistoryDecodeResult<HostHistorySinceRequest> {
  if (!isRecord(value) || !exactKeys(value, ['threadId', 'since'])) {
    return fail('history since request is invalid')
  }
  if (!isCanonicalString(value.threadId, MAX_ID)) return fail('history since request is invalid')
  const since = decodeHostHistoryCursor(value.since)
  if (!since.ok) return fail('history since request is invalid')
  return { ok: true, value: { threadId: value.threadId, since: since.value } }
}

export function decodeHostTranscriptHistoryEntry(
  value: unknown
): HostHistoryDecodeResult<HostTranscriptHistoryEntry> {
  if (!isRecord(value) || !exactKeys(value, ['entryId', 'role', 'createdAt', 'text', 'label'])) {
    return fail('history entry is invalid')
  }
  if (!isCanonicalString(value.entryId, MAX_ID) || !isNonNegativeInt(value.createdAt)) {
    return fail('history entry is invalid')
  }
  if (!['user', 'assistant', 'system', 'tool'].includes(String(value.role))) {
    return fail('history entry is invalid')
  }
  if (!isSafeTranscriptText(value.text)) {
    return fail('history entry is invalid')
  }
  if (value.label !== undefined && !isCanonicalString(value.label, HOST_HISTORY_MAX_ENTRY_LABEL)) {
    return fail('history entry is invalid')
  }
  return {
    ok: true,
    value: {
      entryId: value.entryId,
      role: value.role as HostTranscriptRole,
      createdAt: value.createdAt,
      text: value.text,
      ...(value.label ? { label: value.label } : {})
    }
  }
}

export function decodeHostThreadHistoryPage(
  value: unknown
): HostHistoryDecodeResult<HostThreadHistoryPage> {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['threadId', 'generation', 'cursor', 'entries', 'nextBefore'])
  ) {
    return fail('thread history page is invalid')
  }
  if (
    !isCanonicalString(value.threadId, MAX_ID) ||
    !isNonNegativeInt(value.generation) ||
    !isNonNegativeInt(value.cursor)
  ) {
    return fail('thread history page is invalid')
  }
  if (!Array.isArray(value.entries) || value.entries.length > HOST_HISTORY_MAX_PAGE_SIZE) {
    return fail('thread history page is invalid')
  }
  const entries: HostTranscriptHistoryEntry[] = []
  const ids = new Set<string>()
  for (const entry of value.entries) {
    const decoded = decodeHostTranscriptHistoryEntry(entry)
    if (!decoded.ok || ids.has(decoded.value.entryId)) return fail('thread history page is invalid')
    ids.add(decoded.value.entryId)
    entries.push(decoded.value)
  }
  let nextBefore: HostHistoryCursor | undefined
  if (value.nextBefore !== undefined) {
    const decoded = decodeHostHistoryCursor(value.nextBefore)
    if (!decoded.ok) return fail('thread history page is invalid')
    nextBefore = decoded.value
  }
  return {
    ok: true,
    value: {
      threadId: value.threadId,
      generation: value.generation,
      cursor: value.cursor,
      entries,
      ...(nextBefore ? { nextBefore } : {})
    }
  }
}

function decodeHistoryDelta(value: unknown): HostHistoryDecodeResult<HostHistoryDelta> {
  if (!isRecord(value) || typeof value.kind !== 'string') return fail('history delta is invalid')
  if (value.kind === 'append' || value.kind === 'replace') {
    if (!exactKeys(value, ['kind', 'entry'])) return fail('history delta is invalid')
    const entry = decodeHostTranscriptHistoryEntry(value.entry)
    if (!entry.ok) return fail('history delta is invalid')
    return { ok: true, value: { kind: value.kind, entry: entry.value } }
  }
  if (value.kind === 'remove') {
    if (!exactKeys(value, ['kind', 'entryId']) || !isCanonicalString(value.entryId, MAX_ID)) {
      return fail('history delta is invalid')
    }
    return { ok: true, value: { kind: 'remove', entryId: value.entryId } }
  }
  return fail('history delta is invalid')
}

export function decodeHostHistorySinceResult(
  value: unknown
): HostHistoryDecodeResult<HostHistorySinceResult> {
  if (!isRecord(value) || typeof value.kind !== 'string')
    return fail('history since result is invalid')
  if (value.kind === 'deltas') {
    if (!exactKeys(value, ['kind', 'threadId', 'generation', 'fromCursor', 'toCursor', 'deltas'])) {
      return fail('history since result is invalid')
    }
    if (
      !isCanonicalString(value.threadId, MAX_ID) ||
      !isNonNegativeInt(value.generation) ||
      !isNonNegativeInt(value.fromCursor) ||
      !isNonNegativeInt(value.toCursor) ||
      value.toCursor < value.fromCursor ||
      !Array.isArray(value.deltas) ||
      value.deltas.length > HOST_HISTORY_MAX_PAGE_SIZE
    ) {
      return fail('history since result is invalid')
    }
    const deltas: HostHistoryDelta[] = []
    for (const delta of value.deltas) {
      const decoded = decodeHistoryDelta(delta)
      if (!decoded.ok) return fail('history since result is invalid')
      deltas.push(decoded.value)
    }
    return {
      ok: true,
      value: {
        kind: 'deltas',
        threadId: value.threadId,
        generation: value.generation,
        fromCursor: value.fromCursor,
        toCursor: value.toCursor,
        deltas
      }
    }
  }
  if (value.kind === 'full_resnapshot_required') {
    if (
      !exactKeys(value, [
        'kind',
        'threadId',
        'generation',
        'cursor',
        'clientGeneration',
        'clientCursor',
        'reason'
      ])
    ) {
      return fail('history since result is invalid')
    }
    if (
      !isCanonicalString(value.threadId, MAX_ID) ||
      !isNonNegativeInt(value.generation) ||
      !isNonNegativeInt(value.cursor) ||
      !isNonNegativeInt(value.clientGeneration) ||
      !isNonNegativeInt(value.clientCursor) ||
      !['generation_mismatch', 'retention_gap', 'cursor_mismatch'].includes(String(value.reason))
    ) {
      return fail('history since result is invalid')
    }
    return {
      ok: true,
      value: {
        kind: 'full_resnapshot_required',
        threadId: value.threadId,
        generation: value.generation,
        cursor: value.cursor,
        clientGeneration: value.clientGeneration,
        clientCursor: value.clientCursor,
        reason: value.reason as Extract<
          HostHistorySinceResult,
          { kind: 'full_resnapshot_required' }
        >['reason']
      }
    }
  }
  return fail('history since result is invalid')
}

export function decodeHostHistoryDeltasFrame(
  value: unknown
): HostHistoryDecodeResult<HostHistoryDeltasFrame> {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['type', 'protocolVersion', 'threadId', 'result']) ||
    value.type !== 'host.history'
  ) {
    return fail('history frame is invalid')
  }
  if (value.protocolVersion !== 2 || !isCanonicalString(value.threadId, MAX_ID)) {
    return fail('history frame is invalid')
  }
  const result = decodeHostHistorySinceResult(value.result)
  if (!result.ok || result.value.threadId !== value.threadId)
    return fail('history frame is invalid')
  return {
    ok: true,
    value: {
      type: 'host.history',
      protocolVersion: 2,
      threadId: value.threadId,
      result: result.value
    }
  }
}
