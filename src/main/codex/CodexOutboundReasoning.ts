import {
  codexModelContextConfig,
  codexWireReasoningEffort,
  type CodexWireReasoningEffort
} from '../providers/StaticProviderModels'
import { codexReasoningSummaryModeForEffort } from './CodexEventFormatting'

export interface CodexOutboundReasoning {
  effort: CodexWireReasoningEffort
  summary: ReturnType<typeof codexReasoningSummaryModeForEffort>
  turnParams: {
    effort: CodexWireReasoningEffort
    summary?: NonNullable<ReturnType<typeof codexReasoningSummaryModeForEffort>>
  }
  threadConfig: Record<string, string | number>
  execConfigArgs: string[]
}

export interface CodexThreadResumeRequest {
  threadId: string
  config: Record<string, string | number>
  persistExtendedHistory: true
}

export interface PersistedCodexModelSelection {
  selectedModelType?: unknown
  customModel?: unknown
  lastRunActualModel?: unknown
  lastRunRequestedModel?: unknown
  chatLastActualModel?: unknown
  chatRequestedModel?: unknown
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim() || undefined
}

/**
 * Recover the concrete model behind persisted solo-composer state.
 *
 * `selectedModelType: "custom"` is a picker sentinel, not a runnable model id.
 * Passing it through Codex normalization silently selects GPT-5.5, so a custom
 * chat must prefer its separately persisted `customModel` and otherwise fall
 * back to the last concrete run identity.
 */
export function resolvePersistedCodexModelSelection(
  selection: PersistedCodexModelSelection
): string | undefined {
  const selectedModelType = optionalTrimmedString(selection.selectedModelType)
  const fallbackModel =
    optionalTrimmedString(selection.lastRunActualModel) ||
    optionalTrimmedString(selection.lastRunRequestedModel) ||
    optionalTrimmedString(selection.chatLastActualModel) ||
    optionalTrimmedString(selection.chatRequestedModel)

  if (selectedModelType === 'custom') {
    return optionalTrimmedString(selection.customModel) || fallbackModel
  }
  if (selectedModelType && selectedModelType !== 'default') return selectedModelType
  return fallbackModel
}

/**
 * Resolve every Codex outbound surface from one concrete effort.
 *
 * App-server thread creation/resume and the turn itself both receive the
 * override so a user-global `model_reasoning_effort` cannot leak into the
 * run. The exec fallback uses the equivalent CLI config override. Keeping the
 * three forms together makes it difficult for a future adapter path to restore
 * the omission bug on only one transport.
 */
export function resolveCodexOutboundReasoning(
  model: string | null | undefined,
  requestedEffort: string | null | undefined
): CodexOutboundReasoning {
  const effort = codexWireReasoningEffort(requestedEffort, model)
  const summary = codexReasoningSummaryModeForEffort(effort)
  return {
    effort,
    summary,
    turnParams: {
      effort,
      ...(summary ? { summary } : {})
    },
    threadConfig: {
      ...(codexModelContextConfig(model) || {}),
      model_reasoning_effort: effort
    },
    execConfigArgs: ['-c', `model_reasoning_effort="${effort}"`]
  }
}

/** Cold resume boundary shared by normal turns and manual compaction. */
export function buildCodexThreadResumeRequest(
  threadId: string,
  reasoning: CodexOutboundReasoning
): CodexThreadResumeRequest {
  return {
    threadId,
    config: reasoning.threadConfig,
    persistExtendedHistory: true
  }
}

/** Attach the mandatory effort/summary fields to every turn/start variant. */
export function buildCodexTurnStartRequest<T extends Record<string, unknown>>(
  base: T,
  reasoning: CodexOutboundReasoning
): T & CodexOutboundReasoning['turnParams'] {
  return { ...base, ...reasoning.turnParams }
}
