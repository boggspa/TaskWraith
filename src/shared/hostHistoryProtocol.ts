/** Bounded, read-only transcript history projections for Host v2. */

export const HOST_HISTORY_MAX_PAGE_SIZE = 100
export const HOST_HISTORY_DEFAULT_PAGE_SIZE = 50
export const HOST_HISTORY_MAX_ENTRY_TEXT = 16_000
export const HOST_HISTORY_MAX_ENTRY_LABEL = 200
export const HOST_HISTORY_MAX_ENTRY_TOOLS = 32
export const HOST_HISTORY_MAX_TOOL_NAME = 200
export const HOST_HISTORY_MAX_TOOL_FILE = 512
export const HOST_HISTORY_MAX_TOOL_HUNKS = 8
export const HOST_HISTORY_MAX_TOOL_DIFF_LINES = 80
export const HOST_HISTORY_MAX_TOOL_DIFF_HEADER = 240
export const HOST_HISTORY_MAX_TOOL_DIFF_LINE_CHARS = 400
export const HOST_HISTORY_MAX_TOOL_COMMAND_CHARS = 1_000
export const HOST_HISTORY_MAX_TOOL_OUTPUT_CHARS = 4_000

export type HostHistoryDecodeResult<T> = { ok: true; value: T } | { ok: false; error: string }
export type HostTranscriptRole = 'user' | 'assistant' | 'system' | 'tool'
export type HostHistoryToolCategory = 'task' | 'read' | 'write' | 'search' | 'shell' | 'unknown'
export type HostHistoryToolStatus = 'running' | 'success' | 'error'
export type HostHistoryToolDiffLineType = 'context' | 'add' | 'del'

export interface HostHistoryCursor {
  readonly generation: number
  readonly cursor: number
}

export interface HostThreadHistoryRequest {
  readonly threadId: string
  readonly before?: HostHistoryCursor
  readonly limit: number
}

export interface HostHistoryToolDiffLine {
  readonly type: HostHistoryToolDiffLineType
  readonly text: string
  readonly oldLine?: number
  readonly newLine?: number
}

export interface HostHistoryToolDiffHunk {
  readonly header: string
  readonly lines: readonly HostHistoryToolDiffLine[]
}

/** Bounded, display-only diff data. File contents never travel as raw payloads. */
export interface HostHistoryToolDiff {
  readonly hunks: readonly HostHistoryToolDiffHunk[]
  readonly truncated?: boolean
}

/** Bounded command card data. Output is a presentation preview, not an audit log. */
export interface HostHistoryToolCommand {
  readonly command?: string
  readonly output?: string
  readonly exitCode?: number
  readonly truncated?: boolean
}

/** Bounded display-only tool activity attached to its assistant transcript row. */
export interface HostHistoryToolEntry {
  readonly id: string
  readonly name: string
  readonly category: HostHistoryToolCategory
  readonly status: HostHistoryToolStatus
  readonly file?: string
  readonly additions?: number
  readonly deletions?: number
  readonly diff?: HostHistoryToolDiff
  readonly command?: HostHistoryToolCommand
}

export interface HostTranscriptHistoryEntry {
  readonly entryId: string
  readonly role: HostTranscriptRole
  readonly createdAt: number
  readonly text: string
  readonly label?: string
  readonly tools?: readonly HostHistoryToolEntry[]
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

function isSafeToolLineText(value: unknown, max: number): value is string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return false
  }
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code === 0x09) continue
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

function decodeHostHistoryToolDiffLine(
  value: unknown,
  index: number
): HostHistoryDecodeResult<HostHistoryToolDiffLine> {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['type', 'text', 'oldLine', 'newLine']) ||
    !['context', 'add', 'del'].includes(String(value.type)) ||
    !isSafeToolLineText(value.text, HOST_HISTORY_MAX_TOOL_DIFF_LINE_CHARS)
  ) {
    return fail(`history diff line ${index} is invalid`)
  }
  for (const key of ['oldLine', 'newLine'] as const) {
    if (
      value[key] !== undefined &&
      (!isNonNegativeInt(value[key]) || Number(value[key]) > 1_000_000_000)
    ) {
      return fail(`history diff line ${index} is invalid`)
    }
  }
  return {
    ok: true,
    value: {
      type: value.type as HostHistoryToolDiffLineType,
      text: value.text,
      ...(value.oldLine !== undefined ? { oldLine: value.oldLine as number } : {}),
      ...(value.newLine !== undefined ? { newLine: value.newLine as number } : {})
    }
  }
}

function decodeHostHistoryToolDiffHunk(
  value: unknown,
  index: number,
  lineBudget: { count: number }
): HostHistoryDecodeResult<HostHistoryToolDiffHunk> {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['header', 'lines']) ||
    !isSafeToolLineText(value.header, HOST_HISTORY_MAX_TOOL_DIFF_HEADER) ||
    !Array.isArray(value.lines)
  ) {
    return fail(`history diff hunk ${index} is invalid`)
  }
  const lines: HostHistoryToolDiffLine[] = []
  for (let lineIndex = 0; lineIndex < value.lines.length; lineIndex += 1) {
    lineBudget.count += 1
    if (lineBudget.count > HOST_HISTORY_MAX_TOOL_DIFF_LINES) {
      return fail(`history diff hunk ${index} is invalid`)
    }
    const decoded = decodeHostHistoryToolDiffLine(value.lines[lineIndex], lineIndex)
    if (!decoded.ok) return fail(`history diff hunk ${index} is invalid`)
    lines.push(decoded.value)
  }
  return { ok: true, value: { header: value.header, lines } }
}

function decodeHostHistoryToolDiff(value: unknown): HostHistoryDecodeResult<HostHistoryToolDiff> {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['hunks', 'truncated']) ||
    !Array.isArray(value.hunks) ||
    value.hunks.length > HOST_HISTORY_MAX_TOOL_HUNKS ||
    (value.truncated !== undefined && typeof value.truncated !== 'boolean')
  ) {
    return fail('history tool diff is invalid')
  }
  const lineBudget = { count: 0 }
  const hunks: HostHistoryToolDiffHunk[] = []
  for (let index = 0; index < value.hunks.length; index += 1) {
    const decoded = decodeHostHistoryToolDiffHunk(value.hunks[index], index, lineBudget)
    if (!decoded.ok) return fail('history tool diff is invalid')
    hunks.push(decoded.value)
  }
  return {
    ok: true,
    value: {
      hunks,
      ...(value.truncated === true ? { truncated: true } : {})
    }
  }
}

function decodeHostHistoryToolCommand(
  value: unknown
): HostHistoryDecodeResult<HostHistoryToolCommand> {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['command', 'output', 'exitCode', 'truncated']) ||
    (value.command !== undefined &&
      !isSafeToolLineText(value.command, HOST_HISTORY_MAX_TOOL_COMMAND_CHARS)) ||
    (value.output !== undefined && !isSafeTranscriptText(value.output)) ||
    (value.output !== undefined && value.output.length > HOST_HISTORY_MAX_TOOL_OUTPUT_CHARS) ||
    (value.exitCode !== undefined &&
      (!Number.isSafeInteger(value.exitCode) || Math.abs(Number(value.exitCode)) > 1_000_000)) ||
    (value.truncated !== undefined && typeof value.truncated !== 'boolean') ||
    (value.command === undefined && value.output === undefined && value.exitCode === undefined)
  ) {
    return fail('history tool command is invalid')
  }
  return {
    ok: true,
    value: {
      ...(value.command !== undefined ? { command: value.command } : {}),
      ...(value.output !== undefined ? { output: value.output } : {}),
      ...(value.exitCode !== undefined ? { exitCode: value.exitCode as number } : {}),
      ...(value.truncated === true ? { truncated: true } : {})
    }
  }
}

export function decodeHostHistoryToolEntry(
  value: unknown,
  index: number
): HostHistoryDecodeResult<HostHistoryToolEntry> {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'id',
      'name',
      'category',
      'status',
      'file',
      'additions',
      'deletions',
      'diff',
      'command'
    ]) ||
    !isCanonicalString(value.id, MAX_ID) ||
    !isCanonicalString(value.name, HOST_HISTORY_MAX_TOOL_NAME) ||
    !['task', 'read', 'write', 'search', 'shell', 'unknown'].includes(String(value.category)) ||
    !['running', 'success', 'error'].includes(String(value.status))
  ) {
    return fail(`history tool entry ${index} is invalid`)
  }
  if (value.file !== undefined && !isCanonicalString(value.file, HOST_HISTORY_MAX_TOOL_FILE)) {
    return fail(`history tool entry ${index} is invalid`)
  }
  if (value.additions !== undefined && !isNonNegativeInt(value.additions)) {
    return fail(`history tool entry ${index} is invalid`)
  }
  if (value.deletions !== undefined && !isNonNegativeInt(value.deletions)) {
    return fail(`history tool entry ${index} is invalid`)
  }
  let diff: HostHistoryToolDiff | undefined
  if (value.diff !== undefined) {
    const decoded = decodeHostHistoryToolDiff(value.diff)
    if (!decoded.ok) return fail(`history tool entry ${index} is invalid`)
    diff = decoded.value
  }
  let command: HostHistoryToolCommand | undefined
  if (value.command !== undefined) {
    const decoded = decodeHostHistoryToolCommand(value.command)
    if (!decoded.ok) return fail(`history tool entry ${index} is invalid`)
    command = decoded.value
  }
  return {
    ok: true,
    value: {
      id: value.id,
      name: value.name,
      category: value.category as HostHistoryToolCategory,
      status: value.status as HostHistoryToolStatus,
      ...(value.file !== undefined ? { file: value.file } : {}),
      ...(value.additions !== undefined ? { additions: value.additions } : {}),
      ...(value.deletions !== undefined ? { deletions: value.deletions } : {}),
      ...(diff ? { diff } : {}),
      ...(command ? { command } : {})
    }
  }
}

export function decodeHostTranscriptHistoryEntry(
  value: unknown
): HostHistoryDecodeResult<HostTranscriptHistoryEntry> {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['entryId', 'role', 'createdAt', 'text', 'label', 'tools'])
  ) {
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
  let tools: HostHistoryToolEntry[] | undefined
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools) || value.tools.length > HOST_HISTORY_MAX_ENTRY_TOOLS) {
      return fail('history entry is invalid')
    }
    const ids = new Set<string>()
    tools = []
    for (let index = 0; index < value.tools.length; index += 1) {
      const decoded = decodeHostHistoryToolEntry(value.tools[index], index)
      if (!decoded.ok || ids.has(decoded.value.id)) return fail('history entry is invalid')
      ids.add(decoded.value.id)
      tools.push(decoded.value)
    }
  }
  return {
    ok: true,
    value: {
      entryId: value.entryId,
      role: value.role as HostTranscriptRole,
      createdAt: value.createdAt,
      text: value.text,
      ...(value.label ? { label: value.label } : {}),
      ...(tools && tools.length > 0 ? { tools } : {})
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
