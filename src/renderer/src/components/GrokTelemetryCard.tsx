/*
 * GrokTelemetryCard — Grok subscription-credit card for the Settings
 * "Provider Telemetry" grid (1.0.6-CRUX15).
 *
 * The grid is otherwise driven by `usageSummary` quota windows/balances, but
 * Grok's credits don't flow through that pipeline — they come from the
 * SuperGrok `/usage` PTY probe (`grok-usage:probe`, the same source as the
 * sidebar GrokCreditsMeter). This card calls that IPC directly so Grok sits
 * as a sibling of the Cursor/Gemini/etc. telemetry cards. The main-process
 * probe is cached (CRUX15), so mounting this alongside the meter does NOT
 * trigger a second TUI scrape within the TTL.
 *
 * Pure-ish: probe in an effect, render the shared `.settings-provider-*`
 * telemetry-card markup. SSR-safe (no probe during static render → the
 * "reading…" placeholder shows).
 */
import { useEffect, useRef, useState } from 'react'
import type { GrokUsageSnapshot } from '../../../main/grok/GrokUsage'

/** Tidy a collapsed reset-window string (e.g. "May31,16:00PT") for display —
 *  mirrors GrokCreditsMeter's formatter so both reads match. Idempotent. */
function formatResetWindow(text: string): string {
  return text
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z]{2,})/g, '$1 $2')
    .replace(/,(?=\S)/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function GrokTelemetryCard(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<GrokUsageSnapshot | null>(null)
  const [loading, setLoading] = useState(
    () => typeof window === 'undefined' || typeof window.api?.probeGrokUsage === 'function'
  )
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (typeof api?.probeGrokUsage !== 'function') {
      return () => {
        mountedRef.current = false
      }
    }
    api
      .probeGrokUsage()
      .then((snap) => {
        if (!mountedRef.current) return
        setSnapshot(snap)
        setLoading(false)
      })
      .catch(() => {
        if (mountedRef.current) setLoading(false)
      })
    return () => {
      mountedRef.current = false
    }
  }, [])

  const observed = snapshot?.confidence === 'observed'
  const display = snapshot?.creditsUsedDisplay || '0%'
  // Weekly-limit /usage screens (mid-2026 CLI) vs the legacy monthly credit pool.
  const weekly = snapshot?.usageKind === 'weekly_limit'
  const kindText = weekly ? 'Weekly limit' : 'Subscription credits'

  return (
    <article className="settings-provider-telemetry-card provider-grok" data-provider="grok">
      <div className="settings-provider-telemetry-title">
        <span className="settings-model-comparison-dot provider-grok" aria-hidden />
        <strong>Grok</strong>
        {snapshot?.planLabel ? <span>{snapshot.planLabel}</span> : null}
      </div>
      <div className="settings-provider-telemetry-meta">
        <span>{kindText}</span>
        <span>grok cli usage</span>
      </div>
      {observed ? (
        <div className="settings-provider-balance-list">
          <div className="settings-provider-balance">
            <span>{weekly ? 'Weekly limit used' : 'Credits used'}</span>
            <strong>{display}</strong>
            {snapshot?.resetAtText ? (
              <small>resets {formatResetWindow(snapshot.resetAtText)}</small>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="settings-provider-balance settings-provider-balance-empty">
          <span>Usage</span>
          <strong>{loading ? '…' : 'Unavailable'}</strong>
        </div>
      )}
    </article>
  )
}
