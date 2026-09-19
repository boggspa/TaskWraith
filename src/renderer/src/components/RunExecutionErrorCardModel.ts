/**
 * RunExecutionErrorCardModel — pure classification and copy for the
 * transcript run-error card.
 *
 * WHY THIS EXISTS. A `role: 'error'` transcript message used to render as a
 * bare red pill carrying the full thrown string — IPC envelope, error class
 * names, transport codes and all. That text is written for logs, not for the
 * person staring at a dead run. This model separates the two audiences: calm
 * surface copy for everyone, and the untouched raw string behind an
 * expandable "Technical details" disclosure for anyone who needs it.
 *
 * CLASSIFICATION IS CONTENT-BASED ON PURPOSE. Error messages already sitting
 * in saved transcripts carry no metadata, so keying off the message text —
 * not a new metadata kind — repairs the rendering of history as well as new
 * failures.
 *
 * Every decision a human reads (kicker, title, body, prompt, button label)
 * is derived here as pure data, testable without a DOM — the same pattern as
 * HostStatusRow's describe* functions.
 */

import type { HostLifecyclePhase, HostLifecycleSnapshot } from '../../../shared/hostLifecycle'
import type { ChatMessage, ProviderId } from '../../../main/store/types'
import { getProviderLabel } from '../lib/providerLabels'
import {
  classifyFailureRemedy,
  describeFailureRemedyCopy,
  extractProviderFromFailureText
} from '../lib/runFailureRemedy'
import type { FailureRemedyKind } from '../lib/runFailureRemedy'
import { describeHostLifecycleControl, type HostLifecycleControlView } from './HostStatusRow'

/**
 * The shapes the card can take. Only Host outages earn a restart control.
 * `seat-failed` is produced by the participant-failure seat card
 * (SeatFailureCard), which shares this description shape and the
 * run-error-card chrome so both failures read as one surface language.
 */
export type RunErrorKind =
  | 'host-unavailable'
  | 'run-failed'
  | 'seat-failed'
  | 'auth-required'
  | 'usage-limited'
  | 'model-retired'
  | 'context-overflow'
  | 'missing-cli'
  | 'dispatch-failed'
  | 'network-issue'
  | 'run-interrupted'
  | 'catalogue-reindexing'

export interface RunErrorDescription {
  readonly kind: RunErrorKind
  /** Small uppercase eyebrow above the title — keeps the word "error" honest. */
  readonly kicker: string
  /** The calm, plain-language headline. */
  readonly title: string
  /** One or two sentences explaining what happened and what is safe. */
  readonly body: string
  /** The original message, verbatim, for the disclosure and Copy details. */
  readonly raw: string
  /** The provider the remedy actions target, when the text identifies one. */
  readonly provider?: ProviderId
  /** Optional left-slot guidance line for the actions row. */
  readonly note?: string
}

/**
 * Markers that all mean "Host could not be reached". Each is a real token
 * emitted somewhere along the host projection path — the transport code
 * (`host_unavailable`), the persist error class, and the transport error
 * wording — matched case-insensitively against the whole message so any
 * prefix ("Run execution failed unexpectedly:", "Failed to start …:") still
 * classifies correctly.
 */
const HOST_UNAVAILABLE_MARKERS = [
  'host_unavailable',
  'hostthreadrecordpersisterror',
  'host projection transport error'
] as const

export function classifyRunError(content: string): RunErrorKind {
  const haystack = content.toLowerCase()
  if (HOST_UNAVAILABLE_MARKERS.some((marker) => haystack.includes(marker))) {
    return 'host-unavailable'
  }
  const remedy = classifyFailureRemedy(content)
  if (remedy) return RUN_KIND_BY_REMEDY[remedy]
  return 'run-failed'
}

/** Run-error kind per remedy family — the card variant names. */
const RUN_KIND_BY_REMEDY: Record<FailureRemedyKind, RunErrorKind> = {
  auth: 'auth-required',
  'model-retired': 'model-retired',
  'usage-limit': 'usage-limited',
  'context-overflow': 'context-overflow',
  'missing-cli': 'missing-cli',
  dispatch: 'dispatch-failed',
  network: 'network-issue',
  'catalogue-reindexing': 'catalogue-reindexing'
}

/**
 * Kinds where "Retry run" is the honest primary action: transient failures
 * where nothing needs to change first. Auth/quota/retired need their remedy
 * BEFORE a retry; host needs the restart; an interrupted run has nothing
 * pending to retry.
 */
export const RETRYABLE_RUN_KINDS: ReadonlySet<RunErrorKind> = new Set([
  'catalogue-reindexing',
  'network-issue',
  'dispatch-failed',
  'run-failed'
])

export function describeRunError(content: string): RunErrorDescription {
  const raw = content.trim()
  const kind = classifyRunError(raw)
  if (kind === 'host-unavailable') {
    return {
      kind: 'host-unavailable',
      kicker: 'Run error',
      title: 'The Host is currently offline',
      body: 'This turn could not run because TaskWraith Host — the local helper that connects your providers and approvals — is not reachable. Nothing was sent, and your conversation is intact.',
      raw
    }
  }
  const provider = extractProviderFromFailureText(raw)
  const remedy = classifyFailureRemedy(raw)
  if (remedy) {
    // Deterministic template pool: the headline names the cause, not just
    // the failure. Subject prefers the identified provider so the card points
    // at who needs attention.
    const subject = provider ? getProviderLabel(provider) : 'The provider'
    const copy = describeFailureRemedyCopy(remedy, {
      subject,
      providerLabel: subject,
      surface: 'run'
    })
    return {
      kind,
      kicker: 'Run error',
      title: copy.title,
      body: copy.body,
      raw,
      ...(provider ? { provider } : {}),
      ...(copy.note ? { note: copy.note } : {})
    }
  }
  return {
    kind: 'run-failed',
    kicker: 'Run error',
    title: 'The run stopped unexpectedly',
    body: 'Something went wrong while this turn was running. Your conversation is intact — you can try sending it again.',
    raw
  }
}

/**
 * The providerRunFailure metadata shape (stderr-rim card legacy) read through
 * the SAME calm card. This is the coalescing seam: one error presentation
 * regardless of which pipeline stage caught the failure. The stderr lines in
 * the metadata are classified eagerly — no fetch needed — so auth/quota/
 * retirement remedies fire immediately, with the provider identity the
 * metadata already carries.
 */
export function describeProviderRunFailureMessage(msg: ChatMessage): RunErrorDescription {
  const metadata = msg.metadata ?? {}
  const provider = metadata.provider as ProviderId | undefined
  const label = provider ? getProviderLabel(provider) : 'The provider'
  const headline = typeof metadata.headline === 'string' ? metadata.headline : ''
  const hint = typeof metadata.hint === 'string' && metadata.hint.trim() ? metadata.hint : ''
  const exitCode = typeof metadata.exitCode === 'number' ? metadata.exitCode : undefined
  const lineTexts = (
    Array.isArray(metadata.lines) ? (metadata.lines as ReadonlyArray<unknown>) : []
  )
    .map((line) =>
      line && typeof line === 'object' && typeof (line as { text?: unknown }).text === 'string'
        ? ((line as { text: string }).text || '').trim()
        : ''
    )
    .filter(Boolean)
  // The raw block mirrors the legacy card's copy layout, so Copy details and
  // the disclosure carry exactly what the old card would have shown.
  const raw =
    [headline, '---', ...lineTexts, ...(hint ? [hint] : [])]
      .filter((part) => Boolean(part && part.trim()))
      .join('\n') || (msg.content || '').trim()

  // Interrupted runs (exit 130 / cancelled) are not failures to fix — they
  // get their own calm wording rather than a remedy.
  if (exitCode === 130 || /\bcancelled\b|\binterrupted\b/i.test(headline)) {
    return {
      kind: 'run-interrupted',
      kicker: 'Run error',
      title: `${label} was interrupted`,
      body: 'The run stopped before it could finish — nothing is pending on it. Re-send the prompt when you’re ready.',
      raw,
      ...(provider ? { provider } : {}),
      ...(hint ? { note: hint } : {})
    }
  }

  const classificationText = [headline, ...lineTexts, hint].join('\n')
  // Host outages surface through provider exits too — the coalesced card
  // keeps the restart control for them, same as the free-text path.
  const haystack = classificationText.toLowerCase()
  if (HOST_UNAVAILABLE_MARKERS.some((marker) => haystack.includes(marker))) {
    return {
      kind: 'host-unavailable',
      kicker: 'Run error',
      title: 'The Host is currently offline',
      body: 'This turn could not run because TaskWraith Host — the local helper that connects your providers and approvals — is not reachable. Nothing was sent, and your conversation is intact.',
      raw,
      ...(provider ? { provider } : {})
    }
  }
  const remedy = classifyFailureRemedy(classificationText)
  if (remedy) {
    const copy = describeFailureRemedyCopy(remedy, {
      subject: label,
      providerLabel: label,
      surface: 'run'
    })
    return {
      kind: RUN_KIND_BY_REMEDY[remedy],
      kicker: 'Run error',
      title: copy.title,
      body: copy.body,
      raw,
      ...(provider ? { provider } : {}),
      // An actionable hint from the producer (e.g. the context-wall hint)
      // outranks the pool note — it is the more specific sentence.
      ...(hint ? { note: hint } : copy.note ? { note: copy.note } : {})
    }
  }
  return {
    kind: 'run-failed',
    kicker: 'Run error',
    title: 'The run stopped unexpectedly',
    body: 'Something went wrong while this turn was running. Your conversation is intact — you can try sending it again.',
    raw,
    ...(provider ? { provider } : {}),
    ...(hint ? { note: hint } : {})
  }
}

/**
 * The question line beside the lifecycle button, keyed off the live lifecycle
 * phase so the card keeps telling the truth while Host restarts underneath
 * it. `undefined` covers the pre-fetch render, where the control is still
 * checking.
 */
export function hostActionPrompt(phase: HostLifecyclePhase | undefined): string {
  switch (phase) {
    case 'running':
      return 'Host is running again — you can retry your run.'
    case 'starting':
      return 'Restarting the Host…'
    case 'stopping':
      return 'Stopping the Host…'
    case 'failed':
      return 'The Host did not start cleanly. Would you like to try again?'
    default:
      return 'Would you like to restart the Host?'
  }
}

/**
 * The approvals-popover lifecycle control, re-voiced for the error card. The
 * action, disabled, and detail logic all come from the shared
 * `describeHostLifecycleControl`; only the start label changes — next to the
 * question "Would you like to restart the Host?", the button reads
 * "Restart Host" instead of "Start Host"/"Retry Host".
 */
export function describeRunErrorHostControl(
  lifecycle: HostLifecycleSnapshot | null,
  pending = false,
  unavailableReason?: string
): HostLifecycleControlView {
  const control = describeHostLifecycleControl(lifecycle, pending, unavailableReason)
  if (control.action !== 'start') return control
  const actionLabel = pending || lifecycle?.phase === 'starting' ? 'Starting…' : 'Restart Host'
  return { ...control, actionLabel }
}
