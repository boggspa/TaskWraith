import type { ChatRecord } from './store/types'
import {
  CHAT_UPDATE_CHANNEL,
  CHAT_UPDATE_PROTOCOL_V1,
  CHAT_UPDATE_PROTOCOL_V2,
  buildChatUpdateDelivery,
  chatUpdateProducerEnvelopeFor,
  composeChatUpdateProducerDeltas,
  computeChatSubRevisions,
  estimateChatRecordBytes,
  type ChatUpdateAck,
  type ChatUpdateBaseline,
  type ChatUpdateDelivery,
  type ChatUpdateProducerEnvelope,
  type ChatUpdateProtocolVersion,
  type CompactChatUpdateBaseline
} from '../shared/chatUpdateTransport'

export interface ChatUpdateDeliveryTarget {
  id: number
  isDestroyed: () => boolean
  send: (channel: string, payload: unknown) => void
}

interface PendingChatUpdate {
  revision: number
  chat: ChatRecord
  producer?: ChatUpdateProducerEnvelope
  retainedBytes: number
}

interface InFlightChatUpdate extends PendingChatUpdate {
  deliveryId: string
  recordHash: string
  compactBaseline: CompactChatUpdateBaseline
}

interface TargetChatState {
  target: ChatUpdateDeliveryTarget
  chatId: string
  nextRevision: number
  /**
   * Compact ACK baseline (hash + generation). Never holds a ChatRecord —
   * that would make acknowledged + inFlight + pending three full refs.
   */
  acknowledged?: CompactChatUpdateBaseline
  /**
   * Full chat retained solely for the next patch build. Cleared after the
   * following delivery is built so idle/in-flight state never stacks a third
   * full ChatRecord beside pending.
   */
  baselineChat?: ChatRecord
  inFlight?: InFlightChatUpdate
  pending?: PendingChatUpdate
  timer?: ReturnType<typeof setTimeout>
  ackTimer?: ReturnType<typeof setTimeout>
  consecutiveRejects: number
  lastSentAt: number
  lastTouchedAt: number
}

export interface ChatUpdateDeliveryStats {
  trackedChats: number
  inFlight: number
  pending: number
  retainedMessages: number
  /** Sum of retained baseline/in-flight/pending chat byte estimates. */
  retainedBaselineBytes: number
}

/**
 * Cumulative, coordinator-wide delivery mix. Deliberately separate from
 * `ChatUpdateDeliveryStats`, which is a point-in-time retention view.
 *
 * Patching only applies while an acknowledged baseline is held; a failed apply
 * or an ACK timeout drops that baseline and forces a full snapshot next
 * delivery. Under fan-out that degradation is plausible exactly when it is
 * most expensive, and nothing counted it — so a frame-cadence triage window
 * could see main-thread cost from full-record sends with no way to attribute
 * it. Three integers make the ratio observable instead of assumed.
 */
export interface ChatUpdateProtocolCounters {
  /** Deliveries sent as a whole-record snapshot. */
  snapshots: number
  /** Deliveries sent as a compact field-mask patch. */
  patches: number
  /** Times an acknowledged baseline was dropped (nack or ACK timeout). */
  baselineDrops: number
}

export interface ChatUpdateDeliveryCoordinatorOptions {
  /** Caps deliveries per target/chat even when producers and ACKs are faster. */
  minDeliveryIntervalMs?: number
  /** Releases a delivery if an old/mismatched preload never ACKs it. */
  ackTimeoutMs?: number
  /** Bounds acknowledged baselines retained for patch generation per renderer. */
  maxTrackedChatsPerTarget?: number
  /**
   * Wire protocol for buildChatUpdateDelivery. Default remains v1; set to 2
   * (or TASKWRAITH_CHAT_UPDATE_PROTOCOL=2) to emit compact field-mask patches.
   * Apply dual-reads both versions regardless of this flag.
   */
  emitProtocolVersion?: ChatUpdateProtocolVersion
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

/** Test seam: the default-protocol decision is a shipping behaviour worth pinning. */
export function resolveEmitProtocolVersionForTest(
  requested?: ChatUpdateProtocolVersion
): ChatUpdateProtocolVersion {
  return resolveEmitProtocolVersion(requested)
}

function resolveEmitProtocolVersion(
  requested?: ChatUpdateProtocolVersion
): ChatUpdateProtocolVersion {
  if (requested === CHAT_UPDATE_PROTOCOL_V1 || requested === CHAT_UPDATE_PROTOCOL_V2) {
    return requested
  }
  const fromEnv = process.env.TASKWRAITH_CHAT_UPDATE_PROTOCOL?.trim()
  if (fromEnv === '1') return CHAT_UPDATE_PROTOCOL_V1
  if (fromEnv === '2') return CHAT_UPDATE_PROTOCOL_V2
  // Default v2. Measured 2026-08-05 on a real 26k-message / 62 MB chat with
  // the transcript open: v1 degraded 6.6 s -> 22.8 s across seven identical
  // saves while v2 held flat at ~3.4 s, and v2 opened the chat in 2.35 s vs
  // 6.75 s holding 196 MB vs 717 MB of renderer heap. Patching is fail-safe —
  // it happens only while the acknowledged baseline is held, and a failed
  // apply nacks, which drops the baseline and forces a full snapshot next
  // delivery. TASKWRAITH_CHAT_UPDATE_PROTOCOL=1 is the escape hatch.
  return CHAT_UPDATE_PROTOCOL_V2
}

/**
 * Newest persisted revision this state already knows about, in freshness
 * order: pending (newest enqueued) → in flight → the retained patch-base chat.
 * The enqueue guard keeps pending ≥ inFlight ≥ baseline, so first-defined is
 * the maximum. Undefined when nothing comparable is held.
 */
function newestKnownPersistenceRevision(state: TargetChatState): number | undefined {
  const pendingRevision = state.pending?.producer?.state.persistenceRevision
  if (pendingRevision !== undefined) return pendingRevision
  const inFlightRevision = state.inFlight?.producer?.state.persistenceRevision
  if (inFlightRevision !== undefined) return inFlightRevision
  const baselineRevision = state.baselineChat?.persistenceRevision
  return Number.isSafeInteger(baselineRevision) && (baselineRevision ?? -1) >= 0
    ? baselineRevision!
    : undefined
}

function toPatchBaseline(
  acknowledged: CompactChatUpdateBaseline,
  baselineChat: ChatRecord
): ChatUpdateBaseline {
  return {
    revision: acknowledged.revision,
    chat: baselineChat,
    ensembleRevision: acknowledged.ensembleRevision,
    runsRevision: acknowledged.runsRevision,
    recordHash: acknowledged.recordHash
  }
}

/**
 * ACK-gated, latest-wins delivery for main-owned chat projections.
 *
 * Each renderer/chat may own at most one native IPC payload in flight and one
 * replaceable pending ChatRecord. Acknowledged state is hash+generation only,
 * so a target never retains three full ChatRecord refs at once. A slow or hung
 * renderer therefore creates a fixed-size backlog instead of an unbounded queue
 * of multi-megabyte clones.
 */
export class ChatUpdateDeliveryCoordinator {
  private readonly statesByTarget = new Map<number, Map<string, TargetChatState>>()
  private readonly deliveryIndex = new Map<string, { targetId: number; chatId: string }>()
  private readonly minDeliveryIntervalMs: number
  private readonly ackTimeoutMs: number
  private readonly maxTrackedChatsPerTarget: number
  private readonly emitProtocolVersion: ChatUpdateProtocolVersion
  private readonly now: () => number
  private readonly setTimer: (
    callback: () => void,
    delayMs: number
  ) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  private deliverySequence = 0
  private readonly counters: ChatUpdateProtocolCounters = {
    snapshots: 0,
    patches: 0,
    baselineDrops: 0
  }

  constructor(options: ChatUpdateDeliveryCoordinatorOptions = {}) {
    this.minDeliveryIntervalMs = Math.max(0, options.minDeliveryIntervalMs ?? 100)
    this.ackTimeoutMs = Math.max(0, options.ackTimeoutMs ?? 5_000)
    this.maxTrackedChatsPerTarget = Math.max(2, options.maxTrackedChatsPerTarget ?? 24)
    this.emitProtocolVersion = resolveEmitProtocolVersion(options.emitProtocolVersion)
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
  }

  enqueue(target: ChatUpdateDeliveryTarget, chat: ChatRecord): void {
    if (!chat?.appChatId || target.isDestroyed()) return
    const states = this.statesByTarget.get(target.id) ?? new Map<string, TargetChatState>()
    this.statesByTarget.set(target.id, states)
    let state = states.get(chat.appChatId)
    if (!state) {
      state = {
        target,
        chatId: chat.appChatId,
        nextRevision: 0,
        consecutiveRejects: 0,
        lastSentAt: Number.NEGATIVE_INFINITY,
        lastTouchedAt: this.now()
      }
      states.set(chat.appChatId, state)
    }
    state.target = target
    state.lastTouchedAt = this.now()
    const producer = chatUpdateProducerEnvelopeFor(chat)
    // A producer that saves, awaits, then broadcasts (the delegate-wave return
    // path awaits a fleet-worktree settle between the two) can rebroadcast an
    // OLDER persisted revision after a sibling already broadcast a fresher one.
    // persistenceRevision is store-owned and strictly monotonic per chat, so
    // lower always means stale: replacing fresher queued content would regress
    // the transcript and break the producer-delta chain, degrading a multi-MB
    // chat to a snapshot pair. Envelope-less broadcasts (no revision to
    // compare) keep latest-enqueued-wins semantics.
    const incomingRevision = producer?.state.persistenceRevision
    const newestKnownRevision = newestKnownPersistenceRevision(state)
    if (
      incomingRevision !== undefined &&
      newestKnownRevision !== undefined &&
      incomingRevision < newestKnownRevision
    ) {
      if (
        state.pending?.producer?.delta &&
        producer?.delta &&
        producer.delta.persistenceRevision === state.pending.producer.delta.basePersistenceRevision
      ) {
        // The late arrival is the pending delta's missing base link: splice it
        // in FRONT so the composed chain still patches from the renderer's
        // baseline instead of falling back to a stale-content snapshot.
        const healed = composeChatUpdateProducerDeltas(
          producer.delta,
          state.pending.producer.delta
        )
        if (healed) {
          state.pending = {
            ...state.pending,
            producer: { state: state.pending.producer.state, delta: healed }
          }
        }
      }
      this.maybeSend(state)
      this.pruneTarget(target.id)
      return
    }
    state.nextRevision += 1
    const retainedBytes = producer?.state.retainedBytes ?? estimateChatRecordBytes(chat)
    if (state.pending) {
      const composedDelta =
        state.pending.producer?.delta && producer?.delta
          ? composeChatUpdateProducerDeltas(state.pending.producer.delta, producer.delta)
          : null
      state.pending = {
        revision: state.nextRevision,
        chat,
        retainedBytes,
        ...(producer ? { producer: { state: producer.state, delta: composedDelta } } : {})
      }
    } else {
      state.pending = {
        revision: state.nextRevision,
        chat,
        retainedBytes,
        ...(producer ? { producer } : {})
      }
    }
    this.maybeSend(state)
    this.pruneTarget(target.id)
  }

  acknowledge(targetId: number, ack: ChatUpdateAck): boolean {
    const indexed = this.deliveryIndex.get(ack.deliveryId)
    if (!indexed || indexed.targetId !== targetId) return false
    const states = this.statesByTarget.get(targetId)
    const state = states?.get(indexed.chatId)
    const inFlight = state?.inFlight
    if (!state || !inFlight || inFlight.deliveryId !== ack.deliveryId) return false

    this.deliveryIndex.delete(ack.deliveryId)
    if (state.ackTimer) {
      this.clearTimer(state.ackTimer)
      state.ackTimer = undefined
    }
    state.inFlight = undefined
    state.lastTouchedAt = this.now()

    const revisionMismatch = typeof ack.revision === 'number' && ack.revision !== inFlight.revision
    const hashMismatch =
      typeof ack.recordHash === 'string' &&
      ack.recordHash.length > 0 &&
      ack.recordHash !== inFlight.recordHash
    const applied = ack.applied === true && !revisionMismatch && !hashMismatch

    if (applied) {
      // Compact fingerprint only — the full chat is kept in baselineChat for
      // the next patch build, never as a third acknowledged ChatRecord ref.
      // The fingerprint and retained-byte estimate were computed when this
      // delivery was built. Recomputing them here made every successful ACK
      // scan the full transcript again on the main event loop.
      state.acknowledged = inFlight.compactBaseline
      state.baselineChat = inFlight.chat
      state.consecutiveRejects = 0
    } else {
      // Degradation: the renderer could not apply the patch (or the revision /
      // hash did not match), so the baseline is gone and the next delivery must
      // be a full snapshot. This is the transition worth counting.
      if (state.acknowledged || state.baselineChat) this.counters.baselineDrops += 1
      state.acknowledged = undefined
      state.baselineChat = undefined
      state.consecutiveRejects += 1
      // One immediate snapshot retry repairs a missing/stale renderer base.
      // If that snapshot is also rejected, wait for a future producer update
      // instead of creating a deterministic 10 Hz retry loop.
      if (state.consecutiveRejects === 1 && !state.pending) {
        state.pending = {
          revision: inFlight.revision,
          chat: inFlight.chat,
          producer: inFlight.producer,
          retainedBytes: inFlight.retainedBytes
        }
      }
    }
    this.maybeSend(state)
    this.pruneTarget(targetId)
    return true
  }

  clearTarget(targetId: number): void {
    const states = this.statesByTarget.get(targetId)
    if (!states) return
    for (const state of states.values()) this.disposeState(state)
    this.statesByTarget.delete(targetId)
  }

  /** Cumulative delivery mix for the whole coordinator. Cheap enough to read
   *  on every sample; a triage window diffs two reads. */
  protocolCounters(): ChatUpdateProtocolCounters {
    return { ...this.counters }
  }

  statsForTarget(targetId: number): ChatUpdateDeliveryStats {
    const states = this.statesByTarget.get(targetId)
    if (!states) {
      return {
        trackedChats: 0,
        inFlight: 0,
        pending: 0,
        retainedMessages: 0,
        retainedBaselineBytes: 0
      }
    }
    let inFlight = 0
    let pending = 0
    let retainedMessages = 0
    let retainedBaselineBytes = 0
    for (const state of states.values()) {
      if (state.inFlight) {
        inFlight += 1
        retainedMessages += state.inFlight.chat.messages.length
        retainedBaselineBytes += state.inFlight.compactBaseline.retainedBytes
      }
      if (state.pending) {
        pending += 1
        retainedMessages += state.pending.chat.messages.length
        retainedBaselineBytes += state.pending.retainedBytes
      }
      if (state.baselineChat) {
        retainedMessages += state.baselineChat.messages.length
        retainedBaselineBytes += state.acknowledged?.retainedBytes ?? 0
      } else if (state.acknowledged) {
        // Compact fingerprint only — charge a small constant, not the prior
        // full-chat estimate (that chat is no longer retained on main).
        retainedBaselineBytes += 64
      }
    }
    return {
      trackedChats: states.size,
      inFlight,
      pending,
      retainedMessages,
      retainedBaselineBytes
    }
  }

  private maybeSend(state: TargetChatState): void {
    if (state.inFlight || !state.pending || state.timer) return
    if (state.target.isDestroyed()) {
      this.clearTarget(state.target.id)
      return
    }
    const elapsed = this.now() - state.lastSentAt
    const delay = Math.max(0, this.minDeliveryIntervalMs - elapsed)
    if (delay > 0) {
      state.timer = this.setTimer(() => {
        state.timer = undefined
        this.maybeSend(state)
      }, delay)
      return
    }

    const next = state.pending
    state.pending = undefined
    const deliveryId = `chat-update-${++this.deliverySequence}`
    // Patch only when we still hold the baseline chat. Compact acknowledged
    // alone forces a snapshot — that is the byte-aware miss path (one retry).
    const baseline: ChatUpdateBaseline | undefined =
      state.acknowledged && state.baselineChat
        ? toPatchBaseline(state.acknowledged, state.baselineChat)
        : undefined
    const delivery: ChatUpdateDelivery = buildChatUpdateDelivery({
      deliveryId,
      revision: next.revision,
      chat: next.chat,
      baseline,
      producerState: next.producer?.state,
      producerDelta: next.producer?.delta ?? undefined,
      protocolVersion: this.emitProtocolVersion
    })
    const deliveryRecordHash = 'recordHash' in delivery ? delivery.recordHash : undefined
    const deliveryEnsembleRevision =
      'ensembleRevision' in delivery ? delivery.ensembleRevision : undefined
    const deliveryRunsRevision = 'runsRevision' in delivery ? delivery.runsRevision : undefined
    const fallbackSubRevisions =
      delivery.protocolVersion === CHAT_UPDATE_PROTOCOL_V1 ||
      deliveryRecordHash === undefined ||
      deliveryEnsembleRevision === undefined ||
      deliveryRunsRevision === undefined
        ? computeChatSubRevisions(next.chat)
        : undefined
    const recordHash = deliveryRecordHash ?? fallbackSubRevisions!.recordHash
    const compactBaseline: CompactChatUpdateBaseline = {
      revision: next.revision,
      recordHash,
      ensembleRevision: deliveryEnsembleRevision ?? fallbackSubRevisions!.ensembleRevision,
      runsRevision: deliveryRunsRevision ?? fallbackSubRevisions!.runsRevision,
      retainedBytes: next.retainedBytes
    }
    if (delivery.kind === 'snapshot') this.counters.snapshots += 1
    else this.counters.patches += 1
    state.inFlight = { ...next, deliveryId, recordHash, compactBaseline }
    // Drop the patch-base chat once the next full payload is in flight so we
    // never retain acknowledged+baselineChat+inFlight+pending as three+ fulls.
    state.baselineChat = undefined
    state.lastSentAt = this.now()
    state.lastTouchedAt = state.lastSentAt
    this.deliveryIndex.set(deliveryId, { targetId: state.target.id, chatId: state.chatId })
    try {
      state.target.send(CHAT_UPDATE_CHANNEL, delivery)
      if (this.ackTimeoutMs > 0) {
        state.ackTimer = this.setTimer(() => {
          state.ackTimer = undefined
          if (state.inFlight?.deliveryId !== deliveryId) return
          this.deliveryIndex.delete(deliveryId)
          state.inFlight = undefined
          // A renderer that cannot ACK cannot share a revision baseline. The
          // newest pending update will therefore repair itself as a snapshot.
          if (state.acknowledged || state.baselineChat) this.counters.baselineDrops += 1
          state.acknowledged = undefined
          state.baselineChat = undefined
          state.lastTouchedAt = this.now()
          this.maybeSend(state)
          this.pruneTarget(state.target.id)
        }, this.ackTimeoutMs)
        ;(state.ackTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
      }
    } catch {
      this.clearTarget(state.target.id)
    }
  }

  private pruneTarget(targetId: number): void {
    const states = this.statesByTarget.get(targetId)
    if (!states || states.size <= this.maxTrackedChatsPerTarget) return
    const idle = [...states.values()]
      .filter((state) => !state.inFlight && !state.pending && !state.timer)
      .sort((a, b) => a.lastTouchedAt - b.lastTouchedAt)
    while (states.size > this.maxTrackedChatsPerTarget && idle.length > 0) {
      const state = idle.shift()
      if (!state) break
      this.disposeState(state)
      states.delete(state.chatId)
    }
  }

  private disposeState(state: TargetChatState): void {
    if (state.timer) this.clearTimer(state.timer)
    if (state.ackTimer) this.clearTimer(state.ackTimer)
    if (state.inFlight) this.deliveryIndex.delete(state.inFlight.deliveryId)
    state.baselineChat = undefined
    state.acknowledged = undefined
  }
}
