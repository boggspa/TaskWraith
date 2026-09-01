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
  muse: 'Muse',
  devin: 'Devin'
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

/** Plural sibling of the hint above. A wave settlement collapses into ONE
 * notice, so the hint must not claim there is a single run to re-send. */
export const STALE_RUN_SETTLEMENT_HINT_PLURAL =
  'No results will arrive for these runs. Re-send the prompt to try again.'

/** How many run ids a grouped notice names before it summarises the rest —
 * enough to correlate the card with the durable run-event log without turning
 * it into a wall of ids. */
const STALE_RUN_SETTLEMENT_NAMED_IDS = 3

export interface StaleRunSettlementEntry {
  /** The run AFTER settlement (carries the stamped exitCode/endedAt). */
  run: ChatRun
  /** Status the run projected as before the sweep ('running', 'queued', …). */
  previousStatus: string
}

export interface StaleRunSettlementNoticeInput {
  chatId: string
  /**
   * Every run this sweep settled in the chat, ordered so the LAST entry is the
   * batch's newest (the reconciler sorts by transcript position). One notice
   * covers the whole batch on purpose: a fan-out round that loses its GPU
   * orphans every seat at the same instant, and thirteen byte-identical cards
   * are not thirteen times the information — they are the same sentence read
   * thirteen times, on every chat open, forever. A LATER sweep settling a
   * LATER crash still writes its own notice, so a genuine series of crashes
   * still reads as a series.
   */
  settlements: readonly StaleRunSettlementEntry[]
  /** `CHAT_RUN_STALE_REASON` — the same string the durable run-event carries. */
  reason: string
  settledAt: string
}

/**
 * The one value every settled run agrees on, or undefined when they differ.
 * A grouped notice may only claim a provider / status / exit code that holds
 * for the WHOLE batch: the card's headline and provider hue are read as
 * describing every run in it, so a value borrowed from one seat would speak
 * for all of them.
 */
function sharedSettlementValue<T>(values: readonly T[]): T | undefined {
  const first = values[0]
  return values.every((value) => value === first) ? first : undefined
}

const describeSettledRunIds = (runIds: readonly string[]): string => {
  const named = runIds.slice(0, STALE_RUN_SETTLEMENT_NAMED_IDS)
  const rest = runIds.length - named.length
  return `Runs: ${named.join(', ')}${rest > 0 ? ` +${rest} more` : ''}`
}

const describeSettledProviders = (providers: ReadonlyArray<ProviderId | undefined>): string => {
  const labels: string[] = []
  for (const provider of providers) {
    const label = runFailureProviderLabel(provider)
    if (!labels.includes(label)) labels.push(label)
  }
  return labels.join(', ')
}

/**
 * The transcript row for a reconciler sweep's settlements in one chat: names
 * the runs, the status they were wedged in, and the reason the sweep gave up
 * on them. A single settlement renders exactly as it always did.
 */
export function buildStaleRunSettlementNotice(input: StaleRunSettlementNoticeInput): ChatMessage {
  const settlements = input.settlements.filter((entry) => Boolean(entry?.run?.runId))
  if (settlements.length === 0) {
    throw new Error('buildStaleRunSettlementNotice needs at least one settled run')
  }
  // The batch's newest run owns the row: the reconciler inserts the notice
  // after that run's last transcript row, so binding `runId` to it keeps the
  // row's identity consistent with where it lands.
  const anchor = settlements[settlements.length - 1].run
  const count = settlements.length

  const providers = settlements.map((entry) => entry.run.provider)
  const sharedProvider = sharedSettlementValue(providers)
  const sharedStatus = sharedSettlementValue(settlements.map((entry) => entry.previousStatus))
  const sharedExitCode = sharedSettlementValue(settlements.map((entry) => entry.run.exitCode))

  const label = runFailureProviderLabel(sharedProvider)
  const headline =
    count === 1
      ? `${label} run interrupted`
      : sharedProvider
        ? `${label} · ${count} runs interrupted`
        : `${count} runs interrupted`

  const lines: RunFailureNoticeLine[] = [
    {
      text:
        count === 1
          ? `Run ${anchor.runId} was still marked ${sharedStatus} with no live process owner, so TaskWraith settled it as failed.`
          : `${count} runs were still marked ${sharedStatus ?? 'active'} with no live process owner, so TaskWraith settled them as failed.`,
      timestamp: input.settledAt
    }
  ]
  if (count > 1) {
    lines.push({ text: describeSettledRunIds(settlements.map((entry) => entry.run.runId)) })
    if (!sharedProvider) lines.push({ text: `Providers: ${describeSettledProviders(providers)}.` })
  }
  lines.push(...runFailureNoticeLines(input.reason))

  const hint = count === 1 ? STALE_RUN_SETTLEMENT_HINT : STALE_RUN_SETTLEMENT_HINT_PLURAL
  const bounded = lines.slice(0, RUN_FAILURE_MAX_LINES)
  return {
    id: staleRunSettlementNoticeId(input.chatId, anchor.runId),
    role: 'error',
    content: runFailureNoticeCopyText(headline, bounded, hint),
    timestamp: input.settledAt,
    runId: anchor.runId,
    metadata: buildRunFailureNoticeMetadata({
      ...(sharedProvider ? { provider: sharedProvider } : {}),
      headline,
      ...(typeof sharedExitCode === 'number' ? { exitCode: sharedExitCode } : {}),
      failureAt: input.settledAt,
      lines: bounded,
      hint
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
