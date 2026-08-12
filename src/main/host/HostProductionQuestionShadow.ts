/**
 * Host Arc Wave 5c Phase 3 — RemoteQuestionRegistry shadow → Host family.
 *
 * WHAT THIS IS. Agent/desktop questions live in RemoteQuestionRegistry keyed by
 * a registry-minted questionId. Host question cards on the wire use the same
 * id so clients can join. This adapter owns the allowlisted mapping into
 * HostQuestionProjection without importing electron, AppStore, or the
 * registry class itself.
 *
 * BOUNDARIES:
 * - zero electron / AppStore / RemoteQuestionRegistry value imports;
 * - constructs allowlisted HostQuestionProjection fields only;
 * - never forwards options, context, provider, workspacePath, answer bodies,
 *   or cancellation reasons onto the wire;
 * - never invents a threadId (required on the wire — rows without one are
 *   skipped, not fabricated).
 *
 * HONESTY:
 * - pending and bounded recent resolved metadata are projected;
 * - answer bodies and cancellation reasons never enter this adapter;
 * - askedAt/resolvedAt are parsed from registry ISO timestamps;
 * - receiptId is an exact bounded correlation key and is never truncated;
 * - a throwing listPending propagates (fail closed, never a false empty);
 * - every listQuestions call re-reads (no cache of a moving set).
 */

import type { HostQuestionProjection } from '../../shared/hostProtocol'
import type { HostProductionQuestionListPort } from './HostProductionSuppliers'

/** Wire id bound — matches hostProtocol HOST_PROTOCOL_MAX_ID. */
const HOST_QUESTION_ID_MAX = 512
/** Compact prompt preview bound — matches decode ceiling HOST_PROTOCOL_MAX_WARNING. */
const HOST_QUESTION_PROMPT_PREVIEW_MAX = 1_000

function hasUnsafeHostQuestionIdControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

export type HostQuestionShadowStatus = 'pending' | 'answered' | 'rejected' | 'expired' | 'cancelled'

/**
 * Thin pending-row shape the composition root adapts from
 * RemoteQuestionRegistry.listPending (or any equivalent). Deliberately
 * narrow so this module never pulls registry/store symbols.
 */
export interface HostPendingQuestionShadowEntry {
  readonly questionId: string
  /** Source prompt text → bounded promptPreview. */
  readonly question: string
  /** Required on the wire — rows without a non-empty threadId are skipped. */
  readonly threadId?: string
  /** ISO-8601 createdAt from the registry; parsed to askedAt ms. */
  readonly createdAt: string
  /** Absent remains legacy pending/open. */
  readonly status?: HostQuestionShadowStatus
  /** Required for resolved rows; projected as answeredAt. */
  readonly resolvedAt?: string
  /** Exact Host command receipt correlation; never an answer body. */
  readonly receiptId?: string
}

export interface HostProductionQuestionShadowDeps {
  listPending: () => readonly HostPendingQuestionShadowEntry[]
  listResolved?: () => readonly HostPendingQuestionShadowEntry[]
}

function isUsableId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    !hasUnsafeHostQuestionIdControlCharacter(value)
  )
}

function boundText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function parseTimestampMs(value: string | undefined): number | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || ms < 0) return null
  return Math.floor(ms)
}

function mapQuestionStatus(
  status: HostQuestionShadowStatus | undefined
): HostQuestionProjection['status'] | null {
  switch (status) {
    case undefined:
    case 'pending':
      return 'open'
    case 'answered':
      return 'answered'
    case 'rejected':
    case 'cancelled':
      return 'dismissed'
    case 'expired':
      return 'expired'
    default:
      return null
  }
}

/**
 * Map registry pending entries into allowlisted HostQuestionProjection rows.
 *
 * Exported for unit pins; production callers should use
 * {@link createHostProductionQuestionShadow}.
 */
export function mapQuestionShadowsToHostQuestions(
  entries: readonly HostPendingQuestionShadowEntry[]
): HostQuestionProjection[] {
  if (!Array.isArray(entries) || entries.length === 0) return []

  const rows: HostQuestionProjection[] = []
  for (const entry of entries) {
    if (!entry || !isUsableId(entry.questionId)) continue
    if (entry.questionId.length > HOST_QUESTION_ID_MAX) continue

    // threadId is REQUIRED on HostQuestionProjection — skip rather than invent.
    if (!isUsableId(entry.threadId) || entry.threadId.length > HOST_QUESTION_ID_MAX) continue

    const askedAt = parseTimestampMs(entry.createdAt)
    if (askedAt === null) continue

    const status = mapQuestionStatus(entry.status)
    if (status === null) continue
    const answeredAt = status === 'open' ? null : parseTimestampMs(entry.resolvedAt)
    if (status !== 'open' && answeredAt === null) continue

    const question =
      typeof entry.question === 'string' && entry.question.trim().length > 0
        ? entry.question.trim()
        : ''
    if (question.length === 0) continue

    // ALLOWLIST REBUILD: only these fields reach the wire.
    const row: HostQuestionProjection = {
      questionId: entry.questionId,
      threadId: entry.threadId,
      status,
      promptPreview: boundText(question, HOST_QUESTION_PROMPT_PREVIEW_MAX),
      askedAt
    }
    if (answeredAt !== null) row.answeredAt = answeredAt
    if (
      status !== 'open' &&
      isUsableId(entry.receiptId) &&
      entry.receiptId.length <= HOST_QUESTION_ID_MAX
    ) {
      row.receiptId = entry.receiptId
    }
    rows.push(row)
  }
  return rows
}

/** Legacy pending-only mapper retained for focused callers and tests. */
export function mapPendingQuestionShadowsToHostQuestions(
  entries: readonly HostPendingQuestionShadowEntry[]
): HostQuestionProjection[] {
  return mapQuestionShadowsToHostQuestions(
    entries.map((entry) => ({
      ...entry,
      status: 'pending',
      resolvedAt: undefined,
      receiptId: undefined
    }))
  )
}

/**
 * Build the optional `questions` port for createHostProductionBootstrap /
 * createHostProductionSuppliers.
 */
export function createHostProductionQuestionShadow(
  deps: HostProductionQuestionShadowDeps
): HostProductionQuestionListPort {
  if (!deps || typeof deps.listPending !== 'function') {
    throw new Error('HostProductionQuestionShadow requires listPending to be a function')
  }
  if (deps.listResolved !== undefined && typeof deps.listResolved !== 'function') {
    throw new Error('HostProductionQuestionShadow listResolved must be a function when provided')
  }
  return {
    listQuestions(): HostQuestionProjection[] {
      // Live reads every call — no caching of a moving registry set.
      // Throws propagate: fail closed, never paint a false empty.
      const byQuestionId = new Map<string, HostPendingQuestionShadowEntry>()
      for (const entry of deps.listPending()) {
        if (!entry || typeof entry.questionId !== 'string') continue
        byQuestionId.set(entry.questionId, {
          ...entry,
          status: 'pending',
          resolvedAt: undefined,
          receiptId: undefined
        })
      }
      for (const entry of deps.listResolved?.() ?? []) {
        if (!entry || typeof entry.questionId !== 'string') continue
        // A resolved row wins the same-id handoff between the two live reads.
        byQuestionId.set(entry.questionId, entry)
      }
      return mapQuestionShadowsToHostQuestions([...byQuestionId.values()])
    }
  }
}
