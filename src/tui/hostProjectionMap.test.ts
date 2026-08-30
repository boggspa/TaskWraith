import { describe, expect, it } from 'vitest'
import {
  HOST_PROTOCOL_VERSION,
  HOST_PROJECTION_VERSION,
  type HostSnapshot
} from '../shared/hostProtocol'
import {
  emptyHostSnapshotForTests,
  HOST_TUI_PREVIEW_ROW_KIND,
  mapHostHistoryEntriesToTranscriptRows,
  mapHostSnapshotToControlSnapshot,
  mapHostSnapshotToThreadDetail
} from './hostProjectionMap'

function snapshotWithThread(overrides?: Partial<HostSnapshot>): HostSnapshot {
  const base = emptyHostSnapshotForTests({
    generation: 7,
    cursor: 11,
    generatedAt: '2026-08-06T12:00:00.000Z',
    workspaces: [
      {
        id: 'ws-1',
        name: 'AGBench',
        path: '/Users/chrisizatt/Documents/AGBench',
        pinned: true,
        updatedAt: 100
      }
    ],
    providers: [
      {
        providerId: 'claude',
        displayProvider: 'Claude',
        modelId: 'claude-opus-4-7',
        modelLabel: 'Opus 4.7',
        shortCode: 'CLA',
        hueKey: 'claude',
        available: true
      }
    ],
    threads: [
      {
        id: 'thread-1',
        workspaceId: 'ws-1',
        title: 'Host Arc',
        chatKind: 'single',
        archived: false,
        pinned: true,
        updatedAt: 200,
        messageCount: 4,
        providerId: 'claude',
        modelId: 'claude-opus-5',
        reasoningEffort: 'high',
        permissionPresetId: 'workspace_write',
        latestPreview: 'Bounded preview only',
        previewTruncated: true
      }
    ],
    runs: [
      {
        runId: 'run-1',
        threadId: 'thread-1',
        providerId: 'claude',
        providerOutcome: 'running'
      }
    ],
    usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' }
  })
  return { ...base, ...overrides }
}

describe('hostProjectionMap', () => {
  it('maps bounded Host history entries onto existing transcript rows', () => {
    expect(
      mapHostHistoryEntriesToTranscriptRows([
        {
          entryId: 'history-1',
          role: 'assistant',
          createdAt: Date.UTC(2026, 7, 24, 4, 0, 0),
          text: 'A bounded Host transcript entry.',
          label: 'Host assistant'
        }
      ])
    ).toEqual([
      {
        id: 'host-history:history-1',
        role: 'assistant',
        kind: 'host-history',
        speaker: 'Host assistant',
        text: 'A bounded Host transcript entry.',
        timestamp: '2026-08-24T04:00:00.000Z',
        truncated: false
      }
    ])
  })

  it('keeps provider, model and effort identity on authoritative assistant history rows', () => {
    const thread = mapHostSnapshotToThreadDetail(snapshotWithThread(), 'thread-1')!.thread.thread
    expect(
      mapHostHistoryEntriesToTranscriptRows(
        [
          {
            entryId: 'history-provider',
            role: 'assistant',
            createdAt: 1,
            text: 'Stable identity'
          }
        ],
        thread
      )[0]
    ).toMatchObject({
      speaker: 'Claude',
      provider: { runtimeProvider: 'claude' },
      model: 'Opus 5',
      reasoning: 'high'
    })
  })

  it('maps bounded file-edit activity onto the assistant row', () => {
    const thread = mapHostSnapshotToThreadDetail(snapshotWithThread(), 'thread-1')!.thread.thread
    const row = mapHostHistoryEntriesToTranscriptRows(
      [
        {
          entryId: 'history-edit',
          role: 'assistant',
          createdAt: 1,
          text: 'Updated the file.',
          tools: [
            {
              id: 'tool-edit',
              name: 'Edit File',
              category: 'write',
              status: 'success',
              file: 'src/example.ts',
              additions: 4,
              deletions: 2
            }
          ]
        }
      ],
      thread
    )[0]
    expect(row).toMatchObject({
      text: 'Updated the file.',
      tools: [
        {
          name: 'Edit File',
          category: 'write',
          status: 'success',
          file: 'src/example.ts',
          additions: 4,
          deletions: 2
        }
      ]
    })
  })

  it('maps workspaces and threads onto the control snapshot shape', () => {
    const mapped = mapHostSnapshotToControlSnapshot(snapshotWithThread())
    expect(mapped.generatedAt).toBe('2026-08-06T12:00:00.000Z')
    expect(mapped.sequence).toBe(11)
    expect(mapped.workspaces).toEqual([
      {
        id: 'ws-1',
        name: 'AGBench',
        path: '/Users/chrisizatt/Documents/AGBench',
        pinned: true,
        updatedAt: 100
      }
    ])
    expect(mapped.threads).toHaveLength(1)
    expect(mapped.threads[0]).toMatchObject({
      id: 'thread-1',
      title: 'Host Arc',
      status: 'working',
      chatKind: 'single',
      provider: {
        runtimeProvider: 'claude',
        displayProvider: 'Claude',
        shortCode: 'CLA',
        model: 'claude-opus-5'
      },
      reasoning: 'high'
    })
  })

  it('does not invent cost/tokens from unavailable usage', () => {
    const mapped = mapHostSnapshotToControlSnapshot(
      snapshotWithThread({
        threads: [
          {
            id: 'thread-1',
            workspaceId: 'ws-1',
            title: 'Host Arc',
            chatKind: 'single',
            archived: false,
            pinned: false,
            updatedAt: 1,
            messageCount: 0,
            providerId: 'claude',
            usage: { availability: 'unavailable', tokens: 0, costText: '£0.00' }
          }
        ],
        runs: []
      })
    )
    expect(mapped.threads[0]?.tokenEstimate).toBeUndefined()
    expect(mapped.threads[0]?.costText).toBeUndefined()
  })

  it('joins ensemble participants from the matching Host round', () => {
    const mapped = mapHostSnapshotToControlSnapshot(
      snapshotWithThread({
        threads: [
          {
            id: 'ens-1',
            workspaceId: 'ws-1',
            title: 'Ensemble',
            chatKind: 'ensemble',
            archived: false,
            pinned: false,
            updatedAt: 3,
            messageCount: 2,
            providerId: 'claude',
            activeRoundId: 'round-1'
          }
        ],
        runs: [],
        rounds: [
          {
            roundId: 'round-1',
            threadId: 'ens-1',
            status: 'running',
            participantIds: ['p1', 'p2'],
            providerRunIds: [],
            routing: {
              mode: 'continuous',
              fanout: 'read_only',
              activeParticipantId: 'p1',
              continuationHops: 2,
              maxContinuationHops: 90
            }
          }
        ],
        participants: [
          {
            id: 'p1',
            threadId: 'ens-1',
            providerId: 'claude',
            role: 'Boss',
            order: 1,
            enabled: true,
            active: true,
            stage: 'worker'
          },
          {
            id: 'p2',
            threadId: 'ens-1',
            providerId: 'codex',
            role: 'Worker',
            order: 2,
            enabled: true,
            active: false,
            stage: 'worker'
          }
        ]
      })
    )
    const ensemble = mapped.threads[0]?.ensemble
    expect(ensemble?.mode).toBe('continuous')
    expect(ensemble?.fanout).toBe('read_only')
    expect(ensemble?.participants).toHaveLength(2)
    expect(ensemble?.participants[0]).toMatchObject({
      id: 'p1',
      role: 'Boss',
      active: true,
      next: false
    })
    expect(ensemble?.participants[1]).toMatchObject({
      id: 'p2',
      role: 'Worker',
      next: true
    })
  })

  it('never joins copied participant ids across threads for an idle round', () => {
    const mapped = mapHostSnapshotToControlSnapshot(
      snapshotWithThread({
        threads: [
          {
            id: 'ens-a',
            workspaceId: 'ws-1',
            title: 'A',
            chatKind: 'ensemble',
            archived: false,
            pinned: false,
            updatedAt: 1,
            messageCount: 0,
            activeRoundId: 'round-a'
          },
          {
            id: 'ens-b',
            workspaceId: 'ws-1',
            title: 'B',
            chatKind: 'ensemble',
            archived: false,
            pinned: false,
            updatedAt: 1,
            messageCount: 0,
            activeRoundId: 'round-b'
          }
        ],
        runs: [],
        rounds: [
          {
            roundId: 'round-a',
            threadId: 'ens-a',
            status: 'completed',
            participantIds: [],
            providerRunIds: []
          },
          {
            roundId: 'round-b',
            threadId: 'ens-b',
            status: 'completed',
            participantIds: [],
            providerRunIds: []
          }
        ],
        participants: [
          {
            id: 'shared-seat',
            threadId: 'ens-a',
            providerId: 'claude',
            role: 'A worker',
            order: 1,
            enabled: true,
            active: false
          },
          {
            id: 'shared-seat',
            threadId: 'ens-b',
            providerId: 'claude',
            role: 'B worker',
            order: 1,
            enabled: true,
            active: false
          }
        ]
      })
    )

    expect(mapped.threads.find((thread) => thread.id === 'ens-a')?.ensemble?.participants).toEqual([
      expect.objectContaining({ id: 'shared-seat', role: 'A worker' })
    ])
    expect(mapped.threads.find((thread) => thread.id === 'ens-b')?.ensemble?.participants).toEqual([
      expect.objectContaining({ id: 'shared-seat', role: 'B worker' })
    ])
  })

  it('builds preview-only thread detail without fabricating transcript history', () => {
    const detail = mapHostSnapshotToThreadDetail(snapshotWithThread(), 'thread-1')
    expect(detail?.previewOnly).toBe(true)
    expect(detail?.thread.rows).toHaveLength(1)
    expect(detail?.thread.rows[0]).toMatchObject({
      kind: HOST_TUI_PREVIEW_ROW_KIND,
      text: 'Bounded preview only',
      truncated: true,
      provider: { runtimeProvider: 'claude' },
      model: 'Opus 5',
      reasoning: 'high'
    })
    expect(detail?.thread.hasMoreAbove).toBe(true)
    expect(detail?.thread.context.workspaces[0]?.access).toBe('read')
    expect(detail?.thread.context.permission).toBe('workspace_write')
  })

  it('returns null when the thread is absent from the Host snapshot', () => {
    expect(mapHostSnapshotToThreadDetail(snapshotWithThread(), 'missing')).toBeNull()
  })

  it('keeps protocol versions intact on empty helper snapshots', () => {
    const empty = emptyHostSnapshotForTests()
    expect(empty.protocolVersion).toBe(HOST_PROTOCOL_VERSION)
    expect(empty.projectionVersion).toBe(HOST_PROJECTION_VERSION)
    expect(empty.usage.availability).toBe('unavailable')
  })
})
