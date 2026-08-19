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
  collectCloseoutSubagentDelegations,
  isSameTaskWraithCloseout,
  upsertTaskWraithCloseoutMessage
} from './taskWraithCloseoutMessage'

function chat(overrides: Partial<ChatRecord> & { lastRun?: ChatRun } = {}): ChatRecord & {
  lastRun?: ChatRun
} {
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
  } as ChatRecord & { lastRun?: ChatRun }
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
    expect(closeout.content).toContain('Receipt recorded 1 commit.')
    expect(closeout.content).not.toMatch(/^\s*-\s/m)
    expect(closeout.content).not.toContain('Changed:')
    expect(closeout.content).not.toContain('**Commits**')
    expect(closeout.metadata?.closeoutCommits).toEqual([
      {
        hash: '18003ca96',
        subject: 'Add TaskWraith transcript closeouts',
        stats: '21 files'
      }
    ])
    expect(closeout.metadata?.closeoutReceipt).toMatchObject({
      version: 1,
      targetId: 'run-1',
      scope: 'run',
      status: 'success',
      durationMs: 39_000,
      totalTokens: 3000,
      observedCommitCount: 1,
      observedChangedFileCount: 0
    })
    expect(closeout.content).not.toContain('- Commits:')
  })

  it('tombstones slim fileChanges in metadata and keeps them out of bubble prose', () => {
    const run: ChatRun = {
      runId: 'run-file-changes',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:00:30.000Z',
      status: 'success'
    }
    const fileChanges = [
      {
        path: 'src/main/store/types.ts',
        status: 'modified' as const,
        additions: 12,
        deletions: 2,
        owners: [{ provider: 'codex' as const, participantId: 'p1', role: 'Builder' }]
      },
      {
        path: 'src/renderer/src/lib/taskWraithCloseoutMessage.ts',
        status: 'created' as const,
        additions: 40
      }
    ]
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [
          { ...message('a1', 'assistant', 'Persisted closeout file changes.'), runId: run.runId }
        ],
        runs: [run]
      }),
      run,
      completedAt: '2026-07-07T12:00:30.000Z',
      exitCode: 0,
      fileChanges
    })

    expect(closeout.metadata?.closeoutFileChanges).toEqual(fileChanges)
    expect(closeout.content).not.toContain('src/main/store/types.ts')
    expect(closeout.content).not.toContain('taskWraithCloseoutMessage.ts')
    expect(closeout.content).not.toContain('File Changes')
    expect(closeout.content).not.toContain('Changed:')
    expect(JSON.stringify(closeout.metadata?.closeoutFileChanges)).not.toContain('diffText')

    const round: EnsembleRoundState = {
      roundId: 'round-file-changes',
      status: 'completed',
      prompt: 'Persist file changes',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:01:00.000Z',
      participants: [
        { participantId: 'p1', provider: 'codex', role: 'Builder', order: 1, status: 'answered' }
      ]
    }
    const roundCloseout = buildTaskWraithRoundCloseoutMessage({
      chat: chat({
        chatKind: 'ensemble',
        ensemble: { activeRound: round } as ChatRecord['ensemble']
      }),
      round,
      completedAt: round.endedAt!,
      fileChanges
    })

    expect(roundCloseout.metadata?.closeoutFileChanges).toEqual(fileChanges)
    expect(roundCloseout.content).not.toContain('src/main/store/types.ts')
    expect(roundCloseout.content).not.toContain('File Changes')
  })

  it('harvests slim fileChanges from run-scoped tool activities when input is omitted', () => {
    const run: ChatRun = {
      runId: 'run-harvest-files',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:00:30.000Z',
      status: 'success'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [
          {
            ...message('a1', 'assistant', 'Edited a couple of files.'),
            runId: run.runId,
            toolActivities: [
              activity({
                id: 'edit-1',
                toolName: 'edit_file',
                displayName: 'Edit file',
                category: 'write',
                status: 'success',
                parameters: {
                  file_path: 'src/main/store/types.ts',
                  old_string: 'a\nb',
                  new_string: 'a\nb\nc\nd'
                }
              }),
              activity({
                id: 'write-1',
                toolName: 'write_file',
                displayName: 'Write file',
                category: 'write',
                status: 'success',
                parameters: {
                  file_path: 'src/renderer/src/lib/taskWraithCloseoutMessage.ts',
                  content: 'line1\nline2\nline3'
                }
              })
            ]
          },
          {
            // Other-run noise — must not bleed into this closeout.
            ...message('a2', 'assistant', 'Unrelated edit.'),
            runId: 'run-other',
            toolActivities: [
              activity({
                id: 'edit-other',
                toolName: 'edit_file',
                category: 'write',
                parameters: {
                  file_path: 'src/unrelated.ts',
                  old_string: 'x',
                  new_string: 'y'
                }
              })
            ]
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: '2026-07-07T12:00:30.000Z',
      exitCode: 0
    })

    expect(closeout.metadata?.closeoutFileChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src/main/store/types.ts',
          status: 'modified'
        }),
        expect.objectContaining({
          path: 'src/renderer/src/lib/taskWraithCloseoutMessage.ts',
          status: 'created'
        })
      ])
    )
    expect(closeout.metadata?.closeoutFileChanges).toHaveLength(2)
    expect(JSON.stringify(closeout.metadata?.closeoutFileChanges)).not.toContain('diffText')
    expect(closeout.content).not.toContain('src/main/store/types.ts')
    expect(closeout.content).not.toContain('taskWraithCloseoutMessage.ts')
    expect(closeout.content).not.toContain('File Changes')
  })

  it('harvests slim fileChanges from round-scoped tool activities when input is omitted', () => {
    const round: EnsembleRoundState = {
      roundId: 'round-harvest-files',
      status: 'completed',
      prompt: 'Harvest round file changes',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:01:00.000Z',
      participants: [
        { participantId: 'p1', provider: 'codex', role: 'Builder', order: 1, status: 'answered' }
      ]
    }
    const closeout = buildTaskWraithRoundCloseoutMessage({
      chat: chat({
        chatKind: 'ensemble',
        ensemble: { activeRound: round } as ChatRecord['ensemble'],
        messages: [
          {
            ...message('a1', 'assistant', 'Round edits.', {
              ensembleRoundId: round.roundId,
              ensembleParticipantId: 'p1',
              ensembleProvider: 'codex',
              ensembleRole: 'Builder'
            }),
            toolActivities: [
              activity({
                id: 'edit-round',
                toolName: 'edit_file',
                category: 'write',
                status: 'success',
                parameters: {
                  file_path: 'src/shared/taskWraithCloseout.ts',
                  old_string: 'export const A = 1',
                  new_string: 'export const A = 2'
                },
                metadata: {
                  ensembleProvider: 'codex',
                  ensembleParticipantId: 'p1'
                }
              })
            ]
          },
          {
            ...message('a2', 'assistant', 'Other round.', {
              ensembleRoundId: 'round-other'
            }),
            toolActivities: [
              activity({
                id: 'edit-other-round',
                toolName: 'write_file',
                category: 'write',
                parameters: { file_path: 'src/other-round.ts', content: 'x' }
              })
            ]
          }
        ]
      }),
      round,
      completedAt: round.endedAt!
    })

    expect(closeout.metadata?.closeoutFileChanges).toEqual([
      expect.objectContaining({
        path: 'src/shared/taskWraithCloseout.ts',
        status: 'modified'
      })
    ])
    expect(closeout.content).not.toContain('src/shared/taskWraithCloseout.ts')
    expect(closeout.content).not.toContain('src/other-round.ts')
    expect(closeout.content).not.toContain('File Changes')
  })

  it('prefers explicit fileChanges input over harvested tool-activity rows', () => {
    const run: ChatRun = {
      runId: 'run-override-files',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:00:30.000Z',
      status: 'success'
    }
    const fileChanges = [
      {
        path: 'caller/override.ts',
        status: 'modified' as const,
        additions: 1,
        deletions: 0
      }
    ]
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [
          {
            ...message('a1', 'assistant', 'Tool evidence present.'),
            runId: run.runId,
            toolActivities: [
              activity({
                id: 'edit-1',
                toolName: 'edit_file',
                category: 'write',
                parameters: {
                  file_path: 'harvested/should-not-appear.ts',
                  old_string: 'a',
                  new_string: 'b'
                }
              })
            ]
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: '2026-07-07T12:00:30.000Z',
      exitCode: 0,
      fileChanges
    })

    expect(closeout.metadata?.closeoutFileChanges).toEqual(fileChanges)
    expect(JSON.stringify(closeout.metadata?.closeoutFileChanges)).not.toContain(
      'harvested/should-not-appear.ts'
    )
  })

  it('keeps a long assistant summary intact and flattens Markdown into prose', () => {
    const run: ChatRun = {
      runId: 'run-long-summary',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      status: 'success'
    }
    const expectedSummary =
      'Birmingham sits a little cooler and slightly less settled than Cambridge or Paris this week — still a fine summer spell overall, with a rainy spell to plan around. Here’s the full weekly outlook, including the warmer and cooler turns that matter for planning, without dropping the ending of this deliberately long summary.'
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [
          {
            ...message(
              'a-long',
              'assistant',
              `## Summary\n\nBirmingham sits a little cooler and slightly less settled than Cambridge or Paris this week — still a **fine** summer spell overall, with a rainy spell to plan around. Here’s the [full weekly outlook](https://example.com/weather), including the warmer and cooler turns that matter for planning, without dropping the ending of this deliberately long summary.`
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
    expect(closeout.metadata?.closeoutReceipt?.validations).toEqual({
      passed: ['tests', 'typecheck', 'build', 'diagnostics'],
      failed: []
    })
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
    ).toContain('Validation failures were recorded for the tests.')
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

    expect(closeout.content).not.toContain('**Commits**')
    expect(closeout.metadata?.closeoutCommits?.map((commit) => commit.hash)).toEqual([
      'd038a820e',
      'bf52e2a62'
    ])
    expect(closeout.content).not.toContain('\\n')
  })

  it.each([
    'Shell',
    'Bash',
    'run_terminal_command',
    'run_shell_command',
    'exec_command',
    'mcp__TaskWraith__run_shell_command'
  ])('harvests a real git receipt from the %s terminal alias', (toolName) => {
    const run: ChatRun = {
      runId: `run-shell-commit-${toolName}`,
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:00:39.000Z',
      status: 'success',
      effectiveWorkspacePath: '/repo'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        workspacePath: '/repo',
        messages: [
          {
            ...message('terminal-commit', 'tool', ''),
            runId: run.runId,
            toolActivities: [
              activity({
                toolName,
                displayName: 'Shell command',
                category: 'shell',
                parameters: {
                  cwd: '/repo',
                  command: 'git add src/closeout.ts && git commit -m "fix: keep commits visible"'
                },
                resultSummary:
                  'Exit code: 0\n\nstdout:\n[main a16d0b9e2] fix: keep commits visible\n 2 files changed, 24 insertions(+), 3 deletions(-)'
              })
            ]
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: run.endedAt!,
      exitCode: 0
    })

    expect(closeout.metadata?.closeoutCommits).toEqual([
      {
        hash: 'a16d0b9e2',
        subject: 'fix: keep commits visible',
        stats: '2 files, +24 −3'
      }
    ])
  })

  it('harvests commits from a stripped dedicated git_commit activity via commitEvidence', () => {
    const run: ChatRun = {
      runId: 'run-stripped-dedicated',
      provider: 'claude',
      startedAt: '2026-08-18T22:00:00.000Z',
      endedAt: '2026-08-18T22:03:00.000Z',
      status: 'success'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        workspacePath: '/repo',
        messages: [
          {
            ...message('stripped-dedicated', 'tool', ''),
            runId: run.runId,
            toolActivities: [
              activity({
                toolName: 'mcp__TaskWraith__git_commit',
                displayName: 'git_commit',
                category: 'write',
                detailRef: {
                  schemaVersion: 1,
                  storage: 'run_event_artifact',
                  runId: run.runId,
                  activityId: 'tool-1',
                  offset: 0,
                  byteLength: 512,
                  sha256: 'a'.repeat(64)
                },
                commitEvidence: {
                  receiptText:
                    '[main a048ce5] feat: ChipTown interiors (lab + mart)\n 2 files changed, 212 insertions(+), 157 deletions(-)'
                }
              })
            ]
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: run.endedAt!,
      exitCode: 0
    })

    expect(closeout.metadata?.closeoutCommits).toEqual([
      {
        hash: 'a048ce5',
        subject: 'feat: ChipTown interiors (lab + mart)',
        stats: '2 files, +212 −157'
      }
    ])
  })

  it('harvests a stripped shell commit through commitEvidence command and cwd', () => {
    const run: ChatRun = {
      runId: 'run-stripped-shell',
      provider: 'codex',
      startedAt: '2026-08-18T22:00:00.000Z',
      endedAt: '2026-08-18T22:03:00.000Z',
      status: 'success',
      effectiveWorkspacePath: '/repo'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        workspacePath: '/repo',
        messages: [
          {
            ...message('stripped-shell', 'tool', ''),
            runId: run.runId,
            toolActivities: [
              activity({
                toolName: 'run_shell_command',
                detailRef: {
                  schemaVersion: 1,
                  storage: 'run_event_artifact',
                  runId: run.runId,
                  activityId: 'tool-1',
                  offset: 0,
                  byteLength: 512,
                  sha256: 'b'.repeat(64)
                },
                commitEvidence: {
                  command: 'git commit -m "fix: keep commits visible" -- src/closeout.ts',
                  cwd: '/repo',
                  receiptText:
                    'Exit code: 0\n\nstdout:\n[main a16d0b9e2] fix: keep commits visible\n 2 files changed, 24 insertions(+), 3 deletions(-)'
                }
              })
            ]
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: run.endedAt!,
      exitCode: 0
    })

    expect(closeout.metadata?.closeoutCommits).toEqual([
      {
        hash: 'a16d0b9e2',
        subject: 'fix: keep commits visible',
        stats: '2 files, +24 −3'
      }
    ])
  })

  it('accepts a commit targeted at the run effective worktree', () => {
    const run: ChatRun = {
      runId: 'run-shell-worktree-commit',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:00:39.000Z',
      status: 'success',
      effectiveWorkspacePath: '/repo-worktree'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        workspacePath: '/repo',
        messages: [
          {
            ...message('worktree-commit', 'tool', ''),
            runId: run.runId,
            toolActivities: [
              activity({
                toolName: 'run_terminal_command',
                parameters: {
                  cwd: '/repo',
                  command: 'git -C /repo-worktree commit -m "fix: isolate the closeout"'
                },
                outputPreview:
                  '[codex/closeout 51de7a11b] fix: isolate the closeout\n 1 file changed, 8 insertions(+)'
              })
            ]
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: run.endedAt!,
      exitCode: 0
    })

    expect(closeout.metadata?.closeoutCommits?.map((commit) => commit.hash)).toEqual(['51de7a11b'])
  })

  it('does not attribute a base-checkout commit to an isolated worktree run', () => {
    const run: ChatRun = {
      runId: 'run-shell-worktree-base-commit',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:00:39.000Z',
      status: 'success',
      effectiveWorkspacePath: '/repo-worktree'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        workspacePath: '/repo',
        messages: [
          {
            ...message('base-checkout-commit', 'tool', ''),
            runId: run.runId,
            toolActivities: [
              activity({
                toolName: 'run_shell_command',
                parameters: {
                  cwd: '/repo-worktree',
                  command: 'git -C /repo commit -m "fix: belongs to the base checkout"'
                },
                resultSummary: '[master 52ba5e111] fix: belongs to the base checkout'
              })
            ]
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: run.endedAt!,
      exitCode: 0
    })

    expect(closeout.metadata?.closeoutCommits).toBeUndefined()
  })

  it.each([
    'cd /repo && git commit -m "fix: commit after changing directory"',
    'env CI=1 git commit -m "fix: commit through env"',
    'bash -lc \'git commit -m "fix: commit through a shell wrapper"\''
  ])('recognizes the common shell commit layout: %s', (command) => {
    const run: ChatRun = {
      runId: 'run-shell-layout',
      provider: 'claude',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:00:39.000Z',
      status: 'success',
      effectiveWorkspacePath: '/repo'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        workspacePath: '/repo',
        messages: [
          {
            ...message('shell-layout', 'tool', ''),
            runId: run.runId,
            toolActivities: [
              activity({
                toolName: 'Bash',
                parameters: { cwd: '/repo', command },
                resultSummary: '[main 61c0ffee1] fix: recognize shell layout'
              })
            ]
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: run.endedAt!,
      exitCode: 0
    })

    expect(closeout.metadata?.closeoutCommits?.map((commit) => commit.hash)).toEqual(['61c0ffee1'])
  })

  it('rejects shell mentions, dry runs, stale hashes, and commits in another repository', () => {
    const run: ChatRun = {
      runId: 'run-shell-commit-false-positives',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:00:39.000Z',
      status: 'success',
      effectiveWorkspacePath: '/repo'
    }
    const toolActivities = [
      activity({
        id: 'search-mention',
        toolName: 'Shell',
        parameters: { cwd: '/repo', command: 'rg -n "git commit" docs' },
        resultSummary: '[main 1111111aa] example receipt in a fixture'
      }),
      activity({
        id: 'status-advice',
        toolName: 'Bash',
        parameters: { cwd: '/repo', command: 'git status' },
        resultSummary: 'use "git commit" to record changes\n2222222bb'
      }),
      activity({
        id: 'dry-run',
        toolName: 'run_terminal_command',
        parameters: { cwd: '/repo', command: 'git commit --dry-run -m "inspect only"' },
        resultSummary: '[main 3333333cc] fabricated dry-run receipt'
      }),
      activity({
        id: 'failed-old-head',
        toolName: 'run_shell_command',
        parameters: {
          cwd: '/repo',
          command: 'git commit -m "blocked"; git rev-parse HEAD'
        },
        resultSummary: 'fatal: commit blocked by hook\n4444444dd'
      }),
      activity({
        id: 'failed-fake-receipt',
        toolName: 'run_shell_command',
        status: 'error',
        parameters: {
          cwd: '/repo',
          command: 'git commit -m "blocked"; printf "[main 4545454ee] fake receipt\\n"'
        },
        resultSummary: 'fatal: commit blocked by hook\n[main 4545454ee] fake receipt'
      }),
      activity({
        id: 'other-repository',
        toolName: 'exec_command',
        parameters: {
          cwd: '/repo',
          command: 'git -C /tmp/fixture-repo commit -m "fixture commit"'
        },
        resultSummary: '[main 5555555ee] fixture commit\n 1 file changed'
      }),
      activity({
        id: 'mixed-dynamic-repository',
        toolName: 'Bash',
        parameters: {
          cwd: '/repo',
          command: 'git commit -m "workspace" && git -C "$fixture" commit -m "fixture"'
        },
        resultSummary: '[main 6666666ff] workspace commit\n 1 file changed'
      })
    ]
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        workspacePath: '/repo',
        messages: [
          {
            ...message('false-positive-tools', 'tool', ''),
            runId: run.runId,
            toolActivities
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: run.endedAt!,
      exitCode: 0
    })

    expect(closeout.metadata?.closeoutCommits).toBeUndefined()
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

    expect(closeout.content).not.toContain('**Commits**')
    expect(closeout.metadata?.closeoutCommits).toHaveLength(10)
  })

  it('harvests --stat per-file lines from commit receipts and attaches them as files', () => {
    const run: ChatRun = {
      runId: 'run-stat-files',
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
                  '[main a1b2c3d4e] refactor: split closeout message library\n src/renderer/src/lib/taskWraithCloseoutMessage.ts      | 240 ++++++++++++++++++\n src/renderer/src/lib/taskWraithCloseoutMessage.test.ts | 200 +++++++++++++++\n 2 files changed, 440 insertions(+)'
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

    expect(closeout.metadata?.closeoutCommits).toHaveLength(1)
    const commit = closeout.metadata!.closeoutCommits![0]
    expect(commit.hash).toBe('a1b2c3d4e')
    expect(commit.subject).toBe('refactor: split closeout message library')
    expect(commit.stats).toBe('2 files, +440')
    expect(commit.files).toHaveLength(2)
    expect(commit.files![0]).toEqual({
      path: 'src/renderer/src/lib/taskWraithCloseoutMessage.ts',
      additions: 18
    })
    expect(commit.files![1]).toEqual({
      path: 'src/renderer/src/lib/taskWraithCloseoutMessage.test.ts',
      additions: 15
    })
    // Must not leak files into prose.
    expect(closeout.content).not.toContain('taskWraithCloseoutMessage.ts')
  })

  it('associates --stat file lines with the nearest preceding commit when multiple commits appear', () => {
    const run: ChatRun = {
      runId: 'run-multi-stat',
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
                  '[main abc111111] feat: add parser\n src/parser.ts      | 50 ++++++++++\n 1 file changed, 50 insertions(+)\n[main def222222] feat: add UI\n src/ui.tsx         | 30 +++\n src/styles.css     | 10 +-\n 2 files changed, 40 insertions(+), 10 deletions(-)'
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

    expect(closeout.metadata?.closeoutCommits).toHaveLength(2)
    const commits = closeout.metadata!.closeoutCommits!
    const parserCommit = commits.find((c) => c.hash === 'abc111111')
    const uiCommit = commits.find((c) => c.hash === 'def222222')
    expect(parserCommit?.files).toHaveLength(1)
    expect(parserCommit?.files![0].path).toBe('src/parser.ts')
    expect(uiCommit?.files).toHaveLength(2)
    expect(uiCommit?.files![0].path).toBe('src/ui.tsx')
    expect(uiCommit?.files![1].path).toBe('src/styles.css')
    expect(uiCommit?.files![1].deletions).toBe(1)
  })

  it('keeps --stat file lines out of the commit stats summary field', () => {
    const run: ChatRun = {
      runId: 'run-stat-vs-summary',
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
                  '[main fff999888] chore: update deps\n package.json | 4 ++--\n yarn.lock   | 8 ++++----\n 2 files changed, 12 insertions(+), 6 deletions(-)'
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

    const commit = closeout.metadata?.closeoutCommits?.[0]
    // stats should come from the summary line, not the per-file lines.
    expect(commit?.stats).toBe('2 files, +12 −6')
    expect(commit?.files).toHaveLength(2)
    // File lines must not appear as part of stats.
    expect(commit?.stats).not.toContain('package.json')
    expect(commit?.stats).not.toContain('yarn.lock')
  })

  it('omits files when commit receipt has no --stat lines', () => {
    const run: ChatRun = {
      runId: 'run-no-stat',
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
                  '[main 111aaaa22] fix: typo\n 1 file changed, 1 insertion(+), 1 deletion(-)'
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

    const commit = closeout.metadata?.closeoutCommits?.[0]
    expect(commit?.hash).toBe('111aaaa22')
    expect(commit?.stats).toBe('1 file, +1 −1')
    // files omitted when no --stat lines present:
    expect(commit?.files).toBeUndefined()
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
Birmingham sits a little cooler and slightly less settled than Cambridge or Paris this week — still a fine summer spell overall, with a rainy spell to plan around.
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
      'Birmingham sits a little cooler and slightly less settled than Cambridge or Paris this week — still a fine summer spell overall, with a rainy spell to plan around. Here’s the outlook across the full week without losing the final sentence.'
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

    expect(closeout.content).not.toContain('**Participants**')
    expect(closeout.content).not.toContain('| Seat | Turns & Tokens |')
    expect(closeout.content).toContain('The round used about 2k tokens in total.')
    expect(closeout.content).not.toContain('Participants:')
    expect(closeout.content).not.toContain('- Tokens:')
    const table = closeout.metadata?.closeoutParticipantTable
    expect(table?.rows).toHaveLength(4)
    expect(table?.totalWorkLabel).toBe('~2k Tks / 4 Turns')
    expect(table?.rows?.[0]?.seatLink?.participantId).toBe('p1')
    expect(table?.rows?.[0]?.seatText).toContain(
      '@Builder · Codex · GPT-5.6-Sol · Ultra · Full WS Access'
    )
    expect(table?.rows?.[1]?.seatText).toContain('@Reviewer · Claude · Fable 5 · Max · Ask')
    expect(table?.rows?.[2]?.seatText).toContain(
      '@Cursor · Cursor · Composer 2.5 Fast · Accept Edits'
    )
    expect(table?.rows?.[3]?.seatText).toContain('@Kimi · Kimi · K2.7 Coding · Thinking · Plan')
    expect(table?.rows?.[0]?.workLabel).toBe('2k Tks / 2 Turns')
    expect(table?.rows?.[2]?.workLabel).toBe('—')
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

    // Structured rows keep seat text + status for the Task-complete stack;
    // the close-out bubble itself stays prose-only (no emoji status column).
    const table = closeout.metadata?.closeoutParticipantTable
    expect(table?.rows?.some((row) => row.seatText.includes('@Answered · Codex'))).toBe(true)
    expect(closeout.content).not.toContain('✅')
    expect(closeout.content).not.toContain('💤')
    expect(closeout.content).not.toContain('❌')
    expect(closeout.content).not.toContain('| Status |')
    expect(closeout.content).toContain('The round was completed.')
    expect(closeout.content).not.toContain('Participants:')
    expect(closeout.content).not.toMatch(/^\s*-\s/m)
    expect(table?.totalWorkLabel).toBe('—')
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
    // seatText keeps the full per-turn journey; seatLink carries only its ENDS
    // for the animated element. Mid-round Full WS Access must not be an end state.
    const table = closeout.metadata?.closeoutParticipantTable
    expect(table?.rows?.[0]?.seatText).toContain(
      '@Lead · Claude → Codex · Fable 5 → GPT-5.6-Sol · Ultracode → High · Accept Edits → Full WS Access → Ask'
    )
    expect(table?.rows?.[0]?.seatLink?.after).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      permissionPresetId: 'read_only'
    })
    expect(table?.rows?.[0]?.seatLink?.before).toMatchObject({
      provider: 'claude',
      model: 'claude-fable-5',
      permissionPresetId: 'default'
    })
    expect(table?.totalWorkLabel).toBe('3 Turns')
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

  it('rejects numeral-bearing provider prose and renders only receipt-backed counts', () => {
    const run: ChatRun = {
      runId: 'run-ai-counts',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:00:30.000Z',
      status: 'success'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        workspacePath: '/repo',
        messages: [
          {
            ...message('a-counts', 'assistant', 'Changed 91 files and made 315 commits.'),
            runId: run.runId
          },
          {
            ...message('t-counts', 'tool', ''),
            runId: run.runId,
            toolActivities: [
              activity({
                toolName: 'git_commit',
                outputPreview: '[master abc1234de] Fix the closeout\n 1 file changed'
              })
            ]
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: run.endedAt!,
      exitCode: 0,
      fileChanges: [{ path: 'src/closeout.ts', status: 'modified' }],
      aiSummary: {
        text: 'The run made 315 commits across ninety files.',
        model: 'Apple Foundation Models'
      }
    })

    expect(closeout.content).toContain('The run completed without a final written summary.')
    expect(closeout.content).toContain('Receipt recorded 1 commit and 1 changed file.')
    expect(closeout.content).not.toContain('315')
    expect(closeout.content).not.toContain('91')
    expect(closeout.content).not.toContain('ninety')
    expect(closeout.metadata?.closeoutSource).toBe('deterministicFallback')
    expect(closeout.metadata?.closeoutAiSummary).toBeUndefined()
    expect(closeout.metadata?.closeoutReceipt).toMatchObject({
      observedCommitCount: 1,
      observedChangedFileCount: 1
    })
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

    const hashes = closeout.metadata?.closeoutCommits?.map((commit) => commit.hash) || []
    expect(hashes).toContain('1a2b3c4d5')
    expect(hashes).not.toContain('9f8e7d6c1')
    expect(hashes).not.toContain('89e6c9812')
    expect(hashes).not.toContain('fa3d11234')
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
            toolActivities: [activity({ toolName: 'git_commit', outputPreview: 'abc1234def567\n' })]
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: '2026-07-07T12:00:39.000Z',
      exitCode: 0
    })

    expect(closeout.metadata?.closeoutCommits?.map((commit) => commit.hash)).toEqual([
      'abc1234def567'
    ])
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
        text: 'The participants compared approaches and converged on the simpler fix.',
        model: 'Apple Foundation Models'
      }
    })

    expect(closeout.content).toContain(
      'The participants compared approaches and converged on the simpler fix.'
    )
    expect(closeout.content).not.toContain('Structured block.')
    expect(closeout.metadata?.closeoutSource).toBe('summaryProvider')
    expect(closeout.metadata?.closeoutScope).toBe('ensembleRound')
    expect(closeout.metadata?.closeoutAiSummary).toBe(
      'The participants compared approaches and converged on the simpler fix.'
    )
  })

  it('tombstones scoped sub-thread delegations onto run closeout metadata (not prose)', () => {
    const run: ChatRun = {
      runId: 'run-delegate-1',
      provider: 'claude',
      startedAt: '2026-08-08T12:00:00.000Z',
      endedAt: '2026-08-08T12:01:00.000Z',
      status: 'success'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        provider: 'claude',
        messages: [
          {
            ...message('u1', 'user', 'Spin workers.'),
            runId: run.runId,
            timestamp: '2026-08-08T12:00:01.000Z'
          },
          {
            ...message('del-a', 'system', '↪ Delegated to Codex sub-thread (Worker A).', {
              kind: 'subThreadDelegation',
              subThreadId: 'child-a',
              subThreadProvider: 'codex',
              subThreadTitle: 'Worker A',
              parentProvider: 'claude',
              delegationPromptPreview: 'Review the diff.',
              returnResultToParent: true,
              joinPolicy: { groupId: run.runId }
            }),
            timestamp: '2026-08-08T12:00:10.000Z'
          },
          {
            ...message(
              'ret-a',
              'tool',
              '↩ Result from Codex sub-thread (Worker A):\n\nLooks clean.',
              {
                kind: 'subThreadReturn',
                subThreadId: 'child-a',
                subThreadProvider: 'codex',
                subThreadTitle: 'Worker A',
                subThreadOutcome: 'done',
                parallelResultWaveId: run.runId
              }
            ),
            timestamp: '2026-08-08T12:00:40.000Z'
          },
          {
            ...message('del-noise', 'system', '↪ Other run delegation.', {
              kind: 'subThreadDelegation',
              subThreadId: 'child-other',
              subThreadProvider: 'grok',
              subThreadTitle: 'Other',
              joinPolicy: { groupId: 'run-other' }
            }),
            timestamp: '2026-08-08T12:00:20.000Z'
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: run.endedAt!
    })

    expect(closeout.metadata?.closeoutSubagentDelegations).toEqual([
      expect.objectContaining({
        subThreadId: 'child-a',
        provider: 'codex',
        title: 'Worker A',
        status: 'returned',
        parentProvider: 'claude'
      })
    ])
    expect(closeout.metadata?.closeoutSubagentDelegations).toHaveLength(1)
    expect(closeout.content).not.toContain('Worker A')
    expect(closeout.content).not.toContain('Sub-threads')
    expect(closeout.content).not.toContain('child-a')
  })

  it('omits closeoutSubagentDelegations when the run has no sub-thread cards', () => {
    const run: ChatRun = {
      runId: 'run-empty-delegations',
      provider: 'codex',
      startedAt: '2026-08-08T12:00:00.000Z',
      endedAt: '2026-08-08T12:00:10.000Z',
      status: 'success'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [{ ...message('a1', 'assistant', 'Done.'), runId: run.runId }],
        runs: [run]
      }),
      run,
      completedAt: run.endedAt!
    })
    expect(closeout.metadata?.closeoutSubagentDelegations).toBeUndefined()
  })

  it('dedupes delegation + return for the same subThreadId into one row', () => {
    const run: ChatRun = {
      runId: 'run-dedupe',
      provider: 'claude',
      startedAt: '2026-08-08T12:00:00.000Z',
      endedAt: '2026-08-08T12:01:00.000Z',
      status: 'success'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [
          {
            ...message('del', 'system', '↪ Delegated.', {
              kind: 'subThreadDelegation',
              subThreadId: 'same-child',
              subThreadProvider: 'codex',
              subThreadTitle: 'Same child',
              joinPolicy: { groupId: run.runId }
            }),
            timestamp: '2026-08-08T12:00:05.000Z'
          },
          {
            ...message('ret', 'tool', '↩ Result', {
              kind: 'subThreadReturn',
              subThreadId: 'same-child',
              subThreadProvider: 'codex',
              subThreadTitle: 'Same child',
              subThreadOutcome: 'failed',
              parallelResultWaveId: run.runId
            }),
            timestamp: '2026-08-08T12:00:50.000Z'
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: run.endedAt!
    })
    expect(closeout.metadata?.closeoutSubagentDelegations).toHaveLength(1)
    expect(closeout.metadata?.closeoutSubagentDelegations?.[0]).toMatchObject({
      subThreadId: 'same-child',
      status: 'failed'
    })
  })

  it('scopes round closeout sub-thread rows to round run join groups', () => {
    const round: EnsembleRoundState = {
      roundId: 'round-delegations',
      status: 'completed',
      prompt: 'Delegate inside this round',
      startedAt: '2026-08-08T12:00:00.000Z',
      endedAt: '2026-08-08T12:02:00.000Z',
      participants: [
        {
          participantId: 'p1',
          provider: 'claude',
          role: 'Worker',
          status: 'answered',
          order: 1,
          runId: 'round-run-1'
        }
      ]
    }
    const closeout = buildTaskWraithRoundCloseoutMessage({
      chat: chat({
        chatKind: 'ensemble',
        ensemble: {
          participants: [
            {
              id: 'p1',
              provider: 'claude',
              model: 'claude-sonnet-4-7',
              role: 'Worker',
              order: 1,
              enabled: true
            }
          ]
        } as unknown as ChatRecord['ensemble'],
        messages: [
          {
            ...message('del-in', 'system', '↪ In round.', {
              kind: 'subThreadDelegation',
              subThreadId: 'round-child',
              subThreadProvider: 'codex',
              subThreadTitle: 'Round child',
              joinPolicy: { groupId: 'round-run-1' }
            }),
            timestamp: '2026-08-08T12:00:30.000Z'
          },
          {
            ...message('del-out', 'system', '↪ Other round.', {
              kind: 'subThreadDelegation',
              subThreadId: 'other-child',
              subThreadProvider: 'grok',
              subThreadTitle: 'Other child',
              joinPolicy: { groupId: 'other-run' }
            }),
            timestamp: '2026-08-08T12:00:40.000Z'
          }
        ],
        runs: [
          {
            runId: 'round-run-1',
            provider: 'claude',
            startedAt: round.startedAt,
            endedAt: round.endedAt,
            status: 'success',
            ensembleRoundId: round.roundId,
            ensembleParticipantId: 'p1'
          }
        ]
      }),
      round,
      completedAt: round.endedAt!
    })
    expect(closeout.metadata?.closeoutSubagentDelegations).toEqual([
      expect.objectContaining({ subThreadId: 'round-child', title: 'Round child' })
    ])
    expect(
      closeout.metadata?.closeoutSubagentDelegations?.some(
        (row) => row.subThreadId === 'other-child'
      )
    ).toBe(false)
  })

  it('excludes side-chat returns from the subagent closeout table', () => {
    const run: ChatRun = {
      runId: 'run-sidechat',
      provider: 'claude',
      startedAt: '2026-08-08T12:00:00.000Z',
      endedAt: '2026-08-08T12:01:00.000Z',
      status: 'success'
    }
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [
          {
            ...message('side', 'tool', '↩ Result from side chat', {
              kind: 'subThreadReturn',
              linkedChildRelation: 'sideChat',
              subThreadId: 'side-1',
              subThreadProvider: 'codex',
              subThreadTitle: 'Side',
              parallelResultWaveId: run.runId
            }),
            timestamp: '2026-08-08T12:00:30.000Z'
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: run.endedAt!
    })
    expect(closeout.metadata?.closeoutSubagentDelegations).toBeUndefined()
  })

  it('includes delegate_wave cards whose groupId is a wave-* id (not the parent run id)', () => {
    const run: ChatRun = {
      runId: 'run-wave-parent',
      provider: 'claude',
      startedAt: '2026-08-08T12:00:00.000Z',
      endedAt: '2026-08-08T12:02:00.000Z',
      status: 'success'
    }
    const waveId = 'wave-parent-chat-99'
    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [
          {
            ...message('del-wave', 'system', '↪ Wave worker.', {
              kind: 'subThreadDelegation',
              subThreadId: 'wave-child',
              subThreadProvider: 'codex',
              subThreadTitle: 'Wave child',
              waveId,
              joinPolicy: { groupId: waveId }
            }),
            timestamp: '2026-08-08T12:00:30.000Z'
          },
          {
            ...message('ret-wave', 'tool', '↩ Result', {
              kind: 'subThreadReturn',
              subThreadId: 'wave-child',
              subThreadProvider: 'codex',
              subThreadTitle: 'Wave child',
              subThreadOutcome: 'done',
              parallelResultWaveId: waveId
            }),
            timestamp: '2026-08-08T12:01:10.000Z'
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: run.endedAt!
    })
    expect(closeout.metadata?.closeoutSubagentDelegations).toEqual([
      expect.objectContaining({
        subThreadId: 'wave-child',
        status: 'returned',
        title: 'Wave child'
      })
    ])
  })

  it('preserves closeoutSubagentDelegations on upsert when a rebuild harvests none', () => {
    const existing = message('taskwraith-closeout-run-run-1', 'system', 'Worked for 1s.', {
      kind: TASKWRAITH_CLOSEOUT_KIND,
      closeoutScope: 'run',
      closeoutSubagentDelegations: [
        {
          subThreadId: 'kept',
          identitySeed: 'kept',
          title: 'Kept',
          provider: 'codex',
          status: 'returned'
        }
      ]
    })
    const next = message('taskwraith-closeout-run-run-1', 'system', 'Worked for 1s.', {
      kind: TASKWRAITH_CLOSEOUT_KIND,
      closeoutScope: 'run'
    })
    const updated = upsertTaskWraithCloseoutMessage([existing], next, { sourceRunId: 'run-1' })
    expect(updated[0].metadata?.closeoutSubagentDelegations).toEqual([
      expect.objectContaining({ subThreadId: 'kept' })
    ])
  })

  it('late return flips created→returned and isSameTaskWraithCloseout detects the change', () => {
    const run: ChatRun = {
      runId: 'run-late-return',
      provider: 'claude',
      startedAt: '2026-08-08T12:00:00.000Z',
      endedAt: '2026-08-08T12:01:00.000Z',
      status: 'success'
    }
    const delegation = {
      ...message('del', 'system', '↪ Delegated.', {
        kind: 'subThreadDelegation',
        subThreadId: 'child-late',
        subThreadProvider: 'codex',
        subThreadTitle: 'Late child',
        joinPolicy: { groupId: run.runId }
      }),
      timestamp: '2026-08-08T12:00:10.000Z'
    }
    const early = buildTaskWraithRunCloseoutMessage({
      chat: chat({ messages: [delegation], runs: [run] }),
      run,
      completedAt: run.endedAt!
    })
    expect(early.metadata?.closeoutSubagentDelegations?.[0]?.status).toBe('created')

    const late = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [
          delegation,
          {
            ...message('ret', 'tool', '↩ Result', {
              kind: 'subThreadReturn',
              subThreadId: 'child-late',
              subThreadProvider: 'codex',
              subThreadTitle: 'Late child',
              subThreadOutcome: 'done',
              parallelResultWaveId: run.runId
            }),
            timestamp: '2026-08-08T12:02:00.000Z'
          }
        ],
        runs: [run]
      }),
      run,
      completedAt: run.endedAt!
    })
    expect(late.metadata?.closeoutSubagentDelegations?.[0]?.status).toBe('returned')
    expect(isSameTaskWraithCloseout(early, late)).toBe(false)
  })

  it('passes childChats through run closeout to promote created→running without a return', () => {
    const run: ChatRun = {
      runId: 'run-child-status',
      provider: 'claude',
      startedAt: '2026-08-08T12:00:00.000Z',
      endedAt: '2026-08-08T12:01:00.000Z',
      status: 'success'
    }
    const messages = [
      {
        ...message('del', 'system', '↪ Delegated.', {
          kind: 'subThreadDelegation',
          subThreadId: 'child-live',
          subThreadProvider: 'codex',
          subThreadTitle: 'Live child',
          joinPolicy: { groupId: run.runId }
        }),
        timestamp: '2026-08-08T12:00:10.000Z'
      }
    ]
    const childChats: ChatRecord[] = [
      chat({
        appChatId: 'child-live',
        parentChatId: 'chat-1',
        provider: 'codex',
        runs: [
          {
            runId: 'child-run-1',
            provider: 'codex',
            startedAt: '2026-08-08T12:00:15.000Z',
            status: 'running'
          }
        ]
      })
    ]
    const without = buildTaskWraithRunCloseoutMessage({
      chat: chat({ messages, runs: [run] }),
      run,
      completedAt: run.endedAt!
    })
    expect(without.metadata?.closeoutSubagentDelegations?.[0]?.status).toBe('created')

    const withChild = buildTaskWraithRunCloseoutMessage({
      chat: chat({ messages, runs: [run] }),
      run,
      completedAt: run.endedAt!,
      childChats
    })
    expect(withChild.metadata?.closeoutSubagentDelegations?.[0]?.status).toBe('running')
  })

  it('maps success_with_warnings child runs to completed', () => {
    const rows = collectCloseoutSubagentDelegations({
      messages: [
        {
          ...message('del', 'system', '↪ Delegated.', {
            kind: 'subThreadDelegation',
            subThreadId: 'child-warn',
            subThreadProvider: 'codex',
            subThreadTitle: 'Warn child',
            joinPolicy: { groupId: 'run-warn' }
          }),
          timestamp: '2026-08-08T12:00:10.000Z'
        }
      ],
      parentRunIds: new Set(['run-warn']),
      childChats: [
        chat({
          appChatId: 'child-warn',
          parentChatId: 'chat-1',
          runs: [
            {
              runId: 'child-run-warn',
              provider: 'codex',
              startedAt: '2026-08-08T12:00:15.000Z',
              endedAt: '2026-08-08T12:00:50.000Z',
              status: 'success_with_warnings'
            }
          ]
        })
      ]
    })
    expect(rows).toEqual([
      expect.objectContaining({ subThreadId: 'child-warn', status: 'completed' })
    ])
  })

  it('does not let a summary-only child force created over a returned card', () => {
    const rows = collectCloseoutSubagentDelegations({
      messages: [
        {
          ...message('ret', 'tool', '↩ Result', {
            kind: 'subThreadReturn',
            subThreadId: 'child-summary',
            subThreadProvider: 'codex',
            subThreadTitle: 'Summary child',
            subThreadOutcome: 'done',
            parallelResultWaveId: 'run-summary'
          }),
          timestamp: '2026-08-08T12:00:40.000Z'
        }
      ],
      parentRunIds: new Set(['run-summary']),
      childChats: [
        chat({
          appChatId: 'child-summary',
          parentChatId: 'chat-1',
          runs: [],
          lastRun: undefined
        })
      ]
    })
    expect(rows[0]?.status).toBe('returned')
  })

  it('prefers a return card over a still-running child lastRun (App-shaped inputs)', () => {
    const rows = collectCloseoutSubagentDelegations({
      messages: [
        {
          ...message('del', 'system', '↪ Delegated.', {
            kind: 'subThreadDelegation',
            subThreadId: 'child-race',
            subThreadProvider: 'codex',
            subThreadTitle: 'Race child',
            joinPolicy: { groupId: 'run-race' }
          }),
          timestamp: '2026-08-08T12:00:10.000Z'
        },
        {
          ...message('ret', 'tool', '↩ Result', {
            kind: 'subThreadReturn',
            subThreadId: 'child-race',
            subThreadProvider: 'codex',
            subThreadTitle: 'Race child',
            subThreadOutcome: 'done',
            parallelResultWaveId: 'run-race'
          }),
          timestamp: '2026-08-08T12:02:00.000Z'
        }
      ],
      parentRunIds: new Set(['run-race']),
      childChats: [
        chat({
          appChatId: 'child-race',
          parentChatId: 'chat-1',
          runs: [
            {
              runId: 'child-run-race',
              provider: 'codex',
              startedAt: '2026-08-08T12:00:15.000Z',
              status: 'running'
            }
          ]
        })
      ]
    })
    expect(rows[0]?.status).toBe('returned')
  })

  it('reads lastRun when runs[] is empty (list-summary hydration)', () => {
    const rows = collectCloseoutSubagentDelegations({
      messages: [
        {
          ...message('del', 'system', '↪ Delegated.', {
            kind: 'subThreadDelegation',
            subThreadId: 'child-last-run',
            subThreadProvider: 'codex',
            subThreadTitle: 'LastRun child',
            joinPolicy: { groupId: 'run-last' }
          }),
          timestamp: '2026-08-08T12:00:10.000Z'
        }
      ],
      parentRunIds: new Set(['run-last']),
      childChats: [
        chat({
          appChatId: 'child-last-run',
          parentChatId: 'chat-1',
          runs: [],
          lastRun: {
            runId: 'child-run-lr',
            provider: 'codex',
            startedAt: '2026-08-08T12:00:15.000Z',
            status: 'running'
          }
        })
      ]
    })
    expect(rows[0]?.status).toBe('running')
  })
})

  it('captures run commits from single-provider tool rows when runId is missing but timestamp is within run', () => {
    const run: ChatRun = {
      runId: 'run-single-provider',
      provider: 'codex',
      startedAt: '2026-07-07T12:00:00.000Z',
      endedAt: '2026-07-07T12:00:39.000Z',
      status: 'success'
    }

    const closeout = buildTaskWraithRunCloseoutMessage({
      chat: chat({
        messages: [
          {
            ...message('tool-1', 'tool', ''),
            runId: run.runId,
            timestamp: '2026-07-07T12:00:10.000Z',
            toolActivities: [
              activity({
                toolName: 'git_commit',
                outputPreview:
                  '[main abc12345] First commit with runId\n 5 files changed'
              })
            ]
          },
          {
            ...message('tool-2', 'tool', ''),
            runId: run.runId,
            timestamp: '2026-07-07T12:00:20.000Z',
            toolActivities: [
              activity({
                toolName: 'git_commit',
                outputPreview:
                  '[main def67890] Second commit with runId\n 3 files changed'
              })
            ]
          },
          {
            ...message('tool-3', 'tool', ''),
            timestamp: '2026-07-07T12:00:25.000Z',
            toolActivities: [
              activity({
                toolName: 'git_commit',
                outputPreview:
                  '[main 18003ca96] Commit without runId but in window\n 2 files changed'
              })
            ]
          },
          {
            ...message('tool-4', 'tool', ''),
            timestamp: '2026-07-07T12:01:20.000Z',
            toolActivities: [
              activity({
                toolName: 'git_commit',
                outputPreview:
                  '[main deadbeef0] Commit outside run window\n 1 file changed'
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

    expect(closeout.metadata?.closeoutCommits?.map((c) => c.hash)).toEqual([
      'abc12345',
      'def67890',
      '18003ca96'
    ])
  })
