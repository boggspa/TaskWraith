import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatRecord } from './store/types'
import type { ChatUpdateBaseline, ChatUpdateDelivery } from '../shared/chatUpdateTransport'

const profiles: string[] = []
afterEach(() => {
  for (const profile of profiles.splice(0)) rmSync(profile, { recursive: true, force: true })
})

it.each([false, true])(
  'keeps full delivery intact across a catalogue/paged shell (paged=%s)',
  async (paged) => {
    const profilePath = mkdtempSync(join(tmpdir(), 'taskwraith-live-wire-'))
    profiles.push(profilePath)
    vi.resetModules()
    const { configureHostStoreRuntime, resetHostStoreRuntimeForTests } =
      await import('../host-runtime/HostStoreRuntime')
    resetHostStoreRuntimeForTests()
    configureHostStoreRuntime({
      profilePath,
      secureStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (plain) => Buffer.from(plain),
        decryptString: (encrypted) => encrypted.toString()
      }
    })
    const { AppStore } = await import('./store')
    const { legacyStoreWriterGate } = await import('./store/LegacyStoreWriterGate')
    expect(legacyStoreWriterGate.beginDrain()).toBe(true)
    expect(
      legacyStoreWriterGate.markHostOwned({ hostId: 'host', generation: 1, cutoverId: 'cutover' })
    ).toBe(true)
    AppStore.setHostThreadRecordPersistPortForTests({
      persist: vi.fn(),
      enqueue: vi.fn(),
      drain: vi.fn(async () => {}),
      drainAll: vi.fn(async () => {}),
      pending: () => 0
    })
    const { ChatUpdateDeliveryCoordinator } = await import('./ChatUpdateDeliveryCoordinator')
    const { ChatUpdateInterestRouter } = await import('./ChatUpdateInterestRouter')
    const { catalogueChatListItem } = await import('./store/ThreadCatalogueMirror')
    const { projectHostCatalogueThread } = await import('../host-node/ThreadCatalogueHostMirror')
    const { applyChatUpdateDelivery } = await import('../shared/chatUpdateTransport')
    const initial: ChatRecord = {
      appChatId: 'live-wire',
      scope: 'global',
      chatKind: 'ensemble',
      provider: 'kimi',
      title: 'New Chat',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      persistenceRevision: 1,
      messages: [],
      runs: [],
      ensemble: {
        enabled: true,
        maxParticipants: 2,
        participants: [],
        activeRound: {
          roundId: 'round-1',
          status: 'running',
          prompt: 'Inspect this fixture.',
          startedAt: new Date(1000).toISOString(),
          activeParticipantId: 'seat-1',
          participants: [
            {
              participantId: 'seat-1',
              provider: 'kimi',
              role: 'Worker',
              order: 1,
              status: 'running'
            }
          ]
        }
      }
    }
    mkdirSync(join(profilePath, 'chats'), { recursive: true })
    writeFileSync(join(profilePath, 'chats', 'live-wire.json'), JSON.stringify(initial))
    const deliveries: ChatUpdateDelivery[] = []
    const sink = {
      id: 1,
      isDestroyed: () => false,
      send: (_channel: string, frame: unknown) => {
        deliveries.push(structuredClone(frame) as ChatUpdateDelivery)
      }
    }
    const coordinator = new ChatUpdateDeliveryCoordinator({ minDeliveryIntervalMs: 0 })
    const router = new ChatUpdateInterestRouter({ delivery: coordinator, store: AppStore })
    router.replaceTargetSnapshot(sink.id, {
      protocolVersion: 1,
      entries: [{ chatId: initial.appChatId, mode: 'full' }]
    })
    let baseline: ChatUpdateBaseline | undefined
    const acceptLatest = (saved: ChatRecord, label: string): void => {
      const delivery = deliveries.at(-1)!
      const applied = applyChatUpdateDelivery(delivery, baseline)
      expect(applied, `${label}, ${delivery.kind}`).toMatchObject({ ok: true })
      if (!applied.ok) throw new Error(applied.reason)
      baseline = applied.baseline
      expect(
        coordinator.acknowledge(sink.id, {
          deliveryId: delivery.deliveryId,
          deliveryEpoch: delivery.deliveryEpoch,
          phase: 'accepted',
          rendererEpoch: 'live-wire-document',
          applied: true,
          chatId: delivery.chatId,
          revision: delivery.revision,
          recordHash: baseline.recordHash,
          transcriptHash: baseline.transcriptHash
        })
      ).toBe(true)
      expect(baseline.chat.messages, label).toEqual(saved.messages)
      expect(baseline.chat.ensemble, label).toEqual(saved.ensemble)
      expect((baseline.chat as { summaryOnly?: boolean }).summaryOnly, label).not.toBe(true)
    }
    try {
      for (let step = 0; step < 30; step += 1) {
        const before = AppStore.getChat(initial.appChatId)!
        const messages = [...before.messages]
        if (step % 3 === 0) {
          messages.push({
            id: `message-${step}`,
            role: step === 0 ? 'user' : 'assistant',
            content: step === 0 ? 'Inspect this fixture.' : 'Streaming',
            timestamp: new Date(1000 + step).toISOString()
          })
        } else {
          messages[messages.length - 1] = {
            ...messages[messages.length - 1],
            content: `${messages[messages.length - 1].content} more text`
          }
        }
        const saved = AppStore.saveChat({
          ...before,
          messages,
          ensemble: {
            ...before.ensemble!,
            activeRound: {
              ...before.ensemble!.activeRound!,
              ...(step === 29
                ? { status: 'cancelled' as const, endedAt: new Date(2000).toISOString() }
                : {})
            }
          }
        })
        router.enqueue(sink, saved)
        acceptLatest(saved, `save ${step}`)
        // This is the production catalogue callback's actual payload, delivered
        // between ordinary orchestrator saves to the same open full subscriber.
        const summary = catalogueChatListItem(
          projectHostCatalogueThread(
            saved as unknown as Parameters<typeof projectHostCatalogueThread>[0]
          )
        )
        if (paged) Object.assign(summary, { transcriptPaged: true })
        expect(summary.messages).toEqual([])
        router.enqueue(sink, summary)
        acceptLatest(saved, `catalogue ${step}`)
      }
      expect(coordinator.protocolCounters().ackRejections).toBe(0)
    } finally {
      coordinator.clearTarget(sink.id)
    }
  },
  // Production store import plus fsynced writes; this is a functional replay,
  // not the programme's event-loop latency benchmark.
  30_000
)
