import type { ContinuationDraftProposal } from '../../../main/store/types'

/** Legacy values remain decodeable in local feedback logs. New suggestions use only semantic-continuation. */
export type ComposerSuggestionTrigger =
  | 'semantic-continuation'
  | 'picker-dismissed'
  | 'task-continuation'
  | 'lane-failed'
  | 'uncommitted-changes'

export interface ComposerSuggestion {
  id: string
  trigger: ComposerSuggestionTrigger
  text: string
  explanation?: string
  targetParticipantId?: string
  targetMentionText?: string
  evidenceIds?: string[]
}

export interface ComposerSuggestionCandidate {
  suggestion: ComposerSuggestion
  baselineScore: number
  hard: boolean
}

/** Retained for the failed-lane status extractor; no longer an AutoDraft input. */
export interface ComposerSuggestionLane {
  label: string
  id: string
  provider: string
  kind: 'failed' | 'unreachable'
}

/** Retained only for compatibility with old persisted/local test shapes. */
export interface ComposerSuggestionModel {
  label: string
  key: string
}

export interface ComposerSuggestionContext {
  draft: string
  busy: boolean
  proposals: readonly ContinuationDraftProposal[]
  dismissedIds: ReadonlySet<string>
}

export function deriveComposerSuggestion(
  context: ComposerSuggestionContext
): ComposerSuggestion | null {
  return deriveComposerSuggestionCandidates(context)[0]?.suggestion ?? null
}

/**
 * Generated, main-validated proposals are the only eligible candidates. There
 * is deliberately no picker/Git/goal/failure template fallback.
 */
export function deriveComposerSuggestionCandidates(
  context: ComposerSuggestionContext
): ComposerSuggestionCandidate[] {
  if (context.draft.length > 0 || context.busy) return []
  return context.proposals
    .filter((proposal) => !context.dismissedIds.has(proposal.id))
    .map((proposal) => ({
      suggestion: {
        id: proposal.id,
        trigger: 'semantic-continuation',
        text: proposal.text,
        explanation: proposal.explanation,
        ...(proposal.target
          ? {
              targetParticipantId: proposal.target.participantId,
              targetMentionText: proposal.target.mentionText
            }
          : {}),
        evidenceIds: proposal.evidenceIds
      },
      baselineScore: Math.round(proposal.qualityScore * 100),
      hard: false
    }))
}
