/**
 * The Mistral seat's quota ESTIMATOR — a pure model of a budget Mistral neither
 * publishes nor exposes.
 *
 * WHY THIS EXISTS. Every other TaskWraith seat can be metered from a number the
 * vendor hands us: a window with a `resetAt`, a percentage, a remaining count.
 * Mistral hands us nothing. Three separate doors are shut:
 *
 *   1. The Vibe CLI never asks. The whole package speaks to exactly two
 *      endpoints — `/v1/messages` and `/v1/datalake/events` (telemetry). It
 *      fetches no entitlement, balance or budget.
 *   2. The Admin API, which does expose usage metrics, is Enterprise-only
 *      (Preview) and needs a dedicated admin key. Closed to Pro and Team.
 *   3. Mistral publishes no figure to hardcode. Their own pricing page says
 *      Free is "Limited coding sessions" and Pro is "All-day coding in the CLI,
 *      IDE, and on web". No dollars, no tokens, no message count.
 *
 * Mistral have said a Vibe usage view is on the roadmap (mistralai/mistral-vibe
 * issue #305, where the maintainer wrote "I can assure you that this is on the
 * roadmap"). Until it lands, a seat with no meter at all would sail silently
 * into a monthly wall — the exact failure this module exists to prevent. When
 * that view ships, this estimator should be replaced by it, not layered under it.
 *
 * DESIGN — seed low, accumulate, then learn:
 *
 *   SEED       Anchor the ceiling to the plan PRICE as API-equivalent value,
 *              because it is the only real number in the whole arrangement.
 *              Deliberately biased LOW (see PLAN_SEED_USD): an underestimate
 *              warns early, which is merely noisy; an overestimate warns late,
 *              which is the surprise wall we are trying to avoid.
 *   ACCUMULATE Sum locally observed spend across the billing cycle. The ACP
 *              `usage_update` carries a running `cost {amount, currency}`, and
 *              each turn's `stopReason` carries token counts we can price from
 *              the local catalog.
 *   CALIBRATE  Remember the spend level at which a limit was ACTUALLY hit and
 *              carry it forward as the learned ceiling. Equally, a cycle that
 *              sails past the estimate untouched is evidence the seed was too
 *              low, so raise it. After one full cycle the estimate stops being
 *              a guess and starts being a measurement.
 *
 * PURITY. Every function here is total and side-effect-free, and `now` is always
 * a parameter — never read from the clock. Persistence, IPC and rendering all
 * live with the caller. This mirrors ProviderQuotaWallClassifier.ts, which is
 * likewise a pure classifier with a fully-unit-tested surface.
 *
 * THE NUMBERS BELOW ARE GUESSWORK, AND SAY SO. `confidence` is part of the
 * output for exactly that reason: a seeded estimate must never be rendered with
 * the authority of a measured one.
 */

/** Which Mistral plan the user believes they are on. `unknown` is honest and is
 *  the default — we cannot detect the plan, since nothing in the lane reports
 *  it. */
export type MistralPlanId = 'free' | 'pro' | 'team' | 'unknown'

/** Coarse pressure bands. Deliberately verbal rather than numeric: the whole
 *  point is to convey "you have used quite a bit this month" without implying a
 *  precision we do not have. */
export type MistralQuotaBand = 'quiet' | 'moderate' | 'heavy' | 'near-limit' | 'exceeded'

/** How much the ceiling is worth believing. */
export type MistralQuotaConfidence =
  /** Price-anchored guess, no observations yet. */
  | 'seeded'
  /** Some evidence gathered, not yet a limit event. */
  | 'calibrating'
  /** A real limit event has been observed and recorded. */
  | 'learned'

/**
 * Plan price expressed as an assumed monthly API-equivalent budget, in USD.
 *
 * Rationale, stated plainly because it is a guess: the subscription price is the
 * only hard number Mistral gives us, and a coding plan that returned materially
 * less inference value than its price would not be a coding plan. Using price
 * 1:1 (rather than a generous multiple) biases the first cycle toward warning
 * EARLY. Calibration corrects upward on evidence; nothing here stays wrong for
 * more than one cycle of real use.
 *
 * `free` has no price to anchor to. $5 is arbitrary and conservative — a
 * placeholder that exists only to give the first cycle a scale, and which
 * calibration is expected to replace immediately.
 */
const PLAN_SEED_USD: Readonly<Record<MistralPlanId, number>> = {
  free: 5,
  pro: 14.99,
  team: 24.99,
  unknown: 14.99
}

/** Band thresholds as a fraction of the estimated ceiling. */
const BAND_THRESHOLDS: readonly { readonly atOrAbove: number; readonly band: MistralQuotaBand }[] =
  [
    { atOrAbove: 1, band: 'exceeded' },
    { atOrAbove: 0.8, band: 'near-limit' },
    { atOrAbove: 0.5, band: 'heavy' },
    { atOrAbove: 0.2, band: 'moderate' },
    { atOrAbove: 0, band: 'quiet' }
  ]

/**
 * When a cycle ends without ever hitting a limit, the ceiling was at least what
 * was spent — and probably more. Raise the learned ceiling to the observed
 * spend plus this headroom fraction, so the estimate creeps up rather than
 * pinning itself to whatever the user happened to use.
 */
const UNTOUCHED_CYCLE_HEADROOM = 1.25

/**
 * A limit event is only worth learning from if a plausible amount was spent
 * first. Below this, the stop was almost certainly the dynamic per-minute token
 * throttle rather than the monthly budget — see MistralRateLimitPatience — and
 * treating it as a budget ceiling would collapse the estimate to near zero.
 */
const MIN_CREDIBLE_CEILING_USD = 0.5

/** Persisted per-cycle accounting. The caller owns storage; this module only
 *  ever returns new values. */
export interface MistralQuotaCycle {
  /** ISO timestamp the current billing cycle began. */
  readonly cycleStartedAt: string
  /** USD spent so far this cycle, accumulated locally. */
  readonly spentUsd: number
  /** Total tokens this cycle, for display alongside spend. */
  readonly totalTokens: number
  /** Turns completed this cycle — the denominator for "typical turn cost". */
  readonly turns: number
  /**
   * Ceiling learned from observation, in USD. Absent until either a limit event
   * is recorded or an untouched cycle rolls over. Once present it outranks the
   * price-anchored seed.
   */
  readonly learnedCeilingUsd?: number
  /** Whether a limit event has ever been recorded (drives `confidence`). */
  readonly sawLimitEvent: boolean
}

/** What the meter renders. */
export interface MistralQuotaEstimate {
  readonly band: MistralQuotaBand
  /** 0-100, clamped. Present even when seeded — `confidence` is what tells the
   *  UI how much to trust it. */
  readonly usedPercent: number
  readonly spentUsd: number
  readonly estimatedCeilingUsd: number
  readonly confidence: MistralQuotaConfidence
  /** Short at-a-glance phrasing for the sidebar. Verbal, never falsely precise. */
  readonly label: string
  /** ISO timestamp the cycle is assumed to reset. */
  readonly cycleResetsAt: string
}

/** A fresh cycle starting at `now`. */
export function startCycle(now: Date, carryOver?: MistralQuotaCycle): MistralQuotaCycle {
  const learned = carryOver?.learnedCeilingUsd
  return {
    cycleStartedAt: now.toISOString(),
    spentUsd: 0,
    totalTokens: 0,
    turns: 0,
    ...(typeof learned === 'number' ? { learnedCeilingUsd: learned } : {}),
    sawLimitEvent: false
  }
}

/**
 * Add an observed turn. `costUsd` comes from the ACP `usage_update` cost, which
 * is ABSENT for a zero-priced model (the local llamacpp lane) — pass 0 there
 * rather than fabricating a price, and the turn still counts toward tokens.
 */
export function accumulate(
  cycle: MistralQuotaCycle,
  turn: { readonly costUsd: number; readonly totalTokens: number }
): MistralQuotaCycle {
  const costUsd = Number.isFinite(turn.costUsd) && turn.costUsd > 0 ? turn.costUsd : 0
  const tokens = Number.isFinite(turn.totalTokens) && turn.totalTokens > 0 ? turn.totalTokens : 0
  return {
    ...cycle,
    spentUsd: cycle.spentUsd + costUsd,
    totalTokens: cycle.totalTokens + tokens,
    turns: cycle.turns + 1
  }
}

/**
 * Record that a limit was actually hit. This is the moment the estimate stops
 * guessing — whatever had been spent when the wall arrived IS the ceiling.
 *
 * Callers must only invoke this for a stop believed to be a BUDGET wall, never
 * for the dynamic per-minute throttle: Vibe raises the same `RateLimitError`
 * with the same message for both, so the distinction is the caller's job (see
 * MistralRateLimitPatience). The MIN_CREDIBLE_CEILING_USD floor is a second
 * line of defence against a throttle being mislearned as a ceiling.
 */
export function recordLimitEvent(cycle: MistralQuotaCycle): MistralQuotaCycle {
  if (cycle.spentUsd < MIN_CREDIBLE_CEILING_USD) {
    // Too cheap to be a monthly budget. Note the event for confidence purposes
    // but refuse to poison the ceiling with it.
    return { ...cycle, sawLimitEvent: true }
  }
  return { ...cycle, learnedCeilingUsd: cycle.spentUsd, sawLimitEvent: true }
}

/**
 * Roll the cycle over if a month has elapsed. A cycle that ended WITHOUT a limit
 * event is evidence the ceiling is at least what was spent, so the learned
 * ceiling creeps upward — this is how a too-low seed corrects itself for a user
 * who never hits a wall at all.
 */
export function rolloverIfElapsed(cycle: MistralQuotaCycle, now: Date): MistralQuotaCycle {
  const started = new Date(cycle.cycleStartedAt)
  if (Number.isNaN(started.getTime())) return startCycle(now)
  if (now.getTime() < nextResetAt(started).getTime()) return cycle

  if (!cycle.sawLimitEvent && cycle.spentUsd > MIN_CREDIBLE_CEILING_USD) {
    const floor = cycle.spentUsd * UNTOUCHED_CYCLE_HEADROOM
    const raised = Math.max(cycle.learnedCeilingUsd ?? 0, floor)
    return startCycle(now, { ...cycle, learnedCeilingUsd: raised })
  }
  return startCycle(now, cycle)
}

/** One month on from `from`, which is what "monthly budget tied to the billing
 *  cycle" means in the absence of a real cycle anchor from Mistral. */
function nextResetAt(from: Date): Date {
  const next = new Date(from.getTime())
  next.setMonth(next.getMonth() + 1)
  return next
}

function bandFor(fraction: number): MistralQuotaBand {
  for (const t of BAND_THRESHOLDS) {
    if (fraction >= t.atOrAbove) return t.band
  }
  return 'quiet'
}

function labelFor(band: MistralQuotaBand, confidence: MistralQuotaConfidence): string {
  const hedge = confidence === 'learned' ? '' : ' (estimated)'
  switch (band) {
    case 'exceeded':
      return `Past the usual monthly limit${hedge}`
    case 'near-limit':
      return `Close to the monthly limit${hedge}`
    case 'heavy':
      return `Used quite a bit this month${hedge}`
    case 'moderate':
      return `Moderate use this month${hedge}`
    case 'quiet':
      return `Light use this month${hedge}`
  }
}

/**
 * Produce the meter reading. `plan` only matters while the ceiling is still
 * seeded; once learned, observation outranks the price anchor entirely.
 */
export function estimateQuota(
  cycle: MistralQuotaCycle,
  plan: MistralPlanId,
  now: Date
): MistralQuotaEstimate {
  const seeded = PLAN_SEED_USD[plan] ?? PLAN_SEED_USD.unknown
  const ceiling = cycle.learnedCeilingUsd ?? seeded
  const safeCeiling = ceiling > 0 ? ceiling : seeded

  const confidence: MistralQuotaConfidence = cycle.sawLimitEvent
    ? 'learned'
    : typeof cycle.learnedCeilingUsd === 'number' || cycle.turns > 0
      ? 'calibrating'
      : 'seeded'

  const fraction = cycle.spentUsd / safeCeiling
  const band = bandFor(fraction)
  const started = new Date(cycle.cycleStartedAt)
  const resetsAt = Number.isNaN(started.getTime()) ? nextResetAt(now) : nextResetAt(started)

  return {
    band,
    usedPercent: Math.max(0, Math.min(100, Math.round(fraction * 100))),
    spentUsd: cycle.spentUsd,
    estimatedCeilingUsd: safeCeiling,
    confidence,
    label: labelFor(band, confidence),
    cycleResetsAt: resetsAt.toISOString()
  }
}
