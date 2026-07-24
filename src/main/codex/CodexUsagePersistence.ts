import { buildEnsembleUsageRecord } from '../ensembleUsageRecord'
import { extractProviderUsage, mergeProviderUsage } from '../ProviderRunStats'
import type { ChatRecord, UsageRecord } from '../store/types'

const GLOBAL_USAGE_WORKSPACE_ID = '__taskwraith_global_chats__'

/**
 * Persist Codex usage in Electron main at the provider-owned terminal event.
 * For renderer-visible solo turns, the marker keeps the renderer as an
 * idempotent fallback: it skips after a successful main-side append, but still
 * records if the durable append fails.
 */
export function recordCodexUsageOnCompletion(input: {
  chat: ChatRecord | null | undefined
  runId: string | null | undefined
  model: string
  stats: Record<string, unknown>
  fallbackDurationMs: number
  promptText?: string
  responseText?: string
  recordUsage: (usage: Omit<UsageRecord, 'id' | 'timestamp'>) => void
}): Record<string, unknown> {
  if (!input.chat || !input.runId) return input.stats
  const entry = buildEnsembleUsageRecord({
    provider: 'codex',
    model: input.model,
    workspaceId:
      input.chat.scope === 'global' || !input.chat.workspaceId
        ? GLOBAL_USAGE_WORKSPACE_ID
        : input.chat.workspaceId,
    chatId: input.chat.appChatId,
    runId: input.runId,
    stats: input.stats,
    fallbackDurationMs: input.fallbackDurationMs
  })
  if (!entry) return input.stats
  try {
    input.recordUsage({
      ...entry,
      ...(input.promptText !== undefined ? { promptText: input.promptText } : {}),
      ...(input.responseText !== undefined ? { responseText: input.responseText } : {})
    })
    return { ...input.stats, _taskwraith_usage_recorded: true }
  } catch {
    return input.stats
  }
}

/**
 * Fold complete, sanitized `codex exec --json` frames into one monotonic usage
 * snapshot. Malformed/non-usage lines remain publishable raw output but cannot
 * corrupt accounting.
 */
export function mergeCodexExecUsageJsonLines(
  previous: Record<string, unknown> | undefined,
  text: string
): Record<string, unknown> | undefined {
  let merged = previous
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    try {
      const frame = JSON.parse(line)
      merged = mergeProviderUsage('codex', merged, extractProviderUsage('codex', frame))
    } catch {
      // Raw provider output still reaches the transcript; accounting ignores
      // frames that are not complete JSON objects.
    }
  }
  return merged
}

export function codexUsageResponseText(chunks: Iterable<string>): string | undefined {
  const response = [...chunks].join('')
  return response || undefined
}
