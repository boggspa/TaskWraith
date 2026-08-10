// Transcript notices for runs that end failed WITHOUT an explanation.
//
// Two main-process lanes could stamp `status: 'failed'` onto a ChatRun and
// leave the transcript with nothing to show for it:
//
//   1. `flushBridgeRunTranscript` only writes its `bridge-error-*` row when the
//      finalizer was handed an `errorMessage`. Plenty of failure paths never
//      set one (a provider that exits non-zero after a silent turn, a tool
//      burst that ends with no reply, a terminal seal that arrives empty).
//   2. `reconcileStaleChatRuns` settles orphaned runs to 'failed' and writes NO
//      row at all — the run just flips terminal with an empty tail.
//
// Either way the desktop run-complete card and the iOS TaskCompleteCard say
// "Run failed / See the transcript above for details" while the transcript
// above says nothing. This module builds the missing explanation.
//
// SHAPE: both notices are the renderer's OWN provider-failure message — role
// 'error' plus `metadata.kind: 'providerRunFailure'` (App.tsx's
// `buildProviderRunFailureSnippet` capture). Reusing that shape rather than
// inventing a row kind is deliberate: the desktop ProviderRunFailureCard, the
// iOS ProviderRunFailureCard, `RemoteThreadProjection.buildRunFailure`, and
// iOS `twCarriesUnfoldableCard` (which keeps a failure from folding into a
// settled stack that reads like success) all already understand it. A new kind
// would have had to earn all four seams.
//
// Everything here is PURE so it unit-tests without the AppStore; the writes
// live in `ChatRunReconciler.reconcileStaleChatRuns` and index.ts.

import type { ChatMessage, ChatRun, ProviderId } from './store/types'

/** `metadata.kind` the desktop card, the remote projection and iOS key on. */
export const PROVIDER_RUN_FAILURE_METADATA_KIND = 'providerRunFailure'

/** Same caps the renderer's snippet builder uses, so a main-authored notice
 * can never out-grow a renderer-authored one on the wire. */
const RUN_FAILURE_LINE_MAX_CHARS = 600
const RUN_FAILURE_MAX_LINES = 6

/** Sibling copies live in RemoteThreadProjection.ts, EnsemblePrompt.ts and the
 * renderer's providerLabels.ts. Kept local (and exhaustive over ProviderId, so
 * a new provider fails the build here too) rather than reaching across a
 * module boundary from the reconciler. */
const PROVIDER_LABELS: Record<ProviderId, string> = {
  gemini: 'Gemini',
  codex: 'Codex',
  claude: 'Claude',
  kimi: 'Kimi',
  grok: 'Grok',
  cursor: 'Cursor',
  ollama: 'Ollama',
  antigravity: 'Antigravity',
  pi: 'Pi',
  mistral: 'Mistral',
  muse: 'Muse'
}

export interface RunFailureNoticeLine {
  text: string
  timestamp?: string
}

/** Matches the renderer fallback (`${label} failed`) when the provider is
 * unknown, so a provider-less run never renders a headline with a hole in it. */
export function runFailureProviderLabel(provider?: ProviderId | null): string {
  return (provider && PROVIDER_LABELS[provider]) || 'Provider'
}

const normalizeNoticeLine = (value: string): string =>
  value.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim().slice(0, RUN_FAILURE_LINE_MAX_CHARS)

/** Split a free-form error blob into the card's bounded, de-duplicated line
 * list (renderer `uniqueLines` parity). */
export function runFailureNoticeLines(text: string, timestamp?: string): RunFailureNoticeLine[] {
  const seen = new Set<string>()
  const lines: RunFailureNoticeLine[] = []
  for (const raw of String(text ?? '').split('\n')) {
    if (lines.length >= RUN_FAILURE_MAX_LINES) break
    const normalized = normalizeNoticeLine(raw)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    lines.push(timestamp ? { text: normalized, timestamp } : { text: normalized })
  }
  return lines
}

/** Body text for the row itself: what a client without the card renders, what
 * the thread-list preview shows, and what the card's Copy button yields.
 * Mirrors the renderer's `copyText` layout (headline, rule, lines, hint). */
export function runFailureNoticeCopyText(
  headline: string,
  lines: readonly RunFailureNoticeLine[],
  hint?: string
): string {
  return [headline, '---', ...lines.map((line) => line.text), ...(hint ? [hint] : [])].join('\n')
}

export interface RunFailureNoticeMetadataInput {
  provider?: ProviderId
  headline: string
  exitCode?: number
  failureAt: string
  lines: readonly RunFailureNoticeLine[]
  hint?: string
}

/** The `providerRunFailure` metadata blob both platforms read. */
export function buildRunFailureNoticeMetadata(
  input: RunFailureNoticeMetadataInput
): NonNullable<ChatMessage['metadata']> {
  return {
    kind: PROVIDER_RUN_FAILURE_METADATA_KIND,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(typeof input.exitCode === 'number' && Number.isFinite(input.exitCode)
      ? { exitCode: Math.trunc(input.exitCode) }
      : {}),
    failureAt: input.failureAt,
    headline: input.headline,
    lines: input.lines.map((line) => ({ ...line })),
    ...(input.hint ? { hint: input.hint } : {})
  }
}

/** Deterministic id so a repeated settlement pass over the same run updates
 * one row instead of stacking duplicates (`bridge-error-*` idiom). */
export function staleRunSettlementNoticeId(chatId: string, runId: string): string {
  return `stale-run-error-${chatId}-${runId}`
}

export const STALE_RUN_SETTLEMENT_HINT =
  'No result will arrive for this run. Re-send the prompt to try again.'

export interface StaleRunSettlementNoticeInput {
  chatId: string
  /** The run AFTER settlement (carries the stamped exitCode/endedAt). */
  run: ChatRun
  /** Status the run projected as before the sweep ('running', 'queued', …). */
  previousStatus: string
  /** `CHAT_RUN_STALE_REASON` — the same string the durable run-event carries. */
  reason: string
  settledAt: string
}

/**
 * The transcript row for a reconciler settlement: names the run, the status it
 * was wedged in, and the reason the sweep gave up on it.
 */
export function buildStaleRunSettlementNotice(input: StaleRunSettlementNoticeInput): ChatMessage {
  const label = runFailureProviderLabel(input.run.provider)
  const headline = `${label} run interrupted`
  const lines: RunFailureNoticeLine[] = [
    {
      text: `Run ${input.run.runId} was still marked ${input.previousStatus} with no live process owner, so TaskWraith settled it as failed.`,
      timestamp: input.settledAt
    },
    ...runFailureNoticeLines(input.reason)
  ].slice(0, RUN_FAILURE_MAX_LINES)
  return {
    id: staleRunSettlementNoticeId(input.chatId, input.run.runId),
    role: 'error',
    content: runFailureNoticeCopyText(headline, lines, STALE_RUN_SETTLEMENT_HINT),
    timestamp: input.settledAt,
    runId: input.run.runId,
    metadata: buildRunFailureNoticeMetadata({
      ...(input.run.provider ? { provider: input.run.provider } : {}),
      headline,
      ...(typeof input.run.exitCode === 'number' ? { exitCode: input.run.exitCode } : {}),
      failureAt: input.settledAt,
      lines,
      hint: STALE_RUN_SETTLEMENT_HINT
    })
  }
}

export interface UnexplainedBridgeRunFailureInput {
  /** Tool activities the run recorded before it died. */
  toolCallCount: number
  /** Whether the run produced any assistant prose at all. */
  hasAssistantText: boolean
  exitCode?: number
}

/**
 * Last-resort wording for a bridge run that finalized 'failed' while every
 * upstream lane stayed silent about why. Deliberately generic and short — it
 * exists so the `bridge-error-*` row is written at all; a real provider error
 * always wins over it.
 *
 * Phrasing follows the sibling sentence in `finalizeBridgeRunTranscript`
 * ("The provider ended this turn without producing an assistant response after
 * a tool failed or was rejected.") — the headline already names the provider.
 */
export function describeUnexplainedBridgeRunFailure(
  input: UnexplainedBridgeRunFailureInput
): string {
  const toolCalls = Math.max(0, Math.trunc(input.toolCallCount || 0))
  const after = toolCalls > 0 ? ` after ${toolCalls} tool call${toolCalls === 1 ? '' : 's'}` : ''
  const exit =
    typeof input.exitCode === 'number' && Number.isFinite(input.exitCode)
      ? ` (exit ${Math.trunc(input.exitCode)})`
      : ''
  return input.hasAssistantText
    ? `The provider ended this turn in a failure${after}, without reporting an error${exit}. The reply above may be incomplete.`
    : `The provider ended this turn without a reply${after} and without reporting an error${exit}.`
}

export interface BridgeRunFailureNoticeMetadataInput {
  provider: ProviderId
  errorMessage: string
  failureAt: string
  exitCode?: number
}

/**
 * Card metadata for the `bridge-error-*` row. Desktop-origin failures already
 * get the ProviderRunFailureCard (App.tsx stamps the same kind); without this
 * a phone-dispatched failure rendered as a bare red bubble on BOTH platforms
 * while an identical desktop failure rendered as a card.
 */
export function buildBridgeRunFailureMetadata(
  input: BridgeRunFailureNoticeMetadataInput
): NonNullable<ChatMessage['metadata']> {
  const label = runFailureProviderLabel(input.provider)
  const exitCode =
    typeof input.exitCode === 'number' && Number.isFinite(input.exitCode)
      ? Math.trunc(input.exitCode)
      : undefined
  const headline = exitCode === undefined ? `${label} failed` : `${label} failed · exit ${exitCode}`
  const lines = runFailureNoticeLines(input.errorMessage)
  return buildRunFailureNoticeMetadata({
    provider: input.provider,
    headline,
    ...(exitCode === undefined ? {} : { exitCode }),
    failureAt: input.failureAt,
    lines: lines.length > 0 ? lines : [{ text: headline }]
  })
}
