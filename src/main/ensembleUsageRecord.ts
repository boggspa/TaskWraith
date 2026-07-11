/**
 * 1.0.7 — ensemble participant usage extraction.
 *
 * Ensemble participant runs complete inside EnsembleOrchestrator (via the
 * provider 'result' event → finalizeRun), NOT through the renderer's
 * `handleProviderExit` path that records solo-run usage. So ensemble runs were
 * missing from usage.json entirely — and therefore from the welcome wall-clock,
 * the TaskWraith/Workspace/External activity heatmaps, and the Providers-tab token
 * totals. This pure helper turns a finished participant run's `stats` into the
 * `recordUsage` payload the orchestrator persists once per run.
 *
 * Kept pure (no orchestrator/Electron deps) so the token/duration extraction is
 * exhaustively unit-testable. Field names mirror the canonical snake_case shape
 * `normalizeProviderUsage` emits (input_tokens / output_tokens / total_tokens /
 * duration_ms), which is what EnsembleOrchestrator already reads elsewhere.
 */
import type { ProviderId, UsageRecord } from './store/types'
import {
  usageCacheCreationInputTokens,
  usageCacheReadInputTokens,
  usageInputIncludesCache
} from '../shared/usageAccounting'

/** Read the first finite, positive numeric value among the candidate keys. */
function readCount(stats: Record<string, unknown> | undefined, keys: string[]): number {
  if (!stats) return 0
  for (const key of keys) {
    const value = Number(stats[key])
    if (Number.isFinite(value) && value > 0) return Math.trunc(value)
  }
  return 0
}

export interface EnsembleUsageInput {
  provider: ProviderId
  model: string
  workspaceId: string
  chatId: string
  runId: string
  stats: Record<string, unknown> | undefined
  /** Wall-clock fallback when stats carry no duration (start→end ms). */
  fallbackDurationMs?: number
}

/**
 * Build the `recordUsage` payload for a finished ensemble participant run, or
 * `null` when it should NOT be recorded:
 *   - stats already recorded upstream (`_taskwraith_usage_recorded`) — avoids
 *     double-counting if a provider (e.g. Gemini) recorded main-side, and
 *   - a run with no tokens AND no duration (nothing meaningful to log — a
 *     skipped/unreachable participant).
 */
export function buildEnsembleUsageRecord(
  input: EnsembleUsageInput
): Omit<UsageRecord, 'id' | 'timestamp'> | null {
  const stats = input.stats
  if (stats && stats['_taskwraith_usage_recorded'] === true) return null

  const reportedInputTokens = readCount(stats, ['input_tokens', 'inputTokens'])
  const cacheReadInputTokens = usageCacheReadInputTokens(stats)
  const cacheCreationInputTokens = usageCacheCreationInputTokens(stats)
  const inputIncludesCache = usageInputIncludesCache(stats)
  const inputTokens = inputIncludesCache
    ? Math.max(0, reportedInputTokens - cacheReadInputTokens - cacheCreationInputTokens)
    : reportedInputTokens
  const outputTokens = readCount(stats, ['output_tokens', 'outputTokens'])
  const inclusiveInputTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens
  const totalTokens =
    readCount(stats, ['total_tokens', 'totalTokens']) || inclusiveInputTokens + outputTokens
  const durationMs =
    readCount(stats, ['duration_ms', 'durationMs']) || Math.max(0, input.fallbackDurationMs || 0)

  // Nothing worth recording — a participant that never really ran.
  if (totalTokens <= 0 && durationMs <= 0) return null

  const inputTokenLimit = readCount(stats, ['input_tokens_limit', 'inputTokenLimit'])
  const outputTokenLimit = readCount(stats, ['output_tokens_limit', 'outputTokenLimit'])
  const totalTokenLimit = readCount(stats, ['total_tokens_limit', 'totalTokenLimit'])

  return {
    provider: input.provider,
    workspaceId: input.workspaceId,
    chatId: input.chatId,
    runId: input.runId,
    usageKind: 'run',
    model: input.model || 'unknown',
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadInputTokens > 0 ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
    ...(inputTokenLimit > 0 ? { inputTokenLimit } : {}),
    ...(outputTokenLimit > 0 ? { outputTokenLimit } : {}),
    ...(totalTokenLimit > 0 ? { totalTokenLimit } : {}),
    durationMs
  }
}
