import { describe, expect, it } from 'vitest'
import type {
  ChatMessage,
  ChatRecord,
  ChatRun,
  EnsembleRoundState
} from '../../../main/store/types'
import { TASKWRAITH_CLOSEOUT_KIND } from '../../../shared/taskWraithCloseout'
import {
  buildTaskWraithRoundCloseoutMessage,
  buildTaskWraithRunCloseoutMessage,
  upsertTaskWraithCloseoutMessage
} from './taskWraithCloseoutMessage'

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
  metadata?: ChatMessage['metadata']
): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp: '2026-07-07T12:00:00.000Z',
    ...(metadata ? { metadata } : {})
  }
}

describe('taskWraithCloseoutMessage', () => {
  it('builds a low-trust system run closeout with deterministic provenance', () => {
    const run: ChatRun = {
      runId: 'run-1',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:00:39.000Z',
      status: 'success',
      stats: { input_tokens: 1000, output_tokens: 2000 }
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [
          { ...message('a1', 'assistant', 'Implemented the feature.'), runId: 'run-1' },
          {
            ...message('t1', 'tool', ''),
            runId: 'run-1',
            toolActivities: [
              {
                id: 'tool-1',
                toolName: 'git_commit',
                displayName: 'git commit',
                category: 'write',
                status: 'success',
                outputPreview:
                  '[master 18003ca96] Add TaskWraith transcript closeouts\n 21 files changed'
              }
            ]
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: '2026-07-07T12:00:39.000Z',
      exitCode: 0
    })

    expect(closeout.role).toBe('system')
    expect(closeout.metadata?.kind).toBe(TASKWRAITH_CLOSEOUT_KIND)
    expect(closeout.metadata?.closeoutSource).toBe('deterministicFallback')
    expect(closeout.content).toContain('**Worked for 39s**')
    expect(closeout.content).toContain('Implemented the feature.')
    expect(closeout.content).not.toContain('Changed:')
    expect(closeout.content).toContain('**Commits**')
    expect(closeout.content).toContain('| Hash | Message | Changes |')
    expect(closeout.content).toContain('`18003ca96` | Add TaskWraith transcript closeouts | 21 files |')
    expect(closeout.content).not.toContain('- Commits:')
    expect(closeout.content).toContain('3k total')
  })

  it('formats escaped git commit output into a markdown table', () => {
    const run: ChatRun = {
      runId: 'run-2',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:05:00.000Z',
      status: 'cancelled'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [
          {
            ...message('t1', 'tool', ''),
            runId: 'run-2',
            toolActivities: [
              {
                id: 'tool-1',
                toolName: 'git_commit',
                displayName: 'git commit',
                category: 'write',
                status: 'success',
                outputPreview:
                  '[main d038a820e] refactor(main-m3): make approval orchestration deps explicit\\n 1 file changed, 100 insertions(+), 31 deletions(-)\\n",; [main bf52e2a62] test(services): add coverage for M3 approval routing\\n 1 file changed, 66 insertions(+), 13 deletions(-)\\n'
              }
            ]
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: '2026-07-07T12:05:00.000Z',
      exitCode: 130
    })

    expect(closeout.content).toContain(
      '`d038a820e` | refactor(main-m3): make approval orchestration deps explicit | 1 file, +100 −31 |'
    )
    expect(closeout.content).toContain(
      '`bf52e2a62` | test(services): add coverage for M3 approval routing | 1 file, +66 −13 |'
    )
    expect(closeout.content).not.toContain('\\n')
  })

  it('notes when more commits exist than the table shows', () => {
    const run: ChatRun = {
      runId: 'run-3',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:01:00.000Z',
      status: 'success'
    }
    const toolActivities = Array.from({ length: 10 }, (_, index) => ({
      id: `tool-${index}`,
      toolName: 'git_commit',
      displayName: 'git commit',
      category: 'write' as const,
      status: 'success' as const,
      outputPreview: `[main ${(index + 1).toString(16).padStart(9, '0')}a] commit ${index + 1}\n 1 file changed`
    }))
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [{ ...message('t1', 'tool', ''), runId: 'run-3', toolActivities }],
        runs: [run]
      }),
      run,
      completedAt: '2026-07-07T12:01:00.000Z',
      exitCode: 0
    })

    expect(closeout.content).toContain('_2 more commits not shown._')
    expect(closeout.content.match(/^\| `/gm)?.length).toBe(8)
  })

  it('inserts an ensemble closeout after its round body without stamping ensembleRoundId', () => {
    const round: EnsembleRoundState = {
      roundId: 'round-1',
      status: 'completed',
      prompt: 'Do it',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:01:00.000Z',
      participants: [
        { participantId: 'p1', provider: 'codex', role: 'Builder', order: 1, status: 'answered' }
      ]
    }
    const closeout = buildTaskWraithRoundCloseoutMessage({
      chat: chat({
        chatKind: 'ensemble',
        ensemble: { activeRound: round } as ChatRecord['ensemble']
      }),
      round,
      completedAt: round.endedAt!
    })
    const messages = [
      message('u1', 'user', 'Do it', { ensembleRoundId: 'round-1' }),
      message('a1', 'assistant', 'Done', { ensembleRoundId: 'round-1' }),
      message('u2', 'user', 'Next', { ensembleRoundId: 'round-2' })
    ]

    const updated = upsertTaskWraithCloseoutMessage(messages, closeout, {
      closeoutRoundId: 'round-1'
    })

    expect(updated.map((item) => item.id)).toEqual(['u1', 'a1', closeout.id, 'u2'])
    expect(closeout.metadata?.closeoutRoundId).toBe('round-1')
    expect(closeout.metadata?.ensembleRoundId).toBeUndefined()
  })

  it('attributes the participant summary to individual @-tagged members with turn counts and tokens', () => {
    const round: EnsembleRoundState = {
      roundId: 'round-2',
      status: 'completed',
      prompt: 'Do it',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:01:00.000Z',
      participants: [
        { participantId: 'p1', provider: 'codex', role: 'Builder', order: 1, status: 'answered' },
        { participantId: 'p2', provider: 'claude', role: 'Reviewer', order: 2, status: 'yielded' },
        { participantId: 'p3', provider: 'cursor', role: '', order: 3, status: 'skipped' },
        { participantId: 'p4', provider: 'kimi', role: '', order: 4, status: 'failed' }
      ]
    }
    const runs: ChatRun[] = [
      {
        runId: 'run-p1a',
        provider: 'codex',
        startedAt: '2026-07-07T12:00:00.000Z',
        ensembleRoundId: 'round-2',
        ensembleParticipantId: 'p1',
        stats: { input_tokens: 1000, output_tokens: 200 }
      },
      {
        runId: 'run-p1b',
        provider: 'codex',
        startedAt: '2026-07-07T12:00:10.000Z',
        ensembleRoundId: 'round-2',
        ensembleParticipantId: 'p1',
        stats: { input_tokens: 300, output_tokens: 50 }
      },
      {
        runId: 'run-p2',
        provider: 'claude',
        startedAt: '2026-07-07T12:00:00.000Z',
        ensembleRoundId: 'round-2',
        ensembleParticipantId: 'p2',
        stats: { input_tokens: 400, output_tokens: 100 }
      },
      {
        runId: 'run-p4',
        provider: 'kimi',
        startedAt: '2026-07-07T12:00:00.000Z',
        ensembleRoundId: 'round-2',
        ensembleParticipantId: 'p4',
        stats: { input_tokens: 200, output_tokens: 100 }
      }
    ]
    const closeout = buildTaskWraithRoundCloseoutMessage({
      chat: chat({
        chatKind: 'ensemble',
        ensemble: { activeRound: round } as ChatRecord['ensemble'],
        runs
      }),
      round,
      completedAt: round.endedAt!
    })

    expect(closeout.content).toContain('**Participants**')
    expect(closeout.content).toContain('| Participant | Turns | Tokens | Status |')
    expect(closeout.content).toContain('| [@Builder](ensemble-dm://p1) | 2 | 2k | answered |')
    expect(closeout.content).toContain('| [@Reviewer](ensemble-dm://p2) | 1 | 500 | yielded |')
    expect(closeout.content).toContain('| [@Cursor](ensemble-dm://p3) | 0 | — | skipped |')
    expect(closeout.content).toContain('| [@Kimi](ensemble-dm://p4) | 1 | 300 | failed |')
    expect(closeout.content).toContain(
      '| **Round Total** | 4 | 2k | 1 answered, 1 yielded, 1 skipped, 1 failed |'
    )
    expect(closeout.content).not.toContain('- Tokens:')
  })
})
