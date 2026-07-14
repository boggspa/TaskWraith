import { describe, it, expect } from 'vitest'
import type {
  ChatMessage,
  ChatRun,
  ExternalPathGrant,
  ToolActivity
} from '../../../main/store/types'
import {
  buildRunDiffByPath,
  isSuccessfulRunEvidenceActivity,
  mergeCompletionFileChangeSummaries,
  selectCompletionRunIds,
  selectRunEvidenceMessages,
  selectWriteWorkspacePaths
} from './RunWorkspaceDiff'

const START = '2026-01-01T00:00:00.000Z'
const END = '2026-01-01T00:01:00.000Z'

function run(runId: string, overrides: Partial<ChatRun> = {}): ChatRun {
  return {
    runId,
    startedAt: START,
    endedAt: END,
    ...overrides
  }
}

function grant(
  path: string,
  access: ExternalPathGrant['access'],
  kind: ExternalPathGrant['kind'] = 'directory'
): ExternalPathGrant {
  return { path, access, kind } as ExternalPathGrant
}

function editActivity(id: string, filePath: string, additions: number): ToolActivity {
  return {
    id,
    toolName: 'edit_file',
    displayName: 'Edited file',
    category: 'write',
    status: 'success',
    parameters: { changes: [{ path: filePath, kind: 'modify', additions, deletions: 0 }] }
  }
}

function messageWith(
  activities: ToolActivity[],
  overrides: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    timestamp: '2026-01-01T00:00:30.000Z',
    runId: 'run-current',
    toolActivities: activities,
    ...overrides
  }
}

describe('RunWorkspaceDiff', () => {
  describe('selectWriteWorkspacePaths', () => {
    it('keeps WRITE grants only, in order, de-duplicated', () => {
      const paths = selectWriteWorkspacePaths([
        grant('/repo-a', 'write'),
        grant('/repo-b', 'read'),
        grant('/repo-c', 'write'),
        grant('/repo-a/', 'write'), // canonical duplicate
        grant('relative-repo', 'write')
      ])
      expect(paths).toEqual(['/repo-a', '/repo-c'])
    })

    it('defends against missing / malformed input', () => {
      expect(selectWriteWorkspacePaths(undefined)).toEqual([])
      expect(selectWriteWorkspacePaths([{ access: 'write' } as ExternalPathGrant])).toEqual([])
    })
  })

  describe('buildRunDiffByPath', () => {
    const scope = { runIds: ['run-current'], runs: [run('run-current')] }

    it('returns path-exclusive summaries for each WRITE workspace that changed', () => {
      const messages = [
        messageWith([
          editActivity('t1', '/repo-a/src/app.ts', 5),
          editActivity('t2', '/repo-b/lib/util.ts', 3)
        ])
      ]
      const byPath = buildRunDiffByPath(messages, [
        grant('/repo-a', 'write'),
        grant('/repo-b', 'write')
      ], scope)
      expect(Object.keys(byPath).sort()).toEqual(['/repo-a', '/repo-b'])
      expect(byPath['/repo-a'].map((entry) => entry.path)).toEqual(['src/app.ts'])
      expect(byPath['/repo-b'].map((entry) => entry.path)).toEqual(['lib/util.ts'])
    })

    it('assigns a nested path only to the most-specific WRITE root', () => {
      const byPath = buildRunDiffByPath(
        [messageWith([editActivity('nested', '/repo-a/packages/ui/index.ts', 1)])],
        [grant('/repo-a', 'write'), grant('/repo-a/packages/ui', 'write')],
        scope
      )
      expect(byPath['/repo-a']).toBeUndefined()
      expect(byPath['/repo-a/packages/ui'].map((entry) => entry.path)).toEqual(['index.ts'])
    })

    it('does not treat sibling-prefix or relative paths as belonging to a WRITE root', () => {
      const byPath = buildRunDiffByPath(
        [
          messageWith([
            editActivity('sibling', '/repo-a-copy/leak.ts', 1),
            editActivity('relative', 'relative/leak.ts', 1)
          ])
        ],
        [grant('/repo-a', 'write')],
        scope
      )
      expect(byPath).toEqual({})
    })

    it('canonicalizes dot segments before assigning a WRITE root', () => {
      const byPath = buildRunDiffByPath(
        [
          messageWith([
            editActivity('inside', '/repo-a/src/../lib/inside.ts', 1),
            editActivity('escape', '/repo-a/../repo-b/leak.ts', 1)
          ])
        ],
        [grant('/repo-a', 'write')],
        scope
      )
      expect(byPath['/repo-a'].map((entry) => entry.path)).toEqual(['lib/inside.ts'])
    })

    it('attributes an exact-file WRITE grant without admitting sibling files', () => {
      const byPath = buildRunDiffByPath(
        [
          messageWith([
            editActivity('exact', '/repo-a/allowed.ts', 1),
            editActivity('sibling', '/repo-a/other.ts', 1)
          ])
        ],
        [grant('/repo-a/allowed.ts', 'write', 'file')],
        scope
      )
      expect(byPath).toEqual({
        '/repo-a': [
          expect.objectContaining({
            path: 'allowed.ts'
          })
        ]
      })
    })

    it('excludes READ workspaces from the map', () => {
      const messages = [messageWith([editActivity('t1', '/repo-a/src/app.ts', 5)])]
      const byPath = buildRunDiffByPath(messages, [
        grant('/repo-a', 'write'),
        grant('/repo-read', 'read')
      ], scope)
      expect(byPath['/repo-read']).toBeUndefined()
      expect(byPath['/repo-a']).toBeDefined()
    })

    it('uses only successful evidence from the requested run', () => {
      const failed = editActivity('failed', '/repo-a/failed.ts', 1)
      failed.status = 'error'
      const pending = editActivity('pending', '/repo-a/pending.ts', 1)
      pending.status = 'pending'
      const byPath = buildRunDiffByPath(
        [
          messageWith([editActivity('current', '/repo-a/current.ts', 1), failed, pending]),
          messageWith([editActivity('other', '/repo-a/other.ts', 1)], {
            id: 'other-message',
            runId: 'run-other'
          })
        ],
        [grant('/repo-a', 'write')],
        { runIds: ['run-current'], runs: [run('run-current'), run('run-other')] }
      )
      expect(byPath['/repo-a'].map((entry) => entry.path)).toEqual(['current.ts'])
    })

    it('rejects an optimistic success whose durable tool_result was denied', () => {
      const denied = editActivity('denied', '/repo-a/denied.ts', 1)
      denied.rawResultEvent = {
        type: 'tool_result',
        status: 'error',
        result: {
          structuredContent: {
            ok: false,
            tool: 'write_file',
            error: 'File changes denied by TaskWraith.'
          }
        }
      }
      // This is the exact legacy mismatch reproduced by the live Test 1
      // approval-timeout run: the activity remained success even though the
      // paired result was an error and no file existed on disk.
      expect(denied.status).toBe('success')
      expect(
        buildRunDiffByPath(
          [messageWith([denied])],
          [grant('/repo-a', 'write')],
          scope
        )
      ).toEqual({})
    })

    it('rejects a compacted optimistic success with only a plain-text denial summary', () => {
      const denied = editActivity('denied-compacted', '/repo-a/denied.ts', 1)
      denied.resultSummary = 'File changes denied by TaskWraith.'
      expect(denied.rawResultEvent).toBeUndefined()
      expect(
        buildRunDiffByPath([messageWith([denied])], [grant('/repo-a', 'write')], scope)
      ).toEqual({})
    })

    it('returns an empty map when there are no WRITE grants or no changes', () => {
      expect(buildRunDiffByPath([], [grant('/repo-a', 'write')], scope)).toEqual({})
      expect(
        buildRunDiffByPath(
          [messageWith([editActivity('t1', '/repo-a/x.ts', 1)])],
          [grant('/repo-a', 'read')],
          scope
        )
      ).toEqual({})
    })
  })

  describe('isSuccessfulRunEvidenceActivity', () => {
    it('does not mistake a successful filename containing denial words for a failure', () => {
      const activity = editActivity('success-with-denial-filename', '/repo-a/permission denied.md', 1)
      activity.resultSummary = 'Edited permission denied.md.'
      expect(isSuccessfulRunEvidenceActivity(activity)).toBe(true)
    })
  })

  describe('selectRunEvidenceMessages', () => {
    it('admits bounded unambiguous legacy rows but rejects outside and ambiguous rows', () => {
      const selectedRun = run('selected')
      const overlappingRun = run('overlap', {
        startedAt: '2026-01-01T00:00:20.000Z',
        endedAt: '2026-01-01T00:00:40.000Z'
      })
      const messages = [
        messageWith([editActivity('before', '/repo-a/before.ts', 1)], {
          id: 'before',
          runId: undefined,
          timestamp: '2025-12-31T23:59:59.000Z'
        }),
        messageWith([editActivity('legacy-safe', '/repo-a/safe.ts', 1)], {
          id: 'legacy-safe',
          runId: undefined,
          timestamp: '2026-01-01T00:00:10.000Z'
        }),
        messageWith([editActivity('legacy-ambiguous', '/repo-a/ambiguous.ts', 1)], {
          id: 'legacy-ambiguous',
          runId: undefined,
          timestamp: '2026-01-01T00:00:30.000Z'
        }),
        messageWith([editActivity('tagged', '/repo-a/tagged.ts', 1)], {
          id: 'tagged',
          runId: 'selected',
          timestamp: 'invalid-but-tagged'
        })
      ]

      expect(
        selectRunEvidenceMessages(messages, {
          runIds: ['selected'],
          runs: [selectedRun, overlappingRun]
        }).map((message) => message.id)
      ).toEqual(['legacy-safe', 'tagged'])
      expect(
        selectRunEvidenceMessages(messages, {
          runIds: ['selected', 'overlap'],
          runs: [selectedRun, overlappingRun]
        }).map((message) => message.id)
      ).toEqual(['legacy-safe', 'legacy-ambiguous', 'tagged'])
    })

    it('requires a closed durable window for null-runId evidence', () => {
      const legacy = messageWith([editActivity('legacy', '/repo-a/legacy.ts', 1)], {
        runId: undefined
      })
      expect(
        selectRunEvidenceMessages([legacy], {
          runIds: ['open'],
          runs: [run('open', { endedAt: undefined })]
        })
      ).toEqual([])
    })

    it('treats an overlapping open run as a possible legacy-row owner', () => {
      const legacy = messageWith([editActivity('legacy', '/repo-a/legacy.ts', 1)], {
        runId: undefined,
        timestamp: '2026-01-01T00:00:30.000Z'
      })
      expect(
        selectRunEvidenceMessages([legacy], {
          runIds: ['selected'],
          runs: [
            run('selected'),
            run('still-open', {
              startedAt: '2026-01-01T00:00:20.000Z',
              endedAt: undefined
            })
          ]
        })
      ).toEqual([])
      expect(
        selectRunEvidenceMessages([legacy], {
          runIds: ['selected', 'still-open'],
          runs: [
            run('selected'),
            run('still-open', {
              startedAt: '2026-01-01T00:00:20.000Z',
              endedAt: undefined
            })
          ]
        }).map((message) => message.id)
      ).toEqual(['m1'])
    })
  })

  describe('mergeCompletionFileChangeSummaries', () => {
    it('renders the all-participant round superset once and preserves exact preview data', () => {
      const display = [
        {
          path: 'b.ts',
          status: 'modified' as const,
          additions: 1,
          deletions: 0,
          previewKind: 'git_diff' as const,
          diffText: 'exact preview',
          owners: [{ participantId: 'participant-b', provider: 'codex' as const }]
        }
      ]
      const round = [
        {
          path: '/repo/a.ts',
          status: 'created' as const,
          additions: 2,
          deletions: 0,
          previewKind: 'none' as const,
          owners: [{ participantId: 'participant-a', provider: 'claude' as const }]
        },
        {
          path: '/repo/b.ts',
          status: 'modified' as const,
          additions: 3,
          deletions: 1,
          previewKind: 'none' as const,
          owners: [
            { participantId: 'participant-a', provider: 'claude' as const },
            { participantId: 'participant-b', provider: 'codex' as const }
          ]
        },
        {
          path: './a.ts',
          status: 'created' as const,
          additions: 2,
          deletions: 0,
          previewKind: 'none' as const,
          owners: [{ participantId: 'participant-b', provider: 'codex' as const }]
        }
      ]

      const merged = mergeCompletionFileChangeSummaries(display, round, '/repo')
      expect(merged.map((summary) => summary.path)).toEqual(['/repo/a.ts', '/repo/b.ts'])
      expect(merged[0].owners).toEqual([
        { participantId: 'participant-a', provider: 'claude' },
        { participantId: 'participant-b', provider: 'codex' }
      ])
      expect(merged[1]).toEqual(
        expect.objectContaining({
          additions: 3,
          deletions: 1,
          previewKind: 'git_diff',
          diffText: 'exact preview',
          owners: [
            { participantId: 'participant-a', provider: 'claude' },
            { participantId: 'participant-b', provider: 'codex' }
          ]
        })
      )
    })

    it('preserves exact solo-run evidence while merging live owners', () => {
      const display = [
        {
          path: 'solo.ts',
          status: 'modified' as const,
          additions: 1,
          deletions: 0,
          previewKind: 'git_diff' as const,
          diffText: 'exact preview',
          owners: [{ participantId: 'participant-exact', provider: 'codex' as const }]
        }
      ]
      const round = [
        {
          path: '/repo/solo.ts',
          status: 'created' as const,
          additions: 8,
          deletions: 2,
          previewKind: 'none' as const,
          owners: [{ participantId: 'participant-live', provider: 'claude' as const }]
        }
      ]

      expect(
        mergeCompletionFileChangeSummaries(display, round, '/repo', {
          preferDisplayEvidence: true
        })
      ).toEqual([
        {
          ...display[0],
          owners: [round[0].owners[0], display[0].owners[0]]
        }
      ])
    })

    it('deduplicates case variants under a Windows workspace root', () => {
      const merged = mergeCompletionFileChangeSummaries(
        [
          {
            path: 'Foo.ts',
            status: 'modified',
            additions: 1,
            deletions: 0,
            previewKind: 'git_diff'
          }
        ],
        [
          {
            path: 'C:/Repo/foo.ts',
            status: 'modified',
            additions: 2,
            deletions: 0,
            previewKind: 'none'
          }
        ],
        'C:/Repo'
      )

      expect(merged).toHaveLength(1)
      expect(merged[0].path).toBe('C:/Repo/foo.ts')
    })
  })

  describe('selectCompletionRunIds', () => {
    it('collects every participant and lane run in the active round', () => {
      const runIds = selectCompletionRunIds(
        {
          chatKind: 'ensemble',
          runs: [
            run('seat-a', { ensembleRoundId: 'round-1' }),
            run('seat-b', { ensembleRoundId: 'round-1' }),
            run('old-seat', { ensembleRoundId: 'round-old' })
          ],
          ensemble: {
            activeRound: {
              roundId: 'round-1',
              participants: [{ participantId: 'p-a', runId: 'seat-a' }],
              lanes: { lane: { runId: 'lane-a' } }
            }
          }
        } as never,
        run('seat-b')
      )
      expect(Array.from(runIds).sort()).toEqual(['lane-a', 'seat-a', 'seat-b'])
    })

    it('falls back to the current solo run only', () => {
      expect(
        Array.from(selectCompletionRunIds({ chatKind: 'single', runs: [] }, run('solo')))
      ).toEqual(['solo'])
    })

    it('uses the completed run round rather than a newer active round', () => {
      const runIds = selectCompletionRunIds(
        {
          chatKind: 'ensemble',
          runs: [
            run('completed-a', { ensembleRoundId: 'round-completed' }),
            run('completed-b', { ensembleRoundId: 'round-completed' }),
            run('new-active', { ensembleRoundId: 'round-new' })
          ],
          ensemble: {
            activeRound: {
              roundId: 'round-new',
              participants: [{ participantId: 'p-new', runId: 'new-active' }]
            }
          }
        } as never,
        run('completed-b', { ensembleRoundId: 'round-completed' })
      )
      expect(Array.from(runIds).sort()).toEqual(['completed-a', 'completed-b'])
    })
  })
})
