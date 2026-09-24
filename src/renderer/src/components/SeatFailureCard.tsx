/**
 * SeatFailureCard — the transcript surface for an ensemble seat that
 * finished `failed`, replacing the bare "Review 1 failed." line.
 *
 * SAME CARD LANGUAGE AS THE RUN-ERROR CARD ON PURPOSE: identical chrome
 * (`run-error-card` classes), identical calm copy split, identical
 * "Technical details" disclosure. A person who has read one of these cards
 * has read them all — only the facts change.
 *
 * THE DISCLOSURE IS LAZY. Run events for the seat's `runId` are fetched over
 * the preload bridge only when the disclosure is first opened — a transcript
 * can carry many of these codas and none of them should cost an IPC round
 * trip while closed. When the events carry no error output, the disclosure
 * says so honestly and falls back to the status line itself.
 *
 * STRUCTURE mirrors RunExecutionErrorCard: a pure `SeatFailureCardView`
 * (renderable under `renderToStaticMarkup`, which is how the tests exercise
 * every state) and a wired `SeatFailureCard` owning the fetch state.
 */

import { useCallback, useRef, useState, type ReactNode } from 'react'

import type { ChatMessage, RunEventFilter, RunEventRecord } from '../../../main/store/types'
import type { EnsembleParticipantRetryResult } from '../lib/ensembleRetryPrompt'
import { formatProviderRunFailureTimestamp } from '../lib/providerRunFailureSnippet'
import { launchProviderLogin, providerLoginCapability } from '../lib/runFailureRemedy'
import { getProviderLabel } from '../lib/providerLabels'
import type { RunErrorDescription } from './RunExecutionErrorCardModel'
import { PillButton } from './PillButton'
import {
  SEAT_FAILURE_DETAIL_MAX_CHARS,
  SEAT_FAILURE_EMPTY_DETAIL_NOTE,
  classifySeatFailureRemedy,
  describeSeatFailure,
  seatFailureProvider,
  seatFailureParticipantId,
  seatFailureDetailFromRunEvents
} from './SeatFailureCardModel'

/** The slice of the preload bridge this card needs — injectable for tests. */
export interface SeatFailureRunEventsClient {
  getRunEvents(filter?: RunEventFilter): Promise<RunEventRecord[]>
}

function resolveRunEventsClient(): SeatFailureRunEventsClient {
  if (typeof window === 'undefined' || typeof window.api?.getRunEvents !== 'function') {
    throw new Error('Run events bridge is unavailable outside TaskWraith Desktop.')
  }
  return { getRunEvents: (filter) => window.api.getRunEvents(filter) }
}

export type SeatFailureDetailState = 'idle' | 'loading' | 'ready'

export interface SeatFailureCardViewProps {
  readonly description: RunErrorDescription
  readonly detailState: SeatFailureDetailState
  /** The extracted stderr tail when `detailState` is 'ready' and events had output. */
  readonly detailText?: string
  /** True when events were read but held no error output. */
  readonly detailEmpty: boolean
  readonly detailTruncated: boolean
  /** Retry affordance — present only when the seat can actually be retried. */
  readonly onRetry?: () => void
  /** Outcome line after a retry attempt (the dispatch reason, or a sent note). */
  readonly retryNote?: string
  /** Classified remedy — login button and/or model swap slot. */
  readonly remedyNote?: string
  readonly loginLabel?: string
  readonly onLogin?: () => void
  /** The composer picker's identical pill, rendered for usage-limit failures. */
  readonly modelSwap?: ReactNode
  /** Test hook: render the disclosure open (static markup fires no toggles). */
  readonly detailsOpen?: boolean
  readonly onToggleDetails: (open: boolean) => void
  readonly onCopy: () => void
  readonly copied: boolean
  /** The coda's own timestamp — every transcript event shows one. */
  readonly timestamp?: string
}

export function SeatFailureCardView({
  description,
  detailState,
  detailText,
  detailEmpty,
  detailTruncated,
  onRetry,
  retryNote,
  remedyNote,
  loginLabel,
  onLogin,
  modelSwap,
  detailsOpen,
  onToggleDetails,
  onCopy,
  copied,
  timestamp
}: SeatFailureCardViewProps): React.JSX.Element {
  const sideNote = retryNote ?? remedyNote
  return (
    <div
      className={`run-error-card run-error-card--${description.kind}`}
      role="alert"
      aria-label={`${description.kicker}: ${description.title}`}
    >
      <div className="run-error-card-header">
        <span className="run-error-card-heading">
          <span className="run-error-card-kicker">{description.kicker}</span>
          <span className="run-error-card-title">{description.title}</span>
        </span>
        {timestamp ? (
          <time className="run-error-card-time" dateTime={timestamp}>
            {formatProviderRunFailureTimestamp(timestamp)}
          </time>
        ) : null}
      </div>
      <p className="run-error-card-body">{description.body}</p>
      <div className="run-error-card-actions">
        {sideNote ? <span className="run-error-card-question">{sideNote}</span> : null}
        <span className="run-error-card-buttons">
          {modelSwap ?? null}
          <button type="button" className="run-error-card-copy" onClick={onCopy}>
            {copied ? 'Copied' : 'Copy details'}
          </button>
          {loginLabel && onLogin ? (
            <PillButton variant="primary" size="compact" onClick={onLogin}>
              {loginLabel}
            </PillButton>
          ) : null}
          {onRetry ? (
            <PillButton
              variant="primary"
              size="compact"
              onClick={onRetry}
              title="Retry this participant's last turn — a live round is joined as a dedicated fan-out lane, an idle chat gets a fresh round scoped to this seat"
            >
              Retry
            </PillButton>
          ) : null}
        </span>
      </div>
      <details
        className="run-error-card-details"
        {...(detailsOpen ? { open: true } : {})}
        onToggle={(event) => onToggleDetails(event.currentTarget.open)}
      >
        <summary>Technical details</summary>
        {detailState === 'loading' ? (
          <div className="run-error-card-note">Loading captured output…</div>
        ) : (
          <>
            {detailEmpty && (
              <div className="run-error-card-note">{SEAT_FAILURE_EMPTY_DETAIL_NOTE}</div>
            )}
            {detailTruncated && (
              <div className="run-error-card-note">
                Showing the last {SEAT_FAILURE_DETAIL_MAX_CHARS.toLocaleString()} characters.
              </div>
            )}
            <pre className="run-error-card-raw">{detailText || description.raw}</pre>
          </>
        )}
      </details>
    </div>
  )
}

export interface SeatFailureCardProps {
  readonly message: ChatMessage
  readonly onCopy: (messageId: string, content: string) => void
  readonly copied?: boolean
  /**
   * Retry the failed seat's last turn. Absent → no Retry button (solo
   * transcripts have no seat to re-dispatch). Returns the dispatch outcome so
   * the card can surface the reason when retry is not applicable.
   */
  readonly onRetryParticipant?: (participantId: string) => EnsembleParticipantRetryResult
  /**
   * Renders the composer picker's identical pill for the failed seat — shown
   * when the captured output classifies as a usage limit, so the person can
   * swap the seat's model in place. Absent → the slot simply doesn't render.
   */
  readonly renderModelSwap?: (participantId: string) => ReactNode
  /** Injected only by tests; production resolves the preload bridge lazily. */
  readonly runEventsClient?: SeatFailureRunEventsClient
}

export function SeatFailureCard({
  message,
  onCopy,
  copied = false,
  onRetryParticipant,
  renderModelSwap,
  runEventsClient: injectedClient
}: SeatFailureCardProps): React.JSX.Element {
  const [detailState, setDetailState] = useState<SeatFailureDetailState>('idle')
  const [detailText, setDetailText] = useState<string>()
  const [detailEmpty, setDetailEmpty] = useState(false)
  const [detailTruncated, setDetailTruncated] = useState(false)
  const [retryNote, setRetryNote] = useState<string>()
  const [loginNote, setLoginNote] = useState<string>()
  const requestedRef = useRef(false)

  const participantId = seatFailureParticipantId(message)
  const provider = seatFailureProvider(message)

  // The remedy classifies whatever text exists right now: the coda's own
  // reason suffix immediately, the captured stderr once the disclosure load
  // lands. A card with no actionable cause keeps the plain actions.
  const remedy = classifySeatFailureRemedy(detailText, message.content)
  // The headline itself comes from the same classification — a quota wall
  // reads "…hit a usage limit", a 403 reads "…needs you to sign in again",
  // never the generic "couldn't finish" when the text already knows why.
  const description = describeSeatFailure(message, remedy)
  const loginCapability = provider ? providerLoginCapability(provider) : undefined
  const onLogin =
    remedy === 'auth' && provider && (loginCapability === 'terminal' || loginCapability === 'oauth')
      ? () => setLoginNote(launchProviderLogin(provider).note)
      : undefined
  const loginLabel = onLogin && provider ? `Log in to ${getProviderLabel(provider)}` : undefined
  const remedyNote = (() => {
    if (!remedy) return undefined
    if (remedy === 'auth') {
      if (loginNote) return loginNote
      if (provider && providerLoginCapability(provider) === 'api-key-only') {
        return `This looks like a sign-in problem — ${getProviderLabel(provider)} uses an API key, update it in Settings.`
      }
    }
    return description.note
  })()
  const modelSwap =
    (remedy === 'usage-limit' || remedy === 'model-retired') && renderModelSwap && participantId
      ? renderModelSwap(participantId)
      : undefined
  const onRetry =
    onRetryParticipant && participantId
      ? () => {
          const result = onRetryParticipant(participantId)
          setRetryNote(
            result.ok
              ? result.lane === 'steer'
                ? 'Retry sent — the seat joins the live round as its own fan-out lane.'
                : 'Retry sent — a fresh round scoped to this seat is starting.'
              : result.reason
          )
        }
      : undefined

  const onToggleDetails = useCallback(
    (open: boolean) => {
      if (!open || requestedRef.current) return
      requestedRef.current = true
      const runId = message.runId
      let client: SeatFailureRunEventsClient
      try {
        client = injectedClient ?? resolveRunEventsClient()
      } catch {
        setDetailState('ready')
        setDetailEmpty(true)
        return
      }
      if (!runId) {
        // No run association → nothing to fetch; show the status line alone.
        setDetailState('ready')
        setDetailEmpty(true)
        return
      }
      setDetailState('loading')
      client
        .getRunEvents({ runId, kinds: ['provider_error', 'provider_exit'], limit: 1000 })
        .then((events) => {
          const detail = seatFailureDetailFromRunEvents(events)
          setDetailState('ready')
          if (detail) {
            setDetailText(detail.text)
            setDetailTruncated(detail.truncated)
          } else {
            setDetailEmpty(true)
          }
        })
        .catch(() => {
          // A failed fetch must not look like "no output was captured" — but
          // the disclosure still owes the reader the status line it replaced.
          setDetailState('ready')
          setDetailEmpty(true)
        })
    },
    [injectedClient, message.runId]
  )

  return (
    <SeatFailureCardView
      description={description}
      detailState={detailState}
      {...(detailText ? { detailText } : {})}
      detailEmpty={detailEmpty}
      detailTruncated={detailTruncated}
      {...(onRetry ? { onRetry } : {})}
      {...(retryNote ? { retryNote } : {})}
      {...(remedyNote ? { remedyNote } : {})}
      {...(loginLabel ? { loginLabel } : {})}
      {...(onLogin ? { onLogin } : {})}
      {...(modelSwap ? { modelSwap } : {})}
      onToggleDetails={onToggleDetails}
      onCopy={() => onCopy(message.id, detailText || description.raw)}
      copied={copied}
      timestamp={message.timestamp}
    />
  )
}
