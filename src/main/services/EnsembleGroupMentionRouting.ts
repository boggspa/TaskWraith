import type { EnsembleParticipant } from '../store/types'
import {
  findAllMentions,
  isGroupMention,
  isParticipantMention,
  isUserMentionToken,
  resolvePhraseToParticipant,
  type MentionMatch,
  type GroupMentionMatch,
  type ParticipantMentionMatch
} from './EnsembleMentionAlias'
import {
  ensembleGroupMentionMatchesStage,
  isEnsembleAuthorityGroupMention,
  resolveEnsembleGroupMentionParticipantIds,
  resolveEnsembleGroupMentionToken,
  type EnsembleGroupMentionAuthority,
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
  /** Direct aliases that named a real but switched-off seat. */
  participantNotices: AssistantParticipantMentionRoutingNotice[]
  /** A permitted @Captains/@Management expansion must stay collective. */
  hasAuthorityGroupRoute: boolean
}

export function formatAssistantGroupMentionRoutingNotice(
  notice: AssistantGroupMentionRoutingNotice
): string {
  if (notice.reason === 'authority_required') {
    return `@-mention: ${notice.token} group routing requires Boss/Captain fan-out authority; no turns appended.`
  }
  if (notice.reason === 'outside_dm_scope') {
    return `@-mention: ${notice.token} is outside this user-targeted round; no group turns appended.`
  }
  return `@-mention: ${notice.token} matched no enabled eligible peer seats; no turns appended.`
}

/**
 * Why a direct `@seat` alias resolved to a real roster seat that still cannot
 * take a turn. Kept separate from the group-notice union on purpose: that
 * union's formatter falls through to its last branch, so widening it is a
 * silent-wrong-message hazard.
 */
export type AssistantParticipantMentionRoutingNoticeReason = 'disabled_target'

export interface AssistantParticipantMentionRoutingNotice {
  /** The alias the speaking seat actually wrote, `@` included. */
  token: string
  participantId: string
  /** Display name for the seat, matching the orchestrator's own fallback. */
  role: string
  reason: AssistantParticipantMentionRoutingNoticeReason
}

/**
 * A seat that tags a switched-off peer gets told so. Without this the alias
 * simply fails to resolve and NOTHING is appended, which reads to the speaker
 * exactly like prose — so it tags again on its next turn, and again. Say the
 * seat's name, say the cause is the user's toggle rather than a failure, and
 * name the next move, or the notice just decorates the same loop.
 */
export function formatAssistantParticipantMentionRoutingNotice(
  notice: AssistantParticipantMentionRoutingNotice
): string {
  switch (notice.reason) {
    case 'disabled_target':
      return (
        `@-mention: ${notice.token} names ${notice.role}, a seat the user has switched off; ` +
        'it cannot take a turn, so no turn appended. Route to an enabled seat, or ask the user ' +
        'to re-enable it — tagging it again will not reach it.'
      )
  }
}

/**
 * Narrow a turn's disabled-target notices to the ones this speaker has not
 * already been told about in this round, recording them as reported.
 *
 * The notice exists to stop a seat re-tagging a switched-off peer every turn.
 * Emitting it every turn would persist one status row per turn AND re-inject
 * every copy into every seat's tagged transcript on each later dispatch — a
 * quieter loop that costs more context than the silent one did. A DIFFERENT
 * speaker still gets told once: it has not seen the notice addressed to it.
 *
 * `reported` is mutated, and is owned by the round runtime so the memory dies
 * with the round.
 */
export function selectUnreportedDisabledTargetNotices(
  notices: readonly AssistantParticipantMentionRoutingNotice[],
  speakerParticipantId: string,
  reported: Set<string>
): AssistantParticipantMentionRoutingNotice[] {
  const fresh: AssistantParticipantMentionRoutingNotice[] = []
  for (const notice of notices) {
    const key = `${speakerParticipantId}:${notice.participantId}`
    if (reported.has(key)) continue
    reported.add(key)
    fresh.push(notice)
  }
  return fresh
}

export interface BackgroundMentionRoutingPlan {
  /** Enabled background seats explicitly selected by a direct or group token. */
  participantIds: Set<string>
  /** Direct participant aliases that still require user disambiguation. */
  ambiguities: ParticipantMentionMatch[]
  /**
   * Direct aliases that named a background seat the user has switched off.
   * Reported rather than dropped: naming a BG seat is an explicit request for
   * a lane, and silently launching none looks identical to launching one that
   * produced nothing.
   */
  disabledTargets: ParticipantMentionMatch[]
}

function orderedGroupParticipants(input: {
  group: EnsembleGroupMentionId
  participants: readonly EnsembleParticipant[]
  excludedParticipantIds: ReadonlySet<string>
  authority?: EnsembleGroupMentionAuthority
}): EnsembleParticipant[] {
  const memberIds = resolveEnsembleGroupMentionParticipantIds({
    group: input.group,
    participants: input.participants,
    authority: input.authority
  })
  return input.participants
    .filter(
      (participant) =>
        participant.enabled !== false &&
        !input.excludedParticipantIds.has(participant.id) &&
        memberIds.has(participant.id)
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
 * (normally every configured authority seat plus the speaker). Explicit
 * @Captains/@Management groups override those broad authority exclusions but
 * still remove the speaking participant, preserving collective intent without
 * allowing a self-loop.
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
  authority?: EnsembleGroupMentionAuthority
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
  const participantNotices = resolveDisabledTargetMentionNotices(input, matches)
  const noticeKeys = new Set<string>()
  const groupExclusions = new Set(input.excludedGroupParticipantIds || [])
  groupExclusions.add(input.callerParticipantId)
  let hasAuthorityGroupRoute = false

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
    const authorityGroup = isEnsembleAuthorityGroupMention(match.group)
    const targets = orderedGroupParticipants({
      group: match.group,
      participants: enabledParticipants,
      excludedParticipantIds: authorityGroup
        ? new Set([input.callerParticipantId])
        : groupExclusions,
      authority: input.authority
    })
    if (targets.length === 0) {
      addNotice(match, 'no_eligible_targets')
      continue
    }
    if (authorityGroup) hasAuthorityGroupRoute = true
    for (const participant of targets) {
      participantMatches.push(expandedParticipantMatch(match, participant))
    }
  }

  return { participantMatches, groupNotices, participantNotices, hasAuthorityGroupRoute }
}

/**
 * Second, DIAGNOSTIC-ONLY resolution pass over the full roster.
 *
 * The enabled-only pass above stays the sole routing authority. Resolving
 * routes against the whole roster instead would be a regression twice over:
 * a disabled seat's alias set is byte-identical to its enabled one, so it can
 * win a LONGER longest-prefix match away from an enabled seat, and — because
 * the alias index is built in roster-array order — it can also displace an
 * enabled peer into `ambiguousAmong` and turn a clean route into an ambiguity
 * warning. Running a throwaway second pass and reporting only what it alone
 * saw buys the notice without touching either behaviour.
 *
 * Suppression is keyed on the exact SPAN an alias consumed, never on `atIndex`
 * alone. The two passes can resolve different numbers of words at the same
 * `@`: with an enabled `Codex` and a disabled `Codex Reviewer`, the
 * authoritative pass fails longest-prefix at two words, falls back to one, and
 * routes the enabled `Codex` — at the same offset the full pass resolves the
 * disabled two-word seat. An `atIndex`-only key would read that as "already
 * routed" and stay silent, which is the worse failure: the wrong seat answers
 * a message addressed by name to a switched-off one.
 */
function resolveDisabledTargetMentionNotices(
  input: {
    text: string
    participants: readonly EnsembleParticipant[]
    callerParticipantId: string
  },
  routedMatches: readonly MentionMatch[]
): AssistantParticipantMentionRoutingNotice[] {
  if (!input.participants.some((participant) => participant.enabled === false)) return []
  const routedSpans = new Set(
    routedMatches.map((match) => `${match.atIndex}:${match.consumedLength}`)
  )
  const notices: AssistantParticipantMentionRoutingNotice[] = []
  const seen = new Set<string>()
  for (const match of findAllMentions(
    input.text,
    [...input.participants],
    new Set([input.callerParticipantId])
  )) {
    if (!isParticipantMention(match)) continue
    if (match.participant.enabled !== false) continue
    // The authoritative pass consumed this exact alias and routed a turn for
    // it, so there is nothing to report. A match at the same offset but a
    // DIFFERENT length is a different alias and still needs its notice.
    if (routedSpans.has(`${match.atIndex}:${match.consumedLength}`)) continue
    if (seen.has(match.participant.id)) continue
    seen.add(match.participant.id)
    notices.push({
      token: `@${match.text}`,
      participantId: match.participant.id,
      role: match.participant.role || match.participant.provider,
      reason: 'disabled_target'
    })
  }
  return notices
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
  authority?: EnsembleGroupMentionAuthority
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
        excludedParticipantIds: excluded,
        authority: input.authority
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

export interface EnsembleCommunicationAudience {
  participants: EnsembleParticipant[]
  toUser: boolean
}

function isUserCommunicationSelector(selector: string): boolean {
  return isUserMentionToken(selector.trim().replace(/^@+/, '').trim())
}

/**
 * Resolve the explicit `ensemble_send.to` audience. Only the canonical User
 * aliases cross the participant boundary; unknown selectors still resolve to
 * nothing, message prose is never scanned, and `@All` remains roster-only.
 */
export function resolveEnsembleCommunicationAudience(input: {
  selectors: readonly string[]
  participants: readonly EnsembleParticipant[]
  senderParticipantId: string
  authority?: EnsembleGroupMentionAuthority
}): EnsembleCommunicationAudience {
  const participantSelectors: string[] = []
  let toUser = false
  for (const selector of input.selectors) {
    if (isUserCommunicationSelector(selector)) {
      toUser = true
    } else {
      participantSelectors.push(selector)
    }
  }
  return {
    participants: resolveEnsembleCommunicationTargets({
      ...input,
      selectors: participantSelectors
    }),
    toUser
  }
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
  const disabledTargets: ParticipantMentionMatch[] = []
  const seenDisabled = new Set<string>()

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
    if (match.participant.stageRole !== 'background') continue
    if (match.participant.enabled !== false) {
      participantIds.add(match.participant.id)
      continue
    }
    if (seenDisabled.has(match.participant.id)) continue
    seenDisabled.add(match.participant.id)
    disabledTargets.push(match)
  }

  return { participantIds, ambiguities, disabledTargets }
}
