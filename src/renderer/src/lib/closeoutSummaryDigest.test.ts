import { describe, expect, it } from 'vitest'
import type {
  ChatMessage,
  ChatRecord,
  ChatRun,
  EnsembleRoundState,
  ToolActivity
} from '../../../main/store/types'
import {
  buildRoundCloseoutSummaryDigest,
  buildRunCloseoutSummaryDigest
} from './closeoutSummaryDigest'

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Chat',
    provider: 'codex',
    scope: 'workspace',
    messages: [],
    runs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  } as ChatRecord
}

function message(
  id: string,
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp: '2026-07-07T12:00:00.000Z',
    ...extra
  }
}

function editActivity(path: string, additions: number, deletions: number): ToolActivity {
  return {
    id: `tool-${path}`,
    toolName: 'Edit',
    displayName: `Edit ${path}`,
    category: 'write',
    status: 'success',
    parameters: { file_path: path },
    diffSummary: {
      additions,
      deletions,
      files: [{ path, additions, deletions }],
      source: 'result_diff',
      confidence: 'exact'
    }
  } as ToolActivity
}

describe('closeoutSummaryDigest', () => {
  it('builds a bounded run digest with prompt, files, commits, tools, and final text', () => {
    const run: ChatRun = {
      runId: 'run-1',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:00:39.000Z',
      status: 'success',
      promptMessageId: 'p1',
      actualModel: 'gpt-5.6-sol',
      effectiveWorkspacePath: '/repo',
      warnings: [{ message: 'Sandbox denied one command.', timestamp: '2026-07-07T12:00:10.000Z' }]
    }
    const source = chat({
      workspacePath: '/repo',
      messages: [
        message('p1', 'user', 'Please fix the login bug.'),
        message('t1', 'tool', '', {
          runId: 'run-1',
          toolActivities: [
            editActivity('src/auth/login.ts', 12, 4),
            {
              id: 'commit-1',
              toolName: 'Bash',
              displayName: 'Bash',
              category: 'shell',
              status: 'success',
              parameters: {
                cwd: '/repo',
                command: 'git commit -m "Fix login redirect"'
              },
              outputPreview: '[master abc1234def] Fix login redirect\n 2 files changed'
            } as ToolActivity
          ]
        }),
        message('a1', 'assistant', 'Fixed the login redirect bug and committed the change.', {
          runId: 'run-1'
        })
      ],
      runs: [run]
    })

    const digest = buildRunCloseoutSummaryDigest({
      chat: source,
      run,
      completedAt: '2026-07-07T12:00:39.000Z'
    })

    expect(digest.targetId).toBe('run-1')
    expect(digest.scope).toBe('run')
    expect(digest.status).toBe('success')
    expect(digest.durationMs).toBe(39_000)
    expect(digest.provider).toBe('Codex')
    expect(digest.model).toBe('GPT-5.6-Sol')
    expect(digest.promptText).toBe('Please fix the login bug.')
    expect(digest.finalText).toBe('Fixed the login redirect bug and committed the change.')
    expect(digest.fileChanges).toEqual([{ path: 'src/auth/login.ts', additions: 12, deletions: 4 }])
    expect(digest.commits).toEqual([{ hash: 'abc1234def', subject: 'Fix login redirect' }])
    expect(digest.toolCounts).toEqual({ write: 1, shell: 1 })
    expect(digest.warnings).toEqual(['Sandbox denied one command.'])
  })

  it('omits empty sections and clamps oversized text', () => {
    const run: ChatRun = {
      runId: 'run-2',
      provider: 'claude',
      startedAt: '2026-07-07T12:00:00.000Z',
      status: 'cancelled',
      promptMessageId: 'p2'
    }
    const digest = buildRunCloseoutSummaryDigest({
      chat: chat({
        messages: [message('p2', 'user', `Fix ${'x'.repeat(2000)}`)],
        runs: [run]
      }),
      run,
      completedAt: '2026-07-07T12:00:30.000Z'
    })

    expect(digest.promptText!.length).toBeLessThanOrEqual(600)
    expect(digest.promptText!.endsWith('…')).toBe(true)
    expect(digest.finalText).toBeUndefined()
    expect(digest.fileChanges).toBeUndefined()
    expect(digest.commits).toBeUndefined()
    expect(digest.toolCounts).toBeUndefined()
    expect(digest.warnings).toBeUndefined()
    expect(digest.durationMs).toBe(30_000)
  })

  it('builds a round digest with participants resolved through participant runIds', () => {
    const round: EnsembleRoundState = {
      roundId: 'round-1',
      status: 'completed',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:04:00.000Z',
      participants: [
        {
          participantId: 'seat-a',
          provider: 'claude',
          role: 'Reviewer',
          order: 1,
          status: 'answered',
          runId: 'run-a'
        },
        {
          participantId: 'seat-b',
          provider: 'codex',
          role: '',
          order: 0,
          status: 'answered',
          runId: 'run-b'
        }
      ]
    } as EnsembleRoundState
    const runs: ChatRun[] = [
      {
        runId: 'run-a',
        provider: 'claude',
        startedAt: '2026-07-07T12:00:30.000Z',
        status: 'success',
        promptMessageId: 'p3',
        ensembleParticipantId: 'seat-a',
        actualModel: 'claude-fable-5'
      },
      {
        runId: 'run-b',
        provider: 'codex',
        startedAt: '2026-07-07T12:00:00.000Z',
        status: 'success',
        ensembleParticipantId: 'seat-b'
      }
    ]
    const digest = buildRoundCloseoutSummaryDigest({
      chat: chat({
        chatKind: 'ensemble',
        messages: [
          message('p3', 'user', 'Compare the two approaches.'),
          message('a-b', 'assistant', 'I prefer the queue-based approach.', { runId: 'run-b' }),
          message('a-a', 'assistant', 'Agreed, the queue keeps ordering simple.', {
            runId: 'run-a'
          })
        ],
        runs
      }),
      round,
      completedAt: round.endedAt!
    })

    expect(digest.targetId).toBe('round-1')
    expect(digest.scope).toBe('ensembleRound')
    expect(digest.promptText).toBe('Compare the two approaches.')
    expect(digest.finalText).toBe('Agreed, the queue keeps ordering simple.')
    expect(digest.participants).toHaveLength(2)
    expect(digest.participants![0]).toMatchObject({
      label: 'Codex',
      provider: 'Codex',
      status: 'answered',
      finalText: 'I prefer the queue-based approach.'
    })
    expect(digest.participants![1]).toMatchObject({
      label: 'Reviewer',
      provider: 'Claude',
      model: 'Fable 5',
      status: 'answered',
      finalText: 'Agreed, the queue keeps ordering simple.'
    })
  })

  it('resolves round runs from run.ensembleRoundId when participants carry no runId', () => {
    const round: EnsembleRoundState = {
      roundId: 'round-hist',
      status: 'completed',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:02:00.000Z',
      participants: []
    } as unknown as EnsembleRoundState
    const runs: ChatRun[] = [
      {
        runId: 'run-h1',
        provider: 'kimi',
        startedAt: '2026-07-07T12:00:00.000Z',
        status: 'success',
        ensembleRoundId: 'round-hist',
        promptMessageId: 'p4'
      }
    ]
    const digest = buildRoundCloseoutSummaryDigest({
      chat: chat({
        chatKind: 'ensemble',
        messages: [
          message('p4', 'user', 'Summarize the repo layout.'),
          message('a-h', 'assistant', 'The repo splits into main, renderer, and shared.', {
            runId: 'run-h1'
          })
        ],
        runs
      }),
      round,
      completedAt: round.endedAt!
    })

    expect(digest.promptText).toBe('Summarize the repo layout.')
    expect(digest.finalText).toBe('The repo splits into main, renderer, and shared.')
    expect(digest.participants).toBeUndefined()
  })
})
