import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  applyChatUpdateDelivery,
  attachChatUpdateProducerEnvelope,
  estimateChatRecordBytes,
  type ChatUpdateAck,
  type ChatUpdateBaseline,
  type ChatUpdateDelivery
} from '../shared/chatUpdateTransport'
import {
  ChatUpdateDeliveryCoordinator,
  type ChatUpdateDeliveryStats,
  type ChatUpdateDeliveryTarget
} from './ChatUpdateDeliveryCoordinator'
import { deriveChatRecordMutationWithProjection } from './store/ChatRecordMutation'
import { ChatTranscriptMutationAuthor } from './store/ChatTranscriptMutationAuthoring'
import { ChatUpdateProjectionTracker } from './store/ChatUpdateProjectionTracker'
import type { ChatMessage, ChatRecord, EnsembleParticipant } from './store/types'
import { buildRendererAck } from './chatUpdateRendererAck.testutil'

const RENDERER_EPOCH = 'renderer-scale-gate'
const BASE_TIME = '2026-09-04T12:00:00.000Z'
const HISTORY_BODY = 'history-payload-'.repeat(24)
const HISTORY_TOOL_OUTPUT = 'historical-tool-output-'.repeat(48)
const TERMINAL_BODY = 'terminal-result-'.repeat(72)
const TERMINAL_TOOL_OUTPUT = 'terminal-tool-output-'.repeat(64)

const CHAT_SPECS = [
  { chatId: 'repo-a-chat', seatCount: 20, messageCount: 2_000 },
  { chatId: 'repo-b-chat', seatCount: 23, messageCount: 5_500 },
  { chatId: 'repo-c-chat', seatCount: 25, messageCount: 9_000 }
] as const

const PROVIDERS = ['codex', 'claude', 'kimi', 'grok', 'cursor'] as const

/** Markers a windowed delivery adds; none are declared on `ChatRecord` itself. */
interface ShellMarkers {
  messageCount?: number
  runCount?: number
  runWallMs?: number
  summaryOnly?: boolean
  transcriptPaged?: boolean
}

/**
 * Everything except the transcript and the markers that describe it. A windowed
 * delivery is ALLOWED to differ from canonical on exactly these; anything else
 * differing is a lost field.
 */
function nonTranscriptFields(chat: ChatRecord): Record<string, unknown> {
  const {
    messages: _messages,
    runs: _runs,
    messageCount: _messageCount,
    runCount: _runCount,
    runWallMs: _runWallMs,
    summaryOnly: _summaryOnly,
    transcriptPaged: _transcriptPaged,
    ...rest
  } = chat as ChatRecord & ShellMarkers
  return rest as Record<string, unknown>
}

interface ChatProducer {
  readonly spec: (typeof CHAT_SPECS)[number]
  readonly tracker: ChatUpdateProjectionTracker
  readonly completedSeats: Set<number>
  seed: ChatRecord
  current: ChatRecord
}

interface WireMetrics {
  snapshots: number
  patches: number
  snapshotBytes: number
  initialSnapshotBytes: number
  recoverySnapshots: number
  recoverySnapshotBytes: number
  patchBytes: number
  equivalentFullRecordBytes: number
}

interface PeakRetention {
  inFlight: number
  pending: number
  retainedMessages: number
  retainedBaselineBytes: number
  renderPending: number
}

interface PendingRender {
  chat: ChatRecord
  messagesChanged: boolean
  hasActiveRun: boolean
  renderReceipt: ChatUpdateAck
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function historicalMessage(chatId: string, index: number): ChatMessage {
  const message: ChatMessage = {
    id: `${chatId}-history-${index}`,
    role: index % 7 === 0 ? 'user' : 'assistant',
    content: `${chatId}:${index}:${HISTORY_BODY}`,
    timestamp: BASE_TIME
  }
  if (index % 17 === 0) {
    message.toolActivities = [
      {
        id: `${chatId}-history-tool-${index}`,
        toolName: 'run_shell_command',
        displayName: 'Run command',
        category: 'shell',
        status: 'success',
        startedAt: BASE_TIME,
        endedAt: BASE_TIME,
        parameters: { command: `inspect fixture row ${index}` },
        resultSummary: HISTORY_TOOL_OUTPUT,
        outputPreview: HISTORY_TOOL_OUTPUT
      }
    ]
  }
  return message
}

function participant(chatId: string, index: number): EnsembleParticipant {
  const provider = PROVIDERS[index % PROVIDERS.length]
  return {
    id: `${chatId}-seat-${index}`,
    provider,
    enabled: true,
    role: index === 0 ? 'Boss' : `Seat ${index + 1}`,
    instructions: 'Return one bounded terminal result.',
    order: index,
    model: `${provider}-scale-model`,
    permissionPresetId: 'read_only'
  }
}

function seedChat(spec: (typeof CHAT_SPECS)[number]): ChatRecord {
  const participants = Array.from({ length: spec.seatCount }, (_, index) =>
    participant(spec.chatId, index)
  )
  return {
    appChatId: spec.chatId,
    chatKind: 'ensemble',
    scope: 'global',
    provider: 'codex',
    title: `Scale gate ${spec.chatId}`,
    createdAt: 1,
    updatedAt: 1,
    persistenceRevision: 1,
    archived: false,
    messages: Array.from({ length: spec.messageCount }, (_, index) =>
      historicalMessage(spec.chatId, index)
    ),
    runs: participants.map((seat, index) => ({
      runId: `${spec.chatId}-run-${index}`,
      provider: seat.provider,
      status: 'running',
      startedAt: BASE_TIME,
      ensembleRoundId: `${spec.chatId}-round`,
      ensembleParticipantId: seat.id
    })),
    ensemble: {
      enabled: true,
      maxParticipants: spec.seatCount,
      fanoutPolicy: 'read_only',
      participants,
      bossmanParticipantId: participants[0]?.id,
      activeRound: {
        roundId: `${spec.chatId}-round`,
        status: 'running',
        startedAt: BASE_TIME,
        prompt: 'Complete every lane while renderer acknowledgements are delayed.',
        participants: participants.map((seat) => ({
          participantId: seat.id,
          provider: seat.provider,
          role: seat.role,
          order: seat.order,
          status: 'running',
          runId: `${spec.chatId}-run-${seat.order}`
        }))
      }
    }
  } as ChatRecord
}

function createProducer(spec: (typeof CHAT_SPECS)[number]): ChatProducer {
  const seed = seedChat(spec)
  const tracker = new ChatUpdateProjectionTracker()
  attachChatUpdateProducerEnvelope(seed, { state: tracker.seed(seed), delta: null })
  return {
    spec,
    tracker,
    completedSeats: new Set(),
    seed,
    current: seed
  }
}

function terminalMessage(producer: ChatProducer, seatIndex: number): ChatMessage {
  const seat = producer.current.ensemble!.participants[seatIndex]!
  return {
    id: `${producer.spec.chatId}-terminal-${seatIndex}`,
    role: 'assistant',
    content: `${seat.role}:${TERMINAL_BODY}`,
    timestamp: BASE_TIME,
    runId: `${producer.spec.chatId}-run-${seatIndex}`,
    toolActivities: [
      {
        id: `${producer.spec.chatId}-terminal-tool-${seatIndex}`,
        toolName: 'workspace_search',
        displayName: 'Search workspace',
        category: 'search',
        status: 'success',
        startedAt: BASE_TIME,
        endedAt: BASE_TIME,
        parameters: { query: `seat-${seatIndex}` },
        resultSummary: TERMINAL_TOOL_OUTPUT,
        outputPreview: TERMINAL_TOOL_OUTPUT
      }
    ],
    metadata: {
      kind: 'ensembleParticipant',
      ensembleRoundId: `${producer.spec.chatId}-round`,
      ensembleParticipantId: seat.id,
      ensembleProvider: seat.provider,
      ensembleRole: seat.role,
      ensembleStatus: 'answered'
    }
  }
}

function advanceProducer(
  producer: ChatProducer,
  next: ChatRecord,
  appendedMessages: ChatMessage[]
): ChatRecord {
  const before = producer.current
  const author = new ChatTranscriptMutationAuthor(before.messages.length)
  author.append(appendedMessages)
  const derived = deriveChatRecordMutationWithProjection(before, next, {
    authoredTranscript: author.finish()
  })
  const observation = producer.tracker.observe(before, next, derived)

  expect(
    observation.delta,
    `${producer.spec.chatId} must author a usable producer delta`
  ).not.toBeNull()
  expect(observation.delta?.changedMessageCount).toBe(appendedMessages.length)
  attachChatUpdateProducerEnvelope(next, observation)
  producer.current = next
  return next
}

function completeSeat(producer: ChatProducer, seatIndex: number): ChatRecord {
  const before = producer.current
  producer.completedSeats.add(seatIndex)
  const message = terminalMessage(producer, seatIndex)
  const allCompleted = producer.completedSeats.size === producer.spec.seatCount
  const next: ChatRecord = {
    ...before,
    updatedAt: before.updatedAt + 1,
    persistenceRevision: (before.persistenceRevision ?? 0) + 1,
    messages: [...before.messages, message],
    runs: before.runs.map((run, index) =>
      index === seatIndex ? { ...run, status: 'success', endedAt: BASE_TIME } : run
    ),
    ensemble: {
      ...before.ensemble!,
      updatedAt: BASE_TIME,
      activeRound: {
        ...before.ensemble!.activeRound!,
        status: allCompleted ? 'completed' : 'running',
        participants: before.ensemble!.activeRound!.participants.map((seat, index) =>
          index === seatIndex ? { ...seat, status: 'answered', endedAt: BASE_TIME } : seat
        )
      }
    }
  }
  return advanceProducer(producer, next, [message])
}

function appendCloseout(producer: ChatProducer, ordinal: number): ChatRecord {
  const before = producer.current
  const message: ChatMessage = {
    id: `${producer.spec.chatId}-closeout-${ordinal}`,
    role: 'system',
    content: `Terminal closeout ${ordinal} for ${producer.spec.chatId}.`,
    timestamp: BASE_TIME,
    metadata: { kind: 'ensembleRoundStatus', ensembleRoundId: `${producer.spec.chatId}-round` }
  }
  const next: ChatRecord = {
    ...before,
    updatedAt: before.updatedAt + 1,
    persistenceRevision: (before.persistenceRevision ?? 0) + 1,
    messages: [...before.messages, message]
  }
  return advanceProducer(producer, next, [message])
}

describe('ChatUpdateDeliveryCoordinator three-chat scale gate', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it(
    'bounds a 20/23/25-seat terminal storm while snapshot, patch, and render ACKs lag',
    { timeout: 30_000 },
    () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(BASE_TIME))

      const producers = CHAT_SPECS.map(createProducer)
      const producerByChatId = new Map<string, ChatProducer>(
        producers.map((producer) => [producer.spec.chatId, producer])
      )
      const awaitingDeliveryByChatId = new Map<string, ChatUpdateDelivery>()
      const rendererBaselines = new Map<string, ChatUpdateBaseline>()
      const pendingRenders = new Map<string, PendingRender>()
      const initialSnapshotChatIds = new Set<string>()
      const wire: WireMetrics = {
        snapshots: 0,
        patches: 0,
        snapshotBytes: 0,
        initialSnapshotBytes: 0,
        recoverySnapshots: 0,
        recoverySnapshotBytes: 0,
        patchBytes: 0,
        equivalentFullRecordBytes: 0
      }
      const peak: PeakRetention = {
        inFlight: 0,
        pending: 0,
        retainedMessages: 0,
        retainedBaselineBytes: 0,
        renderPending: 0
      }

      const target: ChatUpdateDeliveryTarget = {
        id: 77,
        isDestroyed: () => false,
        send: (_channel, payload) => {
          const delivery = structuredClone(payload as ChatUpdateDelivery)
          if (awaitingDeliveryByChatId.has(delivery.chatId)) {
            throw new Error(`More than one delivery escaped for ${delivery.chatId}`)
          }
          awaitingDeliveryByChatId.set(delivery.chatId, delivery)
          const bytes = serializedBytes(delivery)
          if (delivery.kind === 'snapshot') {
            wire.snapshots += 1
            wire.snapshotBytes += bytes
            if (initialSnapshotChatIds.has(delivery.chatId)) {
              wire.recoverySnapshots += 1
              wire.recoverySnapshotBytes += bytes
            } else {
              initialSnapshotChatIds.add(delivery.chatId)
              wire.initialSnapshotBytes += bytes
            }
          } else {
            wire.patches += 1
            wire.patchBytes += bytes
            const canonical = producerByChatId.get(delivery.chatId)?.current
            if (!canonical) throw new Error(`Missing canonical chat ${delivery.chatId}`)
            wire.equivalentFullRecordBytes += serializedBytes(canonical)
          }
        }
      }
      const coordinator = new ChatUpdateDeliveryCoordinator({
        minDeliveryIntervalMs: 0,
        ackTimeoutMs: 5_000,
        emitProtocolVersion: 2
      })

      const sampleRetention = (): ChatUpdateDeliveryStats => {
        const stats = coordinator.statsForTarget(target.id)
        peak.inFlight = Math.max(peak.inFlight, stats.inFlight)
        peak.pending = Math.max(peak.pending, stats.pending)
        peak.retainedMessages = Math.max(peak.retainedMessages, stats.retainedMessages)
        peak.retainedBaselineBytes = Math.max(
          peak.retainedBaselineBytes,
          stats.retainedBaselineBytes
        )
        peak.renderPending = Math.max(peak.renderPending, stats.renderPending)
        return stats
      }

      const acceptCurrentGeneration = (expectedKind: ChatUpdateDelivery['kind']): void => {
        const generation = CHAT_SPECS.map((spec) => {
          const delivery = awaitingDeliveryByChatId.get(spec.chatId)
          expect(delivery, `missing ${expectedKind} for ${spec.chatId}`).toBeDefined()
          expect(delivery?.kind).toBe(expectedKind)
          return [spec.chatId, delivery!] as const
        })

        for (const [chatId, delivery] of generation) {
          awaitingDeliveryByChatId.delete(chatId)
          const previous = rendererBaselines.get(chatId)
          const applied = applyChatUpdateDelivery(delivery, previous)
          expect(applied.ok, applied.ok ? undefined : applied.reason).toBe(true)
          if (!applied.ok) throw new Error(applied.reason)

          rendererBaselines.set(chatId, applied.baseline)
          const previousPendingRender = pendingRenders.get(chatId)
          pendingRenders.set(chatId, {
            chat: applied.baseline.chat,
            messagesChanged:
              previousPendingRender?.messagesChanged === true ||
              previous?.chat.messages !== applied.baseline.chat.messages,
            hasActiveRun: applied.baseline.chat.ensemble?.activeRound?.status === 'running',
            renderReceipt: buildRendererAck(delivery, applied.baseline, 'rendered', RENDERER_EPOCH)
          })
          expect(
            coordinator.acknowledge(
              target.id,
              buildRendererAck(delivery, applied.baseline, 'accepted', RENDERER_EPOCH)
            )
          ).toBe(true)
          sampleRetention()
        }
      }

      for (const producer of producers) {
        coordinator.enqueue(target, producer.seed)
        sampleRetention()
      }
      expect(awaitingDeliveryByChatId.size).toBe(CHAT_SPECS.length)
      expect(wire.snapshots).toBe(CHAT_SPECS.length)

      // Fixed coprime stride gives every chat a deterministic out-of-order lane
      // completion order while the three chats remain interleaved.
      const maxSeats = Math.max(...CHAT_SPECS.map((spec) => spec.seatCount))
      for (let step = 0; step < maxSeats; step += 1) {
        for (const producer of producers) {
          if (step >= producer.spec.seatCount) continue
          const seatIndex = (step * 7) % producer.spec.seatCount
          coordinator.enqueue(target, completeSeat(producer, seatIndex))
          sampleRetention()
        }
      }

      const beforeSnapshotAck = sampleRetention()
      expect(beforeSnapshotAck).toMatchObject({
        trackedChats: CHAT_SPECS.length,
        inFlight: CHAT_SPECS.length,
        pending: CHAT_SPECS.length
      })

      // Old behavior timed every snapshot out at 5 s. A real multi-megabyte
      // structured clone can be slow without being corrupt, so the byte-aware
      // snapshot deadline must keep these exact deliveries alive at 8 s.
      vi.advanceTimersByTime(8_000)
      const slowSnapshotState = sampleRetention()
      expect(slowSnapshotState.inFlightAgeMs).toBe(8_000)
      expect(awaitingDeliveryByChatId.size).toBe(CHAT_SPECS.length)
      expect(wire.snapshots).toBe(CHAT_SPECS.length)
      expect(coordinator.protocolCounters()).toMatchObject({
        baselineDrops: 0,
        ackRejections: 0
      })

      acceptCurrentGeneration('snapshot')
      expect(awaitingDeliveryByChatId.size).toBe(CHAT_SPECS.length)
      expect(wire.patches).toBe(CHAT_SPECS.length)

      // Terminal closeout/status saves land while each composed terminal patch
      // is still awaiting its accepted ACK. They must replace one pending slot,
      // never widen the queue or escape as full records.
      for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
        for (const producer of producers) {
          coordinator.enqueue(target, appendCloseout(producer, ordinal))
          sampleRetention()
        }
      }
      expect(sampleRetention()).toMatchObject({
        inFlight: CHAT_SPECS.length,
        pending: CHAT_SPECS.length
      })

      vi.advanceTimersByTime(4_000)
      expect(sampleRetention().inFlightAgeMs).toBe(4_000)
      acceptCurrentGeneration('patch')
      expect(awaitingDeliveryByChatId.size).toBe(CHAT_SPECS.length)
      expect(wire.patches).toBe(CHAT_SPECS.length * 2)

      // React/render receipts can lag independently. They are observational and
      // must not hold the accepted transport queue shut.
      vi.advanceTimersByTime(4_000)
      expect(sampleRetention().inFlightAgeMs).toBe(4_000)
      acceptCurrentGeneration('patch')
      expect(awaitingDeliveryByChatId.size).toBe(0)

      const counters = coordinator.protocolCounters()
      expect(counters).toMatchObject({
        snapshots: CHAT_SPECS.length,
        patches: CHAT_SPECS.length * 2,
        baselineDrops: 0,
        producerDeltaMissing: 0,
        spliceRecoveries: 0,
        staleEnqueueDrops: 0,
        ackRejections: 0,
        ackRejectReasons: {},
        // Every delivery is windowed at these sizes, and the window ANCHOR must
        // survive each round trip: one re-anchor per chat here would mean three
        // extra full snapshots, which is the defect this gate now fences.
        windowedDeliveries: CHAT_SPECS.length * 3,
        windowReanchors: 0
      })
      expect(wire.recoverySnapshots).toBe(0)
      expect(wire.recoverySnapshotBytes).toBe(0)
      expect(wire.snapshotBytes).toBe(wire.initialSnapshotBytes)

      const coldRecordBytes = producers.reduce(
        (total, producer) => total + serializedBytes(producer.seed),
        0
      )
      expect(wire.snapshotBytes).toBeLessThan(coldRecordBytes + CHAT_SPECS.length * 16_384)
      expect(wire.patchBytes).toBeLessThan(wire.equivalentFullRecordBytes * 0.1)

      const finalMessageCount = producers.reduce(
        (total, producer) => total + producer.current.messages.length,
        0
      )
      const finalRetainedEstimate = producers.reduce(
        (total, producer) => total + estimateChatRecordBytes(producer.current),
        0
      )
      expect(peak.inFlight).toBeLessThanOrEqual(CHAT_SPECS.length)
      expect(peak.pending).toBeLessThanOrEqual(CHAT_SPECS.length)
      expect(peak.retainedMessages).toBeLessThanOrEqual(finalMessageCount * 2)
      expect(peak.retainedBaselineBytes).toBeLessThanOrEqual(finalRetainedEstimate * 2)
      expect(peak.renderPending).toBeLessThanOrEqual(CHAT_SPECS.length)

      expect(rendererBaselines.size).toBe(CHAT_SPECS.length)
      expect(pendingRenders.size).toBe(CHAT_SPECS.length)
      const distinctRendererRecords = new Set([
        ...Array.from(rendererBaselines.values(), (baseline) => baseline.chat),
        ...Array.from(pendingRenders.values(), (pending) => pending.chat)
      ])
      expect(distinctRendererRecords.size).toBe(CHAT_SPECS.length)
      // Every spec here is well past the paging threshold, so what the renderer
      // reconstructs is the WINDOWED shell, not the canonical record. The claim
      // that still has to hold is that the window is an exact, gapless tail of
      // the canonical transcript and that every non-transcript field survives
      // the patch chain untouched — a window that drifted by a row, or a
      // recordDelta that quietly dropped a seat, would pass a bare length check
      // and fail this one.
      for (const producer of producers) {
        const rendered = rendererBaselines.get(producer.spec.chatId)?.chat as
          | (ChatRecord & ShellMarkers)
          | undefined
        expect(rendered, `missing renderer baseline for ${producer.spec.chatId}`).toBeDefined()
        if (!rendered) continue
        expect(rendered.transcriptPaged).toBe(true)
        expect(rendered.summaryOnly).toBe(true)
        expect(rendered.messageCount).toBe(producer.current.messages.length)
        expect(rendered.runCount).toBe(producer.current.runs.length)
        expect(rendered.messages.length).toBeGreaterThan(0)
        expect(rendered.messages.length).toBeLessThan(producer.current.messages.length)
        expect(rendered.messages).toEqual(
          producer.current.messages.slice(
            producer.current.messages.length - rendered.messages.length
          )
        )
        expect(nonTranscriptFields(rendered)).toEqual(nonTranscriptFields(producer.current))
      }

      const beforeRenderReceipt = sampleRetention()
      expect(beforeRenderReceipt).toMatchObject({
        inFlight: 0,
        pending: 0,
        renderPending: CHAT_SPECS.length
      })
      for (const [chatId, pending] of pendingRenders) {
        expect(pending.renderReceipt, `missing render receipt for ${chatId}`).toBeDefined()
        expect(coordinator.acknowledge(target.id, pending.renderReceipt)).toBe(true)
      }
      expect(coordinator.statsForTarget(target.id)).toMatchObject({
        inFlight: 0,
        pending: 0,
        renderPending: 0
      })
    }
  )
})
