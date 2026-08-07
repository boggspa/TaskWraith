/**
 * Host Arc Wave 5c Phase 3 — RemoteQuestionRegistry pending shadow → Host family.
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
 * - only pending open questions are projected (the registry's live set);
 * - status is always 'open' for this shadow path;
 * - askedAt is parsed from createdAt ISO — unparseable rows are skipped;
 * - a throwing listPending propagates (fail closed, never a false empty);
 * - every listQuestions call re-reads (no cache of a moving set).
 */

import type { HostQuestionProjection } from '../../shared/hostProtocol'
import type { HostProductionQuestionListPort } from './HostProductionSuppliers'

/** Wire id bound — matches hostProtocol HOST_PROTOCOL_MAX_ID. */
const HOST_QUESTION_ID_MAX = 512
/** Compact prompt preview bound — matches decode ceiling HOST_PROTOCOL_MAX_WARNING. */
const HOST_QUESTION_PROMPT_PREVIEW_MAX = 1_000

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
}

export interface HostProductionQuestionShadowDeps {
  listPending: () => readonly HostPendingQuestionShadowEntry[]
}

function isUsableId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim().length > 0
}

function boundText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function parseAskedAtMs(createdAt: string): number | null {
  if (typeof createdAt !== 'string' || createdAt.length === 0) return null
  const ms = Date.parse(createdAt)
  if (!Number.isFinite(ms) || ms < 0) return null
  return Math.floor(ms)
}

/**
 * Map registry pending entries into allowlisted HostQuestionProjection rows.
 *
 * Exported for unit pins; production callers should use
 * {@link createHostProductionQuestionShadow}.
 */
export function mapPendingQuestionShadowsToHostQuestions(
  entries: readonly HostPendingQuestionShadowEntry[]
): HostQuestionProjection[] {
  if (!Array.isArray(entries) || entries.length === 0) return []

  const rows: HostQuestionProjection[] = []
  for (const entry of entries) {
    if (!entry || !isUsableId(entry.questionId)) continue
    if (entry.questionId.length > HOST_QUESTION_ID_MAX) continue

    // threadId is REQUIRED on HostQuestionProjection — skip rather than invent.
    if (!isUsableId(entry.threadId) || entry.threadId.length > HOST_QUESTION_ID_MAX) continue

    const askedAt = parseAskedAtMs(entry.createdAt)
    if (askedAt === null) continue

    const question =
      typeof entry.question === 'string' && entry.question.trim().length > 0
        ? entry.question.trim()
        : ''
    if (question.length === 0) continue

    // ALLOWLIST REBUILD: only these fields reach the wire.
    const row: HostQuestionProjection = {
      questionId: entry.questionId,
      threadId: entry.threadId,
      status: 'open',
      promptPreview: boundText(question, HOST_QUESTION_PROMPT_PREVIEW_MAX),
      askedAt
    }
    rows.push(row)
  }
  return rows
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
  return {
    listQuestions(): HostQuestionProjection[] {
      // Live read every call — no caching of a moving pending set.
      // Throws propagate: fail closed, never paint a false empty.
      return mapPendingQuestionShadowsToHostQuestions(deps.listPending())
    }
  }
}
