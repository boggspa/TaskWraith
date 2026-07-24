import type { BlackboardEntry, BlackboardPoll, ChatRecord } from '../store/types'
import {
  BLACKBOARD_POLL_MAX_RATIONALE_LEN,
  validateBlackboardPollRecord
} from '../../shared/blackboardPollValidation'

export type BlackboardPollVoteError =
  | 'blackboard_poll_invalid'
  | 'blackboard_poll_closed'
  | 'blackboard_poll_not_visible'
  | 'blackboard_poll_voter_not_eligible'
  | 'blackboard_poll_invalid_choice'

export interface BlackboardPollTally {
  choice: string
  votes: number
}

export type ApplyBlackboardPollVoteResult =
  | { handled: false }
  | {
      handled: true
      ok: false
      pollId: string
      message: string
      error: BlackboardPollVoteError
    }
  | {
      handled: true
      ok: true
      pollId: string
      message: string
      entry: BlackboardEntry
      tally: BlackboardPollTally[]
      updatedChat: ChatRecord
    }

function pollTally(poll: BlackboardPoll): BlackboardPollTally[] {
  return poll.options.map((choice) => ({
    choice,
    votes: poll.votes.filter((vote) => vote.choice === choice).length
  }))
}

function invalid(
  pollId: string,
  error: BlackboardPollVoteError,
  message: string
): ApplyBlackboardPollVoteResult {
  return { handled: true, ok: false, pollId, error, message }
}

/**
 * Apply one human/participant ballot to a durable Blackboard poll.
 *
 * The entry id is the poll id. A caller must supply its trusted voter identity
 * from runtime context (`participantId` for MCP, literal `user` for renderer);
 * identity is never accepted from tool or IPC arguments. Returning
 * `handled:false` is the intentional bridge to the older Boss/Captain poll
 * implementation: only a matching Blackboard poll claims the request.
 */
export function applyBlackboardPollVoteToChat(input: {
  chat: ChatRecord | null | undefined
  pollId: string
  choice: string
  voterId: string
  rationale?: string
  votedAt: string
  updatedAtMs: number
}): ApplyBlackboardPollVoteResult {
  const pollId = input.pollId.trim()
  const chat = input.chat
  if (!pollId || !chat?.ensemble) return { handled: false }
  const entries = chat.ensemble.blackboard || []
  const entryIndex = entries.findIndex((entry) => entry.id === pollId && entry.poll !== undefined)
  if (entryIndex < 0) return { handled: false }

  const entry = entries[entryIndex]
  const pollValidation = validateBlackboardPollRecord(entry.poll)
  if (!pollValidation.ok) {
    return invalid(pollId, 'blackboard_poll_invalid', `Blackboard poll ${pollId} is malformed.`)
  }
  const poll = pollValidation.poll
  if (poll.status !== 'open') {
    return invalid(
      pollId,
      'blackboard_poll_closed',
      `Blackboard poll ${pollId} is ${poll.status || 'closed'}.`
    )
  }
  const activeRoundId = chat.ensemble.activeRound?.roundId || ''
  if (entry.scope === 'round' && (!activeRoundId || entry.roundId !== activeRoundId)) {
    return invalid(
      pollId,
      'blackboard_poll_not_visible',
      `Blackboard poll ${pollId} is not visible in the active round.`
    )
  }

  const voterId = input.voterId.trim()
  const isUser = voterId === 'user'
  if (!voterId || voterId === 'system') {
    return invalid(
      pollId,
      'blackboard_poll_voter_not_eligible',
      'Blackboard poll voting requires an active Ensemble participant or the user.'
    )
  }
  const participantIsIneligible = !isUser && !poll.eligibleParticipantIds.includes(voterId)
  if ((isUser && !poll.includeUser) || participantIsIneligible) {
    return invalid(
      pollId,
      'blackboard_poll_voter_not_eligible',
      `${isUser ? 'The user is' : 'This participant is'} not eligible to vote in Blackboard poll ${pollId}.`
    )
  }

  const choice = input.choice.trim()
  if (!poll.options.includes(choice)) {
    return invalid(
      pollId,
      'blackboard_poll_invalid_choice',
      `Blackboard poll ${pollId} choice must be one of: ${poll.options.join(', ')}.`
    )
  }
  const rationale = (input.rationale || '').trim().slice(0, BLACKBOARD_POLL_MAX_RATIONALE_LEN)
  const nextPoll: BlackboardPoll = {
    ...poll,
    votes: [
      ...poll.votes.filter((vote) => vote.voterId !== voterId),
      {
        voterId,
        choice,
        ...(rationale ? { rationale } : {}),
        votedAt: input.votedAt
      }
    ],
    updatedAt: input.votedAt
  }
  const nextEntry: BlackboardEntry = {
    ...entry,
    poll: nextPoll,
    // A vote changes shared poll state. Resurface the revision to every seat
    // except the voter that just observed it.
    seenBy: [voterId]
  }
  const nextEntries = [...entries]
  nextEntries[entryIndex] = nextEntry
  const updatedChat: ChatRecord = {
    ...chat,
    ensemble: {
      ...chat.ensemble,
      blackboard: nextEntries,
      updatedAt: input.votedAt
    },
    updatedAt: input.updatedAtMs
  }
  return {
    handled: true,
    ok: true,
    pollId,
    entry: nextEntry,
    tally: pollTally(nextPoll),
    updatedChat,
    message: `${isUser ? 'User' : voterId} voted "${choice}" in Blackboard poll ${pollId}.`
  }
}
