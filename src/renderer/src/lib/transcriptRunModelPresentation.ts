import type { ChatMessage, ChatRun } from '../../../main/store/types'
import { effectiveRecordedKimiReasoningEffort } from './taskWraithCloseoutMessage'

/** Project the matched run's actual model into display-only message metadata. */
export function transcriptRunModelPresentation(
  message: ChatMessage,
  run: ChatRun | null | undefined,
  isEnsembleChat: boolean
): ChatMessage {
  const actualModel = run?.actualModel?.trim()
  if (!isEnsembleChat || !run || !actualModel) return message

  const metadata = message.metadata
  const capturedEffort =
    typeof metadata?.ensembleReasoningEffort === 'string'
      ? metadata.ensembleReasoningEffort
      : run.ensembleSeatSnapshot?.reasoningEffort
  const provider = run.providerReroute?.to || run.provider || run.ensembleSeatSnapshot?.provider
  const effort = provider
    ? effectiveRecordedKimiReasoningEffort(provider, actualModel, capturedEffort)
    : capturedEffort
  const projectEffort = effort !== undefined && effort !== metadata?.ensembleReasoningEffort
  if (metadata?.ensembleModel === actualModel && !projectEffort) return message

  // A configured snapshot may predate model-route migration. The provider's
  // actual model wins for this run, without changing that immutable snapshot.
  return {
    ...message,
    metadata: {
      ...metadata,
      ensembleModel: actualModel,
      ...(projectEffort ? { ensembleReasoningEffort: effort } : {})
    }
  }
}
