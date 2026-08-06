import { useEffect, useId, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { ProviderId } from '../../../main/store/types'
import type { SeatChangeSeatState } from '../../../shared/seatChange'
import { MOTION_DURATIONS, presenceSettleMs, usePresence } from '../hooks/usePanelPresence'
import { createOneShotLatch } from '../lib/oneShotLatch'
import { AgentQuestionAsker } from './AgentQuestionAsker'

/**
 * QMOD (1.0.3) — state for an in-flight `ask_user_question` MCP tool
 * invocation. The agent's tool call parks main-process-side; main fires
 * `agent-question-requested` IPC with the question payload + a
 * `questionId` opaque to the renderer. We surface a card in the
 * transcript and on submit/dismiss, post the answer back via
 * `answerAgentQuestion` / `cancelAgentQuestion`. The parked Promise
 * resolves and the agent's tool call returns the answer as its result.
 *
 * Per-chat state because two chats could each have an open question
 * simultaneously and they shouldn't bleed into each other.
 *
 * `messageId` is the synthetic system-message inserted into the chat
 * transcript at question time — the card renders adjacent to that
 * message so it's anchored in the conversation flow.
 */
export type AgentQuestionState = {
  questionId: string
  appRunId: string
  messageId: string
  provider: ProviderId | null
  question: string
  options?: string[]
  context?: string
  askedAt: number
}

export interface AgentQuestionCardProps {
  state: AgentQuestionState
  onAnswer: (answer: string, isCustom: boolean) => void
  onDismiss: () => void
  /**
   * The seat asking, resolved from the run behind the question.
   *
   * Null for a solo or chat-level turn, and then the card shows no asker at all
   * rather than falling back to a provider label. A live card is anchored to the
   * marker row that already names the provider, so in a one-seat chat the label
   * would be the third printing of the same word; the seat element earns its
   * place only where "which of the fifty?" is a real question.
   */
  seat?: SeatChangeSeatState | null
}

export function AgentQuestionCard({
  state,
  onAnswer,
  onDismiss,
  seat = null
}: AgentQuestionCardProps): ReactElement | null {
  const hasOptions = (state.options?.length ?? 0) > 0
  const [showFreeText, setShowFreeText] = useState(!hasOptions)
  const [freeText, setFreeText] = useState('')
  const [isClosing, setIsClosing] = useState(false)
  const providerClass = state.provider ? ` provider-${state.provider}` : ''
  const questionTitleId = useId()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const lastFocusedRef = useRef<HTMLElement | null>(null)

  // Resolve-once guard: a fast double-click, or an answer racing the ×/Escape
  // dismiss, must not fire both `answerAgentQuestion` AND `cancelAgentQuestion`
  // for the same parked MCP call. One latch per mounted card — the render sites
  // key the card by questionId, so each new question mounts a fresh card (and a
  // fresh latch); no in-render ref reset needed.
  const latchRef = useRef(createOneShotLatch())
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (completionTimerRef.current != null) clearTimeout(completionTimerRef.current)
    }
  }, [])

  const finishAfterExit = (resolve: () => void): void => {
    latchRef.current.run(() => {
      setIsClosing(true)
      // Answer after the exit fade; under reduce-motion settle is immediate.
      completionTimerRef.current = setTimeout(resolve, presenceSettleMs(MOTION_DURATIONS.base))
    })
  }

  const answerOnce = (value: string, isCustom: boolean): void => {
    finishAfterExit(() => onAnswer(value, isCustom))
  }
  const dismissOnce = (): void => {
    finishAfterExit(onDismiss)
  }

  const presence = usePresence(!isClosing, {
    durationMs: MOTION_DURATIONS.base,
    variant: 'rise',
    // This card only mounts for a fresh agent request, so it should receive a
    // single gentle entry rather than inheriting the app-restore skip.
    skipInitialAnimation: false
  })

  const submitFreeText = (): void => {
    if (!freeText.trim()) return
    answerOnce(freeText.trim(), true)
  }

  useEffect(() => {
    lastFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null
    const focusTimer = window.setTimeout(() => {
      const root = dialogRef.current
      if (!root) return
      const firstOption = root.querySelector<HTMLElement>('.plan-choice-action-btn')
      const textarea = root.querySelector<HTMLTextAreaElement>('.agent-question-card-input')
      ;(textarea ?? firstOption)?.focus()
    }, 0)
    return () => {
      window.clearTimeout(focusTimer)
      const last = lastFocusedRef.current
      if (last && typeof last.focus === 'function') {
        try {
          last.focus()
        } catch {
          // element may be gone; ignore
        }
      }
    }
  }, [state.questionId, showFreeText])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (showFreeText && hasOptions) {
          setShowFreeText(false)
          setFreeText('')
          return
        }
        dismissOnce()
        return
      }
      if (event.key !== 'Tab') return
      const root = dialogRef.current
      if (!root) return
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea:not([disabled]), input:not([disabled])'
        )
      ).filter((el) => el.offsetParent !== null)
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      } else if (active && !root.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasOptions, showFreeText])

  if (!presence.mounted) return null

  return (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={questionTitleId}
      className={`plan-choice-card agent-question-card${providerClass}${
        presence.className ? ` ${presence.className}` : ''
      }`}
    >
      {/* Present tense: this one is still open. The tombstone's twin reads
          "asked" because by then it is a record. */}
      {seat && <AgentQuestionAsker seat={seat} verb="asks" />}
      <div id={questionTitleId} className="plan-choice-question agent-question-card-question">
        {state.question}
      </div>
      {state.context && <div className="agent-question-card-context">{state.context}</div>}
      {hasOptions && !showFreeText && (
        <div className="plan-choice-actions">
          {state.options!.map((option) => (
            <button
              key={option}
              type="button"
              className="plan-choice-action-btn"
              onClick={() => answerOnce(option, false)}
              aria-label={`Answer: ${option}`}
            >
              {option}
            </button>
          ))}
          <button
            type="button"
            className="plan-choice-action-btn agent-question-card-other"
            onClick={() => setShowFreeText(true)}
            aria-label="Type your own answer instead"
          >
            Other…
          </button>
        </div>
      )}
      {showFreeText && (
        <div className="agent-question-card-freetext">
          <label className="sr-only" htmlFor="agent-question-answer">
            Your answer
          </label>
          <textarea
            id="agent-question-answer"
            className="agent-question-card-input"
            value={freeText}
            onChange={(event) => setFreeText(event.target.value)}
            placeholder="Type your answer… (⌘/Ctrl+Enter to submit)"
            rows={3}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                submitFreeText()
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                if (hasOptions) {
                  setShowFreeText(false)
                  setFreeText('')
                } else {
                  dismissOnce()
                }
              }
            }}
          />
          <div className="agent-question-card-freetext-actions">
            {hasOptions && (
              <button
                type="button"
                className="plan-choice-action-btn agent-question-card-cancel"
                onClick={() => {
                  setShowFreeText(false)
                  setFreeText('')
                }}
              >
                Back to options
              </button>
            )}
            <button
              type="button"
              className="plan-choice-action-btn agent-question-card-submit"
              onClick={submitFreeText}
              disabled={!freeText.trim()}
            >
              Send answer
            </button>
          </div>
        </div>
      )}
      <button
        type="button"
        className="agent-question-card-dismiss"
        onClick={dismissOnce}
        aria-label="Dismiss question without answering"
      >
        ×
      </button>
    </div>
  )
}
