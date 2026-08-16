import { describe, expect, it } from 'vitest'
import {
  summarizeEnsemblePromptCost,
  type EnsemblePromptAttribution,
  type EnsemblePromptCostUsageRecord
} from './ensemblePromptCostAttribution'

function attribution(
  overrides: Partial<EnsemblePromptAttribution> = {}
): EnsemblePromptAttribution {
  return {
    schemaVersion: 1,
    promptKind: 'full',
    sessionContext: 'new',
    primaryPromptChars: 1_000,
    sourceRequestChars: 40,
    transcriptMessageChars: 600,
    transcriptMessageCount: 6,
    replayedTranscriptMessageChars: 400,
    replayedTranscriptMessageCount: 4,
    freshTranscriptMessageChars: 200,
    freshTranscriptMessageCount: 2,
    omittedTranscriptMessageCount: 1,
    transcriptTruncated: false,
    ...overrides
  }
}

describe('summarizeEnsemblePromptCost', () => {
  it('measures input amplification, cache share, and transcript replay', () => {
    const records: EnsemblePromptCostUsageRecord[] = [
      {
        inputTokens: 700,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 100,
        outputTokens: 100,
        ensemblePromptKind: 'full',
        ensemblePromptAttribution: attribution()
      },
      {
        inputTokens: 100,
        outputTokens: 100,
        ensemblePromptKind: 'slim',
        ensemblePromptAttribution: attribution({
          promptKind: 'slim',
          sessionContext: 'resume-requested-with-fallback',
          primaryPromptChars: 300,
          fallbackPromptChars: 1_200,
          transcriptMessageChars: 100,
          transcriptMessageCount: 1,
          replayedTranscriptMessageChars: 0,
          replayedTranscriptMessageCount: 0,
          freshTranscriptMessageChars: 100,
          freshTranscriptMessageCount: 1,
          omittedTranscriptMessageCount: 0,
          transcriptTruncated: true
        })
      }
    ]

    expect(summarizeEnsemblePromptCost(records)).toMatchObject({
      ensembleRunCount: 2,
      attributedRunCount: 2,
      attributionCoverage: 1,
      fullPromptRunCount: 1,
      slimPromptRunCount: 1,
      resumeRequestedRunCount: 1,
      resumeFallbackCandidateRunCount: 1,
      fullPromptOnResumeRequestedRunCount: 0,
      truncatedPromptRunCount: 1,
      freshInputTokens: 800,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 100,
      inclusiveInputTokens: 1_100,
      outputTokens: 200,
      inputToOutputRatio: 5.5,
      cacheReadShareOfInput: 200 / 1_100,
      primaryPromptChars: 1_300,
      fallbackPromptChars: 1_200,
      transcriptMessageChars: 700,
      replayedTranscriptMessageChars: 400,
      freshTranscriptMessageChars: 300,
      replayShareOfTranscript: 400 / 700,
      replayToFreshRatio: 400 / 300,
      transcriptMessageCount: 7,
      replayedTranscriptMessageCount: 4,
      freshTranscriptMessageCount: 3,
      omittedTranscriptMessageCount: 1
    })
  })

  it('keeps legacy ensemble usage in totals and makes partial coverage explicit', () => {
    const summary = summarizeEnsemblePromptCost([
      {
        inputTokens: 90,
        outputTokens: 10,
        runCount: 3,
        ensemblePromptKind: 'full',
        tokenCountConfidence: 'estimated'
      },
      {
        inputTokens: 5,
        outputTokens: 5,
        ensemblePromptKind: 'slim',
        ensemblePromptAttribution: attribution({
          promptKind: 'slim',
          sessionContext: 'resume-requested',
          transcriptMessageChars: 0,
          transcriptMessageCount: 0,
          replayedTranscriptMessageChars: 0,
          replayedTranscriptMessageCount: 0,
          freshTranscriptMessageChars: 0,
          freshTranscriptMessageCount: 0
        })
      },
      { inputTokens: 999, outputTokens: 999 }
    ])

    expect(summary).toMatchObject({
      ensembleRunCount: 4,
      attributedRunCount: 1,
      attributionCoverage: 0.25,
      fullPromptRunCount: 3,
      slimPromptRunCount: 1,
      estimatedTokenRunCount: 3,
      inclusiveInputTokens: 95,
      outputTokens: 15,
      replayShareOfTranscript: null,
      replayToFreshRatio: null
    })
  })

  it('reports undefined ratios as null and ignores malformed counters', () => {
    const summary = summarizeEnsemblePromptCost([
      {
        inputTokens: Number.NaN,
        outputTokens: -1,
        ensemblePromptKind: 'full',
        ensemblePromptAttribution: attribution({
          sessionContext: 'resume-requested',
          primaryPromptChars: Number.POSITIVE_INFINITY,
          transcriptMessageChars: -5,
          transcriptMessageCount: -1,
          replayedTranscriptMessageChars: -2,
          replayedTranscriptMessageCount: -2,
          freshTranscriptMessageChars: 0,
          freshTranscriptMessageCount: 0
        })
      }
    ])

    expect(summary).toMatchObject({
      ensembleRunCount: 1,
      fullPromptOnResumeRequestedRunCount: 1,
      inclusiveInputTokens: 0,
      outputTokens: 0,
      inputToOutputRatio: null,
      cacheReadShareOfInput: null,
      primaryPromptChars: 0,
      replayShareOfTranscript: null,
      replayToFreshRatio: null
    })
  })
})
