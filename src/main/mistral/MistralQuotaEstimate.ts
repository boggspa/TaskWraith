/**
 * The Mistral seat's quota model — vendor figures where we can get them, a
 * hedged estimate where we cannot.
 *
 * WHY THIS EXISTS. Every other TaskWraith seat can be metered from a number the
 * vendor hands us: a window with a `resetAt`, a percentage, a remaining count.
 * For a Free/Pro/Team Mistral seat, nothing in the run lane reports one:
 *
 *   1. The Vibe CLI never asks. The whole package speaks to exactly two
 *      endpoints — `/v1/messages` and `/v1/datalake/events` (telemetry). It
 *      fetches no entitlement, balance or budget, and — see MistralUsage.ts —
 *      reports no token usage over ACP either. Our per-turn spend is projected
 *      from CHARACTER COUNTS, so it is an order-of-magnitude signal at best.
 *   2. The Admin API DOES expose exactly the right figure
 *      (`GET /v1/admin/usage`, with a `vibe_usage` category), but it is Preview
 *      and Enterprise-only, and needs a dedicated key from backoffice.mistral.ai
 *      — a standard API key never grants admin access. See MistralAdminUsage.ts:
 *      when a key IS present the reading below becomes `reported` and none of
 *      the guesswork applies.
 *   3. The allowance is not published. mistral.ai/pricing lists plan prices and
 *      feature blurbs but no credit figure; the only place the number appears is
 *      the user's OWN console at admin.mistral.ai/subscription. Since ~3 Aug
 *      2026 that page carries TWO bars — a shared "Included monthly usage" pool
 *      and a Vibe-Code-only "Vibe Code budget" — and this meter tracks only
 *      the seat's two Vibe-plan models, which spend from the SECOND one
 *      (measured; see PLAN_SEED_USD). Key-marked API models are excluded.
 *      That is why {@link MistralQuotaAnchor} exists — the user can read the two
 *      numbers off their own console and hand them to us, which beats any
 *      heuristic and works on every plan.
 *
 * Mistral have said a Vibe usage view is on the roadmap (mistralai/mistral-vibe
 * issue #305, where the maintainer wrote "I can assure you that this is on the
 * roadmap"). When that view ships, it should REPLACE the estimator below, not
 * be layered under it.
 *
 * SOURCE LADDER — strongest wins, per number, independently:
 *
 *   reported    The Admin API answered. Vendor truth.
 *   anchored    The user read their console and typed it in. Vendor truth as of
 *               a timestamp; local accumulation resumes ON TOP of the reading
 *               (see `localSpentUsdAtAnchor`) so the bar keeps moving between
 *               visits without double-counting what the reading already covered.
 *   learned     A real limit event was observed — whatever had been spent when
 *               the wall arrived IS the ceiling.
 *   calibrating Some local observation, no vendor figure and no wall yet.
 *   seeded      Plan-price guess, nothing observed. Deliberately biased LOW: an
 *               underestimate warns early, which is merely noisy; an
 *               overestimate warns late, which is the surprise wall we are
 *               trying to avoid.
 *
 * The numerator and the ceiling are resolved SEPARATELY and carry their own
 * confidences, because the strongest source for each is often different: the
 * Admin API's usage endpoint reports spend but no entitlement, so a reading can
 * legitimately be `reported` spend against an `anchored` ceiling.
 *
 * PURITY. Every function here is total and side-effect-free, and `now` is always
 * a parameter — never read from the clock. Persistence, IPC, currency conversion
 * and rendering all live with the caller; amounts arriving here are ALREADY
 * normalised to USD (the renderer converts using its live FX table before the
 * anchor crosses IPC) and the original figures ride along only as provenance.
 * This mirrors ProviderQuotaWallClassifier.ts, likewise a pure classifier.
 *
 * WHERE THE NUMBERS ARE STILL GUESSWORK, THEY SAY SO. `confidence` is part of
 * the output for exactly that reason: a seeded estimate must never be rendered
 * with the authority of a measured one.
 */

/** Which Mistral plan the user believes they are on. `unknown` is honest and is
 *  the default — we cannot detect the plan, since nothing in the lane reports
 *  it. */
export type MistralPlanId = 'free' | 'pro' | 'team' | 'unknown'

/** Coarse pressure bands. Deliberately verbal rather than numeric: the whole
 *  point is to convey "you have used quite a bit this month" without implying a
 *  precision we do not have. */
export type MistralQuotaBand = 'quiet' | 'moderate' | 'heavy' | 'near-limit' | 'exceeded'

/** How much a figure is worth believing. See the source ladder in the header. */
export type MistralQuotaConfidence =
  /** Price-anchored guess, no observations yet. */
  | 'seeded'
  /** Some evidence gathered, not yet a limit event. */
  | 'calibrating'
  /** A real limit event has been observed and recorded. */
  | 'learned'
  /** The user read the figure off their own Mistral console and entered it. */
  | 'anchored'
  /** The Admin API reported it. */
  | 'reported'

/** True when a figure came from Mistral rather than from our own inference. */
export function isVendorReportedConfidence(confidence: MistralQuotaConfidence): boolean {
  return confidence === 'anchored' || confidence === 'reported'
}

/**
 * Figures the user read off admin.mistral.ai/subscription and entered by hand.
 *
 * This is the highest-quality source available to a non-Enterprise seat, and the
 * only one that yields an ALLOWANCE — Mistral publish the number nowhere else.
 * Amounts are USD, already converted by the caller.
 */
export interface MistralQuotaAnchor {
  /** "Included monthly usage" ceiling, in USD. */
  readonly allowanceUsd: number
  /** Spend the console showed at `observedAt`, in USD. */
  readonly spentUsd: number
  /**
   * `cycle.spentUsd` at the instant the anchor was taken.
   *
   * The reading already accounts for everything spent up to that moment, so
   * only accumulation ABOVE this watermark may be added on top. Without it a
   * fresh anchor would be double-counted against the whole cycle's local total.
   */
  readonly localSpentUsdAtAnchor: number
  /** When the user took the reading. */
  readonly observedAt: string
  /**
   * The reset the console showed. Mistral's cycle follows the account's own
   * anniversary, NOT the 1st of the month (observed: a 27 Jul reading said
   * "Resets in 4 days"), so this is the only way to get the date right.
   */
  readonly cycleResetsAt?: string
  /** Exactly what the user typed, before conversion — provenance for the UI. */
  readonly declared?: {
    readonly allowance: number
    readonly spent: number
    readonly currency: string
  }
}

/** Figures returned by the Admin API. Amounts are USD, converted by the caller. */
export interface MistralQuotaReport {
  /** Spend for the reported period, in USD. */
  readonly spentUsd: number
  /**
   * `cycle.spentUsd` when this report was applied. The Admin API reading already
   * includes everything before that watermark; only later local estimates may
   * be added on top. Optional for schema-v1 files written before the watermark
   * existed — those safely show the report alone until the next refresh.
   */
  readonly localSpentUsdAtReport?: number
  /**
   * Entitlement, when the response carries one. The documented usage endpoint
   * reports CONSUMPTION only, so expect this to be absent and the ceiling to
   * fall through to the anchor or the seed.
   */
  readonly allowanceUsd?: number
  readonly fetchedAt: string
  readonly periodStart?: string
  readonly periodEnd?: string
  /** The raw vendor figure, before conversion — provenance for the UI. */
  readonly declared?: {
    readonly spent: number
    readonly currency: string
  }
  /**
   * The console's separate "API usage" bar, when the reading carried one (the
   * web-session lane reads both bars; the Admin API reports no such split).
   * Display-only: this seat spends from the Vibe Code budget, so these figures
   * never join the metered spend/ceiling — see the pool-split doctrine above.
   */
  readonly apiUsage?: {
    readonly spentUsd: number
    readonly allowanceUsd?: number
    /** The raw console figures, before conversion — the UI quotes these. */
    readonly declared?: {
      readonly spent: number
      readonly allowance?: number
      readonly currency: string
    }
  }
}

/**
 * Assumed monthly VIBE CODE budget per plan, in USD.
 *
 * ── WHICH POOL THIS SEAT ACTUALLY SPENDS FROM (measured 2026-08-06) ──────────
 * admin.mistral.ai/subscription now shows TWO bars, and they are not the same
 * money:
 *
 *   "Included monthly usage"  €25.50 on Pro — shared across Studio, Vibe Code
 *                             or API.
 *   "Vibe Code budget"        €255 on Pro — "extra monthly usage on top of your
 *                             API budget", Vibe Code only.
 *
 * The Vibe Code bar appeared around 3 Aug 2026, and from that point Vibe stopped
 * debiting the shared pool. Measured on one Pro account inside a single billing
 * cycle: €5.49 of Vibe spend moved the Vibe bar €15.81 -> €21.30 and left the
 * shared bar at €1.84, unchanged TO THE CENT. Proportional draw across the two
 * pools would have added ~€0.55 to the shared bar; it did not move at all. The
 * same account's API usage page read €0.00 for the whole month, so the residual
 * €1.84 is frozen Vibe spend from 1-3 Aug, before the split.
 *
 * So this seat's ceiling is the VIBE CODE budget. The old €25.50 figure is not
 * merely stale — nothing this seat does debits that pool any more, and metering
 * against it under-read the real ceiling by ~10x, which walls a user at a tenth
 * of their runway.
 *
 * USD values carry the EUR figures at roughly 1.09 USD/EUR. The EUR numbers are
 * the source of truth — re-derive from them, don't drift the USD.
 *
 * `free` is deliberately UNCHANGED at the old €8.50 shared-pool figure: Free's
 * own Vibe Code budget has never been observed. It is kept as a FLOOR, because
 * erring low warns early, and `unknown` seeds from it.
 *
 * `team` is NOT observed either. It stays seeded at Pro's budget as a FLOOR
 * ("Team cannot plausibly include less than Pro"), which is safe reasoning,
 * rather than extrapolating a specific larger number, which would be invention.
 *
 * All of these are per-account readings from one console, and neither allowance
 * appears anywhere in Mistral's public pricing — so they are better DEFAULTS,
 * not facts. An {@link MistralQuotaAnchor} outranks them the moment one exists.
 */
const PLAN_SEED_USD: Readonly<Record<MistralPlanId, number>> = {
  free: 9.25,
  pro: 278,
  team: 278,
  unknown: 9.25
}

/**
 * `unknown` seeds at the FREE allowance rather than the Pro price.
 *
 * The plan is undetectable from the lane, so `unknown` is the default every user
 * starts on — and seeding it at 14.99 meant the common case (a Free seat that
 * never told us its plan) was metered against a ceiling 62% too high, the exact
 * late-warning failure PLAN_SEED_USD exists to avoid. Seeding low is the whole
 * doctrine; `unknown` must follow it too.
 */
export const MISTRAL_UNKNOWN_PLAN_SEEDS_AS: MistralPlanId = 'free'

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
  /**
   * The user's console reading for THIS cycle. Dropped at rollover — it
   * described a period that has ended.
   */
  readonly anchor?: MistralQuotaAnchor
  /** The most recent Admin API answer. Dropped at rollover, same reasoning. */
  readonly report?: MistralQuotaReport
  /**
   * Allowance carried ACROSS cycles once a vendor source has told us one. The
   * allowance is a property of the plan, not of the month, so re-anchoring every
   * cycle would be busywork — a user who reads their console once keeps the
   * right ceiling until they change plan.
   */
  readonly knownAllowanceUsd?: number
  /**
   * The real reset instant, carried across cycles and advanced monthly. Mistral
   * bills on the account anniversary, so once we learn the true date we keep it
   * rather than re-deriving from when we happened to start watching.
   */
  readonly knownResetAt?: string
}

/** Where one number in the reading came from. */
export interface MistralQuotaFigureSource {
  readonly confidence: MistralQuotaConfidence
  /** The vendor's own figure and currency, when the source had one. */
  readonly declared?: { readonly amount: number; readonly currency: string }
  /** When the underlying reading was taken (anchor) or fetched (report). */
  readonly asOf?: string
}

/** What the meter renders. */
export interface MistralQuotaEstimate {
  readonly band: MistralQuotaBand
  /** 0-100, clamped. Present even when seeded — `confidence` is what tells the
   *  UI how much to trust it. */
  readonly usedPercent: number
  readonly spentUsd: number
  /**
   * Estimated spend observed locally after the latest console/Admin reading.
   * This is broken out so renderers can show that a low-cost Devstral turn is
   * moving the total even when ordinary two-decimal currency rounding hides it.
   */
  readonly locallyEstimatedSinceReadingUsd: number
  readonly estimatedCeilingUsd: number
  /**
   * Confidence in the SPEND figure — the number the user actually watches.
   * Kept as `confidence` (not renamed) so existing callers keep working.
   */
  readonly confidence: MistralQuotaConfidence
  /**
   * Confidence in the CEILING, resolved independently. The Admin API reports
   * consumption but no entitlement, so `reported` spend against a `seeded`
   * ceiling is a normal, expected combination.
   */
  readonly ceilingConfidence: MistralQuotaConfidence
  /** Provenance for each half, for tooltips that must explain themselves. */
  readonly spentSource: MistralQuotaFigureSource
  readonly ceilingSource: MistralQuotaFigureSource
  /**
   * True when BOTH halves came from Mistral — the only case in which the meter
   * may drop its hedging and render a plain percentage.
   */
  readonly vendorReported: boolean
  /** Short at-a-glance phrasing for the sidebar. Verbal, never falsely precise. */
  readonly label: string
  /** ISO timestamp the cycle is assumed to reset. */
  readonly cycleResetsAt: string
  /**
   * The console's "API usage" bar, surfaced verbatim when the latest report
   * carried one. A second display window beside the Vibe meter — never merged
   * into it, because the seat does not spend from that pool.
   */
  readonly apiUsage?: {
    /** Present only when the reading carried an allowance to divide by. */
    readonly usedPercent?: number
    readonly spentUsd: number
    readonly allowanceUsd?: number
    readonly declared?: {
      readonly spent: number
      readonly allowance?: number
      readonly currency: string
    }
    /** When the underlying reading was fetched. */
    readonly asOf: string
  }
}

/**
 * A fresh cycle starting at `now`.
 *
 * The per-cycle observations (`anchor`, `report`) are deliberately NOT carried:
 * each described a period that has ended, and re-showing last month's console
 * reading against this month's burn would be a lie. What DOES carry is the
 * plan-level knowledge behind them — the allowance and the real reset date.
 */
export function startCycle(now: Date, carryOver?: MistralQuotaCycle): MistralQuotaCycle {
  const learned = carryOver?.learnedCeilingUsd
  const allowance = carryOver?.knownAllowanceUsd ?? carryOver?.anchor?.allowanceUsd
  const knownReset = carryOver?.knownResetAt ?? carryOver?.anchor?.cycleResetsAt
  const advancedReset = knownReset ? advanceResetPast(knownReset, now) : undefined
  return {
    cycleStartedAt: now.toISOString(),
    spentUsd: 0,
    totalTokens: 0,
    turns: 0,
    ...(typeof learned === 'number' ? { learnedCeilingUsd: learned } : {}),
    ...(typeof allowance === 'number' && allowance > 0 ? { knownAllowanceUsd: allowance } : {}),
    ...(advancedReset ? { knownResetAt: advancedReset } : {}),
    sawLimitEvent: false
  }
}

/**
 * Attach a console reading to the cycle.
 *
 * `localSpentUsdAtAnchor` is stamped from the cycle's CURRENT local total, which
 * is what makes anchor-then-accumulate correct: everything already accumulated
 * is, by definition, part of what the console was showing, so only later turns
 * may be added on top.
 */
export function applyAnchor(
  cycle: MistralQuotaCycle,
  reading: {
    readonly allowanceUsd: number
    readonly spentUsd: number
    readonly observedAt: string
    readonly cycleResetsAt?: string
    readonly declared?: MistralQuotaAnchor['declared']
  }
): MistralQuotaCycle {
  const allowanceUsd = positiveOrZero(reading.allowanceUsd)
  const spentUsd = positiveOrZero(reading.spentUsd)
  const anchor: MistralQuotaAnchor = {
    allowanceUsd,
    spentUsd,
    localSpentUsdAtAnchor: cycle.spentUsd,
    observedAt: reading.observedAt,
    ...(reading.cycleResetsAt ? { cycleResetsAt: reading.cycleResetsAt } : {}),
    ...(reading.declared ? { declared: reading.declared } : {})
  }
  return {
    ...cycle,
    anchor,
    ...(allowanceUsd > 0 ? { knownAllowanceUsd: allowanceUsd } : {}),
    ...(reading.cycleResetsAt ? { knownResetAt: reading.cycleResetsAt } : {})
  }
}

/** Drop the console reading, falling back to local accumulation. */
export function clearAnchor(cycle: MistralQuotaCycle): MistralQuotaCycle {
  if (!cycle.anchor) return cycle
  const next = { ...cycle }
  delete (next as { anchor?: MistralQuotaAnchor }).anchor
  return next
}

/** Attach the Admin API's answer. Replaces any previous report outright. */
export function applyReport(
  cycle: MistralQuotaCycle,
  report: MistralQuotaReport
): MistralQuotaCycle {
  const allowanceUsd = positiveOrZero(report.allowanceUsd ?? 0)
  return {
    ...cycle,
    report: { ...report, localSpentUsdAtReport: cycle.spentUsd },
    ...(allowanceUsd > 0 ? { knownAllowanceUsd: allowanceUsd } : {})
  }
}

function positiveOrZero(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
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
  // Deliberately `cycleEndsAt`, NOT `resolveResetAt`: the latter advances past
  // `now` for display, which would make this comparison permanently false and
  // freeze the cycle forever.
  if (now.getTime() < cycleEndsAt(cycle).getTime()) return cycle

  if (!cycle.sawLimitEvent && cycle.spentUsd > MIN_CREDIBLE_CEILING_USD) {
    const floor = cycle.spentUsd * UNTOUCHED_CYCLE_HEADROOM
    const raised = Math.max(cycle.learnedCeilingUsd ?? 0, floor)
    return startCycle(now, { ...cycle, learnedCeilingUsd: raised })
  }
  return startCycle(now, cycle)
}

/**
 * The instant that ENDS the current cycle — not advanced past `now`.
 *
 * Mistral bills on the ACCOUNT'S OWN anniversary, not the 1st of the month: a
 * console read on 27 Jul said "Resets in 4 days", i.e. the 31st. So a known real
 * reset (learned from an anchor) always wins.
 *
 * Falling back to `cycleStartedAt + 1 month` is the old behaviour and is
 * knowingly approximate — it anchors to the moment TaskWraith first saw the
 * seat, which has nothing to do with the billing anniversary and can be most of
 * a month out. That is precisely why the anchor carries `cycleResetsAt`.
 */
function cycleEndsAt(cycle: MistralQuotaCycle): Date {
  const known = cycle.knownResetAt ?? cycle.anchor?.cycleResetsAt
  if (known) {
    const parsed = new Date(known)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  const started = new Date(cycle.cycleStartedAt)
  return addMonthsUtc(Number.isNaN(started.getTime()) ? new Date() : started, 1)
}

/** The next reset the UI should show: the cycle end, rolled forward past `now`
 *  so a cycle that has not been rolled over yet still displays a future date. */
function resolveResetAt(cycle: MistralQuotaCycle, now: Date): Date {
  const known = cycle.knownResetAt ?? cycle.anchor?.cycleResetsAt
  if (known) {
    const parsed = new Date(known)
    if (!Number.isNaN(parsed.getTime())) return new Date(advanceResetPast(known, now))
  }
  const started = new Date(cycle.cycleStartedAt)
  return addMonthsUtc(Number.isNaN(started.getTime()) ? now : started, 1)
}

/**
 * Roll a known reset instant forward by whole months until it is in the future.
 *
 * Each candidate is computed from the ORIGINAL anchor date rather than by
 * repeatedly stepping the previous result. That matters for a month-end
 * anniversary: stepping 31 Jul → 31 Aug → (no 31 Sep) → 30 Sep would then give
 * 30 Oct, permanently losing the 31st. Recomputing from the anchor keeps
 * 31 Jul → 30 Sep → 31 Oct.
 *
 * Bounded rather than a bare `while`: a corrupt far-past date must not spin the
 * main process. 480 months is 40 years, far beyond any real drift.
 */
function advanceResetPast(iso: string, now: Date): string {
  const anchor = new Date(iso)
  if (Number.isNaN(anchor.getTime())) return addMonthsUtc(now, 1).toISOString()
  if (anchor.getTime() > now.getTime()) return anchor.toISOString()
  for (let months = 1; months <= 480; months += 1) {
    const candidate = addMonthsUtc(anchor, months)
    if (candidate.getTime() > now.getTime()) return candidate.toISOString()
  }
  return addMonthsUtc(now, 1).toISOString()
}

/**
 * Add whole months in UTC, clamping to the target month's last day.
 *
 * `Date.prototype.setMonth` is LOCAL-time and overflows rather than clamping —
 * on a BST machine it turned a 31 Jul UTC reset into 1 Nov 01:00 UTC, drifting
 * both the day and the hour. Everything here is a stored UTC instant, so the
 * arithmetic has to be UTC too.
 */
function addMonthsUtc(from: Date, months: number): Date {
  const year = from.getUTCFullYear()
  const month = from.getUTCMonth()
  const day = from.getUTCDate()
  // Day 0 of the following month is the last day of the target month.
  const lastDayOfTarget = new Date(Date.UTC(year, month + months + 1, 0)).getUTCDate()
  return new Date(
    Date.UTC(
      year,
      month + months,
      Math.min(day, lastDayOfTarget),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds()
    )
  )
}

function bandFor(fraction: number): MistralQuotaBand {
  for (const t of BAND_THRESHOLDS) {
    if (fraction >= t.atOrAbove) return t.band
  }
  return 'quiet'
}

/**
 * Phrasing. Hedged unless BOTH halves came from Mistral — a real spend against a
 * guessed ceiling is still a guessed percentage, so it must still read as one.
 */
function labelFor(
  band: MistralQuotaBand,
  spent: MistralQuotaConfidence,
  ceiling: MistralQuotaConfidence,
  hasLocalEstimateSinceReading = false
): string {
  const measured =
    !hasLocalEstimateSinceReading &&
    isVendorReportedConfidence(spent) &&
    isVendorReportedConfidence(ceiling)
  const hedge = measured || (spent === 'learned' && ceiling === 'learned') ? '' : ' (estimated)'
  switch (band) {
    case 'exceeded':
      return measured ? 'Past the monthly limit' : `Past the usual monthly limit${hedge}`
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
 * Resolve the SPEND half.
 *
 * Precedence is report > anchor > local accumulation. The anchor case is the
 * interesting one: the console reading is the floor, and only local spend
 * accumulated ABOVE the watermark stamped at anchor time is added on top — so
 * the bar keeps moving between console visits without re-counting turns the
 * reading already included.
 */
function resolveSpend(cycle: MistralQuotaCycle): {
  spentUsd: number
  locallyEstimatedSinceReadingUsd: number
  source: MistralQuotaFigureSource
} {
  const report = cycle.report
  if (report && Number.isFinite(report.spentUsd)) {
    const watermark = report.localSpentUsdAtReport
    const sinceReport =
      typeof watermark === 'number' && Number.isFinite(watermark)
        ? Math.max(0, cycle.spentUsd - watermark)
        : 0
    return {
      spentUsd: Math.max(0, report.spentUsd + sinceReport),
      locallyEstimatedSinceReadingUsd: sinceReport,
      source: {
        confidence: 'reported',
        ...(report.declared
          ? { declared: { amount: report.declared.spent, currency: report.declared.currency } }
          : {}),
        asOf: report.fetchedAt
      }
    }
  }
  const anchor = cycle.anchor
  if (anchor && Number.isFinite(anchor.spentUsd)) {
    const sinceAnchor = Math.max(0, cycle.spentUsd - anchor.localSpentUsdAtAnchor)
    return {
      spentUsd: Math.max(0, anchor.spentUsd + sinceAnchor),
      locallyEstimatedSinceReadingUsd: sinceAnchor,
      source: {
        confidence: 'anchored',
        ...(anchor.declared
          ? { declared: { amount: anchor.declared.spent, currency: anchor.declared.currency } }
          : {}),
        asOf: anchor.observedAt
      }
    }
  }
  return {
    spentUsd: Math.max(0, cycle.spentUsd),
    locallyEstimatedSinceReadingUsd: 0,
    source: { confidence: cycle.turns > 0 ? 'calibrating' : 'seeded' }
  }
}

/** Resolve the CEILING half: report > anchor > carried allowance > learned > seed. */
function resolveCeiling(
  cycle: MistralQuotaCycle,
  seeded: number
): { ceilingUsd: number; source: MistralQuotaFigureSource } {
  const reported = cycle.report?.allowanceUsd
  if (typeof reported === 'number' && reported > 0) {
    return {
      ceilingUsd: reported,
      source: { confidence: 'reported', asOf: cycle.report?.fetchedAt }
    }
  }
  const anchored = cycle.anchor?.allowanceUsd
  if (typeof anchored === 'number' && anchored > 0) {
    return {
      ceilingUsd: anchored,
      source: {
        confidence: 'anchored',
        ...(cycle.anchor?.declared
          ? {
              declared: {
                amount: cycle.anchor.declared.allowance,
                currency: cycle.anchor.declared.currency
              }
            }
          : {}),
        asOf: cycle.anchor?.observedAt
      }
    }
  }
  // Carried from a previous cycle's vendor source — still a vendor figure, just
  // not re-read this month.
  if (typeof cycle.knownAllowanceUsd === 'number' && cycle.knownAllowanceUsd > 0) {
    return { ceilingUsd: cycle.knownAllowanceUsd, source: { confidence: 'anchored' } }
  }
  if (typeof cycle.learnedCeilingUsd === 'number' && cycle.learnedCeilingUsd > 0) {
    return { ceilingUsd: cycle.learnedCeilingUsd, source: { confidence: 'learned' } }
  }
  return { ceilingUsd: seeded, source: { confidence: 'seeded' } }
}

/**
 * Produce the meter reading. `plan` only matters while the ceiling is still
 * seeded; any vendor source outranks the plan default entirely.
 */
export function estimateQuota(
  cycle: MistralQuotaCycle,
  plan: MistralPlanId,
  now: Date
): MistralQuotaEstimate {
  const effectivePlan = plan === 'unknown' ? MISTRAL_UNKNOWN_PLAN_SEEDS_AS : plan
  const seeded = PLAN_SEED_USD[effectivePlan] ?? PLAN_SEED_USD.unknown

  const { spentUsd, locallyEstimatedSinceReadingUsd, source: spentSource } = resolveSpend(cycle)
  const { ceilingUsd, source: ceilingSource } = resolveCeiling(cycle, seeded)
  const safeCeiling = ceilingUsd > 0 ? ceilingUsd : seeded

  // A recorded wall outranks a merely-accumulating spend reading, but never a
  // vendor figure: the vendor knows what it charged better than we know when it
  // stopped us.
  const spentConfidence: MistralQuotaConfidence =
    !isVendorReportedConfidence(spentSource.confidence) && cycle.sawLimitEvent
      ? 'learned'
      : spentSource.confidence

  const fraction = spentUsd / safeCeiling
  const band = bandFor(fraction)
  const vendorReported =
    locallyEstimatedSinceReadingUsd <= 0 &&
    isVendorReportedConfidence(spentConfidence) &&
    isVendorReportedConfidence(ceilingSource.confidence)

  const reportedApiUsage = cycle.report?.apiUsage
  const apiUsage: MistralQuotaEstimate['apiUsage'] = reportedApiUsage
    ? {
        spentUsd: reportedApiUsage.spentUsd,
        ...(reportedApiUsage.allowanceUsd && reportedApiUsage.allowanceUsd > 0
          ? {
              allowanceUsd: reportedApiUsage.allowanceUsd,
              usedPercent: Math.max(
                0,
                Math.min(
                  100,
                  Math.round((reportedApiUsage.spentUsd / reportedApiUsage.allowanceUsd) * 100)
                )
              )
            }
          : {}),
        ...(reportedApiUsage.declared ? { declared: reportedApiUsage.declared } : {}),
        asOf: cycle.report?.fetchedAt ?? now.toISOString()
      }
    : undefined

  return {
    band,
    usedPercent: Math.max(0, Math.min(100, Math.round(fraction * 100))),
    spentUsd,
    locallyEstimatedSinceReadingUsd,
    estimatedCeilingUsd: safeCeiling,
    confidence: spentConfidence,
    ceilingConfidence: ceilingSource.confidence,
    spentSource: { ...spentSource, confidence: spentConfidence },
    ceilingSource,
    vendorReported,
    label: labelFor(
      band,
      spentConfidence,
      ceilingSource.confidence,
      locallyEstimatedSinceReadingUsd > 0
    ),
    cycleResetsAt: resolveResetAt(cycle, now).toISOString(),
    ...(apiUsage ? { apiUsage } : {})
  }
}
