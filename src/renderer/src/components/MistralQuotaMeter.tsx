/*
 * MistralQuotaMeter — the Mistral Vibe seat's sidebar quota band.
 *
 * WHAT MAKES THIS ONE DIFFERENT. Every other row in the Model Usage card
 * renders a number a vendor reported. This row renders whichever source is
 * strongest — see the ladder in MistralQuotaEstimate.ts — and hedges itself
 * according to how good that source actually is. With no vendor source it falls
 * back to TaskWraith's own estimate, built from spend observed locally on this
 * Mac against a plan-default ceiling.
 *
 * TWO CORRECTIONS TO WHAT THIS FILE USED TO CLAIM, both from consoles read on
 * 2026-07-27:
 *
 *   - "Mistral publishes no quota figure for any plan" — the SUBSCRIPTION
 *     console does. It is per-account and appears in no public pricing page,
 *     which is why the user enters it rather than us hardcoding it. Since ~3 Aug
 *     2026 it shows TWO bars, and this seat is metered against the second: the
 *     Vibe-Code-only "Vibe Code budget" (€255 on Pro), not the shared "Included
 *     monthly usage" bar (€25.50). See PLAN_SEED_USD for the measurement.
 *   - "overflow is pay-as-you-go, so there is no wall to hit" — pay-as-you-go
 *     for Vibe Code is its own toggle and ships DISABLED. With it off, exhausting
 *     the budget STOPS the seat until the cycle resets. There is a wall, which is
 *     precisely why this meter matters.
 *
 * The user asked for exactly this and no more: "even if it's just 'I have used
 * quite a bit this month' rather than 'where is the ceiling vs my usage'".
 * Honouring that precisely is the whole design:
 *
 *   - The primary text is `estimate.label`, which hedges itself
 *     ("Moderate use this month (estimated)").
 *   - Money carries the house `~` tilde plus an "estimated, not billed" tooltip,
 *     the same convention as the API-spend rows.
 *   - A bare percentage is NEVER rendered. `usedPercent` drives the bar's
 *     length, where it reads as a band, and nothing else.
 *   - Until the reading is backed by something real — a vendor figure, or a
 *     limit event that calibrated the ceiling — the fill is hatched and dimmed,
 *     so a plan-default guess cannot be mistaken for a measured value.
 *
 * SHAPE. Follows GrokCreditsMeter, not the generic quota-window path:
 * `ProviderUsageBlock` only ever renders `entry.windows`, so a provider with a
 * bespoke data model has to splice its own component into the card's JSX.
 *
 * GATE. Presence of a persisted cycle — i.e. the user has actually run the
 * seat. The main process returns null until then and the view renders nothing,
 * so a user who never touches Mistral never sees an estimate of a budget they
 * are not spending.
 *
 * Pure presentational view (`MistralQuotaMeterView`, SSR-testable) + a thin IPC
 * shell. The read is a cheap local file, not a probe, so it follows usage
 * broadcasts directly and carries a slow visible-window self-heal heartbeat.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { MistralQuotaSnapshot } from '../../../main/mistral/MistralQuotaStore'
import type {
  MistralQuotaEstimate,
  MistralQuotaFigureSource
} from '../../../main/mistral/MistralQuotaEstimate'
import { formatResetShort } from '../lib/UsageFormat'
import { formatCostAlwaysOn, type DisplayCurrency } from '../lib/formatCost'
import { providerPlanName } from '../lib/providerPlanName'
import {
  formatMistralAccumulatedSpend,
  formatMistralLocalIncrement
} from './MistralQuotaFormatting'
import { ProviderLogoTile } from './ProviderLogoTile'
import { QuotaProgressBar } from './QuotaProgressBar'
import './MistralQuotaMeter.css'

/** The standing explanation. Long by design — it is the only place the user can
 *  learn WHY this row is hedged, and a meter that hides its own basis is worse
 *  than no meter. */
const ESTIMATE_TOOLTIP = [
  'Mistral publishes no quota figure for any plan and exposes no usage endpoint,',
  'so nothing here comes from Mistral.',
  'This is TaskWraith’s own estimate, from spend observed locally on this Mac.'
].join(' ')

const SEEDED_TOOLTIP = [
  'The ceiling is still anchored to the plan price and is deliberately',
  'pessimistic, so early readings warn early. It calibrates as the seat is used.'
].join(' ')

const MONEY_TOOLTIP = 'Estimated spend this cycle — projected locally, never billed or reported.'
const MIXED_MONEY_TOOLTIP =
  'Your Mistral reading plus TaskWraith’s locally estimated spend since that reading.'

/** Cheap local IPC reads keep the meter self-healing even when a completed run
 *  is persisted main-side without the renderer-originated usage broadcast. */
const MISTRAL_QUOTA_REFRESH_INTERVAL_MS = 30_000
/** Re-read once more after a usage event so a cross-process notification cannot
 *  win a race with the quota store's async first load. */
const MISTRAL_QUOTA_USAGE_SETTLE_MS = 250

/**
 * Console-exact money for the API-usage row. Limit Counter renders Mistral
 * currency figures with extra precision so a tiny API spend (€0.0004) does not
 * round to a lying €0.00; this keeps that property while trimming the padding
 * zeros LC's fixed four decimals would show on ordinary amounts.
 */
function formatDeclaredAmount(amount: number, currency: string, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4
    }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}

/** Where each half of a vendor-sourced reading came from, stated plainly. */
function sourcePhrase(source: MistralQuotaFigureSource): string {
  const origin =
    source.confidence === 'reported'
      ? "Mistral's Admin API"
      : source.confidence === 'anchored'
        ? 'your Mistral console'
        : 'a local estimate'
  const declared = source.declared
    ? ` (${source.declared.currency} ${source.declared.amount.toFixed(2)})`
    : ''
  return `${origin}${declared}`
}

/** Replaces the hedged tooltip once the figures are Mistral's own. */
function vendorTooltip(estimate: MistralQuotaEstimate): string {
  const asOf = estimate.spentSource.asOf ? new Date(estimate.spentSource.asOf) : null
  const when = asOf && !Number.isNaN(asOf.getTime()) ? ` Read ${asOf.toLocaleString()}.` : ''
  return [
    `Spend from ${sourcePhrase(estimate.spentSource)};`,
    `allowance from ${sourcePhrase(estimate.ceilingSource)}.${when}`,
    'Local estimates are added on top of the reading until you refresh it.'
  ].join(' ')
}

export interface MistralQuotaMeterViewProps {
  /** null until the seat has been run at least once — the row stays hidden. */
  snapshot: MistralQuotaSnapshot | null
  loading: boolean
  /** The user's display currency (Settings → General). The estimate's figures
   *  are USD; the same FX table that converted the console reading INTO USD on
   *  entry converts them back for display, so a €0.32 reading reads as €0.32.
   *  Defaults to USD when unset (tests, older callers). */
  currency?: DisplayCurrency
  locale?: string
}

/** Pure presentational meter — no IPC, no state. Reuses the Model Usage card's
 *  provider/quota markup so it reads as a sibling of the metered providers. */
export function MistralQuotaMeterView({
  snapshot,
  loading,
  currency,
  locale
}: MistralQuotaMeterViewProps): ReactElement | null {
  // No cycle ⇒ no row at all. Deliberately not a "loading"/"unavailable"
  // placeholder: there is nothing pending to wait for, and an empty Mistral row
  // in every user's sidebar would be exactly the noise this feature avoids.
  if (!snapshot) return null

  const { estimate } = snapshot
  const locallyEstimatedSinceReadingUsd = Math.max(0, estimate.locallyEstimatedSinceReadingUsd ?? 0)
  const hasLocalIncrement = locallyEstimatedSinceReadingUsd > 0
  // `vendorReported` means BOTH halves and the displayed total came from
  // Mistral. Once a local increment is added, the baseline remains real but the
  // combined number regains its estimate hedge.
  const measured = estimate.vendorReported === true
  const ceilingFromVendor =
    estimate.ceilingConfidence === 'anchored' || estimate.ceilingConfidence === 'reported'
  const spendBaseFromVendor =
    estimate.confidence === 'anchored' || estimate.confidence === 'reported'
  const spendFullyFromVendor = spendBaseFromVendor && !hasLocalIncrement
  const calibrated = estimate.confidence === 'learned' || (spendBaseFromVendor && ceilingFromVendor)
  const fraction = Math.max(0, Math.min(1, estimate.usedPercent / 100))
  const resetsAt = formatResetShort({ resetAt: estimate.cycleResetsAt })
  const planName =
    snapshot.plan === 'unknown' ? undefined : providerPlanName('mistral', snapshot.plan)
  const money = (usd: number): string => formatCostAlwaysOn(usd, currency ?? 'USD', locale)
  const spent = formatMistralAccumulatedSpend(
    estimate.spentUsd,
    locallyEstimatedSinceReadingUsd,
    currency ?? 'USD',
    locale
  )
  const localIncrement = hasLocalIncrement
    ? formatMistralLocalIncrement(locallyEstimatedSinceReadingUsd, currency ?? 'USD', locale)
    : null
  const ceiling = money(estimate.estimatedCeilingUsd)
  const title =
    spendBaseFromVendor && ceilingFromVendor
      ? vendorTooltip(estimate)
      : calibrated
        ? ESTIMATE_TOOLTIP
        : `${ESTIMATE_TOOLTIP} ${SEEDED_TOOLTIP}`
  // A vendor figure drops the `~` and the "est." qualifier — carrying them over
  // a number Mistral itself reported would understate what we actually know.
  // Anything short of that keeps the hedge: "of ~$27.80 est." can never be read
  // as a published allowance.
  const ceilingText = ceilingFromVendor ? `of ${ceiling}` : `of ~${ceiling} est.`
  const footnote = [
    ceilingText,
    resetsAt ? `resets ${resetsAt}` : null,
    localIncrement ? `+ ~${localIncrement} tracked locally since reading` : null,
    measured ? null : calibrated ? null : 'not yet calibrated'
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="model-usage-item provider-mistral quota-only mistral-quota-meter">
      <div className="model-usage-provider-heading">
        <span className="sidebar-provider-label provider-mistral">
          <ProviderLogoTile provider="mistral" />
          <span className="model-usage-provider-name">Mistral</span>
          {planName ? <span className="model-usage-tier-badge">{planName}</span> : null}
        </span>
      </div>
      <div className="model-usage-window-list">
        {estimate.apiUsage ? (
          // The console's shared "API usage" bar (Studio / Vibe Code / API),
          // read verbatim from the imported web session. Display-only: the
          // seat spends from the Vibe Code budget metered below, so this row
          // never joins the estimate's spend or ceiling.
          <div
            className="model-usage-window mistral-quota-window mistral-quota-window--api"
            title={[
              'API usage read from your Mistral console' +
                (estimate.apiUsage.asOf &&
                !Number.isNaN(new Date(estimate.apiUsage.asOf).getTime())
                  ? ` (${new Date(estimate.apiUsage.asOf).toLocaleString()}).`
                  : '.'),
              'Shared across Studio, Vibe Code, and the API; this seat spends from the Vibe Code budget below.'
            ].join(' ')}
          >
            <div className="model-usage-window-row">
              <span className="model-usage-window-label">API usage</span>
              <span className="model-usage-window-percent">
                {estimate.apiUsage.declared
                  ? [
                      formatDeclaredAmount(
                        estimate.apiUsage.declared.spent,
                        estimate.apiUsage.declared.currency,
                        locale
                      ),
                      estimate.apiUsage.declared.allowance
                        ? `of ${formatDeclaredAmount(
                            estimate.apiUsage.declared.allowance,
                            estimate.apiUsage.declared.currency,
                            locale
                          )}`
                        : null
                    ]
                      .filter(Boolean)
                      .join(' ')
                  : money(estimate.apiUsage.spentUsd)}
              </span>
            </div>
            {typeof estimate.apiUsage.usedPercent === 'number' ? (
              <QuotaProgressBar
                fraction={Math.max(0, Math.min(1, estimate.apiUsage.usedPercent / 100))}
                accent="var(--provider-mistral-color)"
              />
            ) : null}
          </div>
        ) : null}
        <div
          className="model-usage-window mistral-quota-window"
          title={title}
          data-confidence={estimate.confidence}
          data-band={estimate.band}
        >
          <div className="model-usage-window-row">
            <span className="model-usage-window-label mistral-quota-band-label">
              {estimate.label}
            </span>
            <span
              className="model-usage-window-percent"
              title={
                spendFullyFromVendor
                  ? vendorTooltip(estimate)
                  : hasLocalIncrement
                    ? MIXED_MONEY_TOOLTIP
                    : MONEY_TOOLTIP
              }
            >
              {spendFullyFromVendor ? spent : `~${spent}`}
            </span>
          </div>
          <QuotaProgressBar
            fraction={fraction}
            accent="var(--provider-mistral-color)"
            className={calibrated ? undefined : 'mistral-quota-bar--estimated'}
          />
          <div className="mistral-quota-footnote">
            <span>{footnote}</span>
            {loading ? <span className="mistral-quota-refreshing" aria-hidden /> : null}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Reads the persisted estimate over IPC. This is one tiny local file, not a
 * vendor probe, so the meter listens to usage changes directly and performs a
 * slow visible-window heartbeat as a self-heal. The outer `refreshKey` remains
 * supported for the card's manual refresh and existing App-level broadcast.
 */
export function useMistralQuotaMeterState(refreshKey?: number): MistralQuotaMeterViewProps {
  const [snapshot, setSnapshot] = useState<MistralQuotaSnapshot | null>(null)
  // Seeded lazily so the effect never has to setState synchronously just to
  // report "there is no bridge here" (SSR and component tests take that path).
  const [loading, setLoading] = useState(
    () => typeof window !== 'undefined' && typeof window.api?.getMistralQuotaEstimate === 'function'
  )
  const mountedRef = useRef(true)

  const readSnapshot = useCallback((): void => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (typeof api?.getMistralQuotaEstimate !== 'function') return
    void api
      .getMistralQuotaEstimate()
      .then((next) => {
        if (!mountedRef.current) return
        setSnapshot(next ?? null)
        setLoading(false)
      })
      .catch(() => {
        // A read failure keeps the LAST good reading rather than blanking the
        // row: the underlying number is a slow-moving monthly total, so a stale
        // band is far more useful than an empty one.
        if (!mountedRef.current) return
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    readSnapshot()
  }, [readSnapshot, refreshKey])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const api = window.api
    if (typeof api?.getMistralQuotaEstimate !== 'function') return

    let settleTimer: ReturnType<typeof setTimeout> | null = null
    const refreshAfterUsage = (): void => {
      readSnapshot()
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = setTimeout(readSnapshot, MISTRAL_QUOTA_USAGE_SETTLE_MS)
    }
    const unsubscribe =
      typeof api.onUsageChanged === 'function' ? api.onUsageChanged(refreshAfterUsage) : undefined
    const interval = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') readSnapshot()
    }, MISTRAL_QUOTA_REFRESH_INTERVAL_MS)
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') readSnapshot()
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', refreshWhenVisible)
    }

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
      clearInterval(interval)
      if (settleTimer) clearTimeout(settleTimer)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', refreshWhenVisible)
      }
    }
  }, [readSnapshot])

  return { snapshot, loading }
}

/** Stateful shell (used where the card is not already holding the state). */
export function MistralQuotaMeter({ refreshKey }: { refreshKey?: number }): ReactElement | null {
  return <MistralQuotaMeterView {...useMistralQuotaMeterState(refreshKey)} />
}
