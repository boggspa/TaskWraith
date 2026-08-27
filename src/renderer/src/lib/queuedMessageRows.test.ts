import { describe, expect, it } from 'vitest'
import type {
  ChatMessage,
  ChatRecord,
  EnsembleQueuedPromptState,
  RunQueueJob
} from '../../../main/store/types'
import { midRunQueuedMessageId } from '../../../shared/midRunSteeringQueue'
import type { QueuedRunRequest } from './runRequestTypes'
import {
  alignEnsembleQueuedPromptEntries,
  appendLocalQueuedRunEntries,
  discordContextSelectionSummary,
  filterTranscriptBackedQueuedRunEntries,
  mapQueuedAttachmentsForComposer,
  preserveOptimisticEnsembleQueue,
  queuedRunDisplayPrompt,
  reserveQueuedRunAtFront
} from './queuedMessageRows'

const chat = (id: string): ChatRecord =>
  ({
    appChatId: id,
    chatKind: 'single',
    messages: []
  }) as unknown as ChatRecord

const entry = (
  id: string,
  prompt: string,
  path?: string
): EnsembleQueuedPromptState => ({
  persistenceVersion: 1,
  id,
  prompt,
  imageAttachments: path ? [{ id: `${id}-att`, path, name: path.split('/').pop() }] : []
})

const ensembleChat = (
  id: string,
  roundId: string,
  queuedPrompts: string[],
  queuedPromptEntries?: EnsembleQueuedPromptState[]
): ChatRecord =>
  ({
    appChatId: id,
    chatKind: 'ensemble',
    messages: [],
    ensemble: {
      participants: [],
      activeRound: {
        roundId,
        status: 'running',
        prompt: 'active prompt',
        startedAt: '2026-06-22T10:00:00.000Z',
        participants: [],
        queuedPrompt: queuedPrompts[0],
        queuedPrompts,
        ...(queuedPromptEntries ? { queuedPromptEntries } : {})
      }
    }
  }) as unknown as ChatRecord

const request = (overrides: Partial<QueuedRunRequest> = {}): QueuedRunRequest => ({
  appRunId: 'run-1',
  provider: 'codex',
  prompt: 'Queued prompt',
  displayPrompt: 'Display prompt',
  selectedModelType: 'default',
  customModel: '',
  approvalMode: 'default',
  sessionTrust: false,
  imageAttachments: [],
  chatRecord: chat('chat-1'),
  ...overrides
})

const job = (overrides: Partial<RunQueueJob> = {}): RunQueueJob =>
  ({
    id: 'run-1',
    runId: 'run-1',
    provider: 'codex',
    chatId: 'chat-1',
    source: 'manual',
    status: 'queued',
    priority: 0,
    attempt: 0,
    createdAt: '2026-06-22T10:00:00.000Z',
    updatedAt: '2026-06-22T10:00:00.000Z',
    ...overrides
  }) as RunQueueJob

const fallbackId = (queued: QueuedRunRequest): string =>
  queued.appRunId || `${queued.provider}-${queued.prompt.slice(0, 16)}`

const queueRow = (id: string, prompt = 'Display prompt') => ({
  id,
  provider: 'codex' as const,
  prompt
})

const soloSteerMessage = (runId: string): ChatMessage => ({
  id: midRunQueuedMessageId(runId),
  role: 'user',
  content: 'Display prompt',
  timestamp: '2026-06-22T10:00:01.000Z',
  metadata: {
    kind: 'midRunSteering',
    midRunQueueRunId: runId,
    midRunQueueSource: 'soloSteer'
  }
})

describe('queued message row helpers', () => {
  it('adds a local queued request before the durable queue echo arrives', () => {
    const entries = appendLocalQueuedRunEntries({
      entries: [],
      queuedRuns: [request()],
      runQueueJobs: [],
      chatId: 'chat-1',
      queuedRunFallbackId: fallbackId
    })

    expect(entries).toEqual([
      {
        id: 'run-1',
        provider: 'codex',
        prompt: 'Display prompt',
        dmTargetParticipantId: undefined
      }
    ])
  })

  it('does not duplicate a local request once a durable job for the run exists', () => {
    const entries = appendLocalQueuedRunEntries({
      entries: [{ id: 'run-1', provider: 'codex', prompt: 'Durable prompt' }],
      queuedRuns: [request()],
      runQueueJobs: [job()],
      chatId: 'chat-1',
      queuedRunFallbackId: fallbackId
    })

    expect(entries).toEqual([{ id: 'run-1', provider: 'codex', prompt: 'Durable prompt' }])
  })

  it('suppresses local queued rows after the durable job leaves queued status', () => {
    const entries = appendLocalQueuedRunEntries({
      entries: [],
      queuedRuns: [request()],
      runQueueJobs: [job({ status: 'active' })],
      chatId: 'chat-1',
      queuedRunFallbackId: fallbackId
    })

    expect(entries).toEqual([])
  })

  it('projects DM target labels from local queued requests', () => {
    const entries = appendLocalQueuedRunEntries({
      entries: [],
      queuedRuns: [request({ dmTargetParticipantId: 'participant-1' })],
      runQueueJobs: [],
      chatId: 'chat-1',
      queuedRunFallbackId: fallbackId
    })

    expect(entries[0]?.dmTargetParticipantId).toBe('participant-1')
  })

  it('hides a queued boundary fallback once its exact solo Steer row is in the transcript', () => {
    const boundaryFallback = job({
      status: 'queued',
      queueMessageId: midRunQueuedMessageId('run-1')
    })

    expect(
      filterTranscriptBackedQueuedRunEntries(
        [queueRow(boundaryFallback.runId)],
        [soloSteerMessage(boundaryFallback.runId)]
      )
    ).toEqual([])
  })

  it('hides the same transcript-backed row during steer promotion without depending on status', () => {
    const promoting = job({
      status: 'steer_promoting',
      queueMessageId: midRunQueuedMessageId('run-1')
    })

    expect(
      filterTranscriptBackedQueuedRunEntries(
        [queueRow(promoting.runId)],
        [soloSteerMessage(promoting.runId)]
      )
    ).toEqual([])
  })

  it('preserves ordinary queued rows and requires an exact solo Steer transcript correlation', () => {
    const ordinary = queueRow('run-1', 'Ordinary queued prompt')
    const malformed: ChatMessage = {
      ...soloSteerMessage('run-1'),
      id: 'unrelated-user-row'
    }

    const entries = [ordinary]
    expect(filterTranscriptBackedQueuedRunEntries(entries, [])).toBe(entries)
    expect(filterTranscriptBackedQueuedRunEntries(entries, [malformed])).toBe(entries)
    expect(filterTranscriptBackedQueuedRunEntries(entries, [soloSteerMessage('another-run')])).toBe(
      entries
    )
  })

  it('hides the optimistic local mirror before the durable queue echo arrives', () => {
    const optimistic = appendLocalQueuedRunEntries({
      entries: [],
      queuedRuns: [request()],
      runQueueJobs: [],
      chatId: 'chat-1',
      queuedRunFallbackId: fallbackId
    })

    expect(optimistic).toEqual([
      {
        id: 'run-1',
        provider: 'codex',
        prompt: 'Display prompt',
        dmTargetParticipantId: undefined
      }
    ])
    expect(filterTranscriptBackedQueuedRunEntries(optimistic, [soloSteerMessage('run-1')])).toEqual(
      []
    )
  })

  it('keeps a failed transcript-backed handoff visible for recovery actions', () => {
    const entries = [queueRow('run-1')]

    expect(
      filterTranscriptBackedQueuedRunEntries(entries, [soloSteerMessage('run-1')], {
        preserveRunIds: new Set(['run-1'])
      })
    ).toBe(entries)
  })

  it('reserves a Steer at FIFO head and replaces its older local copy', () => {
    const older = request({ appRunId: 'run-older', prompt: 'Older' })
    const selected = request({ appRunId: 'run-selected', prompt: 'Selected' })
    const staleSelected = request({
      appRunId: 'run-selected',
      prompt: 'Selected before promotion'
    })

    const reserved = reserveQueuedRunAtFront([older, staleSelected], selected, fallbackId)

    expect(reserved.map((candidate) => candidate.appRunId)).toEqual(['run-selected', 'run-older'])
    expect(reserved[0]).toBe(selected)
  })

  it('keeps rapid promoted steers FIFO ahead of ordinary queued work', () => {
    const firstSteer = {
      ...request({ appRunId: 'first-steer', prompt: 'First' }),
      steerOwnerToken: 'owner-1'
    } as unknown as QueuedRunRequest
    const secondSteer = {
      ...request({ appRunId: 'second-steer', prompt: 'Second' }),
      steerOwnerToken: 'owner-2'
    } as unknown as QueuedRunRequest
    const ordinary = request({ appRunId: 'ordinary', prompt: 'Ordinary' })

    const first = reserveQueuedRunAtFront([ordinary], firstSteer, fallbackId)
    const second = reserveQueuedRunAtFront(first, secondSteer, fallbackId)

    expect(second.map((entry) => entry.appRunId)).toEqual([
      'first-steer',
      'second-steer',
      'ordinary'
    ])
  })

  it('gives Discord-only requests a stable non-empty row and transcript summary', () => {
    const discordContextSelection = {
      guildId: 'guild-1',
      guildName: 'TaskWraith',
      channelId: 'channel-1',
      channelName: 'engineering',
      limit: 25 as const
    }
    const discordOnly = request({
      prompt: '',
      displayPrompt: '',
      discordContextSelection
    })

    expect(discordContextSelectionSummary(discordContextSelection)).toBe(
      'Discord context from TaskWraith: #engineering (last 25 messages)'
    )
    expect(queuedRunDisplayPrompt(discordOnly)).toBe(
      'Discord context from TaskWraith: #engineering (last 25 messages)'
    )
  })

  it('preserves a longer local ensemble queue over stale hydration for the same running round', () => {
    const incoming = ensembleChat('chat-1', 'round-1', ['first'], [entry('e1', 'first', '/tmp/a.png')])
    const local = ensembleChat('chat-1', 'round-1', ['first', 'second'])

    const merged = preserveOptimisticEnsembleQueue(incoming, local)

    expect(merged.ensemble?.activeRound?.queuedPrompts).toEqual(['first', 'second'])
    expect(merged.ensemble?.activeRound?.queuedPrompt).toBe('first')
    expect(merged.ensemble?.activeRound?.queuedPromptEntries).toEqual([
      entry('e1', 'first', '/tmp/a.png'),
      {
        persistenceVersion: 1,
        id: 'optimistic-queued-tail-round-1-0',
        prompt: 'second',
        imageAttachments: []
      }
    ])
  })

  it('keeps same-length ensemble queues main-authoritative', () => {
    const incoming = ensembleChat('chat-1', 'round-1', ['main-normalized'])
    const local = ensembleChat('chat-1', 'round-1', ['local-optimistic'])

    const merged = preserveOptimisticEnsembleQueue(incoming, local)

    expect(merged).toBe(incoming)
  })

  it('accepts an authoritative empty queue after a steered item was restored locally', () => {
    // Post-steer race: stale absorb restored ['steered'] after optimistic clear;
    // the later empty dequeue must win, not get treated as unechoed append.
    const incoming = ensembleChat('chat-1', 'round-1', [])
    const local = ensembleChat('chat-1', 'round-1', ['steered'], [
      entry('durable-steered', 'steered')
    ])

    const merged = preserveOptimisticEnsembleQueue(incoming, local)

    expect(merged).toBe(incoming)
  })

  it('does not preserve a longer local queue that is not a prefix of main', () => {
    const incoming = ensembleChat('chat-1', 'round-1', ['kept'])
    const local = ensembleChat('chat-1', 'round-1', ['steered-away', 'kept'])

    const merged = preserveOptimisticEnsembleQueue(incoming, local)

    expect(merged).toBe(incoming)
  })

  it('does not preserve local ensemble queues across different rounds', () => {
    const incoming = ensembleChat('chat-1', 'round-2', [])
    const local = ensembleChat('chat-1', 'round-1', ['stale'])

    const merged = preserveOptimisticEnsembleQueue(incoming, local)

    expect(merged).toBe(incoming)
  })

  it('maps queued attachment snapshots back into composer rows', () => {
    expect(
      mapQueuedAttachmentsForComposer([
        {
          id: 'att-1',
          path: '/tmp/shot.png',
          name: 'shot.png',
          persistenceVersion: 1,
          sha256: 'abc',
          mimeType: 'image/png',
          byteLength: 12
        },
        { path: '' },
        { path: '/tmp/note.pdf' },
        {
          id: 'folder-1',
          path: '/tmp/reference-package',
          name: 'reference-package',
          kind: 'directory'
        }
      ])
    ).toEqual([
      {
        id: 'att-1',
        path: '/tmp/shot.png',
        name: 'shot.png',
        persistenceVersion: 1,
        sha256: 'abc',
        mimeType: 'image/png',
        byteLength: 12
      },
      {
        id: 'queued-edit-attachment-2',
        path: '/tmp/note.pdf',
        name: 'note.pdf'
      },
      {
        id: 'folder-1',
        path: '/tmp/reference-package',
        name: 'reference-package',
        kind: 'directory'
      }
    ])
  })

  it('aligns structured entries on index-accurate removal so attachments stay with remaining prompts', () => {
    const previousPrompts = ['Queued A', 'Queued A', 'Queued C']
    const previousEntries = [
      entry('e0', 'Queued A', '/tmp/a0.png'),
      entry('e1', 'Queued A', '/tmp/a1.png'),
      entry('e2', 'Queued C', '/tmp/c.png')
    ]

    const aligned = alignEnsembleQueuedPromptEntries(
      previousPrompts,
      previousEntries,
      ['Queued A', 'Queued C'],
      { removedIndex: 0 }
    )

    expect(aligned).toEqual([
      entry('e1', 'Queued A', '/tmp/a1.png'),
      entry('e2', 'Queued C', '/tmp/c.png')
    ])
  })

  it('appends an empty-attachment placeholder when optimistically enqueueing', () => {
    const previousPrompts = ['first']
    const previousEntries = [entry('e0', 'first', '/tmp/a.png')]

    const aligned = alignEnsembleQueuedPromptEntries(
      previousPrompts,
      previousEntries,
      ['first', 'second'],
      { appendedPrompt: 'second' }
    )

    expect(aligned).toHaveLength(2)
    expect(aligned?.[0]).toEqual(entry('e0', 'first', '/tmp/a.png'))
    expect(aligned?.[1]).toMatchObject({
      persistenceVersion: 1,
      prompt: 'second',
      imageAttachments: []
    })
  })
})
