import type { EnsembleParticipant } from '../store/types'
import {
  resolveEnsembleGroupMentionParticipantIds,
  type EnsembleGroupMentionAuthority
} from '../../shared/ensembleGroupMention'
import {
  findAllMentions,
  isGroupMention,
  isParticipantMention,
  type GroupMentionMatch,
  type MentionMatch,
  type ParticipantMentionMatch
} from './EnsembleMentionAlias'

export interface EnsembleUserFanoutAmbiguity {
  text: string
  participants: EnsembleParticipant[]
}

export interface EnsembleUserFanoutTargets {
  /** Unique, current, enabled targets in prompt order. */
  targets: EnsembleParticipant[]
  /** Visible participant tags that could not be narrowed to one current seat. */
  ambiguities: EnsembleUserFanoutAmbiguity[]
  /** True when the prompt contains a participant or roster-group routing signal. */
  hasParticipantMention: boolean
}

function candidatesForMention(match: ParticipantMentionMatch): EnsembleParticipant[] {
  return [match.participant, ...(match.ambiguousAmong || [])]
}

type UserFanoutMentionMatch = ParticipantMentionMatch | GroupMentionMatch

function isUserFanoutMention(match: MentionMatch): match is UserFanoutMentionMatch {
  return isParticipantMention(match) || isGroupMention(match)
}

interface StructuredParticipantMention {
  atIndex: number
  participantId: string
  labelStart: number
  labelEndExclusive: number
}

function structuredParticipantMentions(text: string): StructuredParticipantMention[] {
  return Array.from(text.matchAll(/\[[^\]]*@[^\]]+\]\(ensemble-dm:\/\/([^)\s]+)\)/g), (match) => {
    const labelStart = match.index || 0
    return {
      atIndex: labelStart + match[0].indexOf('@'),
      participantId: match[1],
      labelStart,
      labelEndExclusive: labelStart + match[0].indexOf('](')
    }
  }).filter((match) => Boolean(match.participantId))
}

/**
 * Resolve the user-authored participant tags that may open an additive
 * mid-round User Fan-Out wave.
 *
 * The optional exact target is the MAIN-validated picker/structured identity
 * persisted with a queued prompt. It may disambiguate the one visible alias
 * that actually contains that participant, but it never adds a seat that the
 * prompt did not tag. Direct participant tags ignore stage and permission
 * preset; roster-group tags use the shared stage/authority membership table.
 * Arbitrary display-role text never grants Boss or Captain membership.
 */
export function resolveEnsembleUserFanoutTargets(input: {
  text: string
  participants: EnsembleParticipant[]
  exactTargetParticipantId?: string
  authority?: EnsembleGroupMentionAuthority
}): EnsembleUserFanoutTargets {
  const enabledParticipants = input.participants.filter(
    (participant) => participant.enabled !== false
  )
  const currentById = new Map(
    enabledParticipants.map((participant) => [participant.id, participant] as const)
  )
  const exactTargetId = input.exactTargetParticipantId?.trim()
  const structuredMentions = structuredParticipantMentions(input.text)
  const matches = findAllMentions(input.text, enabledParticipants)
    .filter(isUserFanoutMention)
    .filter(
      (match) =>
        !structuredMentions.some(
          (structured) =>
            match.atIndex >= structured.labelStart && match.atIndex < structured.labelEndExclusive
        )
    )
  const targets: EnsembleParticipant[] = []
  const ambiguities: EnsembleUserFanoutAmbiguity[] = []
  const seenTargetIds = new Set<string>()
  const rosterOrderedParticipants = [...enabledParticipants].sort(
    (left, right) => left.order - right.order
  )

  const addTarget = (participant: EnsembleParticipant): void => {
    if (seenTargetIds.has(participant.id)) return
    seenTargetIds.add(participant.id)
    targets.push(participant)
  }

  const routingSignals = [
    ...matches.map((match) => ({ kind: 'alias' as const, atIndex: match.atIndex, match })),
    ...structuredMentions.map((mention) => ({
      kind: 'structured' as const,
      atIndex: mention.atIndex,
      mention
    }))
  ].sort((left, right) => left.atIndex - right.atIndex)

  for (const signal of routingSignals) {
    if (signal.kind === 'structured') {
      const participant = currentById.get(signal.mention.participantId)
      if (participant) addTarget(participant)
      continue
    }
    const match = signal.match
    if (isGroupMention(match)) {
      const memberIds = resolveEnsembleGroupMentionParticipantIds({
        group: match.group,
        participants: rosterOrderedParticipants,
        authority: input.authority
      })
      for (const participant of rosterOrderedParticipants) {
        if (memberIds.has(participant.id)) {
          addTarget(participant)
        }
      }
      continue
    }
    const candidates = candidatesForMention(match).filter(
      (participant) => currentById.get(participant.id) === participant
    )
    if (candidates.length === 0) continue
    if (candidates.length === 1) {
      addTarget(candidates[0])
      continue
    }
    const exact = exactTargetId
      ? candidates.find((participant) => participant.id === exactTargetId)
      : undefined
    if (exact) {
      addTarget(exact)
      continue
    }
    ambiguities.push({ text: match.text, participants: candidates })
  }

  return {
    targets,
    ambiguities,
    hasParticipantMention: routingSignals.length > 0
  }
}
