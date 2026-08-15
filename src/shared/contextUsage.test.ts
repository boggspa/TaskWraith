import { describe, expect, it } from 'vitest'
import {
  buildContextCompactionUsageEvidenceIndex,
  contextUsageAfterCompaction,
  contextTokensFromStats,
  contextUsageFromStats,
  latestContextCompactionUsageEvidence,
  TASKWRAITH_CONTEXT_USAGE_KEY,
  withContextUsageSnapshot
} from './contextUsage'

describe('contextUsage', () => {
  it('treats OpenAI cached input and reasoning as subsets of their parent counts', () => {
    expect(
      contextUsageFromStats({
        inputTokens: 100,
        cachedInputTokens: 80,
        outputTokens: 20,
        reasoningOutputTokens: 15,
        totalTokens: 120
      })
    ).toMatchObject({
      contextTokens: 120,
      inputTokens: 100,
      freshInputTokens: 20,
      cacheReadInputTokens: 80,
      outputTokens: 20,
      visibleOutputTokens: 5,
      reasoningTokens: 15,
      unclassifiedTokens: 0
    })
  })

  it('adds Anthropic cache reads and writes to uncached input', () => {
    expect(
      contextUsageFromStats({
        input_tokens: 2,
        cache_read_input_tokens: 88_434,
        cache_creation_input_tokens: 1_947,
        output_tokens: 812
      })
    ).toMatchObject({
      contextTokens: 91_195,
      inputTokens: 90_383,
      freshInputTokens: 2,
      cacheReadInputTokens: 88_434,
      cacheCreationInputTokens: 1_947,
      outputTokens: 812
    })
  })

  it('keeps Gemini thoughts separate from candidate output and tool prompt tokens nested', () => {
    expect(
      contextUsageFromStats({
        promptTokenCount: 1_000,
        cachedContentTokenCount: 700,
        candidatesTokenCount: 80,
        thoughtsTokenCount: 120,
        toolUsePromptTokenCount: 250,
        totalTokenCount: 1_200
      })
    ).toMatchObject({
      contextTokens: 1_200,
      inputTokens: 1_000,
      freshInputTokens: 300,
      cacheReadInputTokens: 700,
      visibleOutputTokens: 80,
      reasoningTokens: 120,
      toolUsePromptTokens: 250
    })
  })

  it('adds Pi cache counters because Pi input excludes them', () => {
    expect(
      contextUsageFromStats({
        input_tokens: 10,
        cache_read_input_tokens: 90,
        cache_creation_input_tokens: 5,
        output_tokens: 7
      })
    ).toMatchObject({
      contextTokens: 112,
      inputTokens: 105,
      freshInputTokens: 10,
      cacheReadInputTokens: 90,
      cacheCreationInputTokens: 5,
      outputTokens: 7
    })
  })

  it('marks character-count stats as estimated', () => {
    expect(
      contextUsageFromStats({
        input_tokens: 30,
        output_tokens: 12,
        total_tokens: 42,
        _taskwraith_token_count_confidence: 'estimated'
      })
    ).toMatchObject({
      contextTokens: 42,
      source: 'host-estimate',
      precision: 'estimated'
    })
  })

  it('prefers a persisted atomic snapshot over a much larger turn aggregate', () => {
    const aggregate = {
      input_tokens: 500_000,
      output_tokens: 20_000,
      total_tokens: 520_000
    }
    const atomic = withContextUsageSnapshot(
      {
        input_tokens: 90_000,
        output_tokens: 1_000,
        total_tokens: 91_000
      },
      {
        source: 'provider-last-invocation',
        precision: 'exact'
      }
    )[TASKWRAITH_CONTEXT_USAGE_KEY]

    const stats = { ...aggregate, [TASKWRAITH_CONTEXT_USAGE_KEY]: atomic }
    expect(contextTokensFromStats(stats)).toBe(91_000)
    expect(contextUsageFromStats(stats)).toMatchObject({
      contextTokens: 91_000,
      source: 'provider-last-invocation',
      precision: 'exact'
    })
  })

  it('preserves atomic receipt time for ordering against compaction evidence', () => {
    const observedAt = Date.parse('2026-05-30T12:03:00.000Z')
    expect(
      contextUsageFromStats(
        withContextUsageSnapshot(
          { input_tokens: 90_000, output_tokens: 1_000 },
          {
            source: 'provider-last-invocation',
            precision: 'exact',
            observedAt
          }
        )
      )
    ).toMatchObject({ observedAt, contextTokens: 91_000 })
  })

  it('extracts per-seat compaction evidence and represents missing post tokens honestly', () => {
    const messages = [
      {
        id: 'p1-compaction-card',
        timestamp: '2026-05-30T12:01:00.000Z',
        metadata: {
          ensembleParticipantId: 'p1',
          contextCompaction: {
            kind: 'completed',
            telemetry: {
              provider: 'claude',
              eventUuid: 'compact-p1',
              postTokens: 21_000
            }
          }
        }
      },
      {
        timestamp: '2026-05-30T12:02:00.000Z',
        metadata: {
          ensembleParticipantId: 'p2',
          contextCompaction: { kind: 'completed', telemetry: {} }
        }
      }
    ]

    const exact = latestContextCompactionUsageEvidence(messages, 'p1')
    expect(exact).toMatchObject({
      epochKey: 'event:compact-p1',
      messageId: 'p1-compaction-card',
      provider: 'claude'
    })
    expect(contextUsageAfterCompaction(undefined, exact!)).toMatchObject({
      contextTokens: 21_000,
      source: 'provider-compaction',
      precision: 'exact'
    })

    const unknown = latestContextCompactionUsageEvidence(messages, 'p2')
    expect(
      contextUsageAfterCompaction(
        contextUsageFromStats({ input_tokens: 90_000, output_tokens: 1_000 }),
        unknown!
      )
    ).toMatchObject({
      contextTokens: 91_000,
      unclassifiedTokens: 91_000,
      source: 'post-compaction-unknown',
      precision: 'estimated'
    })
    expect(latestContextCompactionUsageEvidence(messages)).toBeNull()
  })

  it('indexes unscoped and per-seat compaction evidence in one transcript walk', () => {
    let metadataReads = 0
    const message = (
      timestamp: string,
      metadata: Record<string, unknown>
    ): Record<string, unknown> => ({
      timestamp,
      get metadata() {
        metadataReads += 1
        return metadata
      }
    })
    const messages = [
      message('2026-05-30T12:00:00.000Z', {
        contextCompaction: { kind: 'completed', telemetry: { postTokens: 30_000 } }
      }),
      message('2026-05-30T12:01:00.000Z', {
        ensembleParticipantId: 'p1',
        contextCompaction: { kind: 'completed', telemetry: { postTokens: 12_000 } }
      }),
      // Equal timestamps keep transcript order deterministic; exact zero must
      // survive the index rather than falling back to the earlier positive value.
      message('2026-05-30T12:01:00.000Z', {
        ensembleParticipantId: 'p1',
        contextCompaction: { kind: 'completed', telemetry: { postTokens: 0 } }
      }),
      message('invalid', {
        ensembleParticipantId: 'p2',
        contextCompaction: { kind: 'completed', telemetry: {} }
      })
    ]

    const evidence = buildContextCompactionUsageEvidenceIndex(messages)

    expect(metadataReads).toBe(messages.length)
    expect(evidence.unscoped).toEqual({
      observedAt: Date.parse('2026-05-30T12:00:00.000Z'),
      postTokens: 30_000
    })
    expect(evidence.byParticipantId.get('p1')).toEqual({
      observedAt: Date.parse('2026-05-30T12:01:00.000Z'),
      postTokens: 0
    })
    expect(evidence.byParticipantId.get('p2')).toEqual({ observedAt: 0 })
    expect(evidence.byParticipantId.has('missing')).toBe(false)
  })

  it('keeps zero as a valid exact post-compaction occupancy', () => {
    const compacted = contextUsageAfterCompaction(contextUsageFromStats({ total_tokens: 91_000 }), {
      observedAt: 1,
      postTokens: 0
    })
    expect(compacted).toMatchObject({
      observedAt: 1,
      contextTokens: 0,
      source: 'provider-compaction',
      precision: 'exact'
    })
    expect(contextUsageFromStats({ [TASKWRAITH_CONTEXT_USAGE_KEY]: compacted })).toMatchObject({
      contextTokens: 0,
      source: 'provider-compaction',
      precision: 'exact'
    })
  })
})
