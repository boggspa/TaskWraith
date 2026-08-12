import { describe, expect, it } from 'vitest'
import type {
  ChatRecord,
  EnsembleQueuedPromptState,
  RunQueueJob
} from '../../../main/store/types'
import type { QueuedRunRequest } from './runRequestTypes'
import {
  alignEnsembleQueuedPromptEntries,
  appendLocalQueuedRunEntries,
  mapQueuedAttachmentsForComposer,
  preserveOptimisticEnsembleQueue
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
