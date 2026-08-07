import { buildMobileQuestionCard, type MobileQuestionCard } from './RemoteTaskProjection'
import type { ProviderId } from './store/types'

export interface RemoteQuestionResolution {
  answer: string
  is_custom: boolean
  cancelled?: boolean
  cancellation_reason?: string
}

export type RemoteQuestionStatus = 'pending' | 'answered' | 'rejected' | 'expired' | 'cancelled'
export type RemoteQuestionSource = 'taskwraith' | 'codex-host'

export interface RemoteQuestionRecord {
  questionId: string
  promptId: string
  question: string
  options?: string[]
  context?: string
  provider?: ProviderId
  workspaceId?: string | null
  workspacePath?: string
  threadId?: string
  runId?: string
  source?: RemoteQuestionSource
  createdAt: string
  expiresAt?: string
  status: RemoteQuestionStatus
  resolvedAt?: string
  cancellationReason?: string
}

export interface RegisterRemoteQuestionInput {
  questionId?: string
  question: string
  options?: string[]
  context?: string
  provider?: ProviderId
  workspaceId?: string | null
  workspacePath?: string
  threadId?: string
  runId?: string
  source?: RemoteQuestionSource
  ttlMs?: number
  expiresAt?: string
  resolve: (result: RemoteQuestionResolution) => void
}

/** Who resolved the question. The desktop modal writes its own transcript
 * reply row in the renderer; every other origin relies on the registry's
 * subscriber to persist one, so the event must say which side answered. */
export type RemoteQuestionAnswerOrigin = 'desktop' | 'remote'

export type RemoteQuestionRegistryEvent =
  | { type: 'registered'; record: RemoteQuestionRecord }
  | {
      type: 'answered'
      record: RemoteQuestionRecord
      answer: string
      isCustom: boolean
      origin: RemoteQuestionAnswerOrigin
    }
  | { type: 'rejected' | 'expired' | 'cancelled'; record: RemoteQuestionRecord; reason: string }

export interface RemoteQuestionRegistryOptions {
  now?: () => number
  defaultTtlMs?: number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  idFactory?: () => string
}

export interface RemoteQuestionResolveResult {
  ok: boolean
  record?: RemoteQuestionRecord
  reason?: 'not-found' | 'not-pending' | 'scope-mismatch'
}

export interface RemoteQuestionResolutionScope {
  workspaceId?: string | null
  threadId?: string
  runId?: string
}

interface PendingRemoteQuestion {
  record: RemoteQuestionRecord
  resolve: (result: RemoteQuestionResolution) => void
  timerHandle?: unknown
}

const DEFAULT_TTL_MS = 12 * 60 * 1000
export const REMOTE_QUESTION_MAX_QUESTION_CHARS = 600
export const REMOTE_QUESTION_MAX_CONTEXT_CHARS = 240
export const REMOTE_QUESTION_MAX_OPTION_CHARS = 96
export const REMOTE_QUESTION_MAX_OPTIONS = 4
export const REMOTE_QUESTION_MAX_ANSWER_CHARS = 8000

export class RemoteQuestionRegistry {
  private readonly now: () => number
  private readonly defaultTtlMs: number
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly idFactory: () => string
  private readonly pending = new Map<string, PendingRemoteQuestion>()
  private readonly listeners = new Set<(event: RemoteQuestionRegistryEvent) => void>()

  constructor(options: RemoteQuestionRegistryOptions = {}) {
    this.now = options.now ?? Date.now
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.idFactory =
      options.idFactory ?? (() => `q-${this.now()}-${Math.random().toString(36).slice(2, 8)}`)
  }

  register(input: RegisterRemoteQuestionInput): RemoteQuestionRecord {
    const question = sanitizeInput(input.question)
    if (!question) {
      throw new Error('RemoteQuestionRegistry.register requires a non-empty question')
    }
    const createdAtMs = this.now()
    const createdAt = new Date(createdAtMs).toISOString()
    const ttlMs = normalizeTtl(input.ttlMs ?? this.defaultTtlMs)
    const expiresAt =
      input.expiresAt ?? (ttlMs > 0 ? new Date(createdAtMs + ttlMs).toISOString() : undefined)
    const questionId = sanitizeInput(input.questionId) || this.idFactory()
    const record: RemoteQuestionRecord = {
      questionId,
      promptId: questionId,
      question,
      status: 'pending',
      createdAt
    }
    const options = sanitizeOptions(input.options)
    if (options.length > 0) record.options = options
    const context = sanitizeInput(input.context, REMOTE_QUESTION_MAX_CONTEXT_CHARS)
    if (context) record.context = context
    if (input.provider) record.provider = input.provider
    if (input.workspaceId !== undefined) record.workspaceId = input.workspaceId
    if (input.workspacePath) record.workspacePath = input.workspacePath
    if (input.threadId) record.threadId = input.threadId
    if (input.runId) record.runId = input.runId
    if (input.source) record.source = input.source
    if (expiresAt) record.expiresAt = expiresAt

    const pending: PendingRemoteQuestion = {
      record,
      resolve: input.resolve
    }
    if (ttlMs > 0) {
      pending.timerHandle = this.setTimer(() => {
        this.expire(questionId, 'timeout')
      }, ttlMs)
    }
    this.pending.set(questionId, pending)
    this.emit({ type: 'registered', record: { ...record } })
    return { ...record }
  }

  answer(
    questionId: string,
    answer: string,
    isCustom = false,
    origin: RemoteQuestionAnswerOrigin = 'desktop'
  ): RemoteQuestionResolveResult {
    const pending = this.pending.get(questionId)
    if (!pending) return { ok: false, reason: 'not-found' }
    const record = this.resolvePending(questionId, 'answered')
    if (!record) return { ok: false, reason: 'not-found' }
    const sanitizedAnswer = sanitizeInput(answer, REMOTE_QUESTION_MAX_ANSWER_CHARS)
    pending.resolve({
      answer: sanitizedAnswer,
      is_custom: Boolean(isCustom)
    })
    this.emit({
      type: 'answered',
      record,
      answer: sanitizedAnswer,
      isCustom: Boolean(isCustom),
      origin
    })
    return { ok: true, record }
  }

  answerScoped(
    questionId: string,
    scope: RemoteQuestionResolutionScope,
    answer: string,
    isCustom = false,
    origin: RemoteQuestionAnswerOrigin = 'desktop'
  ): RemoteQuestionResolveResult {
    const pending = this.pending.get(questionId)
    if (!pending) return { ok: false, reason: 'not-found' }
    if (!recordMatchesScope(pending.record, scope)) {
      return { ok: false, reason: 'scope-mismatch', record: { ...pending.record } }
    }
    return this.answer(questionId, answer, isCustom, origin)
  }

  reject(questionId: string, reason = 'user-dismissed'): RemoteQuestionResolveResult {
    return this.cancelLike(questionId, 'rejected', reason)
  }

  rejectScoped(
    questionId: string,
    scope: RemoteQuestionResolutionScope,
    reason = 'user-dismissed'
  ): RemoteQuestionResolveResult {
    const pending = this.pending.get(questionId)
    if (!pending) return { ok: false, reason: 'not-found' }
    if (!recordMatchesScope(pending.record, scope)) {
      return { ok: false, reason: 'scope-mismatch', record: { ...pending.record } }
    }
    return this.reject(questionId, reason)
  }

  cancel(questionId: string, reason = 'cancelled'): RemoteQuestionResolveResult {
    return this.cancelLike(questionId, 'cancelled', reason)
  }

  cancelScoped(
    questionId: string,
    scope: RemoteQuestionResolutionScope,
    reason = 'cancelled'
  ): RemoteQuestionResolveResult {
    const pending = this.pending.get(questionId)
    if (!pending) return { ok: false, reason: 'not-found' }
    if (!recordMatchesScope(pending.record, scope)) {
      return { ok: false, reason: 'scope-mismatch', record: { ...pending.record } }
    }
    return this.cancel(questionId, reason)
  }

  expire(questionId: string, reason = 'timeout'): RemoteQuestionResolveResult {
    return this.cancelLike(questionId, 'expired', reason)
  }

  cancelForRun(runId: string, reason: string): RemoteQuestionRecord[] {
    if (!runId) return []
    const cancelled: RemoteQuestionRecord[] = []
    for (const [questionId, pending] of [...this.pending.entries()]) {
      if (pending.record.runId !== runId) continue
      const result = this.cancel(questionId, reason)
      if (result.record) cancelled.push(result.record)
    }
    return cancelled
  }

  sweepStale(nowMs: number = this.now(), reason = 'timeout'): RemoteQuestionRecord[] {
    const expired: RemoteQuestionRecord[] = []
    for (const [questionId, pending] of [...this.pending.entries()]) {
      if (!pending.record.expiresAt) continue
      const expiresAtMs = Date.parse(pending.record.expiresAt)
      if (!Number.isFinite(expiresAtMs) || expiresAtMs > nowMs) continue
      const result = this.expire(questionId, reason)
      if (result.record) expired.push(result.record)
    }
    return expired
  }

  has(questionId: string): boolean {
    return this.pending.has(questionId)
  }

  get(questionId: string): RemoteQuestionRecord | null {
    const pending = this.pending.get(questionId)
    return pending ? { ...pending.record } : null
  }

  listPending(
    filter: { threadId?: string; runId?: string; workspaceId?: string } = {}
  ): RemoteQuestionRecord[] {
    this.sweepStale()
    return [...this.pending.values()]
      .map((pending) => pending.record)
      .filter((record) => {
        if (filter.threadId && record.threadId !== filter.threadId) return false
        if (filter.runId && record.runId !== filter.runId) return false
        if (filter.workspaceId && record.workspaceId !== filter.workspaceId) return false
        return true
      })
      .map((record) => ({ ...record }))
  }

  listProjectionCards(
    filter: { threadId?: string; runId?: string; workspaceId?: string } = {}
  ): MobileQuestionCard[] {
    return this.listPending(filter).map((record) => buildMobileQuestionCard(record))
  }

  subscribe(listener: (event: RemoteQuestionRegistryEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  clear(reason = 'cleared'): RemoteQuestionRecord[] {
    const records: RemoteQuestionRecord[] = []
    for (const questionId of [...this.pending.keys()]) {
      const result = this.cancel(questionId, reason)
      if (result.record) records.push(result.record)
    }
    return records
  }

  private cancelLike(
    questionId: string,
    status: 'rejected' | 'expired' | 'cancelled',
    reason: string
  ): RemoteQuestionResolveResult {
    const pending = this.pending.get(questionId)
    if (!pending) return { ok: false, reason: 'not-found' }
    const record = this.resolvePending(questionId, status, reason)
    if (!record) return { ok: false, reason: 'not-found' }
    pending.resolve({
      answer: '',
      is_custom: false,
      cancelled: true,
      cancellation_reason: reason
    })
    this.emit({ type: status, record, reason })
    return { ok: true, record }
  }

  private resolvePending(
    questionId: string,
    status: Exclude<RemoteQuestionStatus, 'pending'>,
    reason?: string
  ): RemoteQuestionRecord | null {
    const pending = this.pending.get(questionId)
    if (!pending) return null
    this.pending.delete(questionId)
    if (pending.timerHandle !== undefined) this.clearTimer(pending.timerHandle)
    const record: RemoteQuestionRecord = {
      ...pending.record,
      status,
      resolvedAt: new Date(this.now()).toISOString()
    }
    if (reason) record.cancellationReason = reason
    pending.record = record
    return { ...record }
  }

  private emit(event: RemoteQuestionRegistryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // Registry state should not depend on best-effort projection listeners.
      }
    }
  }
}

function sanitizeInput(value: unknown, maxChars = REMOTE_QUESTION_MAX_QUESTION_CHARS): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized.length <= maxChars ? normalized : normalized.slice(0, maxChars)
}

function sanitizeOptions(options: unknown): string[] {
  if (!Array.isArray(options)) return []
  const seen = new Set<string>()
  const sanitized: string[] = []
  for (const option of options) {
    const value = sanitizeInput(option, REMOTE_QUESTION_MAX_OPTION_CHARS)
    if (!value || seen.has(value)) continue
    seen.add(value)
    sanitized.push(value)
    if (sanitized.length >= REMOTE_QUESTION_MAX_OPTIONS) break
  }
  return sanitized
}

function normalizedScopeValue(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function recordMatchesScope(
  record: RemoteQuestionRecord,
  scope: RemoteQuestionResolutionScope = {}
): boolean {
  const expectedWorkspaceId = normalizedScopeValue(record.workspaceId)
  const providedWorkspaceId = normalizedScopeValue(scope.workspaceId)
  if (expectedWorkspaceId && providedWorkspaceId && expectedWorkspaceId !== providedWorkspaceId) {
    return false
  }

  const expectedThreadId = normalizedScopeValue(record.threadId)
  const providedThreadId = normalizedScopeValue(scope.threadId)
  if (expectedThreadId && providedThreadId && expectedThreadId !== providedThreadId) {
    return false
  }

  const expectedRunId = normalizedScopeValue(record.runId)
  const providedRunId = normalizedScopeValue(scope.runId)
  if (expectedRunId && providedRunId && expectedRunId !== providedRunId) {
    return false
  }

  return true
}

function normalizeTtl(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
