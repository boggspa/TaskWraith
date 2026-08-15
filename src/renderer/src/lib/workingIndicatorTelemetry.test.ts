import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRun, ProviderId, ToolActivity } from '../../../main/store/types'
import {
  buildWorkingIndicatorTokenTargets,
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
