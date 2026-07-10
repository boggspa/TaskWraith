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
        {
          participantId: 'p1',
          provider: 'codex',
          role: 'Builder',
          order: 1,
          status: 'answered',
          model: 'gpt-5.5',
          reasoningEffort: 'ultracode',
          permissionPresetId: 'read_only'
        },
        {
          participantId: 'p2',
          provider: 'claude',
          role: 'Reviewer',
          order: 2,
          status: 'yielded',
          model: 'claude-fable-5',
          reasoningEffort: 'max',
          permissionPresetId: 'read_only'
        },
        {
          participantId: 'p3',
          provider: 'cursor',
          role: '',
          order: 3,
          status: 'skipped',
          initialSeatSnapshot: {
            schemaVersion: 1,
            provider: 'cursor',
            model: 'composer-2.5-fast',
            configuredPermissionPresetId: 'default'
          }
        },
        {
          participantId: 'p4',
          provider: 'kimi',
          role: '',
          order: 4,
          status: 'failed',
          initialSeatSnapshot: {
            schemaVersion: 1,
            provider: 'kimi',
            model: 'kimi-k2.7-code',
            thinkingEnabled: true,
            configuredPermissionPresetId: 'plan'
          }
        }
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
        actualModel: 'gpt-5.6-sol',
        permissionPosture: {
          schemaVersion: 1,
          presetId: 'workspace_write',
          externalPathGrantCount: 0,
          postureHash: 'posture-p1b',
          signaturePresent: true
        },
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
        ensemble: {
          activeRound: round,
          participants: [
            {
              id: 'p1',
              provider: 'codex',
              enabled: true,
              role: 'Builder',
              instructions: '',
              order: 1,
              model: 'gpt-5.4',
              reasoningEffort: 'medium',
              permissionPresetId: 'default'
            },
            {
              id: 'p2',
              provider: 'claude',
              enabled: true,
              role: 'Reviewer',
              instructions: '',
              order: 2,
              model: 'claude-opus-4-8',
              reasoningEffort: 'high',
              permissionPresetId: 'default'
            },
            {
              id: 'p3',
              provider: 'cursor',
              enabled: true,
              role: '',
              instructions: '',
              order: 3,
              model: 'composer-2.5-fast',
              permissionPresetId: 'default'
            },
            {
              id: 'p4',
              provider: 'kimi',
              enabled: true,
              role: '',
              instructions: '',
              order: 4,
              model: 'kimi-k2.7-code',
              thinkingEnabled: true,
              permissionPresetId: 'plan'
            }
          ]
        } as ChatRecord['ensemble'],
        runs
      }),
      round,
      completedAt: round.endedAt!
    })

    expect(closeout.content).toContain('**Participants**')
    expect(closeout.content).toContain(
      '| Participant | Provider | Model | Reasoning | Permissions | Turns | Tokens | Status |'
    )
    expect(closeout.content).toContain(
      '| [@Builder](ensemble-dm://p1) | Codex | GPT-5.6-Sol | Ultra | Workspace Write | 2 | 2k | ✅ |'
    )
    expect(closeout.content).toContain(
      '| [@Reviewer](ensemble-dm://p2) | Claude | Fable 5 | Max | Read-Only/Recon | 1 | 500 | ✅ |'
    )
    expect(closeout.content).toContain(
      '| [@Cursor](ensemble-dm://p3) | Cursor | Composer 2.5 Fast | — | Default Approval | 0 | — | 💤 |'
    )
    expect(closeout.content).toContain(
      '| [@Kimi](ensemble-dm://p4) | Kimi | K2.7 Code | Thinking | Plan | 1 | 300 | ❌ |'
    )
    expect(closeout.content).toContain('| **Round Total** | — | — | — | — | 4 | 2k | **4** |')
    expect(closeout.content).not.toContain('- Tokens:')
  })

  it('uses compact status icons while retaining the textual round summary', () => {
    const round: EnsembleRoundState = {
      roundId: 'round-status-icons',
      status: 'completed',
      prompt: 'Exercise every status family',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:01:00.000Z',
      participants: [
        { participantId: 'ok', provider: 'codex', role: 'Answered', order: 1, status: 'answered' },
        {
          participantId: 'warn',
          provider: 'claude',
          role: 'Cancelled',
          order: 2,
          status: 'cancelled'
        },
        {
          participantId: 'bad',
          provider: 'grok',
          role: 'Unreachable',
          order: 3,
          status: 'unreachable'
        },
        { participantId: 'idle', provider: 'kimi', role: 'Sleeping', order: 4, status: 'sleeping' }
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

    expect(closeout.content).toContain('[@Answered](ensemble-dm://ok) | Codex |')
    expect(closeout.content).toMatch(/\[@Answered\].*\| ✅ \|/)
    expect(closeout.content).toMatch(/\[@Cancelled\].*\| ⚠️ \|/)
    expect(closeout.content).toMatch(/\[@Unreachable\].*\| ❌ \|/)
    expect(closeout.content).toMatch(/\[@Sleeping\].*\| 💤 \|/)
    expect(closeout.content).toContain(
      '- Participants: 1 contributed; 1 cancelled; 1 unreachable; 1 sleeping.'
    )
    expect(closeout.content).toContain('| **Round Total** | — | — | — | — | 0 | — | **4** |')
  })

  it('reports per-turn seat changes and keeps contributors removed from the live round', () => {
    const round: EnsembleRoundState = {
      roundId: 'round-seat-history',
      status: 'completed',
      prompt: 'Exercise seat changes',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:03:00.000Z',
      participants: []
    }
    const runs: ChatRun[] = [
      {
        runId: 'seat-run-1',
        provider: 'claude',
        startedAt: '2026-07-07T12:00:00.000Z',
        status: 'success',
        requestedModel: 'claude-fable-5',
        ensembleRoundId: round.roundId,
        ensembleParticipantId: 'seat',
        ensembleRole: 'Lead',
        ensembleOrder: 1,
        ensembleSeatSnapshot: {
          schemaVersion: 1,
          provider: 'claude',
          model: 'claude-fable-5',
          reasoningEffort: 'ultracode',
          configuredPermissionPresetId: 'default'
        },
        permissionPosture: {
          schemaVersion: 1,
          presetId: 'default',
          externalPathGrantCount: 0,
          postureHash: 'seat-posture-1',
          signaturePresent: true
        }
      },
      {
        runId: 'seat-run-2',
        provider: 'codex',
        startedAt: '2026-07-07T12:01:00.000Z',
        status: 'success',
        actualModel: 'gpt-5.6-sol',
        ensembleRoundId: round.roundId,
        ensembleParticipantId: 'seat',
        ensembleRole: 'Lead',
        ensembleOrder: 1,
        ensembleSeatSnapshot: {
          schemaVersion: 1,
          provider: 'codex',
          model: 'gpt-5.6-sol',
          reasoningEffort: 'high',
          configuredPermissionPresetId: 'workspace_write'
        },
        permissionPosture: {
          schemaVersion: 1,
          presetId: 'workspace_write',
          externalPathGrantCount: 0,
          postureHash: 'seat-posture-2',
          signaturePresent: true
        }
      },
      {
        runId: 'seat-run-3',
        provider: 'codex',
        startedAt: '2026-07-07T12:02:00.000Z',
        status: 'success',
        actualModel: 'gpt-5.6-sol',
        ensembleRoundId: round.roundId,
        ensembleParticipantId: 'seat',
        ensembleRole: 'Lead',
        ensembleOrder: 1,
        ensembleSeatSnapshot: {
          schemaVersion: 1,
          provider: 'codex',
          model: 'gpt-5.6-sol',
          reasoningEffort: 'high',
          configuredPermissionPresetId: 'read_only'
        },
        permissionPosture: {
          schemaVersion: 1,
          presetId: 'read_only',
          externalPathGrantCount: 0,
          postureHash: 'seat-posture-3',
          signaturePresent: true
        }
      }
    ]
    const closeout = buildTaskWraithRoundCloseoutMessage({
      chat: chat({ chatKind: 'ensemble', runs }),
      round,
      completedAt: round.endedAt!
    })

    expect(closeout.content).toContain('- Participants: 1 contributed.')
    expect(closeout.content).toContain(
      '| [@Lead](ensemble-dm://seat) | Claude → Codex | Fable 5 → GPT-5.6-Sol | Ultracode → High | Default Approval → Workspace Write → Read-Only/Recon | 3 | — | ✅ |'
    )
    expect(closeout.content).toContain('| **Round Total** | — | — | — | — | 3 | — | **1** |')
  })
})
