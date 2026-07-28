import type { ReactElement } from 'react'
import type { ProviderId } from '../../../main/store/types'
import type { AgentQuestionTombstone } from '../lib/agentQuestionTombstone'

/**
 * The settled twin of `AgentQuestionCard` — what an `ask_user_question` leaves
 * in the transcript once it has been answered or skipped.
 *
 * A SEPARATE component rather than a `settled` prop on the live card, because
 * the live one is all interaction: a focus trap, a one-shot resolve latch, an
 * Escape handler, an exit-fade timer. None of that belongs on a record of a
 * past decision, and a card that cannot answer cannot accidentally re-answer a
 * parked MCP call that has already resolved.
 *
 * It shares the live card's chrome classes so it reads as the same object at
 * rest, with `is-settled` toning it down.
 */
export interface AgentQuestionTombstoneCardProps {
  tombstone: AgentQuestionTombstone
  provider: ProviderId | null
  /** Who asked, already labelled ("Codex"). Absent falls back to "Agent". */
  providerLabel?: string
}

function formatTime(iso: string | undefined): string | null {
  if (!iso) return null
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function AgentQuestionTombstoneCard({
  tombstone,
  provider,
  providerLabel
}: AgentQuestionTombstoneCardProps): ReactElement {
  const providerClass = provider ? ` provider-${provider}` : ''
  const answered = tombstone.outcome === 'answered'
  // A typed answer has no matching button, so it gets its own row below the
  // options rather than silently failing to highlight any of them.
  const customAnswer = answered && tombstone.isCustomAnswer ? tombstone.answer : undefined
  const chosenOption = answered && !tombstone.isCustomAnswer ? tombstone.answer : undefined
  const stamp = formatTime(tombstone.answeredAt ?? tombstone.askedAt)

  return (
    <div
      className={`plan-choice-card agent-question-card agent-question-card--settled${providerClass}`}
      data-outcome={tombstone.outcome}
    >
      <div className="agent-question-card-settled-kicker">{providerLabel || 'Agent'} asked</div>
      <div className="plan-choice-question agent-question-card-question">{tombstone.question}</div>
      {tombstone.context && <div className="agent-question-card-context">{tombstone.context}</div>}

      {tombstone.options.length > 0 && (
        // A <ul>, not buttons. The options are being reported, not offered —
        // rendering them as disabled buttons would still read as a live control
        // the user could plausibly try to click.
        <ul className="agent-question-card-settled-options">
          {tombstone.options.map((option) => {
            const isChosen = option === chosenOption
            return (
              <li
                key={option}
                className={`agent-question-card-settled-option${isChosen ? ' is-chosen' : ''}`}
                aria-current={isChosen ? 'true' : undefined}
              >
                <span className="agent-question-card-settled-option-text">{option}</span>
                {isChosen && (
                  <span className="agent-question-card-settled-tick" aria-hidden="true">
                    ✓
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {customAnswer && (
        <div className="agent-question-card-settled-custom">
          <span className="agent-question-card-settled-custom-label">You answered</span>
          <span className="agent-question-card-settled-custom-text">{customAnswer}</span>
        </div>
      )}

      <div className="agent-question-card-settled-footer">
        {answered ? (
          // Screen readers get the whole sentence; sighted users get the tick
          // in the list above plus this stamp.
          <span className="agent-question-card-settled-outcome">
            Answered
            {/* The tick in the list above is visual only, so the answer is
                spelled out here for anyone reading with a screen reader. */}
            <span className="sr-only">{`: ${tombstone.answer ?? ''}`}</span>
          </span>
        ) : (
          <span className="agent-question-card-settled-outcome is-skipped">
            Skipped — no answer sent
          </span>
        )}
        {stamp && <span className="agent-question-card-settled-stamp">{stamp}</span>}
      </div>
    </div>
  )
}
