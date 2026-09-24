import { describe, expect, it, vi } from 'vitest'
import { ChatService, type ChatServiceStore } from '../../../main/services/ChatService'
import type { ChatMessage, ChatRecord, ChatRun } from '../../../main/store/types'
import {
  applyChatTranscriptOps,
  computeChatSubRevisions
} from '../../../shared/chatUpdateTransport'
import {
  RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION,
  chatPersistenceRevision,
  type RendererChatTranscriptMutationRequest,
  type RendererChatTranscriptMutationResult
} from '../../../shared/rendererChatTranscriptMutation'
import { preserveSettledRunSeals } from '../../../shared/threadCatalogueTerminalRuns'
import { preserveContinuityRunReceipts } from '../../../shared/threadContinuity'
import { advanceRendererRecord, type RendererRecordAdvance } from './advanceRendererRecord'
import { RendererChatTranscriptPersistence } from './RendererChatTranscriptPersistence'

function message(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, timestamp: '2026-09-08T12:00:00.000Z' }
}

function baseChat(): ChatRecord {
  return {
    appChatId: 'chat-1',
    provider: 'mistral',
    scope: 'global',
    title: 'Base title',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    pinned: false,
    persistenceRevision: 3,
    providerMetadata: { selectedModelType: 'old-model' },
    messages: [message('m1', 'Original')],
    runs: [{ runId: 'old-run', status: 'running', startedAt: '2026-09-08T10:00:00.000Z' }]
  }
}

function adoptedSettlement(base: ChatRecord): ChatRecord {
  return {
    ...structuredClone(base),
    persistenceRevision: 4,
    updatedAt: 2,
    messages: [
      ...structuredClone(base.messages),
      { ...message('settlement', 'Stale run settled'), role: 'system' }
    ],
    runs: [
      {
        ...base.runs[0],
        status: 'failed',
        endedAt: '2026-09-08T11:00:00.000Z',
        exitCode: 1,
        staleSettlementProvenance: {
          schemaVersion: 1,
          origin: 'stale-run-reconciler',
          runId: 'old-run',
          settledAt: '2026-09-08T11:00:00.000Z',
          previousStatus: 'running',
          authoredEndedAt: true,
          authoredExitCode: true
        },
        continuityCheckpointDelivery: {
          key: 'canonical-receipt',
          seatId: '__solo__',
          revision: 2,
          sourceId: 'source'
        }
      }
    ]
  }
}

interface ScenarioOptions {
  settlement?: boolean
  changeCanonical?: (chat: ChatRecord) => ChatRecord
  lateLocal?: (chat: ChatRecord) => ChatRecord
  queueSecond?: boolean
}

/**
 * Exercise actual renderer queue/rebase callbacks and the actual ChatService CAS.
 * Only the disk store is replaced: it increments the revision and applies the
 * same main-owned run guards as both AppStore.saveChat branches.
 */
async function scenario(options: ScenarioOptions = {}) {
  const base = baseChat()
  const target = { ...base, messages: [...base.messages, message('m2', 'New message')] }
  let canonical = options.settlement === false ? structuredClone(base) : adoptedSettlement(base)
  if (options.changeCanonical) canonical = options.changeCanonical(canonical)
  let current = target
  const write = vi.fn((incoming: ChatRecord) => {
    canonical = {
      ...structuredClone(incoming),
      runs: preserveContinuityRunReceipts(
        preserveSettledRunSeals(incoming.runs, canonical.runs),
        canonical.runs
      ),
      persistenceRevision: chatPersistenceRevision(canonical) + 1,
      updatedAt: canonical.updatedAt + 1
    }
    return canonical
  })
  const store = { getChat: () => canonical, saveChat: write } as unknown as ChatServiceStore
  const service = new ChatService({
    appStore: store,
    sanitizeChatForSave: (chat) => chat,
    findRegisteredWorkspace: () => undefined,
    canonicalPath: (path) => path,
    prepareForkMessages: ({ copiedMessages }) => copiedMessages,
    appendDurableRunEventForRoute: () => {}
  })
  let release!: () => void
  const firstRequest = new Promise<void>((resolve) => {
    release = resolve
  })
  const advances: Array<RendererRecordAdvance & { phase: 'recovered' | 'accepted' }> = []
  const acknowledgements: Array<{ optimistic: ChatRecord; accepted: ChatRecord }> = []
  let calls = 0
  const mutate = vi.fn(
    async (
      request: RendererChatTranscriptMutationRequest
    ): Promise<RendererChatTranscriptMutationResult> => {
      if (++calls === 1) await firstRequest
      if (request.baseRevision !== chatPersistenceRevision(canonical)) {
        return {
          version: RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION,
          accepted: false,
          chatId: base.appChatId,
          revision: chatPersistenceRevision(canonical),
          reason: 'revision-conflict',
          canonical: structuredClone(canonical)
        }
      }
      const messages = applyChatTranscriptOps(canonical.messages, request.transcriptOps)
      if (!messages) throw new Error('Test submitted invalid transcript operations')
      const saved = service.saveChat({ ...canonical, messages })
      return {
        version: RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION,
        accepted: true,
        chatId: base.appChatId,
        revision: chatPersistenceRevision(saved),
        updatedAt: saved.updatedAt,
        messageCount: saved.messages.length,
        recordHash: computeChatSubRevisions(saved).recordHash
      }
    }
  )
  const loadCanonical = vi.fn(async () => structuredClone(canonical))
  const onUnrecoverable = vi.fn((_chatId: string, record: ChatRecord | null) => {
    if (record) current = record
  })
  const persistence = new RendererChatTranscriptPersistence({
    mutate,
    loadCanonical,
    onUnrecoverable,
    // Match App.tsx: publish the helper's complete result for both callbacks.
    onRecovered(_chatId, before, next) {
      const advance = advanceRendererRecord(before, next, current)
      advances.push({ ...advance, phase: 'recovered' })
      current = advance.record
    },
    onAccepted(_chatId, _baseRevision, optimistic, _result, before, accepted) {
      const advance = advanceRendererRecord(before, optimistic, current)
      advances.push({ ...advance, phase: 'accepted' })
      acknowledgements.push({ optimistic, accepted })
      current = advance.record
    }
  })
  expect(persistence.queue(base, target)).toBe(true)
  const flushing = persistence.flush(base.appChatId)
  if (options.queueSecond) {
    const second = { ...target, messages: [...target.messages, message('m3', 'Next message')] }
    expect(persistence.queue(target, second)).toBe(true)
    current = second
  }
  if (options.lateLocal) current = options.lateLocal(current)
  release()
  await flushing
  await persistence.whenIdle(base.appChatId)
  const beforeWholeSave = structuredClone(canonical)
  const beforeWholeSaveCount = write.mock.calls.length
  const final = service.saveChat(structuredClone(current))
  return {
    current,
    canonical,
    final,
    beforeWholeSave,
    advances,
    acknowledgements,
    mutate,
    loadCanonical,
    onUnrecoverable,
    wholeSaveAccepted: write.mock.calls.length > beforeWholeSaveCount
  }
}

function expectSettlement(chat: ChatRecord): void {
  const run = chat.runs.find((candidate) => candidate.runId === 'old-run')
  expect(run).toMatchObject({
    status: 'failed',
    endedAt: '2026-09-08T11:00:00.000Z',
    staleSettlementProvenance: { runId: 'old-run', origin: 'stale-run-reconciler' },
    continuityCheckpointDelivery: { key: 'canonical-receipt', revision: 2 }
  })
  expect(chat.messages.filter((candidate) => candidate.id === 'settlement')).toHaveLength(1)
  expect(chat.messages.filter((candidate) => candidate.id === 'm2')).toHaveLength(1)
}

describe('renderer transcript persistence after canonical recovery', () => {
  it('preserves an adopted settlement through tail conflict, retry, ACK and whole-record save', async () => {
    const result = await scenario()
    expect(result.mutate).toHaveBeenCalledTimes(2)
    expect(result.mutate.mock.calls.map(([request]) => request.baseRevision)).toEqual([3, 4])
    expect(result.advances.map(({ phase }) => phase)).toEqual(['recovered', 'accepted'])
    expect(result.current.persistenceRevision).toBe(5)
    expect(result.final.persistenceRevision).toBe(6)
    expect(result.wholeSaveAccepted).toBe(true)
    expect(result.onUnrecoverable).not.toHaveBeenCalled()
    expectSettlement(result.current)
    expectSettlement(result.final)
  })

  it('preserves later local pin, title, model and new run edits while accepting canonical seals', async () => {
    const result = await scenario({
      lateLocal: (chat) => ({
        ...chat,
        pinned: true,
        title: 'Local title',
        providerMetadata: { ...chat.providerMetadata, selectedModelType: 'local-model' },
        runs: [
          ...chat.runs,
          { runId: 'new-run', status: 'running', startedAt: '2026-09-08T12:00:00.000Z' }
        ]
      })
    })
    expect(result.wholeSaveAccepted).toBe(true)
    expect(result.final).toMatchObject({
      pinned: true,
      title: 'Local title',
      providerMetadata: { selectedModelType: 'local-model' }
    })
    expect(result.final.runs.find((run) => run.runId === 'new-run')?.status).toBe('running')
    expect(result.advances.flatMap(({ conflicts }) => conflicts)).toEqual([])
    expectSettlement(result.final)
  })

  it('preserves each queued transcript descendant exactly once on conflict recovery', async () => {
    const result = await scenario({ queueSecond: true })
    expect(result.mutate).toHaveBeenCalledTimes(2)
    expect(result.final.messages.map(({ id }) => id)).toEqual(['m1', 'settlement', 'm2', 'm3'])
    expectSettlement(result.final)
  })

  it('keeps the accepted target separate from the newer queued target on a healthy ACK', async () => {
    const result = await scenario({ settlement: false, queueSecond: true })
    expect(result.mutate).toHaveBeenCalledTimes(2)
    expect(result.acknowledgements[0].accepted.messages.map(({ id }) => id)).toEqual(['m1', 'm2'])
    expect(result.acknowledgements[0].optimistic.messages.map(({ id }) => id)).toEqual([
      'm1',
      'm2',
      'm3'
    ])
    expect(result.final.messages.map(({ id }) => id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('retains a conflicting local draft without allowing the next ACK to make it current', async () => {
    const result = await scenario({
      changeCanonical: (chat) => ({ ...chat, title: 'Canonical title' }),
      lateLocal: (chat) => ({ ...chat, title: 'Conflicting draft' })
    })
    expect(result.advances.find(({ phase }) => phase === 'recovered')?.conflicts).toContain('title')
    expect(result.advances.find(({ phase }) => phase === 'accepted')?.conflicts).toContain(
      'persistenceRevision'
    )
    expect(result.current.title).toBe('Conflicting draft')
    expect(result.current.persistenceRevision).toBe(3)
    expect(result.wholeSaveAccepted).toBe(false)
    expect(result.final.title).toBe('Canonical title')
    expectSettlement(result.final)
  })

  it('does not treat a concurrent run removal as permission to drop an adopted seal', async () => {
    const result = await scenario({ lateLocal: (chat) => ({ ...chat, runs: [] }) })
    expect(result.advances.flatMap(({ conflicts }) => conflicts)).toContain('runs.old-run.status')
    expect(result.wholeSaveAccepted).toBe(false)
    expectSettlement(result.current)
    expectSettlement(result.final)
  })

  it('loads canonical on a real ACK hash mismatch and preserves a same-revision model change', async () => {
    const result = await scenario({
      settlement: false,
      changeCanonical: (chat) => ({
        ...chat,
        providerMetadata: { ...chat.providerMetadata, selectedModelType: 'canonical-model' }
      })
    })
    // The mutation was accepted, but its actual canonical non-message hash
    // differs from the renderer's optimistic record at that same revision.
    expect(result.mutate).toHaveBeenCalledTimes(1)
    expect(result.loadCanonical).toHaveBeenCalledTimes(1)
    expect(result.acknowledgements).toEqual([])
    expect(result.advances.map(({ phase }) => phase)).toEqual(['recovered'])
    expect(result.onUnrecoverable).not.toHaveBeenCalled()
    expect(result.wholeSaveAccepted).toBe(true)
    expect(result.current.providerMetadata?.selectedModelType).toBe('canonical-model')
    expect(result.final.providerMetadata?.selectedModelType).toBe('canonical-model')
    expect(result.final.messages.map(({ id }) => id)).toEqual(['m1', 'm2'])
  })

  it('refuses a tail-only request carrying non-transcript changes', () => {
    const base = baseChat()
    const persistence = new RendererChatTranscriptPersistence({
      mutate: vi.fn(),
      loadCanonical: vi.fn(),
      onAccepted: vi.fn(),
      onRecovered: vi.fn(),
      onUnrecoverable: vi.fn()
    })
    expect(
      persistence.queue(base, {
        ...base,
        pinned: true,
        messages: [...base.messages, message('m2', 'New message')]
      })
    ).toBe(false)
  })
})

describe('settled run writer backstop', () => {
  it.each(['running', 'sleeping', undefined])(
    'preserves a canonical seal against incoming %s status',
    (status) => {
      const canonical = adoptedSettlement(baseChat()).runs[0]
      const incoming: ChatRun = { ...baseChat().runs[0], status }
      expect(preserveSettledRunSeals([incoming], [canonical])).toEqual([canonical])
    }
  )

  it.each(['success', 'success_with_warnings', 'failed', 'cancelled'])(
    'allows a later terminal %s correction',
    (status) => {
      const canonical = adoptedSettlement(baseChat()).runs[0]
      const corrected: ChatRun = {
        ...canonical,
        status,
        endedAt: '2026-09-08T12:01:00.000Z',
        exitCode: status === 'failed' ? 1 : 0
      }
      expect(preserveSettledRunSeals([corrected], [canonical])).toEqual([corrected])
    }
  )

  it('keeps explicit omission/removal available to the owning writer', () => {
    expect(preserveSettledRunSeals([], adoptedSettlement(baseChat()).runs)).toEqual([])
  })
})
