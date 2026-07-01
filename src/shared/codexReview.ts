/**
 * Codex native-review telemetry.
 *
 * Codex has a native code-review sub-run (`startAgentReview` → `review/start`
 * RPC). Unlike Claude's `Workflow` tool it emits NO structured findings and NO
 * lifecycle frames beyond a terminal `review/completed` (which the main process
 * handles identically to `turn/completed`). So the honest surface is a
 * lightweight RUN-STATUS card — target, status, duration, tokens, model — and
 * NOT a findings/severity dashboard (that would require parsing freeform prose =
 * fabrication). The review's findings already appear in the transcript as normal
 * assistant text; this card is just status chrome anchored to the review run.
 *
 * Because Codex emits no natural anchor tool-call for a review, the main process
 * synthesizes a single `codex_review` tool activity at review start and attaches
 * this telemetry to it (keyed by that activity id), mirroring how the Claude
 * workflow card attaches to the `Workflow` tool_use.
 *
 * Pure and node-builtin-free: imported by main (ingestion), renderer (adapter +
 * card), and the shared `ToolActivity` type. Kept dependency-free (provider is a
 * loose string) to avoid a cycle with store/types.
 */

export type CodexReviewStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'unknown'

/** The honest slice of a Codex review run we can surface. Attached to the
 * synthesized `codex_review` tool activity as `ToolActivity.reviewSummary`. */
export interface CodexReviewTelemetry {
  /** Producing provider — 'codex' today (loose string to keep this module pure). */
  provider?: string
  status?: CodexReviewStatus
  /** Human label for what was reviewed, e.g. "uncommitted changes". */
  target?: string
  model?: string
  durationMs?: number
  /** Whole-review token usage (real; from the review turn's usage). */
  totalTokens?: number
  error?: string
}

/** Tool name of the synthesized review anchor activity. */
export const CODEX_REVIEW_TOOL_NAME = 'codex_review'

const TERMINAL_REVIEW_STATUSES = new Set<CodexReviewStatus>(['completed', 'failed', 'stopped'])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

/** True when a tool name is the synthesized Codex review anchor. */
export function isCodexReviewToolName(name: string | undefined | null): boolean {
  return str(name).toLowerCase() === CODEX_REVIEW_TOOL_NAME
}

/** Map a review/turn status string to a normalized review status. */
export function normalizeCodexReviewStatus(raw: unknown): CodexReviewStatus {
  const value = str(raw).toLowerCase()
  if (!value) return 'unknown'
  if (value === 'completed' || value === 'complete' || value === 'success' || value === 'done')
    return 'completed'
  if (value === 'failed' || value === 'failure' || value === 'error') return 'failed'
  if (
    value === 'stopped' ||
    value === 'cancelled' ||
    value === 'canceled' ||
    value === 'aborted' ||
    value === 'interrupted'
  )
    return 'stopped'
  if (value === 'running' || value === 'in_progress' || value === 'active' || value === 'started')
    return 'running'
  return 'unknown'
}

/**
 * Human label for a review target. Codex sends `{ type: 'uncommittedChanges' }`
 * today; tolerate a bare string or other shapes defensively.
 */
export function codexReviewTargetLabel(target: unknown): string | undefined {
  if (typeof target === 'string' && target.trim()) return target.trim()
  const record = asRecord(target)
  if (!record) return undefined
  const type = str(record.type)
  if (!type) return undefined
  switch (type) {
    case 'uncommittedChanges':
      return 'uncommitted changes'
    case 'stagedChanges':
      return 'staged changes'
    case 'commit':
      return str(record.sha) ? `commit ${str(record.sha).slice(0, 8)}` : 'a commit'
    case 'diff':
      return 'a diff'
    default:
      // Convert camelCase/snake_case to spaced words as a readable fallback.
      return type
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .toLowerCase()
  }
}

/** Initial telemetry for a review at start (from the `review/start` request). */
export function codexReviewStartTelemetry(input: {
  target?: unknown
  model?: unknown
}): CodexReviewTelemetry {
  const telemetry: CodexReviewTelemetry = { provider: 'codex', status: 'running' }
  const target = codexReviewTargetLabel(input.target)
  if (target) telemetry.target = target
  const model = str(input.model)
  if (model) telemetry.model = model
  return telemetry
}

/** Terminal telemetry for a review on `review/completed`. */
export function codexReviewCompletionTelemetry(input: {
  status?: unknown
  durationMs?: unknown
  totalTokens?: unknown
  error?: unknown
}): CodexReviewTelemetry {
  const telemetry: CodexReviewTelemetry = {
    provider: 'codex',
    status: input.error ? 'failed' : normalizeCodexReviewStatus(input.status) || 'completed'
  }
  if (telemetry.status === 'unknown') telemetry.status = input.error ? 'failed' : 'completed'
  const durationMs = firstNumber(input.durationMs)
  if (durationMs !== undefined) telemetry.durationMs = durationMs
  const totalTokens = firstNumber(input.totalTokens)
  if (totalTokens !== undefined) telemetry.totalTokens = totalTokens
  const error = str(input.error)
  if (error) telemetry.error = error
  return telemetry
}

/**
 * Merge a telemetry patch onto accumulated review telemetry. Only DEFINED
 * (non-empty) fields overwrite, and a terminal status is never downgraded back
 * to `running` by a late/out-of-order frame.
 */
export function mergeCodexReviewTelemetry(
  previous: CodexReviewTelemetry | undefined,
  next: Partial<CodexReviewTelemetry> | null | undefined
): CodexReviewTelemetry {
  const merged: CodexReviewTelemetry = { ...(previous || {}) }
  if (!next) return merged
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined || value === null || value === '') continue
    ;(merged as Record<string, unknown>)[key] = value
  }
  if (
    previous?.status &&
    TERMINAL_REVIEW_STATUSES.has(previous.status) &&
    merged.status === 'running'
  ) {
    merged.status = previous.status
  }
  return merged
}
