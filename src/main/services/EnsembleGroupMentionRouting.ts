import type { EnsembleParticipant } from '../store/types'
import {
  findAllMentions,
  isGroupMention,
  isParticipantMention,
  resolvePhraseToParticipant,
  type GroupMentionMatch,
  type ParticipantMentionMatch
} from './EnsembleMentionAlias'
import {
  ensembleGroupMentionMatchesStage,
  resolveEnsembleGroupMentionToken,
  type EnsembleGroupMentionId
} from '../../shared/ensembleGroupMention'

export type AssistantGroupMentionRoutingNoticeReason =
  | 'authority_required'
  | 'outside_dm_scope'
  | 'no_eligible_targets'

export interface AssistantGroupMentionRoutingNotice {
  group: EnsembleGroupMentionId
  token: string
  reason: AssistantGroupMentionRoutingNoticeReason
}

export interface AssistantMentionRoutingPlan {
  /** Direct participant matches plus permitted group expansions, in source order. */
  participantMatches: ParticipantMentionMatch[]
  /** Group tokens deliberately left presentation-only at this boundary. */
  groupNotices: AssistantGroupMentionRoutingNotice[]
}

export interface BackgroundMentionRoutingPlan {
  /** Enabled background seats explicitly selected by a direct or group token. */
  participantIds: Set<string>
  /** Direct participant aliases that still require user disambiguation. */
  ambiguities: ParticipantMentionMatch[]
}

function orderedGroupParticipants(input: {
  group: EnsembleGroupMentionId
  participants: readonly EnsembleParticipant[]
  excludedParticipantIds: ReadonlySet<string>
}): EnsembleParticipant[] {
  return input.participants
    .filter(
      (participant) =>
        participant.enabled !== false &&
        !input.excludedParticipantIds.has(participant.id) &&
        ensembleGroupMentionMatchesStage(input.group, participant.stageRole)
    )
    .slice()
    .sort((left, right) => left.order - right.order)
}

function expandedParticipantMatch(
  groupMatch: GroupMentionMatch,
  participant: EnsembleParticipant
): ParticipantMentionMatch {
  return {
    kind: 'participant',
    participant,
    atIndex: groupMatch.atIndex,
    consumedLength: groupMatch.consumedLength,
    text: groupMatch.text
  }
}

/**
 * Convert assistant-authored group addresses into the same participant-match
 * shape used by the existing between-turn mention promoter. The caller owns
 * the Boss/Captain authority decision and supplies broad-discovery exclusions
 * (normally every configured authority seat plus the speaker).
 *
 * A user-targeted DM is never widened. Direct one-seat peer mentions retain
 * their existing behavior regardless of group authority.
 */
export function resolveAssistantMentionRoutingPlan(input: {
  text: string
  participants: readonly EnsembleParticipant[]
  callerParticipantId: string
  canRouteGroups: boolean
  dmTargetParticipantId?: string
  excludedGroupParticipantIds?: ReadonlySet<string>
}): AssistantMentionRoutingPlan {
  const enabledParticipants = input.participants.filter(
    (participant) => participant.enabled !== false
  )
  const matches = findAllMentions(
    input.text,
    enabledParticipants,
    new Set([input.callerParticipantId])
  )
  const participantMatches: ParticipantMentionMatch[] = []
  const groupNotices: AssistantGroupMentionRoutingNotice[] = []
  const noticeKeys = new Set<string>()
  const groupExclusions = new Set(input.excludedGroupParticipantIds || [])
  groupExclusions.add(input.callerParticipantId)

  const addNotice = (
    match: GroupMentionMatch,
    reason: AssistantGroupMentionRoutingNoticeReason
  ): void => {
    const key = `${match.group}:${reason}`
    if (noticeKeys.has(key)) return
    noticeKeys.add(key)
    groupNotices.push({ group: match.group, token: `@${match.text}`, reason })
  }

  for (const match of matches) {
    if (isParticipantMention(match)) {
      participantMatches.push(match)
      continue
    }
    if (!isGroupMention(match)) continue
    if (input.dmTargetParticipantId) {
      addNotice(match, 'outside_dm_scope')
      continue
    }
    if (!input.canRouteGroups) {
      addNotice(match, 'authority_required')
      continue
    }
    const targets = orderedGroupParticipants({
      group: match.group,
      participants: enabledParticipants,
      excludedParticipantIds: groupExclusions
    })
    if (targets.length === 0) {
      addNotice(match, 'no_eligible_targets')
      continue
    }
    for (const participant of targets) {
      participantMatches.push(expandedParticipantMatch(match, participant))
    }
  }

  return { participantMatches, groupNotices }
}

/**
 * Resolve explicit `ensemble_send.to` selectors. Group tokens expand under
 * the tool's existing any-active-seat communication policy; the message body
 * is never scanned to invent recipients. Invalid selectors remain ignored as
 * before, and callers reject the request only when nothing resolves.
 */
export function resolveEnsembleCommunicationTargets(input: {
  selectors: readonly string[]
  participants: readonly EnsembleParticipant[]
  senderParticipantId: string
}): EnsembleParticipant[] {
  const enabledParticipants = input.participants.filter(
    (participant) => participant.enabled !== false
  )
  const excluded = new Set([input.senderParticipantId])
  const recipients: EnsembleParticipant[] = []
  const seen = new Set<string>()
  const add = (participant: EnsembleParticipant): void => {
    if (seen.has(participant.id)) return
    seen.add(participant.id)
    recipients.push(participant)
  }

  for (const selector of input.selectors) {
    const group = resolveEnsembleGroupMentionToken(selector)
    if (group) {
      for (const participant of orderedGroupParticipants({
        group: group.id,
        participants: enabledParticipants,
        excludedParticipantIds: excluded
      })) {
        add(participant)
      }
      continue
    }
    const participant = resolvePhraseToParticipant(selector, enabledParticipants, excluded)
    if (participant) add(participant)
  }

  return recipients
}

/**
 * Resolve the detached background lanes requested by a user-authored round.
 * `@BG` and `@All` are deliberate groups, so they expand to every enabled
 * background seat. Direct participant aliases keep the legacy ambiguity
 * behaviour; stage groups that cannot contain background seats are ignored.
 */
export function resolveBackgroundMentionRouting(input: {
  text: string
  participants: readonly EnsembleParticipant[]
}): BackgroundMentionRoutingPlan {
  const participantIds = new Set<string>()
  const ambiguities: ParticipantMentionMatch[] = []

  for (const match of findAllMentions(input.text, [...input.participants])) {
    if (isGroupMention(match)) {
      if (!ensembleGroupMentionMatchesStage(match.group, 'background')) continue
      for (const participant of orderedGroupParticipants({
        group: match.group,
        participants: input.participants,
        excludedParticipantIds: new Set()
      })) {
        if (participant.stageRole === 'background') participantIds.add(participant.id)
      }
      continue
    }
    if (!isParticipantMention(match)) continue
    const candidates = [match.participant, ...(match.ambiguousAmong || [])]
    if (!candidates.some((participant) => participant.stageRole === 'background')) continue
    if (match.ambiguousAmong && match.ambiguousAmong.length > 0) {
      ambiguities.push(match)
      continue
    }
    if (match.participant.stageRole === 'background' && match.participant.enabled !== false) {
      participantIds.add(match.participant.id)
    }
  }

  return { participantIds, ambiguities }
}
