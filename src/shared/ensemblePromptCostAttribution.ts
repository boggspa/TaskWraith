/**
 * Content-free receipt for one accepted Ensemble participant prompt.
 *
 * The receipt deliberately records lengths and counts only. Transcript text,
 * prompt text, participant prose, and message ids never enter usage.json.
 */
export interface EnsemblePromptTranscriptAttribution {
  /** Sanitized source request length before any provider-specific capsule bound. */
  sourceRequestChars: number
  /** Message-row characters actually retained in this prompt projection. */
  transcriptMessageChars: number
  transcriptMessageCount: number
  /** Retained rows at or before this seat's preceding transcript turn. */
  replayedTranscriptMessageChars: number
  replayedTranscriptMessageCount: number
  /** Retained rows after this seat's preceding turn, or all rows on its first turn. */
  freshTranscriptMessageChars: number
  freshTranscriptMessageCount: number
  /** Eligible rows absent from this prompt projection. */
  omittedTranscriptMessageCount: number
  /** True when either the transcript budget or a provider capsule dropped rows. */
  transcriptTruncated: boolean
}

export interface EnsemblePromptAttribution extends EnsemblePromptTranscriptAttribution {
  schemaVersion: 1
  promptKind: 'full' | 'slim'
  /** What the host asked the provider transport to do; not a claim that resume succeeded. */
  sessionContext: 'new' | 'resume-requested' | 'resume-requested-with-fallback'
  /** Exact accepted primary payload length after host routing appendices. */
  primaryPromptChars: number
  /** Exact cold-session candidate length when the adapter may fall back. */
  fallbackPromptChars?: number
}

export function buildEnsemblePromptAttribution(input: {
  promptKind: 'full' | 'slim'
  providerSessionId?: string | null
  primaryPromptChars: number
  fallbackPromptChars?: number
  transcript: EnsemblePromptTranscriptAttribution
}): EnsemblePromptAttribution {
  const resumeRequested = Boolean(input.providerSessionId?.trim())
  const fallbackPromptChars = resumeRequested ? count(input.fallbackPromptChars) : 0
  return {
    schemaVersion: 1,
    promptKind: input.promptKind,
    sessionContext: !resumeRequested
      ? 'new'
      : fallbackPromptChars > 0
        ? 'resume-requested-with-fallback'
        : 'resume-requested',
    primaryPromptChars: count(input.primaryPromptChars),
    ...(fallbackPromptChars > 0 ? { fallbackPromptChars } : {}),
    ...input.transcript
  }
}

/** Structural subset accepted from UsageRecord without coupling this shared fold to the store. */
export interface EnsemblePromptCostUsageRecord {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  runCount?: number
  tokenCountConfidence?: 'reported' | 'estimated'
  ensemblePromptKind?: 'full' | 'slim'
  ensemblePromptAttribution?: EnsemblePromptAttribution
}

export interface EnsemblePromptCostSummary {
  schemaVersion: 1
  ensembleRunCount: number
  attributedRunCount: number
  attributionCoverage: number | null
  fullPromptRunCount: number
  slimPromptRunCount: number
  resumeRequestedRunCount: number
  resumeFallbackCandidateRunCount: number
  fullPromptOnResumeRequestedRunCount: number
  truncatedPromptRunCount: number
  estimatedTokenRunCount: number
  freshInputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  inclusiveInputTokens: number
  outputTokens: number
  inputToOutputRatio: number | null
  cacheReadShareOfInput: number | null
  primaryPromptChars: number
  fallbackPromptChars: number
  transcriptMessageChars: number
  replayedTranscriptMessageChars: number
  freshTranscriptMessageChars: number
  replayShareOfTranscript: number | null
  replayToFreshRatio: number | null
  transcriptMessageCount: number
  replayedTranscriptMessageCount: number
  freshTranscriptMessageCount: number
  omittedTranscriptMessageCount: number
}

function count(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}

/**
 * Fold usage rows into the measurements needed to diagnose long-horizon
 * re-reading. Legacy Ensemble rows still contribute token and full/slim
 * totals; the explicit coverage field prevents partial replay telemetry from
 * masquerading as a complete mission measurement.
 */
export function summarizeEnsemblePromptCost(
  records: readonly EnsemblePromptCostUsageRecord[]
): EnsemblePromptCostSummary {
  const summary: EnsemblePromptCostSummary = {
    schemaVersion: 1,
    ensembleRunCount: 0,
    attributedRunCount: 0,
    attributionCoverage: null,
    fullPromptRunCount: 0,
    slimPromptRunCount: 0,
    resumeRequestedRunCount: 0,
    resumeFallbackCandidateRunCount: 0,
    fullPromptOnResumeRequestedRunCount: 0,
    truncatedPromptRunCount: 0,
    estimatedTokenRunCount: 0,
    freshInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    inclusiveInputTokens: 0,
    outputTokens: 0,
    inputToOutputRatio: null,
    cacheReadShareOfInput: null,
    primaryPromptChars: 0,
    fallbackPromptChars: 0,
    transcriptMessageChars: 0,
    replayedTranscriptMessageChars: 0,
    freshTranscriptMessageChars: 0,
    replayShareOfTranscript: null,
    replayToFreshRatio: null,
    transcriptMessageCount: 0,
    replayedTranscriptMessageCount: 0,
    freshTranscriptMessageCount: 0,
    omittedTranscriptMessageCount: 0
  }

  for (const record of records) {
    const attribution = record.ensemblePromptAttribution
    const promptKind = attribution?.promptKind ?? record.ensemblePromptKind
    if (!promptKind) continue

    const runCount = Math.max(1, count(record.runCount))
    summary.ensembleRunCount += runCount
    summary[promptKind === 'slim' ? 'slimPromptRunCount' : 'fullPromptRunCount'] += runCount
    if (record.tokenCountConfidence === 'estimated') summary.estimatedTokenRunCount += runCount

    const freshInputTokens = count(record.inputTokens)
    const cacheReadInputTokens = count(record.cacheReadInputTokens)
    const cacheCreationInputTokens = count(record.cacheCreationInputTokens)
    summary.freshInputTokens += freshInputTokens
    summary.cacheReadInputTokens += cacheReadInputTokens
    summary.cacheCreationInputTokens += cacheCreationInputTokens
    summary.inclusiveInputTokens +=
      freshInputTokens + cacheReadInputTokens + cacheCreationInputTokens
    summary.outputTokens += count(record.outputTokens)

    if (!attribution) continue
    summary.attributedRunCount += runCount
    summary.primaryPromptChars += count(attribution.primaryPromptChars)
    summary.fallbackPromptChars += count(attribution.fallbackPromptChars)
    summary.transcriptMessageChars += count(attribution.transcriptMessageChars)
    summary.replayedTranscriptMessageChars += count(attribution.replayedTranscriptMessageChars)
    summary.freshTranscriptMessageChars += count(attribution.freshTranscriptMessageChars)
    summary.transcriptMessageCount += count(attribution.transcriptMessageCount)
    summary.replayedTranscriptMessageCount += count(attribution.replayedTranscriptMessageCount)
    summary.freshTranscriptMessageCount += count(attribution.freshTranscriptMessageCount)
    summary.omittedTranscriptMessageCount += count(attribution.omittedTranscriptMessageCount)
    if (attribution.transcriptTruncated) summary.truncatedPromptRunCount += runCount
    if (attribution.sessionContext !== 'new') {
      summary.resumeRequestedRunCount += runCount
      if (promptKind === 'full') summary.fullPromptOnResumeRequestedRunCount += runCount
    }
    if (attribution.sessionContext === 'resume-requested-with-fallback') {
      summary.resumeFallbackCandidateRunCount += runCount
    }
  }

  summary.attributionCoverage = ratio(summary.attributedRunCount, summary.ensembleRunCount)
  summary.inputToOutputRatio = ratio(summary.inclusiveInputTokens, summary.outputTokens)
  summary.cacheReadShareOfInput = ratio(summary.cacheReadInputTokens, summary.inclusiveInputTokens)
  summary.replayShareOfTranscript = ratio(
    summary.replayedTranscriptMessageChars,
    summary.transcriptMessageChars
  )
  summary.replayToFreshRatio = ratio(
    summary.replayedTranscriptMessageChars,
    summary.freshTranscriptMessageChars
  )
  return summary
}
