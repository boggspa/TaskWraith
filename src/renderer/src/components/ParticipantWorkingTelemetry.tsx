import { memo, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { paintLiveAttribute, paintLiveText, useSharedNowEffect } from '../hooks/useSharedNowTick'
import type { ProviderId } from '../../../main/store/types'
import { useParticipantWorkingTokenSnapshot } from '../lib/participantWorkingTelemetryStore'
import {
  compactWorkingTokenOdometer,
  formatParticipantWorkingElapsed,
  reconcileWorkingTokenDisplayEpoch,
  unreportedWorkingTokenEstimate,
  workingSnapshotBelongsToTokenEpoch
} from '../lib/participantWorkingTelemetryModel'
import {
  workingIndicatorTokenSnapshotBucket,
  type WorkingIndicatorContextState
} from '../lib/workingIndicatorTelemetry'
import { DigitOdometer } from './DigitOdometer'

const TOKEN_TICK_MS = 500

export type ParticipantWorkingTelemetryProps = {
  runId: string | null
  startedAt: string | null
  provider: ProviderId | null
  tokenEpochKey: string
  tokenEpochObservedAt: number | null
  /** Latest sealed current-context snapshot for this provider/model seat. */
  contextBaselineTokens: number
  contextBaselineAvailable: boolean
  contextState: WorkingIndicatorContextState
  /** Current-context baseline plus a renderer-side visible-payload fallback. */
  fallbackTargetTokens: number
  estimatedCurrentTurnTokens: number
  estimatedToolResultTokens: number
}

function ParticipantWorkingTelemetry({
  runId,
  startedAt,
  provider,
  tokenEpochKey,
  tokenEpochObservedAt,
  contextBaselineTokens,
  contextBaselineAvailable,
  contextState,
  fallbackTargetTokens,
  estimatedCurrentTurnTokens,
  estimatedToolResultTokens
}: ParticipantWorkingTelemetryProps): JSX.Element {
  const rawProviderSnapshot = useParticipantWorkingTokenSnapshot(runId)
  const providerSnapshot = workingSnapshotBelongsToTokenEpoch(
    rawProviderSnapshot,
    provider,
    tokenEpochObservedAt
  )
    ? rawProviderSnapshot
    : null
  const baseTokens = Math.max(0, Math.trunc(contextBaselineTokens || 0))
  const fallbackTokens = Math.max(baseTokens, Math.trunc(fallbackTargetTokens || 0))
  const currentToolResultTokens = Math.max(0, Math.trunc(estimatedToolResultTokens || 0))
  const [providerEstimateBaseline, setProviderEstimateBaseline] = useState({
    runId,
    tokenEpochKey,
    snapshot: providerSnapshot,
    toolResultTokens: currentToolResultTokens
  })
  const baselineMatchesSnapshot =
    providerEstimateBaseline.runId === runId &&
    providerEstimateBaseline.tokenEpochKey === tokenEpochKey &&
    providerEstimateBaseline.snapshot === providerSnapshot
  if (!baselineMatchesSnapshot) {
    setProviderEstimateBaseline({
      runId,
      tokenEpochKey,
      snapshot: providerSnapshot,
      toolResultTokens: currentToolResultTokens
    })
  }
  const toolResultTokensAtSnapshot = baselineMatchesSnapshot
    ? providerEstimateBaseline.toolResultTokens
    : currentToolResultTokens
  const unreportedToolResultTokens =
    providerSnapshot && !providerSnapshot.estimated
      ? unreportedWorkingTokenEstimate(currentToolResultTokens, toolResultTokensAtSnapshot)
      : 0
  const providerTargetTokens = providerSnapshot?.contextUsage
    ? providerSnapshot.contextUsage.contextTokens + unreportedToolResultTokens
    : providerSnapshot?.estimated
      ? baseTokens + Math.max(0, providerSnapshot.totalTokens) + unreportedToolResultTokens
      : Math.max(0, providerSnapshot?.totalTokens || 0) + unreportedToolResultTokens
  const targetTokens = Math.max(fallbackTokens, providerTargetTokens)
  const targetTokensRef = useRef(targetTokens)
  const [displayState, setDisplayState] = useState({ tokenEpochKey, tokens: targetTokens })
  const reconciledDisplayState = reconcileWorkingTokenDisplayEpoch(
    displayState,
    tokenEpochKey,
    targetTokens
  )
  if (reconciledDisplayState !== displayState) {
    setDisplayState(reconciledDisplayState)
  }
  const displayedTokens = reconciledDisplayState.tokens
  // Compaction resets only the token epoch. Elapsed time remains anchored to
  // the active run/turn, so a mid-run reset never restarts this timer.
  const turnKey = `${runId || 'no-run'}:${startedAt || 'no-start'}`
  // FIRST PAINT ONLY. This row lives in the transcript and used to join the
  // shared tick with no argument at all, so simply being mounted cost a
  // Sync-lane re-render every second purely to advance a digit. The live value
  // is written straight to the DOM by useSharedNowEffect below instead, so a
  // subscription no longer costs a render.
  const nowMs = useMemo(() => Date.now(), [turnKey])
  // An unparseable-but-non-empty startedAt would subscribe forever to advance a
  // value pinned at "0s", so gate on what the formatter can actually use.
  const hasLiveElapsed = Number.isFinite(Date.parse(startedAt ?? ''))
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const elapsedRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    targetTokensRef.current = targetTokens
  }, [targetTokens])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setDisplayState((current) => {
        if (current.tokenEpochKey !== tokenEpochKey) {
          return { tokenEpochKey, tokens: targetTokensRef.current }
        }
        const target = targetTokensRef.current
        if (target <= current.tokens) return current
        // Ease toward sparse provider/stream snapshots. This schedules a
        // component-local render only; the app and transcript stay untouched.
        const step = Math.max(1, Math.ceil((target - current.tokens) / 2))
        return { tokenEpochKey, tokens: Math.min(target, current.tokens + step) }
      })
    }, TOKEN_TICK_MS)
    return () => window.clearInterval(timer)
  }, [tokenEpochKey, turnKey])

  const elapsed = formatParticipantWorkingElapsed(startedAt, nowMs)
  const compactTokens = compactWorkingTokenOdometer(displayedTokens)
  // A snapshot marked `estimated` is a chars÷4 stream estimate riding the
  // telemetry lane (Grok/Cursor/Kimi-ACP) — it keeps the ≈ marker so the
  // figure never masquerades as provider-billed usage.
  const hasReportedUsage = Boolean(
    providerSnapshot &&
    (providerSnapshot.contextUsage || providerSnapshot.totalTokens > 0) &&
    !providerSnapshot.estimated
  )
  const resolvedContextState: WorkingIndicatorContextState = providerSnapshot
    ? providerSnapshot.estimated || providerSnapshot.contextUsage?.precision === 'estimated'
      ? 'estimated'
      : 'available'
    : contextState
  const isEstimated =
    resolvedContextState === 'estimated' ||
    unreportedToolResultTokens > 0 ||
    providerSnapshot?.contextUsage?.precision === 'estimated' ||
    (!hasReportedUsage &&
      (Boolean(providerSnapshot?.estimated && providerSnapshot.totalTokens > 0) ||
        estimatedCurrentTurnTokens > 0))
  const isPostCompactionUnknown = resolvedContextState === 'post-compaction-unknown'
  const isUnavailable =
    isPostCompactionUnknown ||
    (resolvedContextState === 'unavailable' &&
      !contextBaselineAvailable &&
      !providerSnapshot &&
      displayedTokens <= 0 &&
      fallbackTokens <= 0 &&
      estimatedCurrentTurnTokens <= 0)
  const source =
    unreportedToolResultTokens > 0
      ? 'provider usage plus live tool-result estimate'
      : hasReportedUsage
        ? 'live provider context snapshot'
        : isEstimated
          ? 'live output estimate'
          : 'latest persisted context snapshot'
  // One spelling of the title, used by both the declarative first paint and the
  // per-second DOM write, so the two can never drift apart.
  const buildTitle = (elapsedText: string): string =>
    isPostCompactionUnknown
      ? `${elapsedText} elapsed · post-compaction context unavailable; waiting for the next provider snapshot`
      : isUnavailable
        ? `${elapsedText} elapsed · current-context token usage unavailable`
        : `${elapsedText} elapsed · ${displayedTokens.toLocaleString()} current-context tokens (${source})`
  const title = buildTitle(elapsed)

  useSharedNowEffect(hasLiveElapsed, (tickNowMs) => {
    const live = formatParticipantWorkingElapsed(startedAt, tickNowMs)
    paintLiveText(elapsedRef.current, live)
    paintLiveAttribute(rootRef.current, 'title', buildTitle(live))
  })

  return (
    <span className="message-working-telemetry" ref={rootRef} title={title} aria-hidden="true">
      <span ref={elapsedRef} className="message-working-elapsed">
        {elapsed}
      </span>
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
    previous.provider === next.provider &&
    previous.tokenEpochKey === next.tokenEpochKey &&
    previous.tokenEpochObservedAt === next.tokenEpochObservedAt &&
    previous.contextBaselineAvailable === next.contextBaselineAvailable &&
    previous.contextState === next.contextState &&
    workingIndicatorTokenSnapshotBucket(previous.contextBaselineTokens) ===
      workingIndicatorTokenSnapshotBucket(next.contextBaselineTokens) &&
    workingIndicatorTokenSnapshotBucket(previous.fallbackTargetTokens) ===
      workingIndicatorTokenSnapshotBucket(next.fallbackTargetTokens) &&
    workingIndicatorTokenSnapshotBucket(previous.estimatedCurrentTurnTokens) ===
      workingIndicatorTokenSnapshotBucket(next.estimatedCurrentTurnTokens) &&
    workingIndicatorTokenSnapshotBucket(previous.estimatedToolResultTokens) ===
      workingIndicatorTokenSnapshotBucket(next.estimatedToolResultTokens)
)
