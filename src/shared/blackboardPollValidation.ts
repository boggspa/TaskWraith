export const BLACKBOARD_MIN_POLL_OPTIONS = 2
export const BLACKBOARD_MAX_POLL_OPTIONS = 6
export const BLACKBOARD_MAX_POLL_OPTION_LEN = 160
export const BLACKBOARD_POLL_MAX_RATIONALE_LEN = 500

export type BlackboardPollOptionsErrorCode =
  | 'blackboard_poll_options_invalid'
  | 'blackboard_poll_option_too_long'
  | 'blackboard_poll_options_duplicate'

export type BlackboardPollOptionsValidation =
  | { ok: true; options?: string[] }
  | {
      ok: false
      code: BlackboardPollOptionsErrorCode
      message: string
      maxLength?: number
      maxItems?: number
      minItems?: number
    }

export interface ValidatedBlackboardPollVote {
  voterId: string
  choice: string
  rationale?: string
  votedAt: string
}

export interface ValidatedBlackboardPoll {
  status: 'open' | 'closed'
  options: string[]
  votes: ValidatedBlackboardPollVote[]
  eligibleParticipantIds: string[]
  includeUser: boolean
  updatedAt: string
  closedAt?: string
}

export type BlackboardPollRecordValidation =
  | { ok: true; poll: ValidatedBlackboardPoll }
  | { ok: false }

function normalizePollOption(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

export function validateBlackboardPollOptions(value: unknown): BlackboardPollOptionsValidation {
  if (value === undefined) return { ok: true }
  if (
    !Array.isArray(value) ||
    value.length < BLACKBOARD_MIN_POLL_OPTIONS ||
    value.length > BLACKBOARD_MAX_POLL_OPTIONS
  ) {
    return {
      ok: false,
      code: 'blackboard_poll_options_invalid',
      message: `pollOptions must contain ${BLACKBOARD_MIN_POLL_OPTIONS}–${BLACKBOARD_MAX_POLL_OPTIONS} plain-text choices.`,
      minItems: BLACKBOARD_MIN_POLL_OPTIONS,
      maxItems: BLACKBOARD_MAX_POLL_OPTIONS
    }
  }
  const options: string[] = []
  const seen = new Set<string>()
  for (const rawOption of value) {
    if (typeof rawOption !== 'string') {
      return {
        ok: false,
        code: 'blackboard_poll_options_invalid',
        message: 'Every poll option must be a non-empty plain-text string.'
      }
    }
    const option = normalizePollOption(rawOption)
    if (!option) {
      return {
        ok: false,
        code: 'blackboard_poll_options_invalid',
        message: 'Every poll option must be a non-empty plain-text string.'
      }
    }
    if (option.length > BLACKBOARD_MAX_POLL_OPTION_LEN) {
      return {
        ok: false,
        code: 'blackboard_poll_option_too_long',
        message: `Poll options may contain at most ${BLACKBOARD_MAX_POLL_OPTION_LEN} characters.`,
        maxLength: BLACKBOARD_MAX_POLL_OPTION_LEN
      }
    }
    const identity = option.toLowerCase()
    if (seen.has(identity)) {
      return {
        ok: false,
        code: 'blackboard_poll_options_duplicate',
        message: 'Poll options must be unique.'
      }
    }
    seen.add(identity)
    options.push(option)
  }
  return { ok: true, options }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Parse one persisted Blackboard poll using the same fail-closed contract for
 * prompt injection, renderer controls, and vote mutation.
 */
export function validateBlackboardPollRecord(value: unknown): BlackboardPollRecordValidation {
  if (!isRecord(value)) return { ok: false }
  const rawOptions = value.options
  const optionValidation = validateBlackboardPollOptions(rawOptions)
  if (
    !Array.isArray(rawOptions) ||
    !optionValidation.ok ||
    !optionValidation.options ||
    (value.status !== 'open' && value.status !== 'closed') ||
    typeof value.includeUser !== 'boolean' ||
    typeof value.updatedAt !== 'string' ||
    !value.updatedAt.trim() ||
    (value.closedAt !== undefined &&
      (typeof value.closedAt !== 'string' || !value.closedAt.trim())) ||
    !Array.isArray(value.eligibleParticipantIds) ||
    !Array.isArray(value.votes)
  ) {
    return { ok: false }
  }
  if (optionValidation.options.some((option, index) => rawOptions[index] !== option)) {
    return { ok: false }
  }

  const eligibleParticipantIds: string[] = []
  const eligibleSet = new Set<string>()
  for (const rawParticipantId of value.eligibleParticipantIds) {
    if (
      typeof rawParticipantId !== 'string' ||
      !rawParticipantId.trim() ||
      rawParticipantId !== rawParticipantId.trim() ||
      rawParticipantId === 'user' ||
      rawParticipantId === 'system' ||
      eligibleSet.has(rawParticipantId)
    ) {
      return { ok: false }
    }
    eligibleSet.add(rawParticipantId)
    eligibleParticipantIds.push(rawParticipantId)
  }

  const votes: ValidatedBlackboardPollVote[] = []
  const seenVoters = new Set<string>()
  for (const rawVote of value.votes) {
    if (!isRecord(rawVote)) return { ok: false }
    const voterId = rawVote.voterId
    const choice = rawVote.choice
    const rationale = rawVote.rationale
    const votedAt = rawVote.votedAt
    if (
      typeof voterId !== 'string' ||
      !voterId.trim() ||
      voterId !== voterId.trim() ||
      voterId === 'system' ||
      seenVoters.has(voterId) ||
      typeof choice !== 'string' ||
      !optionValidation.options.includes(choice) ||
      typeof votedAt !== 'string' ||
      !votedAt.trim() ||
      (rationale !== undefined &&
        (typeof rationale !== 'string' || rationale.length > BLACKBOARD_POLL_MAX_RATIONALE_LEN)) ||
      (voterId === 'user' ? !value.includeUser : !eligibleSet.has(voterId))
    ) {
      return { ok: false }
    }
    seenVoters.add(voterId)
    votes.push({
      voterId,
      choice,
      ...(typeof rationale === 'string' && rationale ? { rationale } : {}),
      votedAt
    })
  }

  return {
    ok: true,
    poll: {
      status: value.status,
      options: optionValidation.options,
      votes,
      eligibleParticipantIds,
      includeUser: value.includeUser,
      updatedAt: value.updatedAt,
      ...(typeof value.closedAt === 'string' ? { closedAt: value.closedAt } : {})
    }
  }
}
