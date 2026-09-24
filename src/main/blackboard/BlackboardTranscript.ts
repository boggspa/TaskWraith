import { BLACKBOARD_CHANGE_KIND, type BlackboardChangePayload } from '../../shared/blackboardChange'
import { resolveHealthEntryPresentation } from '../../shared/ollamaBrandTable'
import { providerLabel } from '../ProviderAdapters'
import type { ScoutBriefRecord } from '../ScoutBrief'
import type { BlackboardEntry, ChatMessage, EnsembleParticipant } from '../store/types'

export type BlackboardTranscriptParticipant = Pick<EnsembleParticipant, 'id' | 'provider' | 'model'>

export interface BlackboardTranscriptEvent {
  content: string
  metadata?: NonNullable<ChatMessage['metadata']>
}

type BlackboardChangeMutation<T extends BlackboardChangePayload = BlackboardChangePayload> =
  T extends BlackboardChangePayload
    ? Omit<T, 'provider' | 'displayProviderLabel' | 'displayHueClass' | 'changedAt'>
    : never

function mutationMetadata(
  participant: BlackboardTranscriptParticipant | undefined,
  mutation: BlackboardChangeMutation,
  changedAt: string
): NonNullable<ChatMessage['metadata']> | undefined {
  if (!participant) return undefined
  const presentation = resolveHealthEntryPresentation(
    participant.provider,
    participant.model,
    providerLabel(participant.provider)
  )
  const blackboardChange: BlackboardChangePayload = {
    ...mutation,
    provider: participant.provider,
    displayProviderLabel: presentation.displayProviderLabel,
    displayHueClass: presentation.displayHueClass,
    changedAt
  } as BlackboardChangePayload
  return {
    kind: BLACKBOARD_CHANGE_KIND,
    provider: participant.provider,
    ensembleParticipantId: participant.id,
    displayProviderLabel: presentation.displayProviderLabel,
    displayHueClass: presentation.displayHueClass,
    blackboardChange
  }
}

/** Build the durable status row for a successful `blackboard_post`. */
export function buildBlackboardPostTranscriptEvent(
  entry: BlackboardEntry,
  participant: BlackboardTranscriptParticipant | undefined
): BlackboardTranscriptEvent {
  if (entry.poll) {
    const content = `Blackboard poll opened: ${entry.key} (${entry.poll.options.length} choices).`
    return {
      content,
      metadata: mutationMetadata(
        participant,
        {
          action: 'pollOpened',
          key: entry.key,
          category: entry.category,
          scope: entry.scope,
          optionCount: entry.poll.options.length
        },
        entry.createdAt
      )
    }
  }

  const content = `Blackboard updated: ${entry.category} / ${entry.key}.`
  return {
    content,
    metadata: mutationMetadata(
      participant,
      {
        action: 'updated',
        key: entry.key,
        category: entry.category,
        scope: entry.scope
      },
      entry.createdAt
    )
  }
}

/** Build the durable status row for a successful `blackboard_delete`. */
export function buildBlackboardCleanedTranscriptEvent(
  removedCount: number,
  changedAt: string,
  participant: BlackboardTranscriptParticipant | undefined
): BlackboardTranscriptEvent {
  const content = `Blackboard cleaned: removed ${removedCount} ${
    removedCount === 1 ? 'entry' : 'entries'
  }.`
  return {
    content,
    metadata: mutationMetadata(participant, { action: 'cleaned', removedCount }, changedAt)
  }
}

function scoutBriefCaveat(confidence: ScoutBriefRecord['confidence']): string {
  if (confidence === 'low') return ' · needs verification'
  if (confidence === 'medium') return ' · tentative'
  return ''
}

/** Build the durable Blackboard-style handoff row for `scout_brief`. */
export function buildScoutBriefSharedTranscriptEvent(
  brief: ScoutBriefRecord,
  participant: BlackboardTranscriptParticipant | undefined
): BlackboardTranscriptEvent {
  const metadata = mutationMetadata(
    participant,
    {
      action: 'scoutBriefShared',
      role: brief.participantRole,
      ...(brief.confidence === 'high' ? {} : { confidence: brief.confidence })
    },
    brief.emittedAt
  )
  const displayProviderLabel =
    metadata?.blackboardChange?.displayProviderLabel || providerLabel(brief.provider)
  return {
    content: `Scout brief shared · ${brief.participantRole} (${displayProviderLabel}) · Blackboard + next writer${scoutBriefCaveat(brief.confidence)}.`,
    metadata
  }
}
