import { createHash, randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import type { ChatMessage, ChatRecord } from '../store/types'
import { isTaskWraithCodexRolloutOriginator } from '../codex/CodexHome'
import {
  extractTranscriptMessageText,
  isCursorSandboxProjectDir
} from '../cursor/CursorExternalActivity'
import { isAgyCompletedFinalResponseCandidate } from '../antigravity/AntigravityFinalResponseLiveness'
import type { AgyTranscriptStep } from '../antigravity/AntigravityToolProjection'
import {
  EXTERNAL_PROVIDER_THREAD_IMPORT_MESSAGE_KIND,
  EXTERNAL_PROVIDER_THREAD_IMPORT_NOTICE_KIND,
  EXTERNAL_PROVIDER_THREAD_IMPORT_SCHEMA_VERSION,
  EXTERNAL_PROVIDER_THREAD_IMPORT_TRUST,
  externalProviderThreadImportLabel,
  isExternalProviderThreadImportProvider,
  type ExternalProviderThreadImportProvider
} from '../../shared/externalProviderThreadImport'

export const EXTERNAL_PROVIDER_THREAD_IMPORT_MAX_FILE_BYTES = 16 * 1024 * 1024
export const EXTERNAL_PROVIDER_THREAD_IMPORT_MAX_MESSAGES = 2_000
export const EXTERNAL_PROVIDER_THREAD_IMPORT_MAX_MESSAGE_CHARS = 100_000
export const EXTERNAL_PROVIDER_THREAD_IMPORT_MAX_TOTAL_CHARS = 4 * 1024 * 1024
const MAX_SOURCE_RECORDS = 50_000

export interface ParsedExternalProviderThreadMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
  readonly timestamp: string
  readonly sourceMessageId?: string
}

export interface ParsedExternalProviderThread {
  readonly sourceConversationId?: string
  readonly messages: readonly ParsedExternalProviderThreadMessage[]
  readonly sourceMessageCount: number
  readonly invalidRecordCount: number
  readonly omittedRecordCount: number
  readonly truncated: boolean
  readonly taskWraithOwnedSource: boolean
}

export interface ExternalProviderThreadImportDeps {
  readonly readFile: (filePath: string) => Promise<string>
  readonly stat: (filePath: string) => Promise<{
    size: number
    mtimeMs: number
    isFile?: () => boolean
  }>
  readonly getChats: () => ChatRecord[]
  readonly getChat: (chatId: string) => ChatRecord | null
  readonly createGlobalChat: () => ChatRecord
  readonly saveChat: (chat: ChatRecord) => ChatRecord
  readonly deleteChat: (chatId: string) => void
  readonly now?: () => number
  readonly createId?: () => string
}

export interface ImportExternalProviderThreadInput {
  readonly provider: ExternalProviderThreadImportProvider
  readonly filePath: string
}

export interface ImportExternalProviderThreadResult {
  readonly chat: ChatRecord
  readonly duplicate: boolean
  readonly truncated: boolean
  readonly importedMessageCount: number
  readonly sourceMessageCount: number
}

export type ExternalProviderThreadImportErrorCode =
  | 'invalid-file'
  | 'file-too-large'
  | 'no-messages'
  | 'read-failed'
  | 'history-disabled'

export class ExternalProviderThreadImportError extends Error {
  constructor(
    readonly code: ExternalProviderThreadImportErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ExternalProviderThreadImportError'
  }
}

interface JsonRecordParse {
  records: Record<string, unknown>[]
  invalidRecordCount: number
  truncated: boolean
}

interface CandidateMessage {
  role: 'user' | 'assistant'
  content: unknown
  timestamp: unknown
  sourceMessageId?: unknown
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function canonicalString(value: unknown, max = 512): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max ? trimmed : undefined
}

function safeTimestamp(value: unknown, fallbackMs: number, offset: number): string {
  const parsed =
    typeof value === 'number' && Number.isFinite(value)
      ? value < 10_000_000_000
        ? value * 1_000
        : value
      : typeof value === 'string'
        ? Date.parse(value)
        : Number.NaN
  const candidateDate = new Date(parsed)
  if (Number.isFinite(candidateDate.getTime())) return candidateDate.toISOString()
  const fallbackDate = new Date(fallbackMs + offset)
  return Number.isFinite(fallbackDate.getTime())
    ? fallbackDate.toISOString()
    : new Date(offset).toISOString()
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const item of value) {
    const block = record(item)
    if (!block) continue
    const type = canonicalString(block.type, 64)?.toLowerCase()
    if (
      type &&
      ['tool_use', 'tool_result', 'function_call', 'function_call_output'].includes(type)
    ) {
      continue
    }
    if (
      (!type || ['text', 'input_text', 'output_text', 'message'].includes(type)) &&
      typeof block.text === 'string'
    ) {
      parts.push(block.text)
      continue
    }
    if (typeof block.content === 'string' && (!type || type === 'text')) {
      parts.push(block.content)
    }
  }
  return parts.join('\n')
}

function messageText(value: unknown): string {
  if (typeof value === 'string' || Array.isArray(value)) return textFromContent(value)
  const message = record(value)
  if (!message) return ''
  return textFromContent(message.content ?? message.text ?? message.message)
}

function parseJsonRecords(raw: string): JsonRecordParse {
  const trimmed = raw.trim()
  if (!trimmed) return { records: [], invalidRecordCount: 0, truncated: false }
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (!Array.isArray(parsed)) return { records: [], invalidRecordCount: 1, truncated: false }
      const bounded = parsed.slice(0, MAX_SOURCE_RECORDS)
      return {
        records: bounded
          .map(record)
          .filter((entry): entry is Record<string, unknown> => Boolean(entry)),
        invalidRecordCount: bounded.filter((entry) => !record(entry)).length,
        truncated: parsed.length > bounded.length
      }
    } catch {
      return { records: [], invalidRecordCount: 1, truncated: false }
    }
  }

  const records: Record<string, unknown>[] = []
  let invalidRecordCount = 0
  let sourceRecordCount = 0
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    sourceRecordCount += 1
    if (sourceRecordCount > MAX_SOURCE_RECORDS) break
    try {
      const parsed = record(JSON.parse(line))
      if (parsed) records.push(parsed)
      else invalidRecordCount += 1
    } catch {
      invalidRecordCount += 1
    }
  }
  return {
    records,
    invalidRecordCount,
    truncated: sourceRecordCount > MAX_SOURCE_RECORDS
  }
}

function codexCandidate(entry: Record<string, unknown>): CandidateMessage | null {
  const payload = record(entry.payload)
  if (!payload) return null
  if (entry.type === 'event_msg') {
    const type = payload.type
    if (type === 'user_message' || type === 'agent_message') {
      return {
        role: type === 'user_message' ? 'user' : 'assistant',
        content: payload.message ?? payload.content,
        timestamp: entry.timestamp ?? payload.timestamp,
        sourceMessageId: payload.id
      }
    }
  }
  if (entry.type === 'response_item' && payload.type === 'message') {
    if (payload.role !== 'user' && payload.role !== 'assistant') return null
    return {
      role: payload.role,
      content: payload.content,
      timestamp: entry.timestamp ?? payload.timestamp,
      sourceMessageId: payload.id
    }
  }
  return null
}

function claudeCandidate(entry: Record<string, unknown>): CandidateMessage | null {
  if (entry.isSidechain === true || (entry.type !== 'user' && entry.type !== 'assistant')) {
    return null
  }
  const message = record(entry.message)
  const role = message?.role ?? entry.type
  if (role !== 'user' && role !== 'assistant') return null
  return {
    role,
    content: message?.content ?? entry.content,
    timestamp: entry.timestamp ?? message?.createdAt,
    sourceMessageId: entry.uuid ?? entry.id
  }
}

function cursorCandidate(entry: Record<string, unknown>): CandidateMessage | null {
  if (entry.role !== 'user' && entry.role !== 'assistant') return null
  const message = record(entry.message)
  return {
    role: entry.role,
    content: extractTranscriptMessageText(message?.content ?? entry.content),
    timestamp: message?.createdAt ?? entry.timestamp,
    sourceMessageId: message?.id ?? entry.id
  }
}

function antigravityCandidate(entry: Record<string, unknown>): CandidateMessage | null {
  const source = canonicalString(entry.source, 64)?.toUpperCase()
  const type = canonicalString(entry.type, 64)?.toUpperCase()
  if (source === 'USER' && ['USER_INPUT', 'USER_MESSAGE', 'PROMPT'].includes(type || '')) {
    return {
      role: 'user',
      content: entry.content,
      timestamp: entry.created_at ?? entry.timestamp,
      sourceMessageId: entry.step_index ?? entry.id
    }
  }
  const step: AgyTranscriptStep = {
    step_index: typeof entry.step_index === 'number' ? entry.step_index : -1,
    source: source || '',
    type: type || '',
    status: canonicalString(entry.status, 64) || '',
    created_at: canonicalString(entry.created_at, 128) || '',
    content: typeof entry.content === 'string' ? entry.content : '',
    thinking: typeof entry.thinking === 'string' ? entry.thinking : undefined,
    tool_calls: Array.isArray(entry.tool_calls) ? entry.tool_calls : undefined,
    truncated_fields: Array.isArray(entry.truncated_fields)
      ? entry.truncated_fields.map(String)
      : undefined
  }
  if (isAgyCompletedFinalResponseCandidate(step)) {
    return {
      role: 'assistant',
      content: entry.content,
      timestamp: entry.created_at ?? entry.timestamp,
      sourceMessageId: entry.step_index ?? entry.id
    }
  }
  return null
}

function conversationId(
  provider: ExternalProviderThreadImportProvider,
  records: readonly Record<string, unknown>[]
): string | undefined {
  for (const entry of records) {
    if (provider === 'codex' && entry.type === 'session_meta') {
      const id = canonicalString(record(entry.payload)?.id)
      if (id) return id
    }
    for (const key of [
      'sessionId',
      'session_id',
      'conversationId',
      'conversation_id',
      'composerId'
    ]) {
      const id = canonicalString(entry[key])
      if (id) return id
    }
  }
  return undefined
}

export function parseExternalProviderThread(
  provider: ExternalProviderThreadImportProvider,
  raw: string,
  fallbackTimestampMs = Date.now()
): ParsedExternalProviderThread {
  const parsed = parseJsonRecords(raw)
  const messages: ParsedExternalProviderThreadMessage[] = []
  let sourceMessageCount = 0
  let totalChars = 0
  let truncated = parsed.truncated
  const candidateFor =
    provider === 'codex'
      ? codexCandidate
      : provider === 'claude'
        ? claudeCandidate
        : provider === 'cursor'
          ? cursorCandidate
          : antigravityCandidate

  for (const entry of parsed.records) {
    const candidate = candidateFor(entry)
    if (!candidate) continue
    sourceMessageCount += 1
    let content = messageText(candidate.content)
      .split('\u0000')
      .join('')
      .replace(/\r\n/g, '\n')
      .trim()
    if (!content) continue
    if (content.length > EXTERNAL_PROVIDER_THREAD_IMPORT_MAX_MESSAGE_CHARS) {
      content = `${content.slice(0, EXTERNAL_PROVIDER_THREAD_IMPORT_MAX_MESSAGE_CHARS - 1)}…`
      truncated = true
    }
    if (
      messages.length >= EXTERNAL_PROVIDER_THREAD_IMPORT_MAX_MESSAGES ||
      totalChars + content.length > EXTERNAL_PROVIDER_THREAD_IMPORT_MAX_TOTAL_CHARS
    ) {
      truncated = true
      break
    }
    const previous = messages[messages.length - 1]
    if (previous?.role === candidate.role && previous.content === content) continue
    const timestamp = safeTimestamp(candidate.timestamp, fallbackTimestampMs, messages.length)
    messages.push({
      role: candidate.role,
      content,
      timestamp,
      ...(canonicalString(String(candidate.sourceMessageId ?? ''), 512)
        ? { sourceMessageId: String(candidate.sourceMessageId) }
        : {})
    })
    totalChars += content.length
  }

  return {
    ...(conversationId(provider, parsed.records)
      ? { sourceConversationId: conversationId(provider, parsed.records) }
      : {}),
    messages: Object.freeze(messages),
    sourceMessageCount,
    invalidRecordCount: parsed.invalidRecordCount,
    omittedRecordCount:
      parsed.invalidRecordCount +
      Math.max(0, parsed.records.length - sourceMessageCount) +
      Math.max(0, sourceMessageCount - messages.length),
    truncated,
    taskWraithOwnedSource:
      provider === 'codex' &&
      parsed.records.some(
        (entry) =>
          entry.type === 'session_meta' &&
          isTaskWraithCodexRolloutOriginator(record(entry.payload)?.originator)
      )
  }
}

function safeSourceFileName(filePath: string): string {
  const safe = [...basename(filePath)]
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code >= 0x20 && code !== 0x7f
    })
    .join('')
    .slice(0, 160)
  return safe || 'transcript.jsonl'
}

function importedTitle(
  provider: ExternalProviderThreadImportProvider,
  sourceFileName: string
): string {
  const extension = extname(sourceFileName)
  const stem = sourceFileName.slice(0, extension ? -extension.length : undefined).trim()
  const label = externalProviderThreadImportLabel(provider)
  return `Imported ${label} · ${(stem || 'thread').slice(0, 80)}`
}

/** Explicit one-file import. No home-directory discovery or provider resume. */
export class ExternalProviderThreadImportService {
  private readonly now: () => number
  private readonly createId: () => string
  private persistenceTail: Promise<void> = Promise.resolve()

  constructor(private readonly deps: ExternalProviderThreadImportDeps) {
    this.now = deps.now ?? Date.now
    this.createId = deps.createId ?? randomUUID
  }

  async importFile(
    input: ImportExternalProviderThreadInput
  ): Promise<ImportExternalProviderThreadResult> {
    if (!isExternalProviderThreadImportProvider(input.provider)) {
      throw new ExternalProviderThreadImportError(
        'invalid-file',
        'Choose a supported transcript provider.'
      )
    }
    const filePath = canonicalString(input.filePath, 8_192)
    if (!filePath) {
      throw new ExternalProviderThreadImportError('invalid-file', 'Choose one transcript file.')
    }
    if (input.provider === 'cursor') {
      const normalizedPath = filePath.replace(/\\/g, '/')
      const projectDir = normalizedPath.split('/projects/')[1]?.split('/')[0] || ''
      if (
        normalizedPath.includes('/subagents/') ||
        (projectDir && isCursorSandboxProjectDir(projectDir))
      ) {
        throw new ExternalProviderThreadImportError(
          'invalid-file',
          'Cursor subagent and TaskWraith sandbox transcripts are not importable.'
        )
      }
    }
    let stats: Awaited<ReturnType<ExternalProviderThreadImportDeps['stat']>>
    let raw: string
    try {
      stats = await this.deps.stat(filePath)
      if (stats.isFile && !stats.isFile()) {
        throw new ExternalProviderThreadImportError(
          'invalid-file',
          'The selected item is not a file.'
        )
      }
      if (!Number.isFinite(stats.size) || stats.size < 0) {
        throw new ExternalProviderThreadImportError('invalid-file', 'The selected file is invalid.')
      }
      if (stats.size > EXTERNAL_PROVIDER_THREAD_IMPORT_MAX_FILE_BYTES) {
        throw new ExternalProviderThreadImportError(
          'file-too-large',
          'The selected transcript exceeds the 16 MB import limit.'
        )
      }
      raw = await this.deps.readFile(filePath)
      if (Buffer.byteLength(raw, 'utf8') > EXTERNAL_PROVIDER_THREAD_IMPORT_MAX_FILE_BYTES) {
        throw new ExternalProviderThreadImportError(
          'file-too-large',
          'The selected transcript exceeds the 16 MB import limit.'
        )
      }
    } catch (error) {
      if (error instanceof ExternalProviderThreadImportError) throw error
      throw new ExternalProviderThreadImportError(
        'read-failed',
        'The selected transcript could not be read.'
      )
    }

    const fingerprint = createHash('sha256')
      .update(`${input.provider}\u0000`, 'utf8')
      .update(raw, 'utf8')
      .digest('hex')
    return this.enqueuePersistence(async () => {
      const duplicate = this.deps
        .getChats()
        .find(
          (chat) =>
            chat.externalProviderThreadImport?.sourceFingerprintSha256 === fingerprint &&
            chat.externalProviderThreadImport.provider === input.provider
        )
      if (duplicate) {
        return {
          chat: duplicate,
          duplicate: true,
          truncated: duplicate.externalProviderThreadImport?.truncated === true,
          importedMessageCount:
            duplicate.externalProviderThreadImport?.importedMessageCount ??
            duplicate.messages.length,
          sourceMessageCount:
            duplicate.externalProviderThreadImport?.sourceMessageCount ?? duplicate.messages.length
        }
      }

      const parsed = parseExternalProviderThread(
        input.provider,
        raw,
        Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : this.now()
      )
      if (parsed.taskWraithOwnedSource) {
        throw new ExternalProviderThreadImportError(
          'invalid-file',
          'That Codex transcript was created by TaskWraith and is already managed here.'
        )
      }
      if (parsed.messages.length === 0) {
        throw new ExternalProviderThreadImportError(
          'no-messages',
          'No supported user or assistant messages were found in that transcript.'
        )
      }
      const now = this.now()
      const importedAt = new Date(now).toISOString()
      const sourceFileName = safeSourceFileName(filePath)
      const providerLabel = externalProviderThreadImportLabel(input.provider)
      const notice: ChatMessage = {
        id: this.createId(),
        role: 'system',
        content:
          `Imported from a user-selected ${providerLabel} transcript file. ` +
          'This local snapshot is external and untrusted, is excluded from provider prompts, and cannot resume the native provider thread. Use an explicit Add to prompt or copy/paste, review, and Send to bridge selected text as a new host message.',
        timestamp: importedAt,
        metadata: { kind: EXTERNAL_PROVIDER_THREAD_IMPORT_NOTICE_KIND }
      }
      const importedMessages: ChatMessage[] = parsed.messages.map((message) => ({
        id: this.createId(),
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        metadata: {
          kind: EXTERNAL_PROVIDER_THREAD_IMPORT_MESSAGE_KIND,
          sourceTrust: EXTERNAL_PROVIDER_THREAD_IMPORT_TRUST,
          providerContextVisibility: 'projection-only',
          externalProvider: input.provider,
          ...(message.sourceMessageId ? { externalSourceMessageId: message.sourceMessageId } : {})
        }
      }))
      const created = this.deps.createGlobalChat()
      // createGlobalChat may persist a revisioned canonical record before it
      // returns its draft. Re-read so the import cannot lose to the optimistic
      // save fence as a stale whole-record clone.
      const base =
        this.deps.getChats().find((candidate) => candidate.appChatId === created.appChatId) ??
        created
      const chat: ChatRecord = {
        ...base,
        title: importedTitle(input.provider, sourceFileName),
        updatedAt: now,
        archived: true,
        workflowMode: 'normal',
        messages: [notice, ...importedMessages],
        runs: [],
        externalProviderThreadImport: {
          schemaVersion: EXTERNAL_PROVIDER_THREAD_IMPORT_SCHEMA_VERSION,
          provider: input.provider,
          trust: EXTERNAL_PROVIDER_THREAD_IMPORT_TRUST,
          sourceFileName,
          sourceFingerprintSha256: fingerprint,
          ...(parsed.sourceConversationId
            ? { sourceConversationId: parsed.sourceConversationId }
            : {}),
          sourceMessageCount: parsed.sourceMessageCount,
          importedMessageCount: importedMessages.length,
          omittedRecordCount: parsed.omittedRecordCount,
          invalidRecordCount: parsed.invalidRecordCount,
          importedAt,
          truncated: parsed.truncated,
          promptBridgeEnabled: false,
          nativeResumeAllowed: false
        }
      }
      this.deps.saveChat(chat)
      const saved = this.deps.getChat(created.appChatId)
      if (
        !saved ||
        saved.externalProviderThreadImport?.sourceFingerprintSha256 !== fingerprint ||
        saved.messages.length < importedMessages.length
      ) {
        try {
          this.deps.deleteChat(created.appChatId)
        } catch {
          // The draft may never have been persisted (history disabled).
        }
        throw new ExternalProviderThreadImportError(
          'history-disabled',
          'Enable local chat history before importing an external thread.'
        )
      }
      return {
        chat: saved,
        duplicate: false,
        truncated: parsed.truncated,
        importedMessageCount: importedMessages.length,
        sourceMessageCount: parsed.sourceMessageCount
      }
    })
  }

  private enqueuePersistence<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.persistenceTail.then(operation, operation)
    this.persistenceTail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}
