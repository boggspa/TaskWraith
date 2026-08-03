import { memo, useEffect, useRef, useState, type JSX } from 'react'
import { useParticipantWorkingTokenSnapshot } from '../lib/participantWorkingTelemetryStore'
import {
  compactWorkingTokenOdometer,
  formatParticipantWorkingElapsed
} from '../lib/participantWorkingTelemetryModel'
import { workingIndicatorTokenSnapshotBucket } from '../lib/workingIndicatorTelemetry'
import { DigitOdometer } from './DigitOdometer'

const TOKEN_TICK_MS = 500

export type ParticipantWorkingTelemetryProps = {
  runId: string | null
  startedAt: string | null
  /** Durable completed-turn total for this seat. */
  tokenAccumulatorBase: number
  /** Baseline plus a renderer-side streamed-output fallback. */
  fallbackTargetTokens: number
  estimatedCurrentTurnTokens: number
}

function ParticipantWorkingTelemetry({
  runId,
  startedAt,
  tokenAccumulatorBase,
  fallbackTargetTokens,
  estimatedCurrentTurnTokens
}: ParticipantWorkingTelemetryProps): JSX.Element {
  const providerSnapshot = useParticipantWorkingTokenSnapshot(runId)
  const baseTokens = Math.max(0, Math.trunc(tokenAccumulatorBase || 0))
  const fallbackTokens = Math.max(baseTokens, Math.trunc(fallbackTargetTokens || 0))
  const providerTargetTokens = baseTokens + Math.max(0, providerSnapshot?.totalTokens || 0)
  const targetTokens = Math.max(fallbackTokens, providerTargetTokens)
  const targetTokensRef = useRef(targetTokens)
  const [displayedTokens, setDisplayedTokens] = useState(targetTokens)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const turnKey = `${runId || 'no-run'}:${startedAt || 'no-start'}`

  useEffect(() => {
    targetTokensRef.current = targetTokens
  }, [targetTokens])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setNowMs(Date.now()))
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearInterval(timer)
    }
  }, [turnKey])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setDisplayedTokens((current) => {
        const target = targetTokensRef.current
        if (target <= current) return current
        // Ease toward sparse provider/stream snapshots. This schedules a
        // component-local render only; the app and transcript stay untouched.
        const step = Math.max(1, Math.ceil((target - current) / 2))
        return Math.min(target, current + step)
      })
    }, TOKEN_TICK_MS)
    return () => window.clearInterval(timer)
  }, [turnKey])

  const elapsed = formatParticipantWorkingElapsed(startedAt, nowMs)
  const compactTokens = compactWorkingTokenOdometer(displayedTokens)
  // A snapshot marked `estimated` is a chars÷4 stream estimate riding the
  // telemetry lane (Grok/Cursor/Kimi-ACP) — it keeps the ≈ marker so the
  // figure never masquerades as provider-billed usage.
  const hasReportedUsage = Boolean(
    providerSnapshot && providerSnapshot.totalTokens > 0 && !providerSnapshot.estimated
  )
  const isEstimated =
    !hasReportedUsage &&
    (Boolean(providerSnapshot?.estimated && providerSnapshot.totalTokens > 0) ||
      estimatedCurrentTurnTokens > 0)
  const isUnavailable =
    !providerSnapshot &&
    displayedTokens <= 0 &&
    fallbackTokens <= 0 &&
    estimatedCurrentTurnTokens <= 0
  const source = hasReportedUsage
    ? 'live provider usage snapshot'
    : isEstimated
      ? 'live output estimate'
      : 'completed-turn accumulator'
  const title = isUnavailable
    ? `${elapsed} elapsed · current-run token usage unavailable`
    : `${elapsed} elapsed · ${displayedTokens.toLocaleString()} accumulated tokens (${source})`

  return (
    <span className="message-working-telemetry" title={title} aria-hidden="true">
      <span className="message-working-elapsed">{elapsed}</span>
      <span className="message-working-telemetry-separator">·</span>
      <span className="message-working-token-count">
        {isUnavailable ? (
          <span className="message-working-token-unavailable">— tokens</span>
        ) : (
          <>
            {isEstimated && <span className="message-working-token-estimate">≈</span>}
            <DigitOdometer
              key={`${compactTokens.suffix}:${compactTokens.decimalPlaces}`}
              value={compactTokens.value}
              decimalPlaces={compactTokens.decimalPlaces}
              ariaLabel={compactTokens.label}
            />
            <span className="message-working-token-suffix">{compactTokens.suffix}</span>
          </>
        )}
      </span>
    </span>
  )
}

export const MemoizedParticipantWorkingTelemetry = memo(
  ParticipantWorkingTelemetry,
  (previous, next) =>
    previous.runId === next.runId &&
    previous.startedAt === next.startedAt &&
    workingIndicatorTokenSnapshotBucket(previous.tokenAccumulatorBase) ===
      workingIndicatorTokenSnapshotBucket(next.tokenAccumulatorBase) &&
    workingIndicatorTokenSnapshotBucket(previous.fallbackTargetTokens) ===
      workingIndicatorTokenSnapshotBucket(next.fallbackTargetTokens) &&
    workingIndicatorTokenSnapshotBucket(previous.estimatedCurrentTurnTokens) ===
      workingIndicatorTokenSnapshotBucket(next.estimatedCurrentTurnTokens)
)
