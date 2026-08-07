import { memo, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { ProviderId } from '../../../main/store/types'
import { formatContextTokens } from '../lib/contextWindows'
import { formatCostAlwaysOn, type DisplayCurrency } from '../lib/formatCost'
import {
  estimateRunCostUsd,
  isKnownLocalOllamaModel,
  type RendererProviderRates
} from '../lib/providerRateEstimate'
import { formatTallySuffix, tallyCostUsd, type ChatTokenTally } from '../lib/threadTokenTally'
import { resolveLiveTallyTokens } from '../lib/liveTallyTokens'
import { useParticipantWorkingTokenSnapshot } from '../lib/participantWorkingTelemetryStore'
import { DigitOdometer } from './DigitOdometer'

const LIVE_TICK_MS = 1000

export type LiveThreadTokenTallyProps = {
  baseTally: ChatTokenTally
  currency: DisplayCurrency
  /** Ensemble / guest threads show API cost and Ollama peak RAM together. */
  dualCostAndRam?: boolean
  model: string | undefined
  overestimatePercent: number
  provider: ProviderId
  providerRates: RendererProviderRates
  running: boolean
  liveOutputTokens: number
  /** Active run id whose authoritative live usage snapshot (if any) should
   * lead the char estimate. Solo runs surface it via SoloWorkingTokenTelemetry;
   * ensemble runs via the orchestrator. Undefined/null → estimate only. */
  activeRunId?: string | null
  title: string
}

export { estimateLiveOutputTokensFromChars } from '../lib/liveOutputTokens'

/**
 * Odometer-friendly split of `formatContextTokens` (identical rounding), so the
 * footer's live "out" figure rolls in the same `1k / 1.2M` style it shows idle
 * — never the working row's `… tokens` suffix.
 */
export function contextTokensOdometer(n: number): {
  value: number
  decimalPlaces: number
  suffix: string
  label: string
} {
  const tokens = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
  if (tokens >= 1_000_000) {
    if (tokens >= 10_000_000) {
      const value = Math.round(tokens / 1_000_000)
      return { value, decimalPlaces: 0, suffix: 'M', label: `${value}M` }
    }
    const tenths = Math.round(tokens / 100_000)
    return { value: tenths, decimalPlaces: 1, suffix: 'M', label: `${(tenths / 10).toFixed(1)}M` }
  }
  if (tokens >= 1_000) {
    const value = Math.round(tokens / 1_000)
    return { value, decimalPlaces: 0, suffix: 'k', label: `${value}k` }
  }
  return { value: tokens, decimalPlaces: 0, suffix: '', label: String(tokens) }
}

export const LiveThreadTokenTally = memo(function LiveThreadTokenTally({
  baseTally,
  currency,
  dualCostAndRam = false,
  model,
  overestimatePercent,
  provider,
  providerRates,
  running,
  liveOutputTokens,
  activeRunId,
  title
}: LiveThreadTokenTallyProps): ReactElement | null {
  const liveSnapshot = useParticipantWorkingTokenSnapshot(running ? activeRunId ?? null : null)
  const resolved = resolveLiveTallyTokens({
    running,
    baseInputTokens: baseTally.inputTokens,
    baseOutputTokens: baseTally.outputTokens,
    estimatedOutputTokens: running ? Math.max(0, Math.trunc(liveOutputTokens)) : 0,
    snapshotInputTokens: liveSnapshot?.inputTokens,
    snapshotOutputTokens: liveSnapshot?.outputTokens,
    snapshotEstimated: liveSnapshot?.estimated
  })
  const targetOutputTokens = resolved.outputTokensTarget
  const liveInputExtra = resolved.liveInputExtra
  const displayInputTokens = resolved.inputTokens
  const targetOutputRef = useRef(targetOutputTokens)
  const baseOutputRef = useRef(baseTally.outputTokens)
  const [displayedOutputTokens, setDisplayedOutputTokens] = useState(targetOutputTokens)

  useEffect(() => {
    targetOutputRef.current = targetOutputTokens
    baseOutputRef.current = baseTally.outputTokens
    if (!running) {
      setDisplayedOutputTokens(targetOutputTokens)
    } else {
      setDisplayedOutputTokens((current) =>
        current < baseTally.outputTokens ? baseTally.outputTokens : current
      )
    }
  }, [baseTally.outputTokens, running, targetOutputTokens])

  useEffect(() => {
    if (!running) return
    const interval = window.setInterval(() => {
      setDisplayedOutputTokens((current) => {
        const target = targetOutputRef.current
        const baseOutput = baseOutputRef.current
        if (current < baseOutput) return baseOutput
        if (current >= target) return target
        const step = Math.max(1, Math.ceil((target - current) / 2))
        return Math.min(target, current + step)
      })
    }, LIVE_TICK_MS)
    return () => window.clearInterval(interval)
  }, [running])

  const suffix = useMemo(() => {
    // Local Ollama lanes (including Google-branded Gemma) must never project
    // live £/$/€. Ensemble chats often keep a cloud seed on chat.provider
    // while the active model is a local tag — isKnownLocalOllamaModel catches
    // that without stripping sealed non-Ollama cost from dual telemetry.
    const localOllamaLane =
      provider === 'ollama' || isKnownLocalOllamaModel(providerRates, model)
    if (!dualCostAndRam && localOllamaLane) {
      return formatTallySuffix('ollama', baseTally, currency, overestimatePercent)
    }
    const liveOutputExtra = Math.max(0, displayedOutputTokens - baseTally.outputTokens)
    // Now prices BOTH the live input (from the authoritative snapshot) and the
    // live output — previously input was hard-coded to 0, so mid-turn cost
    // omitted the in-flight prompt entirely.
    const liveCostUsd =
      running && !localOllamaLane
        ? estimateRunCostUsd(providerRates, provider, model, liveInputExtra, liveOutputExtra)
        : 0
    const baseCostUsd = tallyCostUsd(baseTally)
    const totalCostUsd = baseCostUsd + liveCostUsd
    const hasProjectedCost = (baseTally.estimatedCostUsd || 0) > 0 || liveCostUsd > 0
    if (dualCostAndRam) {
      // Live projection already skipped for local lanes. Keep dual formatting
      // so sealed cloud spend in mixed ensembles still appears next to peak GB;
      // pure-local tallies (totalCostUsd === 0) render RAM only.
      const tallyForSuffix =
        running && liveCostUsd > 0
          ? { ...baseTally, estimatedCostUsd: (baseTally.estimatedCostUsd || 0) + liveCostUsd }
          : baseTally
      return formatTallySuffix(
        provider === 'ollama' ? 'ollama' : provider,
        tallyForSuffix,
        currency,
        overestimatePercent,
        {
          dualCostAndRam: true,
          projectedCost: running && liveCostUsd > 0
        }
      )
    }
    const cost =
      totalCostUsd > 0
        ? formatCostAlwaysOn(totalCostUsd, currency, undefined, overestimatePercent)
        : ''
    const prefix = hasProjectedCost ? '~' : ''
    return cost ? ` · ${prefix}${cost}` : ''
  }, [
    baseTally,
    currency,
    displayedOutputTokens,
    dualCostAndRam,
    liveInputExtra,
    model,
    overestimatePercent,
    provider,
    providerRates,
    running
  ])

  if (baseTally.totalTokens <= 0 && displayedOutputTokens <= 0 && displayInputTokens <= 0) {
    return null
  }

  const liveSource = resolved.authoritative
    ? 'live provider usage snapshot'
    : 'live output estimate'
  const liveIsActive =
    running && (targetOutputTokens > baseTally.outputTokens || liveInputExtra > 0)
  const liveTitle = liveIsActive
    ? dualCostAndRam
      ? `${title}\n\nLive tokens (${liveSource}) and projected cost update once per second while this run is active. Peak RAM updates when an Ollama lane finishes.`
      : provider === 'ollama'
        ? `${title}\n\nLive tokens (${liveSource}) update once per second while this run is active. Peak RAM updates when the run finishes.`
        : `${title}\n\nLive tokens (${liveSource}) and projected cost update once per second while this run is active.`
    : dualCostAndRam && baseTally.peakMemoryRssGb > 0
      ? `${title}\n\nCost from provider-reported spend and API-equivalent estimates. Peak RAM from the latest completed Ollama lane.`
      : provider === 'ollama' && baseTally.peakMemoryRssGb > 0
        ? `${title}\n\nPeak llama-server RAM from the latest completed Ollama run.`
        : title

  const outOdometer = contextTokensOdometer(displayedOutputTokens)

  return (
    <span
      className={`composer-thread-token-tally${running ? ' is-live' : ''}`}
      title={liveTitle}
      aria-live="off"
    >
      {`${formatContextTokens(displayInputTokens)} in / `}
      {running ? (
        <span className="composer-thread-token-out">
          <DigitOdometer
            key={`${outOdometer.suffix}:${outOdometer.decimalPlaces}`}
            value={outOdometer.value}
            decimalPlaces={outOdometer.decimalPlaces}
            ariaLabel={outOdometer.label}
            className="composer-thread-token-odometer"
          />
          {outOdometer.suffix ? (
            <span className="composer-thread-token-out-suffix">{outOdometer.suffix}</span>
          ) : null}
        </span>
      ) : (
        formatContextTokens(displayedOutputTokens)
      )}
      {` out${suffix}`}
    </span>
  )
})
