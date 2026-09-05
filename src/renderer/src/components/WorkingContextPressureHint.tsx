import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { CONTEXT_PRESSURE_WARN_PERCENT } from '../../../shared/contextCompaction'

/** Token-growth stall window before a high-pressure working row is presumed
 * to be compacting (providers that auto-compact without emitting any frame —
 * the "participant goes quiet, then the record appears" report). */
const WORKING_QUIET_COMPACTION_MS = 20_000

/**
 * Context-pressure hint riding the working indicator: at ≥80% occupancy the
 * row discloses the percent ("context 87%"), and if token growth then stalls
 * for 20s at that pressure it escalates to "likely compacting" — a TENTATIVE
 * presumption for lanes whose native auto-compaction emits no start signal.
 * Confirmed compaction (a real `started` event) flips the whole indicator to
 * "Compacting context" upstream, which supersedes this hint.
 */
export function WorkingContextPressureHint({
  percent,
  estimatedTokens
}: {
  percent: number
  estimatedTokens: number
}): ReactElement | null {
  const [quiet, setQuiet] = useState(false)
  // Growth timestamps are recorded in an effect keyed on estimatedTokens
  // (render-time ref writes + Date.now() violate react-hooks/purity); the
  // one-commit lag is irrelevant against the 20s stall threshold. Null until
  // the first commit, which the interval reads as "not quiet yet".
  const lastGrowthAtMsRef = useRef<number | null>(null)
  useEffect(() => {
    lastGrowthAtMsRef.current = Date.now()
  }, [estimatedTokens])
  useEffect(() => {
    const timer = window.setInterval(() => {
      const lastGrowthAtMs = lastGrowthAtMsRef.current
      setQuiet(
        lastGrowthAtMs !== null && Date.now() - lastGrowthAtMs >= WORKING_QUIET_COMPACTION_MS
      )
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])
  if (!(percent >= CONTEXT_PRESSURE_WARN_PERCENT)) return null
  const rounded = Math.round(percent)
  return (
    <span
      className={`working-context-pressure-hint${percent >= 90 ? ' is-critical' : ''}${
        quiet ? ' is-quiet' : ''
      }`}
      title={
        quiet
          ? 'No token growth for 20s at high context pressure — the provider is likely auto-compacting its context.'
          : 'Live context occupancy. Providers auto-compact near their window limit.'
      }
    >
      {quiet ? `quiet at ${rounded}% context — likely compacting` : `context ${rounded}%`}
    </span>
  )
}
