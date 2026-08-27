import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord, ChatRun, ToolActivity } from '../../../main/store/types'
import { threadHomeRunStats } from './threadHomeActivityStats'

const run = (runId: string, overrides: Partial<ChatRun> = {}): ChatRun => ({
  runId,
  startedAt: '2026-08-27T18:00:00.000Z',
  status: 'running',
  ...overrides
})

const activity = (overrides: Partial<ToolActivity> = {}): ToolActivity => ({
  id: overrides.id || 'activity',
  toolName: overrides.toolName || 'write_file',
  displayName: overrides.displayName || 'Write file',
  category: overrides.category || 'write',
  status: overrides.status || 'success',
  ...overrides
})

const message = (
  id: string,
  runId: string,
  activities: ToolActivity[],
  metadata?: ChatMessage['metadata']
): ChatMessage => ({
  id,
  runId,
  role: 'assistant',
  content: '',
  timestamp: '2026-08-27T18:01:00.000Z',
  toolActivities: activities,
  ...(metadata ? { metadata } : {})
})

const chat = (overrides: Partial<ChatRecord> = {}): ChatRecord =>
  ({
    appChatId: 'chat-1',
    title: 'Live work',
    provider: 'codex',
    scope: 'workspace',
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    runs: [],
    ...overrides
  }) as ChatRecord

describe('threadHomeRunStats', () => {
  it('keeps cumulative live edits and a commit receipt visible together', () => {
    const liveRun = run('run-1')
    const source = chat({
      runs: [liveRun],
      messages: [
        message('write-1', liveRun.runId, [
          activity({
            id: 'write-1',
            diffSummary: {
              source: 'result_diff',
              confidence: 'exact',
              files: [{ path: 'src/a.ts', status: 'modified', additions: 5, deletions: 2 }]
            }
          })
        ]),
        message('write-2', liveRun.runId, [
          activity({
            id: 'write-2',
            diffSummary: {
              source: 'result_diff',
              confidence: 'exact',
              files: [
                { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 },
                { path: 'src/b.ts', status: 'created', additions: 7 }
              ]
            }
          })
        ]),
        message('commit', liveRun.runId, [
          activity({
            id: 'commit',
            toolName: 'git_commit',
            displayName: 'Committed changes',
            commitEvidence: {
              receiptText: '[master abc12345] Keep the evidence\n 2 files changed'
            }
          })
        ])
      ]
    })

    expect(threadHomeRunStats(source)).toEqual({
      filesChanged: 2,
      additions: 15,
      deletions: 3,
      hasLineStats: true,
      commits: 1
    })
  })

  it('combines current Ensemble participant evidence but excludes an older round', () => {
    const oldRun = run('old', {
      status: 'success',
      endedAt: '2026-08-27T17:00:00.000Z',
      ensembleRoundId: 'round-old'
    })
    const first = run('first', {
      status: 'success',
      endedAt: '2026-08-27T18:02:00.000Z',
      ensembleRoundId: 'round-live'
    })
    const second = run('second', { ensembleRoundId: 'round-live' })
    const source = chat({
      chatKind: 'ensemble',
      runs: [oldRun, first, second],
      ensemble: {
        participants: [],
        activeRound: {
          roundId: 'round-live',
          status: 'running',
          prompt: 'Work',
          startedAt: '2026-08-27T18:00:00.000Z',
          participants: [
            {
              participantId: 'p1',
              provider: 'codex',
              role: 'Worker',
              order: 0,
              status: 'answered',
              runId: 'first'
            },
            {
              participantId: 'p2',
              provider: 'claude',
              role: 'Reviewer',
              order: 1,
              status: 'running',
              runId: 'second'
            }
          ]
        }
      },
      messages: [
        message('old', 'old', [
          activity({
            id: 'old',
            diffSummary: {
              source: 'result_diff',
              confidence: 'exact',
              files: [{ path: 'old.ts', status: 'modified', additions: 99 }]
            }
          })
        ]),
        message('first', 'first', [
          activity({
            id: 'first',
            diffSummary: {
              source: 'result_diff',
              confidence: 'exact',
              files: [{ path: 'one.ts', status: 'modified', additions: 4 }]
            }
          })
        ]),
        message('second', 'second', [
          activity({
            id: 'second',
            diffSummary: {
              source: 'result_diff',
              confidence: 'exact',
              files: [{ path: 'two.ts', status: 'modified', deletions: 3 }]
            }
          })
        ])
      ]
    })

    expect(threadHomeRunStats(source)).toMatchObject({
      filesChanged: 2,
      additions: 4,
      deletions: 3
    })
  })

  it('falls back to a terminal participant run diff when its tool detail is absent', () => {
    const finished = run('finished', {
      status: 'success',
      endedAt: '2026-08-27T18:02:00.000Z',
      ensembleRoundId: 'round-live',
      runDiff: {
        runId: 'finished',
        preSnapshot: { capturedAt: 'before', isGitRepo: true },
        createdFiles: [],
        modifiedFiles: [
          {
            path: 'src/fallback.ts',
            status: 'modified',
            additions: 8,
            deletions: 2,
            previewKind: 'git_diff'
          }
        ],
        deletedFiles: [],
        preExistingFiles: []
      }
    })
    const live = run('live', { ensembleRoundId: 'round-live' })
    const source = chat({
      chatKind: 'ensemble',
      runs: [finished, live],
      ensemble: {
        participants: [],
        activeRound: {
          roundId: 'round-live',
          status: 'running',
          prompt: 'Work',
          startedAt: '2026-08-27T18:00:00.000Z',
          participants: []
        }
      },
      messages: [
        message('read-only-evidence', 'finished', [
          activity({
            id: 'read-only-evidence',
            toolName: 'read_file',
            displayName: 'Read file',
            category: 'read'
          })
        ])
      ]
    })

    expect(threadHomeRunStats(source)).toMatchObject({
      filesChanged: 1,
      additions: 8,
      deletions: 2
    })
  })

  it('does not present partial line totals as exact when any file has unknown counts', () => {
    const liveRun = run('run-fuzzy')
    const source = chat({
      appChatId: 'fuzzy-chat',
      runs: [liveRun],
      messages: [
        message('mixed', liveRun.runId, [
          activity({
            diffSummary: {
              source: 'result_diff',
              confidence: 'exact',
              files: [
                { path: 'known.ts', status: 'modified', additions: 5, deletions: 1 },
                { path: 'unknown.ts', status: 'modified' }
              ]
            }
          })
        ])
      ]
    })

    expect(threadHomeRunStats(source)).toMatchObject({
      filesChanged: 2,
      additions: 5,
      deletions: 1,
      hasLineStats: false
    })
  })

  it('keeps live-only external workspace paths beside an exact primary run diff', () => {
    const finished = run('finished-external', {
      status: 'success',
      endedAt: '2026-08-27T18:02:00.000Z',
      ensembleRoundId: 'round-external',
      runDiff: {
        runId: 'finished-external',
        preSnapshot: { capturedAt: 'before', isGitRepo: true, workspacePath: '/repo' },
        createdFiles: [],
        modifiedFiles: [
          {
            path: 'src/primary.ts',
            status: 'modified',
            additions: 6,
            deletions: 1,
            previewKind: 'git_diff'
          }
        ],
        deletedFiles: [],
        preExistingFiles: []
      }
    })
    const source = chat({
      appChatId: 'external-chat',
      chatKind: 'ensemble',
      runs: [finished],
      ensemble: {
        participants: [],
        activeRound: {
          roundId: 'round-external',
          status: 'running',
          prompt: 'Work',
          startedAt: '2026-08-27T18:00:00.000Z',
          participants: []
        }
      },
      messages: [
        message('external-write', finished.runId, [
          activity({
            diffSummary: {
              source: 'result_diff',
              confidence: 'exact',
              files: [
                {
                  path: '/external/src/secondary.ts',
                  status: 'modified',
                  additions: 4,
                  deletions: 2
                }
              ]
            }
          })
        ])
      ]
    })

    expect(threadHomeRunStats(source)).toMatchObject({
      filesChanged: 2,
      additions: 10,
      deletions: 3,
      hasLineStats: true
    })
  })

  it('returns the cached object for an unchanged streaming projection', () => {
    const liveRun = run('run-cache')
    const messages = [
      message('write', liveRun.runId, [
        activity({
          diffSummary: {
            source: 'result_diff',
            confidence: 'exact',
            files: [{ path: 'a.ts', status: 'modified', additions: 1 }]
          }
        })
      ])
    ]
    const runs = [liveRun]
    const first = threadHomeRunStats(chat({ appChatId: 'cache-chat', messages, runs }))
    const second = threadHomeRunStats(chat({ appChatId: 'cache-chat', messages, runs }))
    expect(second).toBe(first)
  })
})
