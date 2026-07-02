import { memo, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { ProviderId } from '../../../main/store/types'
import { formatContextTokens } from '../lib/contextWindows'
import { formatCostAlwaysOn, type DisplayCurrency } from '../lib/formatCost'
import { estimateRunCostUsd, type RendererProviderRates } from '../lib/providerRateEstimate'
import { formatTallySuffix, tallyCostUsd, type ChatTokenTally } from '../lib/threadTokenTally'

const LIVE_TICK_MS = 1000
const APPROX_CHARS_PER_TOKEN = 4

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
  title: string
}

export function estimateLiveOutputTokensFromChars(charCount: number): number {
  if (!Number.isFinite(charCount) || charCount <= 0) return 0
  return Math.ceil(charCount / APPROX_CHARS_PER_TOKEN)
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
  title
}: LiveThreadTokenTallyProps): ReactElement | null {
  const targetOutputTokens =
    baseTally.outputTokens + (running ? Math.max(0, Math.trunc(liveOutputTokens)) : 0)
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

  const label = useMemo(() => {
    const tokenLabel = `${formatContextTokens(baseTally.inputTokens)} in / ${formatContextTokens(
      displayedOutputTokens
    )} out`
    if (!dualCostAndRam && provider === 'ollama') {
      return `${tokenLabel}${formatTallySuffix(provider, baseTally, currency, overestimatePercent)}`
    }
    const liveOutputExtra = Math.max(0, displayedOutputTokens - baseTally.outputTokens)
    const liveCostUsd = running
      ? estimateRunCostUsd(providerRates, provider, model, 0, liveOutputExtra)
      : 0
    const baseCostUsd = tallyCostUsd(baseTally)
    const totalCostUsd = baseCostUsd + liveCostUsd
    const hasProjectedCost = (baseTally.estimatedCostUsd || 0) > 0 || liveCostUsd > 0
    if (dualCostAndRam) {
      const tallyForSuffix =
        running && liveCostUsd > 0
          ? { ...baseTally, estimatedCostUsd: (baseTally.estimatedCostUsd || 0) + liveCostUsd }
          : baseTally
      return `${tokenLabel}${formatTallySuffix(provider, tallyForSuffix, currency, overestimatePercent, {
        dualCostAndRam: true,
        projectedCost: running && liveCostUsd > 0
      })}`
    }
    const cost =
      totalCostUsd > 0
        ? formatCostAlwaysOn(totalCostUsd, currency, undefined, overestimatePercent)
        : ''
    const prefix = hasProjectedCost ? '~' : ''
    return `${tokenLabel}${cost ? ` · ${prefix}${cost}` : ''}`
  }, [
    baseTally,
    baseTally.explicitCostUsd,
    baseTally.inputTokens,
    baseTally.outputTokens,
    baseTally.peakMemoryRssGb,
    currency,
    dualCostAndRam,
    displayedOutputTokens,
    model,
    overestimatePercent,
    provider,
    providerRates,
    running
  ])

  if (baseTally.totalTokens <= 0 && displayedOutputTokens <= 0) return null

  const liveTitle =
    running && liveOutputTokens > 0
      ? dualCostAndRam
        ? `${title}\n\nLive output and projected cost update once per second while this run is active. Peak RAM updates when an Ollama lane finishes.`
        : provider === 'ollama'
          ? `${title}\n\nLive output updates once per second while this run is active. Peak RAM updates when the run finishes.`
          : `${title}\n\nLive output and projected cost update once per second while this run is active.`
      : dualCostAndRam && baseTally.peakMemoryRssGb > 0
        ? `${title}\n\nCost from provider-reported spend and API-equivalent estimates. Peak RAM from the latest completed Ollama lane.`
        : provider === 'ollama' && baseTally.peakMemoryRssGb > 0
          ? `${title}\n\nPeak llama-server RAM from the latest completed Ollama run.`
          : title

  return (
    <span
      className={`composer-thread-token-tally${running ? ' is-live' : ''}`}
      title={liveTitle}
      aria-live="off"
    >
      {label}
    </span>
  )
})
