/**
 * The Mistral seat's rate-limit DISAMBIGUATOR — a pure classifier for a signal
 * Mistral overloads three ways.
 *
 * THE PROBLEM. A Vibe run can be stopped by three different things, and two of
 * them are byte-identical on the wire:
 *
 *   A. A dynamic per-minute token throttle. Recoverable in about a minute.
 *      Mistral contributor lu-zero describes it as "a quite dynamic rate of
 *      tokens per minute" (mistralai/mistral-vibe issue #275).
 *   B. The monthly budget exhausted with pay-as-you-go overflow OFF.
 *      Recoverable next BILLING CYCLE.
 *   C. The monthly budget exhausted with overflow ON. Not a stop at all — the
 *      run succeeds and you are quietly billed at API rates.
 *
 * A and B both surface as the same `RateLimitError` carrying "Rate limit
 * exceeded. Please wait a moment before trying again." C emits nothing. So the
 * transport cannot tell us which happened, and the reporter in #275 — a paying
 * customer — said exactly that: "I cannot really make a proper decision,
 * because I have no feedback / information of what could have possibly gone
 * wrong."
 *
 * WHY THIS MATTERS HERE. TaskWraith's ProviderQuotaWallClassifier fires only on
 * a TERMINAL non-zero exit and, once fired, can trigger failover. Applied naively
 * to Mistral that is wrong twice over: it would abandon the seat over a throttle
 * that a 60-second wait would clear (A), and it would stay silent in the one case
 * where money is actually burning (C). Hence a provider-specific layer.
 *
 * HOUSE POLICY — MISTRAL GETS MORE PATIENCE THAN THE OTHERS. Where another
 * provider's limit means "this seat is done for now", Mistral's usually means
 * "wait a moment", which is literally what the message says. So the default
 * posture is retry-with-backoff, and we escalate to a budget verdict only on
 * evidence: repeated failures across a long window, or spend that has reached
 * the estimated ceiling. Being slow here is cheap; being wrong is not.
 *
 * PURITY. Total, side-effect-free, `now` always a parameter. The caller owns
 * sleeping, retrying, and recording. Modelled on ProviderQuotaWallClassifier.ts.
 */

import type { MistralQuotaEstimate } from './MistralQuotaEstimate'

/** Which of the three limits we believe stopped the run. */
export type MistralLimitKind =
  /** Transient per-minute throttle. Wait and continue. */
  | 'throttle'
  /** Monthly budget exhausted. Waiting will not help until the cycle rolls. */
  | 'budget'
  /** Cannot tell yet. Treated as a throttle, because that is the recoverable
   *  reading and the cheap mistake. */
  | 'unknown'

export interface MistralLimitVerdict {
  readonly kind: MistralLimitKind
  /** How long the caller should wait before retrying, in ms. Zero means do not
   *  retry — the caller should surface the stop to the user instead. */
  readonly retryAfterMs: number
  /** Whether the estimator should adopt this as a real budget ceiling. Only ever
   *  true for a confident `budget` verdict — a throttle must never teach the
   *  meter a false ceiling. */
  readonly shouldRecordLimitEvent: boolean
  /** Short tag for logs and the audit ledger. */
  readonly reason: string
  /** Plain-language line for the transcript, so the user is never left guessing
   *  the way issue #275's reporter was. */
  readonly userMessage: string
}

/** Message anchors Vibe uses for a rate-limited turn. Matched case-insensitively
 *  against the ERROR channel only, never assistant or tool output — a tool that
 *  prints "rate limit exceeded" from curl must not trip this. */
const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /rate limit exceeded/i,
  /\brate_limit(_error)?\b/i,
  /\b429\b/,
  /too many requests/i
]

/** Backoff ladder, in ms. Deliberately long-tailed: the throttle is described as
 *  per-minute, so the first retries are sub-minute and the later ones step past
 *  a full minute before we give up on the throttle reading. */
const BACKOFF_LADDER_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000, 90_000]

/** Past this many consecutive failures the throttle reading stops being
 *  credible — a genuine per-minute throttle clears well inside this. */
const MAX_THROTTLE_ATTEMPTS = BACKOFF_LADDER_MS.length

/** Spend at or above this fraction of the estimated ceiling makes "budget" the
 *  better reading even early in the retry sequence. */
const BUDGET_SUSPICION_FRACTION = 0.8

/** Below this fraction of the estimated ceiling, a stop is almost certainly the
 *  throttle regardless of how many times it has recurred — we simply have not
 *  spent enough for a monthly budget to be plausible. */
const BUDGET_IMPLAUSIBLE_FRACTION = 0.25

export interface MistralLimitSignals {
  /** Text from the provider's ERROR/transport channel. */
  readonly errorText: string
  /** How many times this turn has already been retried after a limit stop. */
  readonly consecutiveAttempts: number
  /** Current meter reading, if the seat has one. Absent on the very first run. */
  readonly quota?: MistralQuotaEstimate
}

/** Does this error text look like a Mistral rate-limit stop at all? */
export function isMistralRateLimitText(errorText: string): boolean {
  if (!errorText) return false
  return RATE_LIMIT_PATTERNS.some((p) => p.test(errorText))
}

function backoffFor(attempts: number): number {
  const i = Math.max(0, Math.min(BACKOFF_LADDER_MS.length - 1, attempts))
  return BACKOFF_LADDER_MS[i]
}

const NOT_A_LIMIT: MistralLimitVerdict = {
  kind: 'unknown',
  retryAfterMs: 0,
  shouldRecordLimitEvent: false,
  reason: 'not-a-rate-limit',
  userMessage: ''
}

/**
 * Classify a stop. Callers should only reach this once they already know the
 * turn FAILED — a 429 inside a run that ultimately succeeded is noise, exactly
 * as ProviderQuotaWallClassifier's stage 1 requires.
 */
export function classifyMistralLimit(signals: MistralLimitSignals): MistralLimitVerdict {
  if (!isMistralRateLimitText(signals.errorText)) return NOT_A_LIMIT

  const attempts = Math.max(0, signals.consecutiveAttempts)
  const fraction = spendFraction(signals.quota)

  // Spent nowhere near the estimated ceiling: a monthly budget is not a credible
  // explanation no matter how stubborn the stop is. Keep waiting.
  if (fraction !== null && fraction < BUDGET_IMPLAUSIBLE_FRACTION) {
    return {
      kind: 'throttle',
      retryAfterMs: backoffFor(attempts),
      shouldRecordLimitEvent: false,
      reason: 'spend-far-below-ceiling',
      userMessage:
        'Mistral is throttling requests. Waiting a moment and continuing — this is not your monthly limit.'
    }
  }

  // At or past the estimated ceiling: budget is the better reading, and this is
  // the one case worth teaching the meter.
  if (fraction !== null && fraction >= BUDGET_SUSPICION_FRACTION) {
    return {
      kind: 'budget',
      retryAfterMs: 0,
      shouldRecordLimitEvent: true,
      reason: 'spend-at-estimated-ceiling',
      userMessage:
        'Mistral stopped the run and your estimated monthly Vibe usage is spent. This will not clear until the billing cycle resets.'
    }
  }

  // Ambiguous middle. Give the throttle reading the benefit of the doubt for the
  // whole ladder, then concede.
  if (attempts < MAX_THROTTLE_ATTEMPTS) {
    return {
      kind: 'throttle',
      retryAfterMs: backoffFor(attempts),
      shouldRecordLimitEvent: false,
      reason: 'within-retry-ladder',
      userMessage: 'Mistral is throttling requests. Waiting a moment and continuing.'
    }
  }

  return {
    kind: 'budget',
    retryAfterMs: 0,
    // Exhausting the ladder is suggestive, not conclusive — it could still be a
    // long outage. Do not teach the meter a ceiling on this evidence alone.
    shouldRecordLimitEvent: false,
    reason: 'retry-ladder-exhausted',
    userMessage:
      'Mistral kept rate-limiting this run after several retries. This may be your monthly Vibe limit, which will not clear until the billing cycle resets.'
  }
}

function spendFraction(quota: MistralQuotaEstimate | undefined): number | null {
  if (!quota) return null
  if (!Number.isFinite(quota.estimatedCeilingUsd) || quota.estimatedCeilingUsd <= 0) return null
  return quota.spentUsd / quota.estimatedCeilingUsd
}

/**
 * Whether TaskWraith's generic quota-wall machinery should be allowed to treat
 * this stop as a provider wall (and therefore consider failover).
 *
 * Only a confident budget verdict qualifies. A throttle must NOT reach the
 * generic classifier: failing over to another provider because Mistral asked us
 * to wait sixty seconds is precisely the behaviour this seat is built to avoid.
 */
export function mistralStopIsQuotaWall(verdict: MistralLimitVerdict): boolean {
  return verdict.kind === 'budget'
}
