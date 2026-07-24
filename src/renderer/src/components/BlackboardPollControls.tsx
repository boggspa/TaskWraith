import { useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import type { BlackboardEntry, ChatRecord } from '../../../main/store/types'
import { validateBlackboardPollRecord } from '../../../shared/blackboardPollValidation'

interface BlackboardPollControlsProps {
  chat: ChatRecord | null
  entry: BlackboardEntry
  variant: 'panel' | 'popover'
  renderVoter?: (voterId: string, choice: string) => ReactNode
}

export function BlackboardPollControls({
  chat,
  entry,
  variant,
  renderVoter
}: BlackboardPollControlsProps): ReactElement | null {
  const [pendingChoice, setPendingChoice] = useState<string | null>(null)
  const [voteError, setVoteError] = useState<string | null>(null)
  const validation = validateBlackboardPollRecord(entry.poll)
  if (!validation.ok) return null

  const { poll } = validation
  const votes = poll.votes
  const userChoice = votes.find((vote) => vote.voterId === 'user')?.choice
  const canVote = Boolean(chat?.appChatId && poll.includeUser && poll.status === 'open')

  const vote = async (choice: string): Promise<void> => {
    if (!chat?.appChatId || !canVote || pendingChoice || userChoice === choice) return
    setPendingChoice(choice)
    setVoteError(null)
    try {
      const result = await window.api.answerEnsemblePoll({
        appChatId: chat.appChatId,
        pollId: entry.id,
        choice
      })
      if (!result.ok) {
        setVoteError(result.error || 'The vote could not be recorded.')
      }
    } catch (error) {
      setVoteError(error instanceof Error ? error.message : String(error))
    } finally {
      setPendingChoice(null)
    }
  }

  return (
    <section
      className={`blackboard-poll blackboard-poll-${variant}`}
      aria-label={`Poll options for ${entry.key}`}
      aria-busy={pendingChoice !== null}
    >
      <div className="blackboard-poll-status" aria-live="polite">
        <span>Poll · {poll.status}</span>
        <span>
          {votes.length} {votes.length === 1 ? 'vote' : 'votes'}
        </span>
      </div>
      <div className="blackboard-poll-options" role="group" aria-label="Poll choices">
        {poll.options.map((option) => {
          const optionVotes = votes.filter((vote) => vote.choice === option)
          const selected = userChoice === option
          const share = votes.length > 0 ? optionVotes.length / votes.length : 0
          return (
            <div className="blackboard-poll-option" key={option}>
              <button
                type="button"
                className={`blackboard-poll-option-button${selected ? ' is-selected' : ''}`}
                style={{ '--blackboard-poll-share': `${share * 100}%` } as CSSProperties}
                onClick={() => void vote(option)}
                disabled={!canVote || pendingChoice !== null || selected}
                aria-label={`Vote for ${option}, ${optionVotes.length} ${
                  optionVotes.length === 1 ? 'vote' : 'votes'
                }`}
                aria-pressed={selected}
              >
                <span className="blackboard-poll-option-fill" aria-hidden />
                <span className="blackboard-poll-option-label">
                  {selected && <span aria-hidden>✓ </span>}
                  {option}
                </span>
                <span className="blackboard-poll-option-count">{optionVotes.length}</span>
              </button>
              {variant === 'panel' && renderVoter && optionVotes.length > 0 && (
                <div className="blackboard-poll-voters" aria-label={`${option} voters`}>
                  {optionVotes.slice(0, 8).map((ballot) => (
                    <span key={ballot.voterId}>{renderVoter(ballot.voterId, option)}</span>
                  ))}
                  {optionVotes.length > 8 && (
                    <span className="blackboard-poll-voter-more">+{optionVotes.length - 8}</span>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {voteError && (
        <div className="blackboard-poll-error" role="alert">
          {voteError}
        </div>
      )}
    </section>
  )
}
