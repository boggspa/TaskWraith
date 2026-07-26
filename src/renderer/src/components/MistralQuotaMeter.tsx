/*
 * MistralQuotaMeter — the Mistral Vibe seat's sidebar quota band.
 *
 * WHAT MAKES THIS ONE DIFFERENT. Every other row in the Model Usage card
 * renders a number a vendor reported. Mistral publishes no quota figure for any
 * plan and exposes no usage endpoint, and overflow is pay-as-you-go — so there
 * is no wall to hit and no percentage to quote. What this row shows is
 * TaskWraith's own estimate, built from spend observed locally on this Mac
 * against a ceiling seeded from the plan price (see MistralQuotaEstimate.ts).
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
 *   - Until a real limit event has calibrated the ceiling
 *     (`confidence !== 'learned'`) the fill is hatched and dimmed, so a
 *     price-anchored guess cannot be mistaken for a measured value.
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
import { formatResetShort } from '../lib/UsageFormat'
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

function formatUsd(value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? value : 0
  return `$${safe.toFixed(2)}`
}

export interface MistralQuotaMeterViewProps {
  /** null until the seat has been run at least once — the row stays hidden. */
  snapshot: MistralQuotaSnapshot | null
  loading: boolean
}

/** Pure presentational meter — no IPC, no state. Reuses the Model Usage card's
 *  provider/quota markup so it reads as a sibling of the metered providers. */
export function MistralQuotaMeterView({
  snapshot,
  loading
}: MistralQuotaMeterViewProps): ReactElement | null {
  // No cycle ⇒ no row at all. Deliberately not a "loading"/"unavailable"
  // placeholder: there is nothing pending to wait for, and an empty Mistral row
  // in every user's sidebar would be exactly the noise this feature avoids.
  if (!snapshot) return null

  const { estimate } = snapshot
  const calibrated = estimate.confidence === 'learned'
  const fraction = Math.max(0, Math.min(1, estimate.usedPercent / 100))
  const resetsAt = formatResetShort({ resetAt: estimate.cycleResetsAt })
  const planName =
    snapshot.plan === 'unknown' ? undefined : providerPlanName('mistral', snapshot.plan)
  const spent = formatUsd(estimate.spentUsd)
  const ceiling = formatUsd(estimate.estimatedCeilingUsd)
  const title = calibrated ? ESTIMATE_TOOLTIP : `${ESTIMATE_TOOLTIP} ${SEEDED_TOOLTIP}`
  // "of ~$14.99 est." — the ceiling is qualified in place so the ratio can never
  // be read as a published allowance.
  const footnote = [
    `of ~${ceiling} est.`,
    resetsAt ? `resets ${resetsAt}` : null,
    calibrated ? null : 'not yet calibrated'
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
            <span className="model-usage-window-percent" title={MONEY_TOOLTIP}>
              ~{spent}
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
