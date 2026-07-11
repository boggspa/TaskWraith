/**
 * Provider context-window compaction — shared domain model.
 *
 * "Context compaction" here means a provider (or the host) summarizing an
 * agent session's conversation history so the live context shrinks — the thing
 * the Claude and Codex desktop apps chrome as "Compacting…". It is UNRELATED to
 * `src/main/store/ChatCompaction.ts`, which is disk-size compaction of
 * persisted chat records; keep the `contextCompaction*` prefix to avoid the
 * collision.
 *
 * Wire shapes (probe-verified 2026-07-02 against claude CLI 2.1.156 /
 * agent-sdk 0.2.141 and codex-cli 0.139.0 app-server):
 *
 * Claude stream-json (`-p` CLI and SDK `query()` both emit these; `/compact`
 * executes as a slash command in print mode with `--resume`):
 *   - `{type:'system', subtype:'status', status:'compacting'}`
 *   - `{type:'system', subtype:'status', status:null, compact_result:'failed',
 *      compact_error:'…'}`   ← can arrive MORE THAN ONCE per attempt
 *   - `{type:'system', subtype:'status', status:null, compact_result:'success'}`
 *   - `{type:'system', subtype:'compact_boundary', compact_metadata:{
 *      trigger:'manual'|'auto', pre_tokens, post_tokens, duration_ms}, uuid}`
 *
 * Codex app-server (`thread/compact/start {threadId}` resolves ~immediately;
 * the compaction then runs as ITS OWN turn):
 *   - `item/started`   `{item:{type:'contextCompaction', id}, threadId, turnId}`
 *   - `thread/tokenUsage/updated` (post-compaction occupancy in `last`)
 *   - `item/completed` `{item:{type:'contextCompaction', id}, threadId, turnId}`
 *
 * This module is dependency-light and node-builtin-free: it is imported by the
 * main process (ingestion + orchestrator), the renderer (adapter, card, meter
 * chrome), and tests, so it must stay portable and pure.
 */

import { formatContextTokens } from './contextWindows'

export type ContextCompactionTrigger = 'auto' | 'manual'

export interface ContextCompactionTelemetry {
  /** Provider that compacted (ProviderId string; typed loosely to stay pure). */
  provider?: string
  trigger?: ContextCompactionTrigger
  /** Context tokens immediately before compaction. */
  preTokens?: number
  /** Context tokens immediately after compaction. */
  postTokens?: number
  durationMs?: number
  /** Failure detail (e.g. "Not enough messages to compact."). */
  error?: string
  /** Provider-assigned id for THIS compaction event (Claude frame `uuid`,
   * Codex `contextCompaction` item id) — the deterministic card/dedupe key. */
  eventUuid?: string
}

export type ContextCompactionSignalKind = 'started' | 'completed' | 'failed'

export interface ContextCompactionSignal {
  kind: ContextCompactionSignalKind
  telemetry: ContextCompactionTelemetry
}

export type ContextCompactionProgressStatus = 'started' | 'completed' | 'failed'

export interface ContextCompactionProgressEvent {
  chatId: string
  participantId?: string
  provider?: string
  label?: string
  hueClass?: string
  status: ContextCompactionProgressStatus
  trigger?: ContextCompactionTrigger
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * True for the Claude `type:'system'` frames that describe context compaction:
 * the `compact_boundary` marker and the `status` frames that carry a
 * `compacting` status or a `compact_result`. Plain `status` heartbeats (e.g.
 * `status:'requesting'`) are NOT compaction frames.
 */
export function isClaudeContextCompactionSystemEvent(event: unknown): boolean {
  const record = asRecord(event)
  if (!record) return false
  if (str(record.type) !== 'system') return false
  const subtype = str(record.subtype)
  if (subtype === 'compact_boundary') return true
  if (subtype !== 'status') return false
  return str(record.status) === 'compacting' || Boolean(str(record.compact_result))
}

/**
 * Normalize a Claude compaction system frame into a signal.
 *
 * `compact_result:'success'` status frames return null on purpose: the
 * `compact_boundary` frame that follows is the authoritative success record
 * (it carries pre/post tokens + trigger), and emitting both would double-card.
 */
export function normalizeClaudeContextCompactionEvent(
  event: unknown
): ContextCompactionSignal | null {
  const record = asRecord(event)
  if (!record || str(record.type) !== 'system') return null
  const subtype = str(record.subtype)
  const eventUuid = str(record.uuid) || undefined

  if (subtype === 'compact_boundary') {
    const meta = asRecord(record.compact_metadata) || {}
    const rawTrigger = str(meta.trigger)
    const telemetry: ContextCompactionTelemetry = { eventUuid }
    if (rawTrigger === 'auto' || rawTrigger === 'manual') telemetry.trigger = rawTrigger
    const preTokens = finiteNumber(meta.pre_tokens)
    if (preTokens !== undefined) telemetry.preTokens = preTokens
    const postTokens = finiteNumber(meta.post_tokens)
    if (postTokens !== undefined) telemetry.postTokens = postTokens
    const durationMs = finiteNumber(meta.duration_ms)
    if (durationMs !== undefined) telemetry.durationMs = durationMs
    return { kind: 'completed', telemetry }
  }

  if (subtype !== 'status') return null
  if (str(record.status) === 'compacting') {
    return { kind: 'started', telemetry: { eventUuid } }
  }
  const compactResult = str(record.compact_result)
  if (compactResult === 'failed') {
    const telemetry: ContextCompactionTelemetry = { eventUuid }
    const error = str(record.compact_error)
    if (error) telemetry.error = error
    return { kind: 'failed', telemetry }
  }
  // compact_result:'success' — superseded by the compact_boundary frame.
  return null
}

/**
 * Per-run dedupe key. Claude's failure status frame is emitted more than once
 * per attempt with DIFFERENT uuids (probe-observed), so failures key on their
 * error text rather than the frame uuid; started/completed key on the uuid.
 */
export function contextCompactionDedupeKey(signal: ContextCompactionSignal): string {
  if (signal.kind === 'failed') return `failed:${signal.telemetry.error || ''}`
  return `${signal.kind}:${signal.telemetry.eventUuid || ''}`
}

/** True when a Codex thread item is the `contextCompaction` lifecycle item. */
export function isCodexContextCompactionItem(item: unknown): boolean {
  const record = asRecord(item)
  return Boolean(record && str(record.type) === 'contextCompaction')
}

/** Item id off a Codex `contextCompaction` item, when present. */
export function codexContextCompactionItemId(item: unknown): string | undefined {
  const record = asRecord(item)
  return record ? str(record.id) || undefined : undefined
}

// ── Context pressure (detection) ─────────────────────────────────────────────
// Thresholds mirror the only in-repo precedent, the Ollama ensemble pressure
// model (src/main/ollama/OllamaEnsembleContext.ts): warn ≥80%, critical ≥95%.

export const CONTEXT_PRESSURE_WARN_PERCENT = 80
export const CONTEXT_PRESSURE_CRITICAL_PERCENT = 95

/**
 * Threshold applied only to provider-semantic occupancy evidence. Generic run
 * input/output must never be compared to this as though it were a live context
 * window. Sits between warn and critical so a summarize turn retains headroom.
 */
export const CONTEXT_AUTO_COMPACT_PERCENT = 90

/** One host auto-compaction attempt per chat per window — breaks retry loops
 * when the summarize turn itself keeps failing. */
export const CONTEXT_AUTO_COMPACT_COOLDOWN_MS = 10 * 60 * 1000

// ── Stored-summary provenance ───────────────────────────────────────────────────

/**
 * Evidence carried by a host-authored context summary.
 *
 * Only `contiguous_prompt_prefix` is pruning authority. The other variants
 * describe useful but non-contiguous evidence and therefore never authorize
 * deleting transcript rows from a future prompt. Arrays are persisted in the
 * order in which rows were represented to the summarizer/session.
 */
export type ContextCompactionProvenance =
  | {
      kind: 'contiguous_prompt_prefix'
      throughMessageId: string
      /** Exact, gap-free chat-message ids covered from transcript start. */
      coveredMessageIds: string[]
      /** Optional audit link when the replacement summary chained an older summary. */
      chainedFrom?: {
        throughMessageId: string
        summaryCreatedAt: string
      }
    }
  | {
      kind: 'bounded_prompt_window'
      /** Exact ids whose rows were represented, even if their text was truncated. */
      suppliedMessageIds: string[]
      /**
       * Earlier directly-supplied rows represented transitively by the prior
       * durable summary included in this summarize turn. This is progress
       * metadata only: it never authorizes transcript pruning.
       */
      carriedForwardMessageIds?: string[]
      previousSummaryCreatedAt?: string
    }
  | {
      kind: 'provider_session'
      providerSessionId?: string
      /** Exact TaskWraith rows proven observed; empty means no row-level claim. */
      observedMessageIds: string[]
      previousSummaryCreatedAt?: string
    }

type MessageWithId = { id: string }

/**
 * Drop a summarized prefix only when the persisted claim resolves exactly
 * against the current transcript. Missing ids, duplicate ids, gaps, reordered
 * rows, legacy timestamp-only summaries, and every non-prefix provenance kind
 * all fail open by returning the original rows.
 */
export function pruneContiguousCompactionPrefix<T extends MessageWithId>(
  messages: readonly T[],
  provenance: ContextCompactionProvenance | null | undefined
): readonly T[] {
  const provenanceRecord = asRecord(provenance)
  if (str(provenanceRecord?.kind) !== 'contiguous_prompt_prefix') return messages

  const rawThroughMessageId = provenanceRecord?.throughMessageId
  const rawCoveredMessageIds = provenanceRecord?.coveredMessageIds
  if (typeof rawThroughMessageId !== 'string' || !rawThroughMessageId.trim()) return messages
  if (!Array.isArray(rawCoveredMessageIds) || rawCoveredMessageIds.length === 0) return messages
  if (rawCoveredMessageIds.some((id) => typeof id !== 'string' || !id.trim())) return messages
  const throughMessageId = rawThroughMessageId
  const coveredMessageIds = rawCoveredMessageIds as string[]
  if (new Set(coveredMessageIds).size !== coveredMessageIds.length) return messages

  // Every claimed id must resolve uniquely in the current transcript. A
  // duplicate anywhere makes the persisted anchor ambiguous, so fail open.
  const messageIdCounts = new Map<string, number>()
  for (const message of messages) {
    messageIdCounts.set(message.id, (messageIdCounts.get(message.id) || 0) + 1)
  }
  if (coveredMessageIds.some((id) => messageIdCounts.get(id) !== 1)) return messages

  const throughIndex = messages.findIndex((message) => message.id === throughMessageId)
  if (throughIndex < 0) return messages
  if (throughIndex + 1 !== coveredMessageIds.length) return messages
  for (let index = 0; index <= throughIndex; index += 1) {
    if (messages[index].id !== coveredMessageIds[index]) return messages
  }
  if (coveredMessageIds[coveredMessageIds.length - 1] !== throughMessageId) return messages

  const rawChainedFrom = provenanceRecord?.chainedFrom
  if (rawChainedFrom !== undefined) {
    const chainedFrom = asRecord(rawChainedFrom)
    const priorThroughMessageId = chainedFrom?.throughMessageId
    const summaryCreatedAt = chainedFrom?.summaryCreatedAt
    if (
      typeof priorThroughMessageId !== 'string' ||
      !priorThroughMessageId.trim() ||
      typeof summaryCreatedAt !== 'string' ||
      !summaryCreatedAt.trim()
    ) {
      return messages
    }
    const priorIndex = coveredMessageIds.indexOf(priorThroughMessageId)
    if (priorIndex < 0 || priorIndex >= coveredMessageIds.length - 1) {
      return messages
    }
  }
  return messages.slice(throughIndex + 1)
}

// ── Host auto-compaction evidence ───────────────────────────────────────────────

export type HostAutoCompactionProvider = 'cursor' | 'kimi' | 'grok'

export type HostAutoCompactionEvidence =
  | { kind: 'generic_run_usage'; percent: number }
  | { kind: 'provider_semantic_occupancy'; percent: number }
  | { kind: 'classified_context_overflow' }
  | { kind: 'prompt_projection_uncovered'; messageIds: string[] }

/**
 * Generic run input/output is processed usage, not proven live occupancy, so
 * it is always advisory. Cursor/Grok may auto-reset only on a provider-semantic
 * occupancy signal or a classified context overflow. Kimi may additionally
 * refresh its non-destructive rolling summary when prompt projection proves
 * that specific transcript rows are uncovered.
 */
export function shouldAutoCompactHostContext(
  provider: HostAutoCompactionProvider,
  evidence: HostAutoCompactionEvidence
): boolean {
  if (evidence.kind === 'generic_run_usage') return false
  if (evidence.kind === 'classified_context_overflow') return true
  if (evidence.kind === 'provider_semantic_occupancy') {
    return Number.isFinite(evidence.percent) && evidence.percent >= CONTEXT_AUTO_COMPACT_PERCENT
  }
  return provider === 'kimi' && evidence.messageIds.some((id) => Boolean(id.trim()))
}

// ── Host-side fallback compaction (Cursor/Kimi) ─────────────────────────────

/**
 * The summarize instruction dispatched as a REAL turn when the host compacts
 * a session for providers with no native `/compact` equivalent. Shares copy
 * with the composer's `/compact` prompt template so both lanes converge on
 * the same summary shape.
 */
export const CONTEXT_COMPACTION_SUMMARY_PROMPT =
  'Create a compact context summary for continuing this chat. Preserve decisions, constraints, open tasks, changed files, risks, and next actions. Do not omit unresolved questions or verification state.'

/** Stored-summary size cap — the block is re-injected into future prompts, so
 * it must stay well under every provider's context-injection budget. */
export const CONTEXT_COMPACTION_SUMMARY_MAX_CHARS = 8_000

/**
 * Build the exact host-authored summarize prompt used by solo and ensemble
 * fallback compaction. Repeated compactions always carry the prior durable
 * summary before newly selected transcript material, so replacement summaries
 * do not silently discard older memory.
 */
export function buildHostCompactionSummaryPrompt(input: {
  previousSummaryText?: string | null
  materialBlock?: string | null
}): string {
  const previousSummary =
    typeof input.previousSummaryText === 'string' ? input.previousSummaryText.trim() : ''
  const previousSummaryBlock = previousSummary
    ? [
        'Previous durable context summary (carry all still-relevant facts forward):',
        previousSummary.slice(0, CONTEXT_COMPACTION_SUMMARY_MAX_CHARS)
      ].join('\n')
    : ''
  const materialBlock =
    typeof input.materialBlock === 'string' && input.materialBlock.trim() ? input.materialBlock : ''
  return [previousSummaryBlock, materialBlock, CONTEXT_COMPACTION_SUMMARY_PROMPT]
    .filter(Boolean)
    .join('\n\n')
}

export type ContextPressureSeverity = 'ok' | 'warn' | 'critical'

export function contextPressureSeverity(percent: number): ContextPressureSeverity {
  if (!Number.isFinite(percent) || percent < CONTEXT_PRESSURE_WARN_PERCENT) return 'ok'
  return percent >= CONTEXT_PRESSURE_CRITICAL_PERCENT ? 'critical' : 'warn'
}

// ── Overflow error classification ────────────────────────────────────────────

/**
 * True when an error's text reads like a context-window overflow ("the error
 * wall"). Patterns are deliberately narrow: generic "too many tokens" wording
 * is EXCLUDED because xAI uses it for TPM quota walls, which are owned by the
 * quota classifier (src/main/ProviderQuotaWallClassifier.ts).
 */
const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
  /prompt is too long/i,
  /context[_ -]?length[_ -]?exceeded/i,
  /maximum context length/i,
  /exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context (?:window|length|limit)/i,
  /input length and `?max_tokens`? exceed context limit/i,
  /context window (?:is )?(?:too small|exceeded|full)/i
]

export function isContextOverflowErrorText(text: string | undefined | null): boolean {
  if (!text) return false
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))
}

// ── Transcript card helpers ──────────────────────────────────────────────────

/** `ChatMessage.metadata.kind` value for the persisted compaction card. */
export const CONTEXT_COMPACTION_MESSAGE_KIND = 'contextCompaction'

/**
 * Deterministic message id for a compaction card — the idempotency mechanism
 * for card appends (renderer replays, orchestrator flushes, bridge snapshots
 * all converge on the same id). `scopeFallback` disambiguates events that
 * arrive without a provider uuid (e.g. `<runId>-failed`).
 */
export function contextCompactionMessageId(
  telemetry: ContextCompactionTelemetry,
  scopeFallback: string
): string {
  return `context-compaction-${telemetry.eventUuid || scopeFallback}`
}

/**
 * Human-readable one-liner for the card's `content` fallback (iOS/system rows)
 * and the durable run-event summary. Mirrors run-complete row voice
 * (src/renderer/src/lib/runCompleteSummary.ts): terse, mid-dot separated.
 */
export function formatContextCompactionSummary(
  signal: ContextCompactionSignal,
  providerLabel?: string
): string {
  const { telemetry } = signal
  if (signal.kind === 'started') return 'Compacting context…'
  if (signal.kind === 'failed') {
    return telemetry.error
      ? `Context compaction failed — ${telemetry.error}`
      : 'Context compaction failed.'
  }
  const parts: string[] = ['Context compacted']
  if (telemetry.preTokens !== undefined && telemetry.postTokens !== undefined) {
    parts.push(
      `${formatContextTokens(telemetry.preTokens)} → ${formatContextTokens(telemetry.postTokens)} tokens`
    )
  } else if (telemetry.preTokens !== undefined) {
    parts.push(`from ${formatContextTokens(telemetry.preTokens)} tokens`)
  }
  if (telemetry.trigger) parts.push(telemetry.trigger === 'auto' ? 'automatic' : 'manual')
  if (providerLabel) parts.push(providerLabel)
  return parts.join(' · ')
}
