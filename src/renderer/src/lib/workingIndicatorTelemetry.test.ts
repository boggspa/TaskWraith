import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRun } from '../../../main/store/types'
import {
  buildWorkingIndicatorTokenTargets,
  workingIndicatorTokenSnapshotBucket
} from './workingIndicatorTelemetry'

const run = (runId: string, stats?: Record<string, unknown>): ChatRun =>
  ({
    runId,
    startedAt: '2026-07-11T18:00:00.000Z',
    status: 'running',
    ...(stats ? { stats } : {})
  }) as ChatRun

const message = (runId: string, content: string): ChatMessage =>
  ({
    id: `message-${runId}`,
    role: 'assistant',
    runId,
    content,
    timestamp: '2026-07-11T18:00:01.000Z'
  }) as ChatMessage

describe('buildWorkingIndicatorTokenTargets', () => {
  it('keeps simultaneous fan-out run estimates isolated by run id', () => {
    const targets = buildWorkingIndicatorTokenTargets(
      [run('claude-run'), run('cursor-run')],
      [
        message('claude-run', 'abcdefgh'), // 2 estimated tokens
        message('cursor-run', 'abcdefghijklmnop'), // 4 estimated tokens
        message('other-run', 'this must not bleed into either working row')
      ],
      [
        { runId: 'claude-run', tokenAccumulatorBase: 28_500 },
        { runId: 'cursor-run', tokenAccumulatorBase: 14_000 }
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

  it('prefers an authoritative current-run total when one is present', () => {
    const targets = buildWorkingIndicatorTokenTargets(
      [run('claude-run', { input_tokens: 180_000, output_tokens: 4_000, total_tokens: 184_000 })],
      [message('claude-run', 'small streamed preview')],
      [{ runId: 'claude-run', tokenAccumulatorBase: 28_500 }]
    )

    expect(targets.get('claude-run')).toMatchObject({
      targetTokens: 212_500
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
