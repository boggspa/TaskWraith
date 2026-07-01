/*
 * GrokCreditsMeter — Grok SUBSCRIPTION-CREDIT usage (1.0.6-GU).
 *
 * NOT a token/cost meter. SuperGrok / grok.com CLI auth bills against a
 * subscription credit pool (a percent + reset window) with no noninteractive
 * command, so the only safe source is the interactive `/usage` → "Show Usage"
 * screen captured via PTY in the main process (no prompt is ever sent → no
 * model call / credit consumption). The probe is expensive (spawns + scrapes a
 * TUI), so it runs once on mount (plus one cold-start retry); there is no
 * manual refresh button — the meter sits in the Model Usage card and reuses the
 * same DOM/classes as the other providers' quota rows so it reads as a sibling.
 *
 * Monochrome by design — grok's accent (`--provider-grok-color`) aliases to the
 * active theme's primary text colour (white on dark, black on light).
 *
 * Pure presentational view (`GrokCreditsMeterView`, SSR-testable) + impure
 * probe shell. The parent only mounts the shell when the gated Grok adapter is
 * registered, and can bump `refreshKey` to join the sidebar-level refresh.
 * "Stale" = showing the last known-good reading because the latest probe
 * failed/returned unavailable.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GrokUsageSnapshot } from '../../../main/grok/GrokUsage'
import { computeQuotaPace } from '../lib/QuotaPace'
import { ProviderLogoTile } from './ProviderLogoTile'
import { QuotaProgressBar } from './QuotaProgressBar'

/** The captured /usage reset window sometimes comes back with collapsed
 * spacing (e.g. "May31,16:00PT") depending on how the TUI rendered it. Tidy
 * it for display — inserts spaces at month/day, time/timezone, and comma
 * boundaries — without mangling already well-spaced text (idempotent). */
function formatResetWindow(text: string): string {
  return text
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z]{2,})/g, '$1 $2')
    .replace(/,(?=\S)/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export interface GrokCreditsMeterViewProps {
  /** The snapshot to display (may be a prior known-good one when stale). */
  snapshot: GrokUsageSnapshot | null
  loading: boolean
  errored: boolean
  /** True when `snapshot` is a prior reading shown after a failed refresh. */
  stale: boolean
}

export interface GrokCreditsMeterProps {
  refreshKey?: number
}

/** Pure presentational meter — no IPC, no state. Mirrors the Model Usage
 * Card's provider/quota markup so it inherits the same styling. */
export function GrokCreditsMeterView({
  snapshot,
  loading,
  errored,
  stale
}: GrokCreditsMeterViewProps): React.ReactElement {
  const observed = snapshot?.confidence === 'observed'
  const percent = snapshot?.creditsUsedPercent ?? null
  // xAI moved SuperGrok CLI auth from a monthly credit pool to a weekly limit
  // (mid-2026); the snapshot says which generation the /usage screen showed.
  const weekly = snapshot?.usageKind === 'weekly_limit'
  const windowLabel = weekly ? 'Weekly' : 'Credits'
  const kindText = weekly ? 'Weekly limit' : 'Subscription credits'
  // For a "<1%" band (display present, percent null) keep the bar near empty
  // and let the raw display carry the meaning — never invent a number. The
  // weekly ">99%"-style band is the opposite: pin the bar at the band's floor
  // so it reads near-full.
  const bandFloor = snapshot?.creditsUsedDisplay.match(/^>(\d[\d.]*)%$/)
  const fraction =
    percent != null && Number.isFinite(percent)
      ? Math.max(0, Math.min(1, percent / 100))
      : bandFloor
        ? Math.max(0, Math.min(1, Number(bandFloor[1]) / 100))
        : 0
  const display = snapshot?.creditsUsedDisplay || '0%'
  const metaText = stale ? `${kindText} · stale` : kindText
  const pace =
    snapshot?.resetAt && snapshot.limitWindowSeconds && percent != null
      ? computeQuotaPace({
          id: 'grok-credits',
          label: windowLabel,
          runs: 0,
          totalTokens: 0,
          limitLabel: metaText,
          resetAt: snapshot.resetAt,
          usedPercent: percent,
          limitWindowSeconds: snapshot.limitWindowSeconds
        })
      : null

  return (
    <div className="model-usage-item provider-grok quota-only">
      <div className="model-usage-provider-heading">
        <span className="sidebar-provider-label provider-grok">
          <ProviderLogoTile provider="grok" />
          <span className="model-usage-provider-name">Grok</span>
          {snapshot?.planLabel ? (
            <span className="model-usage-tier-badge">{snapshot.planLabel}</span>
          ) : null}
        </span>
      </div>
      <div className="model-usage-window-list">
        {observed ? (
          <div className="model-usage-window" title={`Grok ${kindText.toLowerCase()}`}>
            <div className="model-usage-window-row">
              <span className="model-usage-window-label">{windowLabel}</span>
              {snapshot?.resetAtText ? (
                <span className="model-usage-window-reset">
                  resets {formatResetWindow(snapshot.resetAtText)}
                </span>
              ) : null}
              <span className="model-usage-window-percent">{display}</span>
            </div>
            <QuotaProgressBar fraction={fraction} accent="var(--provider-grok-color)" pace={pace} />
            <div className="model-usage-window-meta">
              <span>{metaText}</span>
            </div>
          </div>
        ) : (
          <div className="model-usage-window" title="Grok usage">
            <div className="model-usage-window-row">
              <span className="model-usage-window-label">Usage</span>
              <span className="model-usage-window-percent">{loading ? '…' : '—'}</span>
            </div>
            <div className="model-usage-window-meta">
              <span>
                {loading
                  ? 'Reading Grok usage…'
                  : errored
                    ? 'Could not read the Grok CLI'
                    : 'Usage unavailable'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Stateful shell: owns the PTY probe + render state (no button). */
export function GrokCreditsMeter({ refreshKey }: GrokCreditsMeterProps): React.ReactElement {
  const [result, setResult] = useState<GrokUsageSnapshot | null>(null)
  const [lastObserved, setLastObserved] = useState<GrokUsageSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [errored, setErrored] = useState(false)
  const mountedRef = useRef(true)
  const retriedRef = useRef(false)
  // Holds the latest runProbe so the retry timer can re-invoke it without
  // runProbe referencing itself (which the hooks linter forbids).
  const runProbeRef = useRef<() => void>(() => {})

  // Async-only probe core: sets state exclusively from promise callbacks, so it
  // is safe to call from the mount effect. Tolerates a flaky cold start by
  // retrying once (keeping the spinner up) before settling on "unavailable".
  const runProbe = useCallback(() => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (typeof api?.probeGrokUsage !== 'function') {
      void Promise.resolve().then(() => {
        if (!mountedRef.current) return
        setErrored(true)
        setLoading(false)
      })
      return
    }
    api
      .probeGrokUsage()
      .then((snap) => {
        if (!mountedRef.current) return
        setResult(snap)
        if (snap.confidence === 'observed') {
          setLastObserved(snap)
          setLoading(false)
          return
        }
        if (!retriedRef.current) {
          retriedRef.current = true
          window.setTimeout(() => mountedRef.current && runProbeRef.current(), 1500)
        } else {
          setLoading(false)
        }
      })
      .catch(() => {
        if (!mountedRef.current) return
        if (!retriedRef.current) {
          retriedRef.current = true
          window.setTimeout(() => mountedRef.current && runProbeRef.current(), 1500)
        } else {
          setErrored(true)
          setLoading(false)
        }
      })
  }, [])

  useEffect(() => {
    runProbeRef.current = runProbe
  }, [runProbe])

  useEffect(() => {
    mountedRef.current = true
    retriedRef.current = false
    setErrored(false)
    setLoading(true)
    runProbe()
    return () => {
      mountedRef.current = false
    }
  }, [runProbe, refreshKey])

  const resultObserved = result?.confidence === 'observed'
  // Prefer a fresh observed result; otherwise fall back to the last good one.
  const display = resultObserved ? result : (lastObserved ?? result)
  const displayObserved = display?.confidence === 'observed'
  const stale = displayObserved && (errored || !resultObserved)

  return (
    <GrokCreditsMeterView snapshot={display} loading={loading} errored={errored} stale={stale} />
  )
}
