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
 * Host auto-compaction trigger for providers with no native lever
 * (Cursor/Kimi). Sits between warn and critical: past the warn band (so we
 * don't compact eagerly and grind away detail) but with ~10% of the window
 * still free — the summarize turn itself needs headroom to run.
 */
export const CONTEXT_AUTO_COMPACT_PERCENT = 90

/** One host auto-compaction attempt per chat per window — breaks retry loops
 * when the summarize turn itself keeps failing. */
export const CONTEXT_AUTO_COMPACT_COOLDOWN_MS = 10 * 60 * 1000

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
