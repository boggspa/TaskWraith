import type { MistralQuotaReport } from './MistralQuotaEstimate'
import type { MistralWebSubscriptionResult } from './MistralWebSubscriptionClient'
import { fetchMistralWebSubscription } from './MistralWebSubscriptionClient'
import { convertVendorAmountToUsd } from './MistralAdminUsage'

/**
 * The web-session refresh lane: turns admin.mistral.ai/subscription readings
 * (via the imported cookie, see MistralWebSessionStore) into quota-store
 * reports, automatically.
 *
 * WHERE THIS SITS IN THE SOURCE LADDER. A web reading is the console's own two
 * bars — the same numbers a hand-typed anchor transcribes, fetched instead of
 * typed. It flows through the EXISTING report mechanism (`setReport`), which
 * `resolveSpend`/`resolveCeiling` already rank above the anchor; carrying the
 * Vibe allowance makes the previously-unreachable `reported` ceiling real.
 * The seat meters against the VIBE CODE budget (see the pool-split doctrine in
 * MistralQuotaEstimate.ts); the API bar rides along as display-only
 * `apiUsage`, never merged into the metered figures.
 *
 * CADENCE. There is no timer. `maybeRefresh()` is fired (and forgotten) from
 * the `mistral-quota:get` read path, which the renderer already polls every
 * 30s while visible — so a configured session refreshes itself at most once
 * per TTL without adding a main-side scheduler or a new IPC channel. Import
 * absorbs immediately via `absorbSummary` (the capture was already validated
 * and parsed — refetching it would be waste).
 *
 * CURRENCY. Conversion uses the Admin lane's static table
 * (convertVendorAmountToUsd): this lane starts in main, where live renderer FX
 * is out of reach by design — see the header of MistralAdminUsage.ts. The
 * exact console figures ride along in `declared`, so the UI can always quote
 * what the console actually said.
 */

const WEB_USAGE_SUCCESS_TTL_MS = 5 * 60 * 1000
const WEB_USAGE_FAILURE_RETRY_MS = 60 * 1000

export interface MistralWebUsageLaneDeps {
  /** The web-session envelope read; anything but status 'ok' means no lane. */
  loadCookie: () => { status: string; value?: string }
  setReport: (
    report: MistralQuotaReport,
    options?: { startCycleIfMissing?: boolean }
  ) => Promise<void>
  fetchSubscription?: (cookieHeader: string) => Promise<MistralWebSubscriptionResult | null>
  convertToUsd?: (amount: number, currency?: string) => number
  now?: () => Date
}

export interface MistralWebUsageLane {
  /** Fire-and-forget TTL'd refresh; safe to call on every quota read. */
  maybeRefresh(): void
  /** Import-time absorption of an already-validated capture. */
  absorbSummary(summary: MistralWebSubscriptionResult): Promise<void>
}

/** Pure half: a subscription read becomes a quota report, or null when the
 *  page carried no Vibe figure to meter against. Exported for tests. */
export function buildMistralWebReport(
  summary: MistralWebSubscriptionResult,
  fetchedAt: Date,
  convertToUsd: (amount: number, currency?: string) => number = convertVendorAmountToUsd
): MistralQuotaReport | null {
  const vibeSpent = summary.vibeSpent
  if (!Number.isFinite(vibeSpent) || (vibeSpent as number) < 0) return null
  const currency = summary.currency
  const vibeAllowance =
    Number.isFinite(summary.vibeAllowance) && (summary.vibeAllowance as number) > 0
      ? (summary.vibeAllowance as number)
      : undefined
  const apiSpent =
    Number.isFinite(summary.apiSpent) && (summary.apiSpent as number) >= 0
      ? (summary.apiSpent as number)
      : undefined
  const apiAllowance =
    Number.isFinite(summary.apiAllowance) && (summary.apiAllowance as number) > 0
      ? (summary.apiAllowance as number)
      : undefined
  return {
    spentUsd: convertToUsd(vibeSpent as number, currency),
    ...(vibeAllowance !== undefined
      ? { allowanceUsd: convertToUsd(vibeAllowance, currency) }
      : {}),
    fetchedAt: fetchedAt.toISOString(),
    ...(summary.periodEnd && !Number.isNaN(summary.periodEnd.getTime())
      ? { periodEnd: summary.periodEnd.toISOString() }
      : {}),
    declared: { spent: vibeSpent as number, currency },
    ...(apiSpent !== undefined
      ? {
          apiUsage: {
            spentUsd: convertToUsd(apiSpent, currency),
            ...(apiAllowance !== undefined
              ? { allowanceUsd: convertToUsd(apiAllowance, currency) }
              : {}),
            declared: {
              spent: apiSpent,
              ...(apiAllowance !== undefined ? { allowance: apiAllowance } : {}),
              currency
            }
          }
        }
      : {})
  }
}

export function createMistralWebUsageLane(deps: MistralWebUsageLaneDeps): MistralWebUsageLane {
  const now = deps.now ?? (() => new Date())
  const fetchSubscription = deps.fetchSubscription ?? fetchMistralWebSubscription
  const convertToUsd = deps.convertToUsd ?? convertVendorAmountToUsd

  let inFlight: Promise<void> | null = null
  let nextAttemptAtMs = 0

  const absorb = async (summary: MistralWebSubscriptionResult): Promise<boolean> => {
    const report = buildMistralWebReport(summary, now(), convertToUsd)
    if (!report) return false
    // The import (and the refresh that follows one) is a deliberate act — the
    // user connected their console precisely to see these numbers, so the
    // report may start a cycle on a seat that has never run.
    await deps.setReport(report, { startCycleIfMissing: true })
    return true
  }

  return {
    maybeRefresh(): void {
      if (inFlight) return
      const nowMs = now().getTime()
      if (nowMs < nextAttemptAtMs) return
      const cookie = deps.loadCookie()
      if (cookie.status !== 'ok' || !cookie.value) return
      // Claim the slot before the await so overlapping reads cannot start a
      // second fetch; the TTL is stamped when the attempt settles.
      inFlight = (async () => {
        try {
          const summary = await fetchSubscription(cookie.value as string)
          const absorbed = summary ? await absorb(summary) : false
          nextAttemptAtMs =
            now().getTime() + (absorbed ? WEB_USAGE_SUCCESS_TTL_MS : WEB_USAGE_FAILURE_RETRY_MS)
        } catch {
          nextAttemptAtMs = now().getTime() + WEB_USAGE_FAILURE_RETRY_MS
        } finally {
          inFlight = null
        }
      })()
    },

    async absorbSummary(summary: MistralWebSubscriptionResult): Promise<void> {
      const absorbed = await absorb(summary)
      if (absorbed) {
        // A fresh import IS a successful read; don't refetch it on the next poll.
        nextAttemptAtMs = now().getTime() + WEB_USAGE_SUCCESS_TTL_MS
      }
    }
  }
}
