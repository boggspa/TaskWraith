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
 *     console does, as an "Included monthly usage" bar (Free €8.50, Pro €25.50).
 *     It is per-account and appears in no public pricing page, which is why the
 *     user enters it rather than us hardcoding it.
 *   - "overflow is pay-as-you-go, so there is no wall to hit" — pay-as-you-go
 *     for Vibe Code is its own toggle and ships DISABLED. With it off, exhausting
 *     the included allowance STOPS the seat until the cycle resets. There is a
 *     wall, which is precisely why this meter matters.
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
 * shell. The read is a cheap local file, not a probe, so it simply re-reads
 * whenever the sidebar's `refreshKey` moves.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { MistralQuotaSnapshot } from '../../../main/mistral/MistralQuotaStore'
import type {
  MistralQuotaEstimate,
  MistralQuotaFigureSource
} from '../../../main/mistral/MistralQuotaEstimate'
import { formatResetShort } from '../lib/UsageFormat'
import { formatCostAlwaysOn, type DisplayCurrency } from '../lib/formatCost'
import { providerPlanName } from '../lib/providerPlanName'
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
  // `vendorReported` means BOTH halves came from Mistral — a real spend against
  // a guessed ceiling is still a guessed ratio and must still be hedged.
  const measured = estimate.vendorReported === true
  const calibrated = measured || estimate.confidence === 'learned'
  const ceilingFromVendor =
    estimate.ceilingConfidence === 'anchored' || estimate.ceilingConfidence === 'reported'
  // The spend half is judged separately: an anchored reading is Mistral's own
  // number even when the ceiling behind it is still a plan default.
  const spendFromVendor = estimate.confidence === 'anchored' || estimate.confidence === 'reported'
  const fraction = Math.max(0, Math.min(1, estimate.usedPercent / 100))
  const resetsAt = formatResetShort({ resetAt: estimate.cycleResetsAt })
  const planName =
    snapshot.plan === 'unknown' ? undefined : providerPlanName('mistral', snapshot.plan)
  const money = (usd: number): string => formatCostAlwaysOn(usd, currency ?? 'USD', locale)
  const spent = money(estimate.spentUsd)
  const ceiling = money(estimate.estimatedCeilingUsd)
  const title = measured
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
              title={spendFromVendor ? vendorTooltip(estimate) : MONEY_TOOLTIP}
            >
              {spendFromVendor ? spent : `~${spent}`}
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
 * Reads the persisted estimate over IPC. Cheap (one small local file), so it
 * simply re-reads on mount and whenever `refreshKey` moves; there is no probe
 * to throttle and no cold-start retry to run.
 */
export function useMistralQuotaMeterState(refreshKey?: number): MistralQuotaMeterViewProps {
  const [snapshot, setSnapshot] = useState<MistralQuotaSnapshot | null>(null)
  // Seeded lazily so the effect never has to setState synchronously just to
  // report "there is no bridge here" (SSR and component tests take that path).
  const [loading, setLoading] = useState(
    () => typeof window !== 'undefined' && typeof window.api?.getMistralQuotaEstimate === 'function'
  )
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (typeof api?.getMistralQuotaEstimate !== 'function') {
      return () => {
        mountedRef.current = false
      }
    }
    api
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
    return () => {
      mountedRef.current = false
    }
  }, [refreshKey])

  return { snapshot, loading }
}

/** Stateful shell (used where the card is not already holding the state). */
export function MistralQuotaMeter({ refreshKey }: { refreshKey?: number }): ReactElement | null {
  return <MistralQuotaMeterView {...useMistralQuotaMeterState(refreshKey)} />
}
