import { describe, expect, it } from 'vitest'
import type {
  ChatMessage,
  ChatRecord,
  ChatRun,
  EnsembleRoundState,
  ToolActivity
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

function activity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: overrides.id || 'tool-1',
    toolName: overrides.toolName || 'run_shell_command',
    displayName: overrides.displayName || 'Shell',
    category: overrides.category || 'shell',
    status: overrides.status || 'success',
    ...overrides
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
    expect(closeout.content).toContain(
      'Close-out:\n\nThe run was completed.\n\nImplemented the feature.'
    )
    expect(closeout.content).toContain('The run used about 3k tokens in total.')
    expect(closeout.content).not.toMatch(/^\s*-\s/m)
    expect(closeout.content).not.toContain('Changed:')
    expect(closeout.content).toContain('**Commits**')
    expect(closeout.content).toContain('| Hash | Message | Changes |')
    expect(closeout.content).toContain(
      '`18003ca96` | Add TaskWraith transcript closeouts | 21 files |'
    )
    expect(closeout.content).not.toContain('- Commits:')
  })

  it('keeps a long assistant summary intact and flattens Markdown into prose', () => {
    const run: ChatRun = {
      runId: 'run-long-summary',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      status: 'success'
    }
    const expectedSummary =
      'Birmingham sits a little cooler and slightly less settled than Cambridge or Paris this week — still a fine summer spell overall, with one day to plan around. Here’s the full seven-day outlook, including the warmer and cooler turns that matter for planning, without dropping the ending of this deliberately long summary.'
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [
          {
            ...message(
              'a-long',
              'assistant',
              `## Summary\n\nBirmingham sits a little cooler and slightly less settled than Cambridge or Paris this week — still a **fine** summer spell overall, with one day to plan around. Here’s the [full seven-day outlook](https://example.com/weather), including the warmer and cooler turns that matter for planning, without dropping the ending of this deliberately long summary.`
            ),
            runId: run.runId
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: '2026-07-07T12:00:30.000Z',
      exitCode: 0
    })

    expect(expectedSummary.length).toBeGreaterThan(180)
    expect(closeout.content).toContain(expectedSummary)
    expect(closeout.content).not.toContain('https://example.com/weather')
    expect(closeout.content).not.toContain('...')
  })

  it('prefers explicit summary sections wherever they appear in the final response', () => {
    const run: ChatRun = {
      runId: 'run-explicit-summary',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      status: 'success'
    }
    const cases = [
      {
        content:
          'I have finished the implementation.\n\n## Summary\n\nThe focused close-out behavior is now complete.\n\n## Validation\n\nnpm test passed.',
        expected: 'The focused close-out behavior is now complete.',
        ignored: 'I have finished the implementation.'
      },
      {
        content:
          '## Validation\n\nnpm test passed.\n\n## Summary\n\nThe summary remains available after the checks.',
        expected: 'The summary remains available after the checks.',
        ignored: 'npm test passed.'
      },
      {
        content:
          '## Summary: The inline summary is preserved.\n\n## Validation\n\nnpm test passed.',
        expected: 'The inline summary is preserved.',
        ignored: 'npm test passed.'
      },
      {
        content:
          'Opening boilerplate.\n\n**Summary:** The emphasized summary is preferred.\n\n**Typechecking**\n\nnpm run typecheck passed.',
        expected: 'The emphasized summary is preferred.',
        ignored: 'npm run typecheck passed.'
      }
    ]

    for (const [index, item] of cases.entries()) {
      const closeout = buildTaskWraithRunCloseoutMessage({
        chat: chat({
          messages: [
            {
              ...message(`explicit-summary-${index}`, 'assistant', item.content),
              runId: run.runId
            }
          ],
          runs: [run]
        }),
        run,
        completedAt: '2026-07-07T12:00:30.000Z',
        exitCode: 0
      })

      expect(closeout.content).toContain(item.expected)
      expect(closeout.content).not.toContain(item.ignored)
    }
  })

  it('neutralises bare links copied into system-authored summary prose', () => {
    const run: ChatRun = {
      runId: 'run-bare-link',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      status: 'success'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [
          {
            ...message(
              'a-bare-link',
              'assistant',
              '## Summary\n\nImplemented the change. Details: https://example.com/untrusted More: www.example.com. Contact: user@example.com.'
            ),
            runId: run.runId
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: '2026-07-07T12:00:30.000Z',
      exitCode: 0
    })

    expect(closeout.content).toContain('Implemented the change. Details: a linked resource')
    expect(closeout.content).toContain('More: a linked page')
    expect(closeout.content).toContain('Contact: an email address')
    expect(closeout.content).not.toContain('https://')
    expect(closeout.content).not.toContain('www.example.com')
    expect(closeout.content).not.toContain('user@example.com')
  })

  it('reports only validations backed by successful structured tool receipts', () => {
    const run: ChatRun = {
      runId: 'run-validation',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      status: 'success'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [
          {
            ...message('a-validation', 'assistant', 'Implemented the requested change.'),
            runId: run.runId
          },
          {
            ...message('t-validation', 'tool', ''),
            runId: run.runId,
            toolActivities: [
              activity({
                id: 'tests',
                toolName: 'mcp__taskwraith__run_task',
                displayName: 'Ran task',
                category: 'task',
                parameters: { task: 'test' },
                rawResultEvent: {
                  result: {
                    task: 'test',
                    exitCode: 0,
                    timedOut: false,
                    summary: { status: 'passed' }
                  }
                }
              }),
              activity({
                id: 'typecheck-build',
                parameters: { command: 'npm run typecheck && npm run build' },
                rawResultEvent: { result: { exitCode: 0, timedOut: false } }
              }),
              activity({
                id: 'diagnostics',
                toolName: 'get_diagnostics',
                displayName: 'Checked diagnostics',
                parameters: { source: 'typescript', path: 'src' },
                rawResultEvent: {
                  result: {
                    ok: true,
                    status: 'clean',
                    hasProblems: false,
                    runs: [{ source: 'typescript', ok: true, skipped: false }]
                  }
                }
              })
            ]
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: '2026-07-07T12:01:00.000Z',
      exitCode: 0
    })

    expect(closeout.content).toContain(
      'Validation passed for the tests, typechecking, the build, and diagnostics.'
    )
  })

  it('does not treat assistant claims or unproven successful activities as validation', () => {
    const run: ChatRun = {
      runId: 'run-unproven-validation',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      status: 'success'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [
          {
            ...message('a-unproven', 'assistant', 'Tests passed and typechecking is clean.'),
            runId: run.runId
          },
          {
            ...message('t-unproven', 'tool', ''),
            runId: run.runId,
            toolActivities: [
              activity({
                id: 'shell-without-receipt',
                parameters: { command: 'npm test' }
              }),
              activity({
                id: 'masked-shell-result',
                parameters: { command: 'npm test; true' },
                rawResultEvent: { result: { exitCode: 0, timedOut: false } }
              }),
              activity({
                id: 'summary-only',
                toolName: 'test_result_summary',
                displayName: 'Test result summary',
                category: 'task',
                outputPreview: '9237 tests passed'
              }),
              activity({
                id: 'untrusted-mcp-task',
                toolName: 'mcp__untrusted__run_task',
                parameters: { task: 'test' },
                rawResultEvent: { result: { exitCode: 0, timedOut: false } }
              }),
              activity({
                id: 'informational-run-task',
                toolName: 'run_task',
                parameters: { task: 'test', args: ['--showConfig'] },
                rawResultEvent: { result: { exitCode: 0, timedOut: false } }
              }),
              ...[
                'vitest --version',
                'pytest --help',
                'eslint --help',
                'tsc --noEmit --help',
                'jest --showConfig',
                'tsc --showConfig --noEmit'
              ].map((command, index) =>
                activity({
                  id: `informational-${index}`,
                  parameters: { command },
                  rawResultEvent: { result: { exitCode: 0, timedOut: false } }
                })
              ),
              activity({
                id: 'diagnostic-problems',
                toolName: 'get_diagnostics',
                displayName: 'Checked diagnostics',
                rawResultEvent: {
                  result: {
                    ok: true,
                    status: 'problems',
                    hasProblems: true,
                    runs: [{ source: 'typescript', ok: true, skipped: false }]
                  }
                }
              })
            ]
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: '2026-07-07T12:01:00.000Z',
      exitCode: 0
    })

    expect(closeout.content).not.toContain('Validation passed')
  })

  it('uses the latest terminal receipt when the same validation command is retried', () => {
    const run: ChatRun = {
      runId: 'run-validation-retry',
      provider: 'claude',
      startedAt: '2026-07-07T12:00:00.000Z',
      status: 'success'
    }
    const shellAttempt = (id: string, status: ToolActivity['status'], exitCode: number) =>
      activity({
        id,
        toolName: 'Bash',
        displayName: 'Bash',
        status,
        parameters: { command: 'npm test' },
        rawResultEvent: { result: { exitCode, timedOut: false } }
      })
    const buildCloseout = (toolActivities: ToolActivity[]) =>
      buildTaskWraithRunCloseoutMessage({
        chat: chat({
          messages: [
            { ...message('a-retry', 'assistant', 'Implemented the fix.'), runId: run.runId },
            { ...message('t-retry', 'tool', ''), runId: run.runId, toolActivities }
          ],
          runs: [run]
        }),
        run,
        completedAt: '2026-07-07T12:01:00.000Z',
        exitCode: 0
      })

    expect(
      buildCloseout([
        shellAttempt('failed-first', 'error', 1),
        shellAttempt('passed-second', 'success', 0)
      ]).content
    ).toContain('Validation passed for the tests.')
    expect(
      buildCloseout([
        shellAttempt('passed-first', 'success', 0),
        shellAttempt('failed-second', 'error', 1)
      ]).content
    ).not.toContain('Validation passed')
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

  it('renders the full structured ensemble summary as prose with round tokens and validation', () => {
    const round: EnsembleRoundState = {
      roundId: 'round-full-summary',
      status: 'completed',
      prompt: 'Compare the forecasts',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:01:00.000Z',
      participants: [
        {
          participantId: 'p1',
          provider: 'codex',
          role: 'Synthesizer',
          order: 1,
          status: 'answered'
        }
      ]
    }
    const run: ChatRun = {
      runId: 'round-summary-run',
      provider: 'codex',
      startedAt: round.startedAt,
      status: 'success',
      ensembleRoundId: round.roundId,
      ensembleParticipantId: 'p1',
      stats: { input_tokens: 700, output_tokens: 300 }
    }
    const summary = `Round summary:
Birmingham sits a little cooler and slightly less settled than Cambridge or Paris this week — still a fine summer spell overall, with one day to plan around.
Here’s the outlook across the full week without losing the final sentence.

Decisions:
- Keep the outdoor plans flexible.

Corrections:
- Cambridge is marginally warmer, not dramatically warmer.

Open risks:
- Friday showers remain possible.

Next action:
- Check the Friday forecast on Thursday.`
    const closeout = buildTaskWraithRoundCloseoutMessage({
      chat: chat({
        chatKind: 'ensemble',
        ensemble: {
          activeRound: round,
          roundSummaries: {
            [round.roundId]: {
              roundId: round.roundId,
              participantId: 'p1',
              provider: 'codex',
              summary,
              capturedAt: round.endedAt!
            }
          }
        } as ChatRecord['ensemble'],
        runs: [run],
        messages: [
          {
            ...message('round-validation', 'tool', ''),
            runId: run.runId,
            toolActivities: [
              activity({
                id: 'round-tests',
                toolName: 'run_task',
                displayName: 'Ran task',
                category: 'task',
                parameters: { task: 'test' },
                rawResultEvent: {
                  result: { task: 'test', exitCode: 0, timedOut: false }
                }
              })
            ]
          }
        ]
      }),
      round,
      completedAt: round.endedAt!
    })

    expect(closeout.content).toContain('The round was completed.')
    expect(closeout.content).toContain(
      'Birmingham sits a little cooler and slightly less settled than Cambridge or Paris this week — still a fine summer spell overall, with one day to plan around. Here’s the outlook across the full week without losing the final sentence.'
    )
    expect(closeout.content).toContain('Decisions: Keep the outdoor plans flexible.')
    expect(closeout.content).toContain(
      'Corrections: Cambridge is marginally warmer, not dramatically warmer.'
    )
    expect(closeout.content).toContain('Open risks: Friday showers remain possible.')
    expect(closeout.content).toContain('Next action: Check the Friday forecast on Thursday.')
    expect(closeout.content).toContain('The round used about 1k tokens in total.')
    expect(closeout.content).toContain('Validation passed for the tests.')
    expect(closeout.content).not.toContain('- Summary:')
    expect(closeout.content).not.toContain('Participants:')
  })

  it('falls back to the final participant prose when no canonical round summary exists', () => {
    const round: EnsembleRoundState = {
      roundId: 'round-final-contribution',
      status: 'completed',
      prompt: 'Investigate the repository',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:01:00.000Z',
      participants: [
        { participantId: 'p1', provider: 'cursor', role: 'Explorer', order: 1, status: 'answered' }
      ]
    }
    const run: ChatRun = {
      runId: 'round-final-run',
      provider: 'cursor',
      startedAt: round.startedAt,
      status: 'success',
      ensembleRoundId: round.roundId,
      ensembleParticipantId: 'p1'
    }
    const closeout = buildTaskWraithRoundCloseoutMessage({
      chat: chat({
        chatKind: 'ensemble',
        ensemble: { activeRound: round } as ChatRecord['ensemble'],
        runs: [run],
        messages: [
          {
            ...message(
              'final-contribution',
              'assistant',
              'Explored the workspace, matched the existing test patterns, and added the focused coverage.'
            ),
            runId: run.runId,
            metadata: { ensembleRoundId: round.roundId, ensembleParticipantId: 'p1' }
          }
        ]
      }),
      round,
      completedAt: round.endedAt!
    })

    expect(closeout.content).toContain(
      'Explored the workspace, matched the existing test patterns, and added the focused coverage.'
    )
    expect(closeout.content).not.toContain('without a canonical summary')
  })

  it('uses an honest prose fallback when a stopped round produced no response', () => {
    const round: EnsembleRoundState = {
      roundId: 'round-stopped-empty',
      status: 'cancelled',
      prompt: 'Stop this round',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:01:00.000Z',
      participants: [
        { participantId: 'p1', provider: 'codex', role: 'Builder', order: 1, status: 'cancelled' },
        { participantId: 'p2', provider: 'claude', role: 'Reviewer', order: 2, status: 'cancelled' }
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

    expect(closeout.content).toContain('The round was stopped.')
    expect(closeout.content).toContain(
      'No participant completed a response before the round was stopped.'
    )
    expect(closeout.content).not.toContain('Participants:')
    expect(closeout.content).not.toMatch(/^\s*-\s/m)
  })

  it('renders participant details with individual @-tagged members, turns, and tokens', () => {
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
        stats: {
          input_tokens: 200,
          output_tokens: 100,
          _taskwraith_token_count_confidence: 'estimated'
        }
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
    expect(closeout.content).toContain('| Seat | Turns & Tokens |')
    // Five columns collapse into one seat link: the element renders from the
    // href, and the link TEXT is what plain-text surfaces still read.
    expect(closeout.content).toContain(
      '| [@Builder · Codex · GPT-5.6-Sol · Ultra · Full WS Access]' +
        '(ensemble-seat://p1?p=codex&m=gpt-5.6-sol&role=Builder&n=1&r=ultracode&k=workspace_write)' +
        ' | 2k Tks / 2 Turns |'
    )
    expect(closeout.content).toContain(
      '| [@Reviewer · Claude · Fable 5 · Max · Ask]' +
        '(ensemble-seat://p2?p=claude&m=claude-fable-5&role=Reviewer&n=2&r=max&k=read_only)' +
        ' | 500 Tks / 1 Turn |'
    )
    // No turns: no work cell at all, and the seat falls back to the
    // round-entry snapshot rather than inventing a change.
    expect(closeout.content).toContain(
      '| [@Cursor · Cursor · Composer 2.5 Fast · Accept Edits]' +
        '(ensemble-seat://p3?p=cursor&m=composer-2.5-fast&role=Cursor&n=3&k=default)' +
        ' | — |'
    )
    // Kimi's "Thinking" comes from the thinking flag, not a reasoning effort —
    // the seat must carry it or the element renders a blank where the text
    // beside it says Thinking.
    expect(closeout.content).toContain(
      '| [@Kimi · Kimi · K2.7 Coding · Thinking · Plan]' +
        '(ensemble-seat://p4?p=kimi&m=kimi-k2.7-code&role=Kimi&n=4&t=1&k=plan)' +
        ' | ~300 Tks / 1 Turn |'
    )
    expect(closeout.content).toContain('| **Round Total** | ~2k Tks / 4 Turns |')
    expect(closeout.content).toContain('The round used about 2k tokens in total.')
    expect(closeout.content).not.toContain('Participants:')
    expect(closeout.content).not.toContain('- Tokens:')
  })

  it('uses compact status icons without repeating participant counts in prose', () => {
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

    // The status column is gone (owner call 2026-08-05: it earned no width in
    // a two-column table) — and with it the emoji vocabulary it carried.
    expect(closeout.content).toContain('[@Answered · Codex')
    expect(closeout.content).not.toContain('✅')
    expect(closeout.content).not.toContain('💤')
    expect(closeout.content).not.toContain('❌')
    expect(closeout.content).not.toContain('Status')
    expect(closeout.content).toContain('The round was completed.')
    expect(closeout.content).not.toContain('Participants:')
    expect(closeout.content).not.toMatch(/^\s*-\s/m)
    expect(closeout.content).toContain('| **Round Total** | — |')
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

    expect(closeout.content).not.toContain('Participants:')
    // The link text keeps the full per-turn journey; the href carries only its
    // ENDS, which is what the element rolls between. Both are derived from one
    // compaction, so a mid-round value (Full WS Access) can never appear as an
    // end state.
    expect(closeout.content).toContain(
      '| [@Lead · Claude → Codex · Fable 5 → GPT-5.6-Sol · Ultracode → High' +
        ' · Accept Edits → Full WS Access → Ask]' +
        '(ensemble-seat://seat?p=codex&m=gpt-5.6-sol&role=Lead&n=1&r=high&k=read_only' +
        '&bp=claude&bm=claude-fable-5&brole=Lead&bn=1&br=ultracode&bk=default)' +
        ' | 3 Turns |'
    )
    expect(closeout.content).toContain('| **Round Total** | 3 Turns |')
  })

  it('prefers an AI summary over the final assistant text and records provenance', () => {
    const run: ChatRun = {
      runId: 'run-ai',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:00:07.000Z',
      status: 'success'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [
          { ...message('a1', 'assistant', 'Hello! How can I help you today?'), runId: run.runId }
        ],
        runs: [run]
      }),
      run,
      completedAt: '2026-07-07T12:00:07.000Z',
      exitCode: 0,
      aiSummary: {
        text: 'The run greeted the user and confirmed the workspace was ready, without making any changes.',
        model: 'Apple Foundation Models'
      }
    })

    expect(closeout.content).toContain(
      'The run greeted the user and confirmed the workspace was ready, without making any changes.'
    )
    expect(closeout.content).not.toContain('Hello! How can I help you today?')
    expect(closeout.metadata?.closeoutSource).toBe('summaryProvider')
    expect(closeout.metadata?.closeoutModel).toBe('Apple Foundation Models')
    expect(closeout.metadata?.closeoutAiSummary).toBe(
      'The run greeted the user and confirmed the workspace was ready, without making any changes.'
    )
  })

  it('neutralises markdown, links, and code fences in AI summary prose', () => {
    const run: ChatRun = {
      runId: 'run-ai-md',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      status: 'success'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({ runs: [run] }),
      run,
      completedAt: '2026-07-07T12:00:30.000Z',
      exitCode: 0,
      aiSummary: {
        text: 'The run **edited** `foo.ts` per [the docs](https://example.com/docs).\n\n```js\nconsole.log(1)\n```'
      }
    })

    expect(closeout.content).toContain('The run edited foo.ts per the docs.')
    expect(closeout.content).not.toContain('https://example.com/docs')
    expect(closeout.content).not.toContain('console.log')
    expect(closeout.metadata?.closeoutSource).toBe('summaryProvider')
    expect(closeout.metadata?.closeoutModel).toBeUndefined()
  })

  it('strips heading, bullet, and quote markers from multi-line AI summaries', () => {
    const run: ChatRun = {
      runId: 'run-ai-structure',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      status: 'success'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({ runs: [run] }),
      run,
      completedAt: '2026-07-07T12:00:30.000Z',
      exitCode: 0,
      aiSummary: {
        text: '# Summary\n\n- Fixed the login bug\n- Added regression tests\n\n> Everything passed'
      }
    })

    expect(closeout.content).toContain(
      'Summary Fixed the login bug Added regression tests Everything passed.'
    )
    expect(closeout.content).not.toContain('\\#')
    expect(closeout.content).not.toContain('- Fixed')
    expect(closeout.content).not.toContain('>')
  })

  it('ignores hex tokens inside commit subjects and diff hunk headers', () => {
    const run: ChatRun = {
      runId: 'run-phantom-hash',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:00:39.000Z',
      status: 'success'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [
          {
            ...message('t1', 'tool', ''),
            runId: run.runId,
            toolActivities: [
              activity({
                toolName: 'git_commit',
                outputPreview:
                  '[master 1a2b3c4d5] Revert 9f8e7d6c1: fix regression\n 2 files changed\nindex 89e6c9812..fa3d11234 100644'
              })
            ]
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: '2026-07-07T12:00:39.000Z',
      exitCode: 0
    })

    expect(closeout.content).toContain('`1a2b3c4d5`')
    expect(closeout.content).not.toContain('`9f8e7d6c1`')
    expect(closeout.content).not.toContain('`89e6c9812`')
    expect(closeout.content).not.toContain('`fa3d11234`')
  })

  it('still extracts bare hashes printed on their own line', () => {
    const run: ChatRun = {
      runId: 'run-bare-hash',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:00:39.000Z',
      status: 'success'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [
          {
            ...message('t1', 'tool', ''),
            runId: run.runId,
            toolActivities: [
              activity({ toolName: 'git_commit', outputPreview: 'abc1234def567\n' })
            ]
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: '2026-07-07T12:00:39.000Z',
      exitCode: 0
    })

    expect(closeout.content).toContain('`abc1234de`')
  })

  it('falls back to deterministic provenance when the AI summary is blank', () => {
    const run: ChatRun = {
      runId: 'run-ai-blank',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      status: 'success'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [{ ...message('a1', 'assistant', 'Implemented the feature.'), runId: run.runId }],
        runs: [run]
      }),
      run,
      completedAt: '2026-07-07T12:00:30.000Z',
      exitCode: 0,
      aiSummary: { text: '   ', model: 'Apple Foundation Models' }
    })

    expect(closeout.content).toContain('Implemented the feature.')
    expect(closeout.metadata?.closeoutSource).toBe('deterministicFallback')
    expect(closeout.metadata?.closeoutAiSummary).toBeUndefined()
    expect(closeout.metadata?.closeoutModel).toBeUndefined()
  })

  it('rebuilds byte-identical content when the same AI summary is re-supplied', () => {
    const run: ChatRun = {
      runId: 'run-ai-idem',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:00:07.000Z',
      status: 'success'
    }
    const input = {
      chat: chat({ runs: [run] }),
      run,
      completedAt: '2026-07-07T12:00:07.000Z',
      exitCode: 0,
      aiSummary: { text: 'The run tidied the workspace.', model: 'Apple Foundation Models' }
    }
    const first = buildTaskWraithRunCloseoutMessage(input)
    const second = buildTaskWraithRunCloseoutMessage(input)

    expect(second.content).toBe(first.content)
    expect(second.timestamp).toBe(first.timestamp)
    expect(second.metadata?.closeoutAiSummary).toBe(first.metadata?.closeoutAiSummary)
  })

  it('prefers an AI round summary over the canonical synthesizer block', () => {
    const round: EnsembleRoundState = {
      roundId: 'round-ai',
      prompt: 'Compare approaches',
      status: 'completed',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:03:00.000Z',
      participants: []
    }
    const closeout = buildTaskWraithRoundCloseoutMessage({
      chat: chat({
        chatKind: 'ensemble',
        ensemble: {
          participants: [],
          roundSummaries: {
            'round-ai': {
              roundId: 'round-ai',
              participantId: 'seat',
              provider: 'codex',
              role: 'Lead',
              runId: 'seat-run-1',
              summary:
                'Round summary: Structured block.\nDecisions: keep.\nCorrections: none.\nOpen risks: none.\nNext action: ship.',
              capturedAt: '2026-07-07T12:03:00.000Z'
            }
          }
        } as unknown as ChatRecord['ensemble'],
        runs: []
      }),
      round,
      completedAt: round.endedAt!,
      aiSummary: {
        text: 'Two participants compared approaches and converged on the simpler fix.',
        model: 'Apple Foundation Models'
      }
    })

    expect(closeout.content).toContain(
      'Two participants compared approaches and converged on the simpler fix.'
    )
    expect(closeout.content).not.toContain('Structured block.')
    expect(closeout.metadata?.closeoutSource).toBe('summaryProvider')
    expect(closeout.metadata?.closeoutScope).toBe('ensembleRound')
    expect(closeout.metadata?.closeoutAiSummary).toBe(
      'Two participants compared approaches and converged on the simpler fix.'
    )
  })
})
