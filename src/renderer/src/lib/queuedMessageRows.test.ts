import { describe, expect, it } from 'vitest'
import type { ChatRecord, RunQueueJob } from '../../../main/store/types'
import type { QueuedRunRequest } from './runRequestTypes'
import {
  deriveQueuedLifecycleProjection,
  appendLocalQueuedRunEntries,
  preserveOptimisticEnsembleQueue
} from './queuedMessageRows'

const chat = (id: string): ChatRecord =>
  ({
    appChatId: id,
    chatKind: 'single',
    messages: []
  }) as unknown as ChatRecord

const ensembleChat = (
  id: string,
  roundId: string,
  queuedPrompts: string[]
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
        queuedPrompts
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

const queuedLifecycleMessage = ({
  appRunId = 'run-1',
  statusText = 'Queued (#1): Display prompt\n— Will dispatch when this chat\'s current Codex turn finishes.'
}: {
  appRunId?: string
  statusText?: string
} = {}): {
  id: string
  role: 'tool' | 'system'
  content: string
  timestamp: string
  metadata: { kind: 'queuedRunRequest'; appRunId: string; queuePosition: number; provider: 'codex' }
} => ({
  id: `queued-${appRunId}`,
  role: 'tool',
  content: statusText,
  timestamp: '2026-06-22T10:00:00.000Z',
  metadata: { kind: 'queuedRunRequest', appRunId, queuePosition: 1, provider: 'codex' }
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

  it('preserves a longer local ensemble queue over stale hydration for the same running round', () => {
    const incoming = ensembleChat('chat-1', 'round-1', ['first'])
    const local = ensembleChat('chat-1', 'round-1', ['first', 'second'])

    const merged = preserveOptimisticEnsembleQueue(incoming, local)

    expect(merged.ensemble?.activeRound?.queuedPrompts).toEqual(['first', 'second'])
    expect(merged.ensemble?.activeRound?.queuedPrompt).toBe('first')
  })

  it('keeps same-length ensemble queues main-authoritative', () => {
    const incoming = ensembleChat('chat-1', 'round-1', ['main-normalized'])
    const local = ensembleChat('chat-1', 'round-1', ['local-optimistic'])

    const merged = preserveOptimisticEnsembleQueue(incoming, local)

    expect(merged).toBe(incoming)
  })

  it('does not preserve local ensemble queues across different rounds', () => {
    const incoming = ensembleChat('chat-1', 'round-2', [])
    const local = ensembleChat('chat-1', 'round-1', ['stale'])

    const merged = preserveOptimisticEnsembleQueue(incoming, local)

    expect(merged).toBe(incoming)
  })

  it('keeps queued lifecycle rows above transcript while still queued', () => {
    const projected = deriveQueuedLifecycleProjection({
      messages: [queuedLifecycleMessage()],
      pendingQueuedAppRunIds: new Set(['run-1'])
    })

    expect(projected).toHaveLength(1)
    expect(projected[0]?.role).toBe('system')
    expect(projected[0]?.content).toContain('Will dispatch')
  })

  it('projects promoted queued cards when queue dispatch completed', () => {
    const projected = deriveQueuedLifecycleProjection({
      messages: [queuedLifecycleMessage({ appRunId: 'run-promoted' })],
      pendingQueuedAppRunIds: new Set(),
      queuedRunStatusByAppRunId: { 'run-promoted': 'steer_promoting' }
    })

    expect(projected[0]?.content).toContain('— Promoted to dispatch')
    expect(projected[0]?.content).not.toContain('Will dispatch')
  })

  it('projects cancelled queued cards when queue lifecycle changed', () => {
    const projected = deriveQueuedLifecycleProjection({
      messages: [queuedLifecycleMessage({ appRunId: 'run-cancelled' })],
      pendingQueuedAppRunIds: new Set(),
      queuedRunStatusByAppRunId: { 'run-cancelled': 'cancelled' }
    })

    expect(projected[0]?.content).toContain('— Cancelled before dispatch')
    expect(projected[0]?.content).not.toContain('Will dispatch')
  })

  it('projects edited queued cards with edited lifecycle label', () => {
    const projected = deriveQueuedLifecycleProjection({
      messages: [queuedLifecycleMessage({ appRunId: 'run-edited' })],
      pendingQueuedAppRunIds: new Set(),
      queuedRunStatusByAppRunId: { 'run-edited': 'edited' }
    })

    expect(projected[0]?.content).toContain('— Removed from queue for editing')
    expect(projected[0]?.content).not.toContain('Will dispatch')
  })
})
