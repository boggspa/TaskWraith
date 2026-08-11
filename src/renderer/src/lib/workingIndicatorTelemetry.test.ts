import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRun, ToolActivity } from '../../../main/store/types'
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

  it('keeps estimating through file reads, shell commands, and edits', () => {
    const targets = buildWorkingIndicatorTokenTargets(
      [run('codex-run')],
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
      [{ runId: 'codex-run', tokenAccumulatorBase: 1_000 }]
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
