import type { CSSProperties, ReactElement } from 'react'
import type { ChatRecord } from '../../../main/store/types'
import { useState } from 'react'

export function EnsemblePollCard({
  chat,
  pollId,
  onVote
}: {
  chat: ChatRecord | null
  pollId: string
  onVote?: (chatId: string, pollId: string, choice: string) => void
}): ReactElement | null {
  const [pendingChoice, setPendingChoice] = useState<string | null>(null)
  const [voteError, setVoteError] = useState<string | null>(null)
  const poll = chat?.ensemble?.bossmanControlState?.polls?.find((entry) => entry.id === pollId)
  if (!chat || !poll) return null
  const userVote = poll.votes.find((vote) => vote.voterLabel === 'User')
  const participantVotes = poll.votes.filter((vote) => vote.voterLabel !== 'User')
  const isOpen = poll.status === 'open'
  const canVote = poll.includeUser === true && isOpen && !userVote

  // Failed seats are never counted: they cannot respond, so they are removed
  // from the responded denominator exactly like the orchestrator's voter
  // roster excludes them.
  const failedSeatIds = new Set(
    (chat.ensemble?.activeRound?.participants || [])
      .filter(
        (roundParticipant) =>
          roundParticipant.status === 'failed' || roundParticipant.status === 'unreachable'
      )
      .map((roundParticipant) => roundParticipant.participantId)
  )
  const expectedSeatCount = (
    poll.targetParticipantIds ||
    (chat.ensemble?.participants || [])
      .filter((participant) => participant.enabled)
      .map((participant) => participant.id)
  ).filter((id) => !failedSeatIds.has(id)).length
  const respondedCount = participantVotes.length + (userVote ? 1 : 0)
  const totalVotesCast = poll.votes.length

  const vote = (choice: string): void => {
    if (!canVote || pendingChoice) return
    setPendingChoice(choice)
    setVoteError(null)
    try {
      // The handler is commonly async (IPC round-trip); surface failures
      // instead of silently swallowing the click.
      void Promise.resolve(onVote?.(chat.appChatId, poll.id, choice))
        .catch((error: unknown) =>
          setVoteError(error instanceof Error ? error.message : String(error))
        )
        .finally(() => setPendingChoice(null))
    } catch (error) {
      setPendingChoice(null)
      setVoteError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="plan-choice-card agent-question-card ensemble-poll-card">
      <div className="plan-choice-question agent-question-card-question">{poll.question}</div>
      {poll.timeoutAt && isOpen && (
        <div className="agent-question-card-context">Open until {poll.timeoutAt}</div>
      )}
      <div className="ensemble-poll-options" role="group" aria-label="Poll choices">
        {poll.options.map((option) => {
          const optionVotes = poll.votes.filter((vote) => vote.choice === option)
          const selected = userVote?.choice === option
          const share = totalVotesCast > 0 ? optionVotes.length / totalVotesCast : 0
          const pct = Math.round(share * 100)
          const voters = optionVotes
            .map((vote) => vote.voterLabel || 'Participant')
            .filter((label) => label !== 'User')
          return (
            <div className="ensemble-poll-option" key={option}>
              <button
                type="button"
                className={`ensemble-poll-option-button${selected ? ' is-selected' : ''}`}
                style={{ '--ensemble-poll-share': `${share * 100}%` } as CSSProperties}
                onClick={() => vote(option)}
                disabled={!canVote || pendingChoice !== null}
                aria-pressed={selected}
                aria-label={`Vote for ${option}, ${pct}% of ${totalVotesCast} ${
                  totalVotesCast === 1 ? 'vote' : 'votes'
                }`}
              >
                <span className="ensemble-poll-option-fill" aria-hidden />
                <span className="ensemble-poll-option-label">
                  {selected && <span aria-hidden>✓ </span>}
                  {option}
                </span>
                {totalVotesCast > 0 && (
                  <>
                    <span className="ensemble-poll-option-meter" aria-hidden>
                      <span className="ensemble-poll-option-bar">
                        <span
                          className="ensemble-poll-option-bar-fill"
                          style={{ width: `${share * 100}%` }}
                        />
                      </span>
                      <span className="ensemble-poll-option-pct">{pct}%</span>
                    </span>
                    <span className="ensemble-poll-option-count">{optionVotes.length}</span>
                  </>
                )}
              </button>
              {voters.length > 0 && (
                <div className="ensemble-poll-option-voters" aria-label={`${option} voters`}>
                  {voters.slice(0, 8).map((label, index) => (
                    <span key={`${label}-${index}`}>{label}</span>
                  ))}
                  {voters.length > 8 && (
                    <span className="ensemble-poll-voter-more">+{voters.length - 8}</span>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="agent-question-card-context ensemble-poll-status">
        {expectedSeatCount > 0
          ? `${respondedCount}/${expectedSeatCount} seats responded`
          : `${respondedCount} ${respondedCount === 1 ? 'vote' : 'votes'} cast`}
        {userVote ? ' · Your vote: ' + userVote.choice : ''}
        {!isOpen ? ` · Poll ${poll.status}` : ''}
      </div>
      {voteError && (
        <div className="ensemble-poll-error" role="alert">
          {voteError}
        </div>
      )}
    </div>
  )
}
