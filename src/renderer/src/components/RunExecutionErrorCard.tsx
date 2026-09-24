/**
 * RunExecutionErrorCard — the transcript surface for `role: 'error'` run
 * failures, replacing the bare red pill.
 *
 * DESIGN. A calm card in the shape of the usage-credit notice: icon, small
 * kicker, plain-language title, an honest sentence about what is safe, and
 * action buttons. The full thrown string — IPC envelope, error classes and
 * all — is preserved untouched behind a "Technical details" disclosure and
 * the "Copy details" button, so supportability is not traded away for calm.
 *
 * THE HOST RESTART CONTROL IS A SECOND CALL SITE, NOT A COPY. The button
 * drives the same preload lifecycle conduit, the same snapshot subscription,
 * and the same action/disabled mapping as the approvals popover's
 * Start Host / Stop Host control (`describeHostLifecycleControl` via
 * `describeRunErrorHostControl`). Both surfaces command the same Host and
 * stay in sync through the shared change stream.
 *
 * STRUCTURE. `RunExecutionErrorCardView` is the pure presentational half —
 * every test that matters runs against it under `renderToStaticMarkup`.
 * `RunExecutionErrorCard` is the wired half: it owns the lifecycle client
 * subscription exactly the way HostStatusRow does. The subscription only
 * mounts for Host outages; a generic failure card has no button to drive.
 */

import { useEffect, useRef, useState } from 'react'

import type { ChatMessage } from '../../../main/store/types'
import type { HostLifecycleSnapshot } from '../../../shared/hostLifecycle'
import { HostLifecycleIpcClient } from '../lib/host/hostLifecycleIpcClient'
import { launchProviderLogin, providerLoginCapability } from '../lib/runFailureRemedy'
import { getProviderLabel } from '../lib/providerLabels'
import { formatProviderRunFailureTimestamp } from '../lib/providerRunFailureSnippet'
import type { EnsembleParticipantRetryResult } from '../lib/ensembleRetryPrompt'
import { HOST_LEASE_LIFETIME_NOTE, type HostLifecycleControlView } from './HostStatusRow'
import { PillButton } from './PillButton'
import {
  describeProviderRunFailureMessage,
  describeRunError,
  describeRunErrorHostControl,
  hostActionPrompt,
  RETRYABLE_RUN_KINDS,
  type RunErrorDescription
} from './RunExecutionErrorCardModel'

export interface RunExecutionErrorCardViewProps {
  readonly description: RunErrorDescription
  /** Present only for Host outages; its presence is what shows the restart row. */
  readonly hostControl?: HostLifecycleControlView
  readonly hostPrompt?: string
  readonly onHostAction?: () => void
  /** Auth remedy — present only when a provider login action exists. */
  readonly loginLabel?: string
  readonly onLogin?: () => void
  /** Retry affordance — present when the failure names a retryable seat. */
  readonly onRetry?: () => void
  /** Retry the whole failed run (rewind-resend from its own user message) —
   * offered for transient kinds only, and only on a fresh (last-row) failure. */
  readonly onRetryRun?: () => void
  /** Left-aligned guidance/outcome line in the actions row. */
  readonly remedyNote?: string
  readonly onCopy: () => void
  readonly copied: boolean
  /** The message's own timestamp, rendered like every other transcript row. */
  readonly timestamp?: string
}

export function RunExecutionErrorCardView({
  description,
  hostControl,
  hostPrompt,
  onHostAction,
  loginLabel,
  onLogin,
  onRetry,
  onRetryRun,
  remedyNote,
  onCopy,
  copied,
  timestamp
}: RunExecutionErrorCardViewProps): React.JSX.Element {
  const sideNote = remedyNote ?? (hostControl && hostPrompt ? hostPrompt : undefined)
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
        {sideNote ? (
          <span
            className="run-error-card-question"
            {...(hostControl?.detail ? { title: hostControl.detail } : {})}
          >
            {sideNote}
          </span>
        ) : null}
        <span className="run-error-card-buttons">
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
          {onRetryRun ? (
            <PillButton
              variant="primary"
              size="compact"
              onClick={onRetryRun}
              title="Retry this run — re-sends its prompt. The failed attempt's card is replaced by the new run."
            >
              Retry run
            </PillButton>
          ) : null}
          {hostControl?.action && onHostAction ? (
            <button
              type="button"
              /* Same class as the approvals-popover toggle on purpose: one
               * button identity, two call sites. */
              className="host-lifecycle-toggle run-error-card-restart"
              disabled={hostControl.disabled}
              onClick={onHostAction}
              aria-label={`${hostControl.actionLabel}. ${HOST_LEASE_LIFETIME_NOTE}`}
            >
              {hostControl.actionLabel}
            </button>
          ) : null}
        </span>
      </div>
      <details className="run-error-card-details">
        <summary>Technical details</summary>
        <pre className="run-error-card-raw">{description.raw}</pre>
      </details>
    </div>
  )
}

export interface RunExecutionErrorCardProps {
  readonly message: ChatMessage
  readonly onCopy: (messageId: string, content: string) => void
  readonly copied?: boolean
  /** Retry the failed seat — offered when the failure names an ensemble
   * participant (providerRunFailure cards carry its roster id). */
  readonly onRetryParticipant?: (participantId: string) => EnsembleParticipantRetryResult
  /** Rewind-resend the failed run's own prompt. Rendered only for transient
   * kinds; the card itself gates which kinds qualify. */
  readonly onRetryRun?: () => void
  /** Injected only by tests; production resolves the preload conduit lazily. */
  readonly lifecycleClient?: HostLifecycleIpcClient
}

export function RunExecutionErrorCard({
  message,
  onCopy,
  copied = false,
  onRetryParticipant,
  onRetryRun: onRetryRunProp,
  lifecycleClient: injectedLifecycleClient
}: RunExecutionErrorCardProps): React.JSX.Element {
  // One presentation for every failure origin: structured providerRunFailure
  // metadata and free-text run errors describe into the same card shape.
  const description =
    message.metadata?.kind === 'providerRunFailure'
      ? describeProviderRunFailureMessage(message)
      : describeRunError(message.content || '')
  const needsHostControl = description.kind === 'host-unavailable'
  const [lifecycleClient] = useState(() => injectedLifecycleClient ?? new HostLifecycleIpcClient())
  const [lifecycle, setLifecycle] = useState<HostLifecycleSnapshot | null>(null)
  const [lifecycleError, setLifecycleError] = useState<string>()
  const [lifecyclePending, setLifecyclePending] = useState(false)
  const mounted = useRef(true)

  // Auth remedy: the login launcher is a direct preload call — the card owns
  // only the outcome note, so a person is never left wondering whether the
  // click did anything.
  const [loginNote, setLoginNote] = useState<string>()
  const remedyProvider = description.provider
  // Seat retry passthrough — the same shared dispatch the SeatFailureCard
  // and the roster chip use.
  const retryParticipantId =
    typeof message.metadata?.ensembleParticipantId === 'string'
      ? message.metadata.ensembleParticipantId
      : undefined
  const [retryNote, setRetryNote] = useState<string>()
  const onRetry =
    onRetryParticipant && retryParticipantId
      ? () => {
          const result = onRetryParticipant(retryParticipantId)
          setRetryNote(
            result.ok
              ? result.lane === 'steer'
                ? 'Retry sent — the seat joins the live round as its own fan-out lane.'
                : 'Retry sent — a fresh round scoped to this seat is starting.'
              : result.reason
          )
        }
      : undefined
  // Seat retry wins when both exist (it is the more specific action); run
  // retry is offered only for transient kinds (RETRYABLE_RUN_KINDS).
  const onRetryRun =
    !onRetry && onRetryRunProp && RETRYABLE_RUN_KINDS.has(description.kind)
      ? onRetryRunProp
      : undefined
  const loginCapability = remedyProvider ? providerLoginCapability(remedyProvider) : undefined
  const onLogin =
    description.kind === 'auth-required' &&
    remedyProvider &&
    (loginCapability === 'terminal' || loginCapability === 'oauth')
      ? () => setLoginNote(launchProviderLogin(remedyProvider).note)
      : undefined
  const loginLabel =
    onLogin && remedyProvider ? `Log in to ${getProviderLabel(remedyProvider)}` : undefined
  const remedyNote = (() => {
    if (description.kind === 'auth-required') {
      if (loginNote) return loginNote
      if (remedyProvider && providerLoginCapability(remedyProvider) === 'api-key-only') {
        return `${getProviderLabel(remedyProvider)} uses an API key — update it in Settings, then retry.`
      }
    }
    return retryNote ?? description.note
  })()

  useEffect(() => {
    if (!needsHostControl) return
    mounted.current = true
    const adopt = (next: HostLifecycleSnapshot): void => {
      if (!mounted.current) return
      setLifecycle((current) => (!current || next.revision >= current.revision ? next : current))
      setLifecycleError(undefined)
    }
    const unsubscribe = lifecycleClient.subscribe(adopt)
    void lifecycleClient.status().then(adopt, (error: unknown) => {
      if (!mounted.current) return
      setLifecycleError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      mounted.current = false
      unsubscribe()
    }
  }, [lifecycleClient, needsHostControl])

  const hostControl = needsHostControl
    ? describeRunErrorHostControl(lifecycle, lifecyclePending, lifecycleError)
    : undefined
  const hostPrompt = needsHostControl ? hostActionPrompt(lifecycle?.phase) : undefined

  const runLifecycleAction = (): void => {
    const action = hostControl?.action
    if (!action || hostControl?.disabled) return
    setLifecyclePending(true)
    setLifecycleError(undefined)
    void lifecycleClient
      .set(action)
      .then((result) => {
        if (!mounted.current) return
        if (result.snapshot) {
          setLifecycle((current) =>
            !current || result.snapshot!.revision >= current.revision ? result.snapshot! : current
          )
        }
        if (!result.ok) setLifecycleError(result.error)
      })
      .catch((error: unknown) => {
        if (mounted.current) {
          setLifecycleError(error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        if (mounted.current) setLifecyclePending(false)
      })
  }

  return (
    <RunExecutionErrorCardView
      description={description}
      {...(hostControl ? { hostControl } : {})}
      {...(hostPrompt ? { hostPrompt } : {})}
      onHostAction={runLifecycleAction}
      {...(loginLabel ? { loginLabel } : {})}
      {...(onLogin ? { onLogin } : {})}
      {...(onRetry ? { onRetry } : {})}
      {...(onRetryRun ? { onRetryRun } : {})}
      {...(remedyNote ? { remedyNote } : {})}
      timestamp={message.timestamp}
      onCopy={() => onCopy(message.id, description.raw)}
      copied={copied}
    />
  )
}
