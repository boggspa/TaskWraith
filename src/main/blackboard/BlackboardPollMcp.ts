import type { BlackboardEntry, ChatRecord } from '../store/types'
import type { BlackboardPollTally } from './BlackboardPoll'
import { applyBlackboardPollVoteToChat } from './BlackboardPoll'

export interface EnsemblePollToolResult {
  ok: boolean
  tool: 'ensemble_poll_response'
  message: string
  pollId?: string
  error?: string
  entry?: BlackboardEntry
  tally?: BlackboardPollTally[]
}

export interface BlackboardPollMcpDeps {
  getChat: (chatId: string) => ChatRecord | null | undefined
  getParticipantIdForRun: (runId: string) => string | undefined
  saveAndBroadcastChat: (chat: ChatRecord) => void
  now?: () => Date
}

export function executeBlackboardAwarePollResponse(
  deps: BlackboardPollMcpDeps,
  input: {
    appChatId?: string
    appRunId: string
    pollId: string
    choice: string
    rationale?: string
    fallback: () => EnsemblePollToolResult
  }
): EnsemblePollToolResult {
  const now = deps.now?.() || new Date()
  const blackboardVote = applyBlackboardPollVoteToChat({
    chat: input.appChatId ? deps.getChat(input.appChatId) : null,
    pollId: input.pollId,
    choice: input.choice,
    voterId: deps.getParticipantIdForRun(input.appRunId) || '',
    rationale: input.rationale,
    votedAt: now.toISOString(),
    updatedAtMs: now.getTime()
  })
  if (!blackboardVote.handled) return input.fallback()
  if (!blackboardVote.ok) {
    return {
      ok: false,
      tool: 'ensemble_poll_response',
      pollId: blackboardVote.pollId,
      message: blackboardVote.message,
      error: blackboardVote.error
    }
  }

  deps.saveAndBroadcastChat(blackboardVote.updatedChat)
  return {
    ok: true,
    tool: 'ensemble_poll_response',
    pollId: blackboardVote.pollId,
    message: blackboardVote.message,
    entry: blackboardVote.entry,
    tally: blackboardVote.tally
  }
}
