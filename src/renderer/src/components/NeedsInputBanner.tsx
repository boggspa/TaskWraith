import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ProviderId } from '../../../main/store/types'
import { getProviderLabel } from '../lib/providerLabels'

/**
 * Global, non-modal "Needs your input" attention banner for out-of-thread
 * `ask_user_question` prompts. The question card still lives in its owning
 * transcript — this surface only grabs attention and deep-links (or answers
 * multi-choice options in place) when the user is elsewhere in the app.
 */

export type NeedsInputBannerEntry = {
  questionId: string
  appChatId: string
  chatTitle?: string
  provider: ProviderId | null
  question: string
  options?: string[]
  context?: string
  askedAt: number
}

const BANNER_TTL_MS = 45_000
/** Cap concurrent banners so a chatty ensemble can't stack the screen. */
const MAX_VISIBLE = 3

export function needsInputOpenAriaLabel(chatTitle: string | undefined): string {
  return chatTitle?.trim() ? `Open thread: ${chatTitle.trim()}` : 'Open thread'
}

export function NeedsInputBannerCard({
  entry,
  onOpen,
  onAnswer,
  onDismiss
}: {
  entry: NeedsInputBannerEntry
  onOpen: () => void
  onAnswer?: (answer: string) => void
  onDismiss: () => void
}): React.JSX.Element {
  const providerLabel = entry.provider ? getProviderLabel(entry.provider) : 'Agent'
  const title = entry.chatTitle?.trim() || 'A thread'
  const hasOptions = (entry.options?.length ?? 0) > 0

  return (
    <div className="needs-input-banner" role="status" data-question-id={entry.questionId}>
      <div className="needs-input-banner-body">
        <div className="needs-input-banner-kicker">Needs your input</div>
        <div className="needs-input-banner-text">
          <strong>
            {providerLabel} in {title}
          </strong>{' '}
          asked: {entry.question}
        </div>
        {entry.context ? (
          <div className="needs-input-banner-context">{entry.context}</div>
        ) : null}
        {hasOptions && onAnswer ? (
          <div className="needs-input-banner-options" aria-label="Answer choices">
            {entry.options!.map((option) => (
              <button
                key={option}
                type="button"
                className="needs-input-banner-option"
                onClick={() => onAnswer(option)}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="needs-input-banner-actions">
        <button
          type="button"
          className="needs-input-banner-open"
          onClick={onOpen}
          aria-label={needsInputOpenAriaLabel(entry.chatTitle)}
          title="Open thread"
        >
          Open
        </button>
        <button
          type="button"
          className="needs-input-banner-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          title="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  )
}

export function NeedsInputBanner({
  entries,
  onOpen,
  onAnswer,
  onDismiss
}: {
  entries: readonly NeedsInputBannerEntry[]
  onOpen: (entry: NeedsInputBannerEntry) => void
  onAnswer?: (entry: NeedsInputBannerEntry, answer: string) => void
  onDismiss: (questionId: string) => void
}): React.JSX.Element | null {
  if (entries.length === 0) return null
  const visible = entries.slice(0, MAX_VISIBLE)

  return createPortal(
    <div className="needs-input-banner-stack" aria-live="polite" aria-relevant="additions">
      {visible.map((entry) => (
        <NeedsInputBannerCard
          key={entry.questionId}
          entry={entry}
          onOpen={() => onOpen(entry)}
          onAnswer={
            onAnswer && entry.options?.length
              ? (answer) => onAnswer(entry, answer)
              : undefined
          }
          onDismiss={() => onDismiss(entry.questionId)}
        />
      ))}
      {entries.length > MAX_VISIBLE ? (
        <div className="needs-input-banner-overflow" role="status">
          +{entries.length - MAX_VISIBLE} more waiting in Approvals
        </div>
      ) : null}
    </div>,
    document.body
  )
}

/**
 * Controller that keeps a short-lived banner queue for out-of-thread agent
 * questions. Call `push` when a question arrives for a chat the user is not
 * viewing; answered/cancelled questions should call `dismiss`.
 */
export function useNeedsInputBannerController(): {
  entries: readonly NeedsInputBannerEntry[]
  push: (entry: NeedsInputBannerEntry) => void
  dismiss: (questionId: string) => void
  clearForChat: (appChatId: string) => void
} {
  const [entries, setEntries] = useState<NeedsInputBannerEntry[]>([])
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = useCallback((questionId: string) => {
    const timer = timersRef.current.get(questionId)
    if (timer) clearTimeout(timer)
    timersRef.current.delete(questionId)
    setEntries((current) => current.filter((entry) => entry.questionId !== questionId))
  }, [])

  const push = useCallback(
    (entry: NeedsInputBannerEntry) => {
      setEntries((current) => {
        const without = current.filter((item) => item.questionId !== entry.questionId)
        return [...without, entry]
      })
      const existing = timersRef.current.get(entry.questionId)
      if (existing) clearTimeout(existing)
      timersRef.current.set(
        entry.questionId,
        setTimeout(() => dismiss(entry.questionId), BANNER_TTL_MS)
      )
    },
    [dismiss]
  )

  const clearForChat = useCallback((appChatId: string) => {
    setEntries((current) => {
      const next: NeedsInputBannerEntry[] = []
      for (const entry of current) {
        if (entry.appChatId === appChatId) {
          const timer = timersRef.current.get(entry.questionId)
          if (timer) clearTimeout(timer)
          timersRef.current.delete(entry.questionId)
        } else {
          next.push(entry)
        }
      }
      return next
    })
  }, [])

  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) clearTimeout(timer)
      timersRef.current.clear()
    }
  }, [])

  return { entries, push, dismiss, clearForChat }
}
