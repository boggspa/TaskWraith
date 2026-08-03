import type { HistoryDeletionPreparation } from '../store'
import type { RunEventRecord } from '../store/types'
import type { ProjectReferenceLegacyArtifactRef } from './ProjectReferenceArtifactStore'

export function projectReferenceOwnedArtifactRefsFromRunEvent(
  event: RunEventRecord
): ProjectReferenceLegacyArtifactRef[] {
  if (
    event.kind !== 'reference_context' ||
    event.phase !== 'artifact' ||
    event.source !== 'main' ||
    !event.chatId ||
    !event.runId
  ) {
    return []
  }
  return (event.artifacts || []).flatMap((artifact) =>
    artifact.kind === 'snapshot' &&
    artifact.metadata?.source === 'project_reference_context' &&
    artifact.metadata?.storage === 'main_owned_snapshot'
      ? [
          {
            sha256: artifact.sha256,
            path: artifact.path,
            sizeBytes: artifact.sizeBytes,
            appChatId: event.chatId!,
            runId: event.runId
          }
        ]
      : []
  )
}

export function filterProjectReferenceLegacyArtifactRefsForPendingDeletion(
  references: readonly ProjectReferenceLegacyArtifactRef[],
  pendingDeletion?: Pick<HistoryDeletionPreparation, 'kind' | 'chatIds' | 'runIds'> | null
): ProjectReferenceLegacyArtifactRef[] {
  if (!pendingDeletion) return [...references]
  if (pendingDeletion.kind === 'global') return []
  const deletedChatIds = new Set(pendingDeletion.chatIds)
  const deletedRunIds = new Set(pendingDeletion.runIds)
  return references.filter(
    (reference) => !deletedChatIds.has(reference.appChatId) && !deletedRunIds.has(reference.runId)
  )
}

/**
 * Project-reference ownership is reconstructed from the durable run-event
 * ledger on every startup. Approval-link events can repeat an artifact; the
 * ownership ledger deliberately deduplicates the same chat/run pair.
 */
export function projectReferenceOwnedArtifactRefsFromRunEvents(
  events: readonly RunEventRecord[],
  pendingDeletion?: Pick<HistoryDeletionPreparation, 'kind' | 'chatIds' | 'runIds'> | null
): ProjectReferenceLegacyArtifactRef[] {
  return filterProjectReferenceLegacyArtifactRefsForPendingDeletion(
    events.flatMap(projectReferenceOwnedArtifactRefsFromRunEvent),
    pendingDeletion
  )
}
