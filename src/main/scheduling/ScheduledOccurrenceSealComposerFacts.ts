import type { ComposerRunPayload } from '../services/ComposerService'
import type { ChatRecord } from '../store/types'
import type { ScheduledSealComposedFacts } from './ScheduledOccurrenceSealService'

/**
 * Maps the exact main-composed payload that will enter the provider dispatcher
 * into the seal service's explicit evidence facts. This deliberately has no
 * fallback to task fields: any composer/dispatch drift is visible to the seal
 * service's posture tripwire rather than silently sealed as a different run.
 */
export function scheduledSealComposedFacts(
  composed: ComposerRunPayload,
  chat: ChatRecord | null
): ScheduledSealComposedFacts {
  return {
    provider: composed.provider,
    model: typeof composed.model === 'string' && composed.model ? composed.model : 'default',
    prompt: composed.prompt,
    finalPrompt: composed.composer.finalPrompt,
    runtimePreambleVersion: metadataString(chat, 'taskWraithRuntimePreambleVersion'),
    approvalMode: composed.approvalMode ?? composed.composer.approvalMode,
    workflowMode: composed.workflowMode === 'plan' ? 'plan' : 'normal',
    effectivePermissions: composed.effectivePermissions ?? null,
    providerSessionId: composed.providerSessionId ?? null,
    reasoningEffort: composed.reasoningEffort ?? null,
    serviceTier: composed.serviceTier ?? null,
    claudeReasoningEffort: composed.claudeReasoningEffort ?? null,
    claudeFastMode: composed.claudeFastMode ?? null,
    cursorReasoningEffort: composed.reasoningEffort ?? null,
    cursorFastMode: composed.serviceTier === 'fast',
    taskWraithMcpAdvertised: composed.taskWraithMcpAdvertised === true,
    taskWraithMcpProfileId: composed.taskWraithMcpProfileId ?? null,
    runtimeProfileId: composed.runtimeProfileId ?? null,
    imageCount: composed.imagePaths?.length ?? 0
  }
}

function metadataString(chat: ChatRecord | null, key: string): string | null {
  const value = (chat?.providerMetadata as Record<string, unknown> | undefined)?.[key]
  return typeof value === 'string' && value ? value : null
}
