import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRun, ProviderId, ToolActivity } from '../../../main/store/types'
import { withContextUsageSnapshot } from '../../../shared/contextUsage'
import {
  buildWorkingIndicatorTokenTargets,
  workingIndicatorTokenTargetKey,
  workingIndicatorTokenSnapshotBucket
} from './workingIndicatorTelemetry'

const run = (
  runId: string,
  stats?: Record<string, unknown>,
  patch: Partial<ChatRun> = {}
): ChatRun =>
  ({
    runId,
    startedAt: '2026-07-11T18:00:00.000Z',
    status: 'running',
    ...(stats ? { stats } : {}),
    ...patch
  }) as ChatRun

const input = (runId: string, participantId: string, provider: ProviderId, modelId: string) => ({
  runId,
  participantId,
  provider,
  modelId
})

const message = (runId: string, content: string): ChatMessage =>
  ({
    id: `message-${runId}`,
    role: 'assistant',
    runId,
    content,
    timestamp: '2026-07-11T18:00:01.000Z'
  }) as ChatMessage

const timedMessage = (runId: string, id: string, content: string, timestamp: string): ChatMessage =>
  ({ id, role: 'assistant', runId, content, timestamp }) as ChatMessage

const compactionMessage = ({
  id,
  participantId,
  provider = 'claude',
  kind = 'completed',
  timestamp,
  postTokens
}: {
  id: string
  participantId: string
  provider?: ProviderId
  kind?: 'started' | 'completed' | 'failed'
  timestamp: string
  postTokens?: number
}): ChatMessage =>
  ({
    id,
    role: 'system',
    content: 'Context compacted',
    timestamp,
    metadata: {
      kind: 'contextCompaction',
      ensembleParticipantId: participantId,
      contextCompaction: {
        kind,
        telemetry: {
          provider,
          eventUuid: id,
          ...(postTokens !== undefined ? { postTokens } : {})
        }
      }
    }
  }) as ChatMessage

const activity = (
  id: string,
  toolName: string,
  category: ToolActivity['category'],
  parameters: Record<string, unknown>,
  outputPreview: string
): ToolActivity =>
  ({
    id,
    toolName,
    displayName: toolName,
    category,
    status: 'success',
    parameters,
    outputPreview
  }) as ToolActivity

const toolMessage = (runId: string, toolActivities: ToolActivity[]): ChatMessage =>
  ({
    id: `tools-${runId}`,
    role: 'tool',
    runId,
    content: '',
    toolActivities,
    timestamp: '2026-07-11T18:00:02.000Z'
  }) as ChatMessage

describe('buildWorkingIndicatorTokenTargets', () => {
  it('keeps simultaneous fan-out run estimates isolated by run id', () => {
    const targets = buildWorkingIndicatorTokenTargets(
      [
        run(
          'claude-previous',
          { total_tokens: 28_500 },
          {
            status: 'completed',
            ensembleParticipantId: 'claude-seat',
            provider: 'claude',
            actualModel: 'claude-opus-4-6'
          }
        ),
        run(
          'cursor-previous',
          { total_tokens: 14_000 },
          {
            status: 'completed',
            ensembleParticipantId: 'cursor-seat',
            provider: 'cursor',
            actualModel: 'composer-1.5'
          }
        ),
        run('claude-run', undefined, {
          ensembleParticipantId: 'claude-seat',
          provider: 'claude',
          actualModel: 'claude-opus-4-6'
        }),
        run('cursor-run', undefined, {
          ensembleParticipantId: 'cursor-seat',
          provider: 'cursor',
          actualModel: 'composer-1.5'
        })
      ],
      [
        message('claude-run', 'abcdefgh'), // 2 estimated tokens
        message('cursor-run', 'abcdefghijklmnop'), // 4 estimated tokens
        message('other-run', 'this must not bleed into either working row')
      ],
      [
        input('claude-run', 'claude-seat', 'claude', 'claude-opus-4-6'),
        input('cursor-run', 'cursor-seat', 'cursor', 'composer-1.5')
      ]
    )

    expect(targets.get('claude-run')).toMatchObject({
      targetTokens: 28_502,
      estimatedCurrentTurnTokens: 2
    })
    expect(targets.get('cursor-run')).toMatchObject({
      targetTokens: 14_004,
      estimatedCurrentTurnTokens: 4
    })
  })

  it('keeps simultaneous pre-run fan-out baselines isolated by participant id', () => {
    const claudeInput = {
      runId: null,
      participantId: 'claude-seat',
      provider: 'claude' as const,
      modelId: 'claude-opus-4-6'
    }
    const cursorInput = {
      runId: null,
      participantId: 'cursor-seat',
      provider: 'cursor' as const,
      modelId: 'composer-1.5'
    }
    const targets = buildWorkingIndicatorTokenTargets(
      [
        run(
          'claude-previous',
          { total_tokens: 28_500 },
          {
            status: 'completed',
            ensembleParticipantId: 'claude-seat',
            provider: 'claude',
            actualModel: 'claude-opus-4-6'
          }
        ),
        run(
          'cursor-previous',
          { total_tokens: 14_000 },
          {
            status: 'completed',
            ensembleParticipantId: 'cursor-seat',
            provider: 'cursor',
            actualModel: 'composer-1.5'
          }
        )
      ],
      [],
      [claudeInput, cursorInput]
    )

    expect(targets.get(workingIndicatorTokenTargetKey(claudeInput))?.targetTokens).toBe(28_500)
    expect(targets.get(workingIndicatorTokenTargetKey(cursorInput))?.targetTokens).toBe(14_000)
  })

  it('uses current invocation context instead of adding it to the prior context', () => {
    const targets = buildWorkingIndicatorTokenTargets(
      [
        run(
          'claude-previous',
          { total_tokens: 28_500 },
          {
            status: 'completed',
            ensembleParticipantId: 'claude-seat',
            provider: 'claude',
            actualModel: 'claude-opus-4-6'
          }
        ),
        run(
          'claude-run',
          { input_tokens: 180_000, output_tokens: 4_000, total_tokens: 184_000 },
          {
            ensembleParticipantId: 'claude-seat',
            provider: 'claude',
            actualModel: 'claude-opus-4-6'
          }
        )
      ],
      [message('claude-run', 'small streamed preview')],
      [input('claude-run', 'claude-seat', 'claude', 'claude-opus-4-6')]
    )

    expect(targets.get('claude-run')).toMatchObject({
      contextBaselineTokens: 28_500,
      contextBaselineAvailable: true,
      targetTokens: 184_000
    })
  })

  it('does not inherit context from a previous model in the same participant slot', () => {
    const targets = buildWorkingIndicatorTokenTargets(
      [
        run(
          'codex-old-model',
          { total_tokens: 920_000 },
          {
            status: 'completed',
            ensembleParticipantId: 'codex-seat',
            provider: 'codex',
            actualModel: 'gpt-5.5'
          }
        ),
        run('codex-spark', undefined, {
          ensembleParticipantId: 'codex-seat',
          provider: 'codex',
          actualModel: 'gpt-5.3-codex-spark'
        })
      ],
      [],
      [input('codex-spark', 'codex-seat', 'codex', 'gpt-5.3-codex-spark')]
    )

    expect(targets.get('codex-spark')).toMatchObject({
      contextBaselineTokens: 0,
      contextBaselineAvailable: false,
      targetTokens: 0
    })

    const previousEpoch = buildWorkingIndicatorTokenTargets(
      [
        run(
          'codex-old-model',
          { total_tokens: 920_000 },
          {
            status: 'completed',
            ensembleParticipantId: 'codex-seat',
            provider: 'codex',
            actualModel: 'gpt-5.5'
          }
        )
      ],
      [],
      [input('codex-old-model', 'codex-seat', 'codex', 'gpt-5.5')]
    ).get('codex-old-model')?.tokenEpochKey
    expect(targets.get('codex-spark')?.tokenEpochKey).not.toBe(previousEpoch)
  })

  it('starts a new token epoch at successful compaction and counts only post-boundary output', () => {
    const compactedAt = '2026-07-11T19:05:00.000Z'
    const targets = buildWorkingIndicatorTokenTargets(
      [
        run(
          'claude-previous',
          { total_tokens: 1_001_208 },
          {
            status: 'completed',
            startedAt: '2026-07-11T18:00:00.000Z',
            ensembleParticipantId: 'claude-seat',
            provider: 'claude',
            actualModel: 'claude-opus-4-6'
          }
        ),
        run('claude-live', undefined, {
          startedAt: '2026-07-11T19:00:00.000Z',
          ensembleParticipantId: 'claude-seat',
          provider: 'claude',
          actualModel: 'claude-opus-4-6'
        })
      ],
      [
        timedMessage('claude-live', 'before', 'x'.repeat(400), '2026-07-11T19:04:00.000Z'),
        compactionMessage({
          id: 'compact-1',
          participantId: 'claude-seat',
          timestamp: compactedAt,
          postTokens: 8_486
        }),
        timedMessage('claude-live', 'after', 'y'.repeat(40), '2026-07-11T19:06:00.000Z')
      ],
      [input('claude-live', 'claude-seat', 'claude', 'claude-opus-4-6')]
    )

    expect(targets.get('claude-live')).toMatchObject({
      tokenEpochKey: '["claude-seat","claude","claude-opus-4-6"]:compaction:event:compact-1',
      tokenEpochObservedAt: Date.parse(compactedAt),
      contextBaselineTokens: 8_486,
      contextBaselineAvailable: true,
      contextState: 'available',
      targetTokens: 8_496,
      estimatedCurrentTurnTokens: 10
    })
  })

  it('does not reset the token epoch for started or failed compaction attempts', () => {
    const targets = buildWorkingIndicatorTokenTargets(
      [
        run(
          'claude-previous',
          { total_tokens: 90_000 },
          {
            status: 'completed',
            ensembleParticipantId: 'claude-seat',
            provider: 'claude',
            actualModel: 'claude-opus-4-6'
          }
        ),
        run('claude-live', undefined, {
          ensembleParticipantId: 'claude-seat',
          provider: 'claude',
          actualModel: 'claude-opus-4-6'
        })
      ],
      [
        compactionMessage({
          id: 'compact-started',
          participantId: 'claude-seat',
          kind: 'started',
          timestamp: '2026-07-11T19:05:00.000Z'
        }),
        compactionMessage({
          id: 'compact-failed',
          participantId: 'claude-seat',
          kind: 'failed',
          timestamp: '2026-07-11T19:06:00.000Z'
        })
      ],
      [input('claude-live', 'claude-seat', 'claude', 'claude-opus-4-6')]
    )

    expect(targets.get('claude-live')).toMatchObject({
      tokenEpochKey: '["claude-seat","claude","claude-opus-4-6"]',
      tokenEpochObservedAt: null,
      contextBaselineTokens: 90_000,
      contextState: 'available'
    })
  })

  it('rejects a pre-compaction current-run snapshot but accepts a newer one', () => {
    const compactedAt = Date.parse('2026-07-11T19:05:00.000Z')
    const build = (observedAt: number, contextTokens: number) =>
      buildWorkingIndicatorTokenTargets(
        [
          run(
            'claude-previous',
            { total_tokens: 90_000 },
            {
              status: 'completed',
              startedAt: '2026-07-11T18:00:00.000Z',
              ensembleParticipantId: 'claude-seat',
              provider: 'claude',
              actualModel: 'claude-opus-4-6'
            }
          ),
          run(
            'claude-live',
            withContextUsageSnapshot(
              { total_tokens: contextTokens },
              { source: 'provider-last-invocation', precision: 'exact', observedAt }
            ),
            {
              startedAt: '2026-07-11T19:00:00.000Z',
              ensembleParticipantId: 'claude-seat',
              provider: 'claude',
              actualModel: 'claude-opus-4-6'
            }
          )
        ],
        [
          compactionMessage({
            id: 'compact-ordering',
            participantId: 'claude-seat',
            timestamp: '2026-07-11T19:05:00.000Z',
            postTokens: 8_486
          })
        ],
        [input('claude-live', 'claude-seat', 'claude', 'claude-opus-4-6')]
      ).get('claude-live')

    expect(build(compactedAt - 1_000, 1_001_208)).toMatchObject({
      contextBaselineTokens: 8_486,
      targetTokens: 8_486
    })
    expect(build(compactedAt + 1_000, 25_500)).toMatchObject({
      contextBaselineTokens: 8_486,
      targetTokens: 25_500
    })
  })

  it('marks context unavailable when successful compaction omits post tokens', () => {
    const targets = buildWorkingIndicatorTokenTargets(
      [
        run(
          'antigravity-previous',
          { total_tokens: 91_000 },
          {
            status: 'completed',
            startedAt: '2026-07-11T18:00:00.000Z',
            ensembleParticipantId: 'antigravity-seat',
            provider: 'antigravity',
            actualModel: 'gemini-3-pro'
          }
        ),
        run('antigravity-live', undefined, {
          startedAt: '2026-07-11T19:00:00.000Z',
          ensembleParticipantId: 'antigravity-seat',
          provider: 'antigravity',
          actualModel: 'gemini-3-pro'
        })
      ],
      [
        compactionMessage({
          id: 'compact-unknown',
          participantId: 'antigravity-seat',
          provider: 'antigravity',
          timestamp: '2026-07-11T19:05:00.000Z'
        }),
        timedMessage(
          'antigravity-live',
          'after-unknown',
          'z'.repeat(40),
          '2026-07-11T19:06:00.000Z'
        )
      ],
      [input('antigravity-live', 'antigravity-seat', 'antigravity', 'gemini-3-pro')]
    )

    expect(targets.get('antigravity-live')).toMatchObject({
      contextBaselineTokens: 0,
      contextBaselineAvailable: false,
      contextState: 'post-compaction-unknown',
      targetTokens: 0,
      estimatedCurrentTurnTokens: 10
    })

    const recovered = buildWorkingIndicatorTokenTargets(
      [
        run(
          'antigravity-previous',
          { total_tokens: 91_000 },
          {
            status: 'completed',
            startedAt: '2026-07-11T18:00:00.000Z',
            ensembleParticipantId: 'antigravity-seat',
            provider: 'antigravity',
            actualModel: 'gemini-3-pro'
          }
        ),
        run(
          'antigravity-live',
          withContextUsageSnapshot(
            { total_tokens: 24_000 },
            {
              source: 'provider-last-invocation',
              precision: 'exact',
              observedAt: Date.parse('2026-07-11T19:06:30.000Z')
            }
          ),
          {
            startedAt: '2026-07-11T19:00:00.000Z',
            ensembleParticipantId: 'antigravity-seat',
            provider: 'antigravity',
            actualModel: 'gemini-3-pro'
          }
        )
      ],
      [
        compactionMessage({
          id: 'compact-unknown',
          participantId: 'antigravity-seat',
          provider: 'antigravity',
          timestamp: '2026-07-11T19:05:00.000Z'
        })
      ],
      [input('antigravity-live', 'antigravity-seat', 'antigravity', 'gemini-3-pro')]
    ).get('antigravity-live')
    expect(recovered).toMatchObject({
      contextState: 'available',
      targetTokens: 24_000
    })
  })

  it('resets only the participant whose fan-out context compacted', () => {
    const targets = buildWorkingIndicatorTokenTargets(
      [
        run(
          'claude-previous',
          { total_tokens: 90_000 },
          {
            status: 'completed',
            startedAt: '2026-07-11T18:00:00.000Z',
            ensembleParticipantId: 'claude-seat',
            provider: 'claude',
            actualModel: 'claude-opus-4-6'
          }
        ),
        run(
          'codex-previous',
          { total_tokens: 31_000 },
          {
            status: 'completed',
            startedAt: '2026-07-11T18:00:00.000Z',
            ensembleParticipantId: 'codex-seat',
            provider: 'codex',
            actualModel: 'gpt-5.5'
          }
        ),
        run('claude-live', undefined, {
          startedAt: '2026-07-11T19:00:00.000Z',
          ensembleParticipantId: 'claude-seat',
          provider: 'claude',
          actualModel: 'claude-opus-4-6'
        }),
        run('codex-live', undefined, {
          startedAt: '2026-07-11T19:00:00.000Z',
          ensembleParticipantId: 'codex-seat',
          provider: 'codex',
          actualModel: 'gpt-5.5'
        })
      ],
      [
        compactionMessage({
          id: 'compact-claude-only',
          participantId: 'claude-seat',
          timestamp: '2026-07-11T19:05:00.000Z',
          postTokens: 8_000
        })
      ],
      [
        input('claude-live', 'claude-seat', 'claude', 'claude-opus-4-6'),
        input('codex-live', 'codex-seat', 'codex', 'gpt-5.5')
      ]
    )

    expect(targets.get('claude-live')).toMatchObject({
      contextBaselineTokens: 8_000,
      targetTokens: 8_000
    })
    expect(targets.get('codex-live')).toMatchObject({
      tokenEpochObservedAt: null,
      contextBaselineTokens: 31_000,
      targetTokens: 31_000
    })
  })

  it('keeps estimating through file reads, shell commands, and edits', () => {
    const targets = buildWorkingIndicatorTokenTargets(
      [
        run(
          'codex-previous',
          { total_tokens: 1_000 },
          {
            status: 'completed',
            ensembleParticipantId: 'codex-seat',
            provider: 'codex',
            actualModel: 'gpt-5.5'
          }
        ),
        run('codex-run', undefined, {
          ensembleParticipantId: 'codex-seat',
          provider: 'codex',
          actualModel: 'gpt-5.5'
        })
      ],
      [
        message('codex-run', 'abcdefgh'),
        toolMessage('codex-run', [
          activity('read', 'read_file', 'read', { path: 'a' }, 'read-result'),
          activity('shell', 'shell', 'shell', { cmd: 'ls -la' }, 'shell-result'),
          activity('write', 'write_file', 'write', { path: 'b', content: 'edit' }, 'done')
        ]),
        toolMessage('other-run', [
          activity('other', 'read_file', 'read', { path: 'large' }, 'must-not-bleed')
        ])
      ],
      [input('codex-run', 'codex-seat', 'codex', 'gpt-5.5')]
    )

    expect(targets.get('codex-run')).toMatchObject({
      targetTokens: 1_029,
      estimatedCurrentTurnTokens: 29,
      estimatedToolResultTokens: 7
    })
  })
})

describe('workingIndicatorTokenSnapshotBucket', () => {
  it('suppresses tiny stream deltas but keeps live snapshots visibly fresh', () => {
    expect(workingIndicatorTokenSnapshotBucket(1_009)).toBe(1_000)
    expect(workingIndicatorTokenSnapshotBucket(1_010)).toBe(1_010)
    expect(workingIndicatorTokenSnapshotBucket(16_099)).toBe(16_000)
    expect(workingIndicatorTokenSnapshotBucket(101_999)).toBe(101_000)
  })
})
