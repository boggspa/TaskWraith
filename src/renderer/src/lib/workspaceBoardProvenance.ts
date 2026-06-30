import type { WorkspaceBoardProvenance } from '../../../main/store/types'

export function createWorkspaceBoardProvenance(
  sourceKind: WorkspaceBoardProvenance['sourceKind'],
  input: Omit<WorkspaceBoardProvenance, 'actor' | 'sourceKind' | 'at' | 'trust'> &
    Partial<Pick<WorkspaceBoardProvenance, 'actor' | 'at' | 'trust'>> = {}
): WorkspaceBoardProvenance {
  return {
    actor: input.actor || 'user',
    sourceKind,
    at: input.at || new Date().toISOString(),
    trust: input.trust || 'user-confirmed',
    sourceId: input.sourceId,
    sourceTitle: input.sourceTitle,
    provider: input.provider,
    runId: input.runId,
    note: input.note
  }
}