import type { ChatRecord } from './store/types'
import {
  CHAT_UPDATE_CHANNEL,
  CHAT_UPDATE_PROTOCOL_V1,
  CHAT_UPDATE_PROTOCOL_V2,
  buildChatUpdateDelivery,
  chatUpdateProducerEnvelopeFor,
  type ChatUpdateDeliveryDiagnostics,
  composeChatUpdateProducerDeltas,
  projectChatUpdateWindow,
  computeChatSubRevisions,
  estimateChatRecordBytes,
  isWindowedChatUpdateRecord,
  type ChatUpdateAck,
  type ChatUpdateBaseline,
  type ChatUpdateDelivery,
  type ChatUpdateProducerEnvelope,
  type ChatUpdateProtocolVersion,
  type CompactChatUpdateBaseline,
  type ChatUpdateRevisionInputBytes,
  utf8ByteLength
} from '../shared/chatUpdateTransport'
import {
  estimateChatUpdateSnapshotBytes,
  resolveChatUpdateAckTimeoutMs,
  resolveSnapshotRetryDelayMs
} from './ChatUpdateSnapshotAckPolicy'

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
  priority: ChatUpdateDeliveryPriority
}

interface InFlightChatUpdate extends PendingChatUpdate {
  deliveryId: string
  deliveryEpoch: number
  recordHash: string
  compactBaseline: CompactChatUpdateBaseline
  /**
   * The record the RENDERER will hold once this lands — the bounded shell for
   * an oversized chat, the canonical record otherwise.
   *
   * Distinct from `chat`, which stays canonical for the retry path. Retaining
   * the canonical record as the patch base while hashing the delivered shell is
   * the exact defect this field closes: the two can never hash equal, so every
   * later delivery to a large thread dropped its baseline and re-sent the whole
   * record.
   */
  deliveredChat: ChatRecord
  /**
   * First row of the transcript window in `deliveredChat`, or null when the
   * record was not windowed. Promoted to the target's anchor on ACK, never
   * before: an anchor adopted at send time would describe a window the renderer
   * may never receive, and every later patch would diff from a fiction.
   */
  windowAnchorMessageId: string | null
}

type ChatUpdateDeliveryPriority = 'normal' | 'urgent'

interface AcceptedChatUpdateReceipt {
  deliveryId: string
  deliveryEpoch: number
  revision: number
  acceptedAtMs: number
  rendererEpoch?: string
  recordHash: string
  transcriptHash?: string
  renderedAtMs?: number
}

interface TargetChatState {
  target: ChatUpdateDeliveryTarget
  chatId: string
  /** Incremented whenever this WebContents reloads or is discarded. */
  deliveryEpoch: number
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
  /**
   * Anchor of the window this target has ACKNOWLEDGED. Held alongside
   * `acknowledged` rather than on `baselineChat`, which is dropped for memory
   * as soon as the next payload is in flight — the anchor is a short string and
   * losing it would silently re-anchor (and so re-snapshot) every delivery.
   */
  windowAnchorMessageId?: string | null
  /**
   * Persistence revision of the ACKNOWLEDGED generation, captured as a scalar.
   *
   * It must NOT be read back off `baselineChat`: that is the store's live cache
   * entry, and `AppStore.saveChat` writes the new revision into its caller's
   * record in place. A `getChat()`-then-save that is never broadcast therefore
   * advanced this watermark to a generation no delivery ever carried, and every
   * later broadcast at or below it was silently discarded by the staleness
   * guard in `enqueue` — a frozen transcript with perfectly healthy counters.
   * Outlives `baselineChat`, which is dropped for memory once the next payload
   * is in flight; cleared with `acknowledged`, whose generation it describes.
   */
  baselineRevision?: number
  inFlight?: InFlightChatUpdate
  pending?: PendingChatUpdate
  timer?: ReturnType<typeof setTimeout>
  ackTimer?: ReturnType<typeof setTimeout>
  consecutiveRejects: number
  /** Consecutive full snapshots that exhausted their size-aware ACK window. */
  consecutiveSnapshotTimeouts: number
  /** Earliest time another snapshot recovery may be sent for this chat. */
  snapshotRetryNotBefore: number
  lastSentAt: number
  lastTouchedAt: number
  /** Latest accepted receipt; render receipts are telemetry and never gate send. */
  lastAccepted?: AcceptedChatUpdateReceipt
  /** Bound to the renderer document that successfully accepted the baseline. */
  rendererEpoch?: string
}

export interface ChatUpdateDeliveryStats {
  trackedChats: number
  inFlight: number
  pending: number
  retainedMessages: number
  /** Sum of retained baseline/in-flight/pending chat byte estimates. */
  retainedBaselineBytes: number
  /** Oldest in-flight delivery age in ms. 0 when nothing is in flight. */
  inFlightAgeMs: number
  /** Accepted deliveries awaiting a non-gating React render receipt. */
  renderPending: number
  /** Age of the oldest non-rendered accepted receipt. 0 when none are pending. */
  renderReceiptAgeMs: number
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
  /**
   * Deliveries where a baseline was held but the producer had no usable delta.
   *
   * This is the cause the other counters cannot see. It used to present as a
   * snapshot flood (2026-08-19: 531 snapshots, 0 patches in 17 minutes, ending
   * in a renderer OOM); those deliveries now recover as bounded patches, so
   * without this counter a broken producer reads as a healthy patch stream.
   */
  producerDeltaMissing: number
  /** Deliveries the transport recovered by diffing the baseline. */
  spliceRecoveries: number
  /**
   * Deliveries built against a bounded transcript window rather than the whole
   * transcript. Expected and healthy on a large thread; the number to read
   * beside it is `snapshots`, which should now stay near one per chat instead
   * of one per delivery.
   */
  windowedDeliveries: number
  /**
   * Windowed deliveries that could NOT extend the target's acknowledged window
   * and therefore cost a fresh snapshot — the anchor row had been compacted
   * away, or the window had grown past `MAX_WINDOWED_TRANSCRIPT_GROWTH_ROWS`.
   * A handful per long thread is the design working; one per delivery means the
   * anchor is not surviving the round trip and patching is off.
   */
  windowReanchors: number
  /**
   * Broadcasts discarded by the enqueue staleness guard (incoming
   * persistenceRevision older than the newest known). Each drop is a stream
   * frame the renderer will never see from this path; sustained increments
   * during an active run present as a frozen transcript with healthy
   * delivery counters.
   */
  staleEnqueueDrops: number
  /** Total accepted deliveries whose ACK was rejected (applied=false). */
  ackRejections: number
  /** Rejected ACKs tallied by each failing validation check. */
  ackRejectReasons: Record<string, number>
  /** Present only when serialized-byte diagnostics were explicitly enabled. */
  serializedBytes?: ChatUpdateSerializedByteTotals
}

/**
 * Cumulative serialized-byte samples for a coordinator.
 *
 * `ensemble`, `runs`, and `nonMessageRecord` are the exact sub-revision
 * inputs. They are not three transcripts. `envelope` is the serialized IPC
 * delivery, `messages` is the canonical message-list input, and `peak` is the
 * largest single delivery envelope observed in this measurement window.
 */
export interface ChatUpdateSerializedByteTotals {
  envelope: number
  peak: number
  ensemble: number
  runs: number
  nonMessageRecord: number
  messages: number
}

export interface ChatUpdateDeliveryCoordinatorOptions {
  /** Caps deliveries per target/chat even when producers and ACKs are faster. */
  minDeliveryIntervalMs?: number
  /** Releases a delivery if an old/mismatched preload never ACKs it. */
  ackTimeoutMs?: number
  /** Bounds acknowledged baselines retained for patch generation per renderer. */
  maxTrackedChatsPerTarget?: number
  /**
   * Opt-in diagnostic only. When enabled, records serialized delivery/input
   * byte totals; when unset it performs no diagnostic serialization or byte
   * walk.
   */
  measureSerializedBytes?: boolean
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
  return state.baselineRevision
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
    recordHash: acknowledged.recordHash,
    transcriptHash: acknowledged.transcriptHash,
    transcriptIdsUnique: acknowledged.transcriptIdsUnique
  }
}

/**
 * AppStore stamps the server-owned persistence revision back onto its caller,
 * and that caller may be the exact object retained here as the renderer's
 * baseline. Normalize that one known scalar mutation before comparing hashes.
 * Any other drift means main no longer holds the record the renderer ACKed, so
 * diffing from it would omit fields and provoke a recordHashMismatch NACK.
 */
function retainedBaselineMatchesAcknowledged(
  acknowledged: CompactChatUpdateBaseline,
  baselineChat: ChatRecord,
  baselineRevision: number | undefined
): boolean {
  const comparable =
    baselineRevision !== undefined && baselineChat.persistenceRevision !== baselineRevision
      ? { ...baselineChat, persistenceRevision: baselineRevision }
      : baselineChat
  return computeChatSubRevisions(comparable).recordHash === acknowledged.recordHash
}

function priorityForChatUpdate(chat: ChatRecord): ChatUpdateDeliveryPriority {
  const roundStatus = chat.ensemble?.activeRound?.status
  if (roundStatus === 'completed' || roundStatus === 'failed' || roundStatus === 'cancelled') {
    return 'urgent'
  }
  const latestRun = chat.runs[chat.runs.length - 1]
  const runStatus = latestRun?.status
  return runStatus === 'success' ||
    runStatus === 'success_with_warnings' ||
    runStatus === 'completed' ||
    runStatus === 'failed' ||
    runStatus === 'cancelled'
    ? 'urgent'
    : 'normal'
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
/**
 * Adopt the record an ACK just confirmed, together with the window anchor that
 * DESCRIBES it.
 *
 * They are one fact — "this is what the renderer holds" — and are assigned in
 * one place so they cannot drift apart. In particular the anchor is never taken
 * at send time: a delivery the renderer did not confirm was never held, and an
 * anchor read off it would name a window that exists only on main, so every
 * later patch would splice onto rows the renderer never received.
 */
function adoptDeliveredRecord(state: TargetChatState, inFlight: InFlightChatUpdate): void {
  state.baselineChat = inFlight.deliveredChat
  state.windowAnchorMessageId = inFlight.windowAnchorMessageId
}

export class ChatUpdateDeliveryCoordinator {
  private readonly statesByTarget = new Map<number, Map<string, TargetChatState>>()
  private readonly deliveryIndex = new Map<string, { targetId: number; chatId: string }>()
  /** Persists across clearTarget so an old renderer document cannot ACK a new one. */
  private readonly deliveryEpochByTarget = new Map<number, number>()
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
  private readonly serializedBytes?: ChatUpdateSerializedByteTotals
  private deliverySequence = 0
  private readonly counters: ChatUpdateProtocolCounters = {
    snapshots: 0,
    patches: 0,
    baselineDrops: 0,
    producerDeltaMissing: 0,
    spliceRecoveries: 0,
    windowedDeliveries: 0,
    windowReanchors: 0,
    staleEnqueueDrops: 0,
    ackRejections: 0,
    ackRejectReasons: {}
  }

  constructor(options: ChatUpdateDeliveryCoordinatorOptions = {}) {
    this.minDeliveryIntervalMs = Math.max(0, options.minDeliveryIntervalMs ?? 100)
    this.ackTimeoutMs = Math.max(0, options.ackTimeoutMs ?? 5_000)
    this.maxTrackedChatsPerTarget = Math.max(2, options.maxTrackedChatsPerTarget ?? 24)
    this.emitProtocolVersion = resolveEmitProtocolVersion(options.emitProtocolVersion)
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
    this.serializedBytes = options.measureSerializedBytes
      ? { envelope: 0, peak: 0, ensemble: 0, runs: 0, nonMessageRecord: 0, messages: 0 }
      : undefined
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
        deliveryEpoch: this.deliveryEpochForTarget(target.id),
        nextRevision: 0,
        consecutiveRejects: 0,
        consecutiveSnapshotTimeouts: 0,
        snapshotRetryNotBefore: Number.NEGATIVE_INFINITY,
        lastSentAt: Number.NEGATIVE_INFINITY,
        lastTouchedAt: this.now()
      }
      states.set(chat.appChatId, state)
    }
    state.target = target
    state.lastTouchedAt = this.now()
    const priority = priorityForChatUpdate(chat)
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
        const healed = composeChatUpdateProducerDeltas(producer.delta, state.pending.producer.delta)
        if (healed) {
          state.pending = {
            ...state.pending,
            producer: { state: state.pending.producer.state, delta: healed }
          }
        }
      }
      // Observable staleness drop: this stream frame is discarded and the
      // renderer will never receive it via enqueue. Sustained increments
      // during a live run are the "frozen transcript, healthy counters"
      // signature — see staleEnqueueDrops on ChatUpdateProtocolCounters.
      this.counters.staleEnqueueDrops += 1
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
        priority:
          state.pending.priority === 'urgent' || priority === 'urgent' ? 'urgent' : priority,
        ...(producer ? { producer: { state: producer.state, delta: composedDelta } } : {})
      }
    } else {
      state.pending = {
        revision: state.nextRevision,
        chat,
        retainedBytes,
        priority,
        ...(producer ? { producer } : {})
      }
    }
    // A normal cadence timer may already be armed when a terminal/error update
    // arrives. Cancel it so urgency takes effect immediately once the current
    // one-slot in-flight boundary permits a send.
    if (state.pending.priority === 'urgent' && state.timer) {
      this.clearTimer(state.timer)
      state.timer = undefined
    }
    this.maybeSend(state)
    this.pruneTarget(target.id)
  }

  /**
   * Advance an idle target's acknowledged baseline after that renderer authored
   * and accepted a compact transcript mutation through invoke/reply. No
   * chat-updated payload is needed; a busy or mismatched lane returns false so
   * the caller can enqueue the ordinary recovery delivery instead.
   */
  adoptRendererMutation(
    targetId: number,
    chat: ChatRecord,
    basePersistenceRevision: number
  ): boolean {
    const states = this.statesByTarget.get(targetId)
    const state = states?.get(chat.appChatId)
    // No transport state means the next main-authored update will seed one
    // snapshot. The renderer already owns this mutation, so there is no echo.
    if (!state) return true
    if (
      state.inFlight ||
      state.pending ||
      !state.acknowledged ||
      !state.baselineChat ||
      // This target holds a bounded WINDOW, and `chat` here is the canonical
      // record. Adopting it would swap the retained base from a page to a whole
      // transcript behind the renderer's back, and the next patch would be
      // diffed against a record it never received. Before bounded shells could
      // hash-match at all this was unreachable; it is reachable now, so it is
      // refused explicitly and the caller sends the ordinary recovery delivery.
      isWindowedChatUpdateRecord(state.baselineChat) ||
      state.baselineRevision !== basePersistenceRevision ||
      !retainedBaselineMatchesAcknowledged(
        state.acknowledged,
        state.baselineChat,
        state.baselineRevision
      )
    ) {
      return false
    }

    const contentSub = computeChatSubRevisions(chat)
    const producer = chatUpdateProducerEnvelopeFor(chat)
    const persistenceRevision = producer?.state.persistenceRevision ?? chat.persistenceRevision
    state.baselineChat = chat
    state.baselineRevision =
      Number.isSafeInteger(persistenceRevision) && (persistenceRevision ?? -1) >= 0
        ? persistenceRevision
        : undefined
    state.acknowledged = {
      ...state.acknowledged,
      recordHash: contentSub.recordHash,
      ensembleRevision: contentSub.ensembleRevision,
      runsRevision: contentSub.runsRevision,
      retainedBytes: producer?.state.retainedBytes ?? estimateChatRecordBytes(chat),
      ...(producer?.state.transcriptHash ? { transcriptHash: producer.state.transcriptHash } : {})
    }
    if (state.lastAccepted) {
      state.lastAccepted = {
        ...state.lastAccepted,
        recordHash: contentSub.recordHash,
        ...(producer?.state.transcriptHash ? { transcriptHash: producer.state.transcriptHash } : {})
      }
    }
    state.lastTouchedAt = this.now()
    return true
  }

  acknowledge(targetId: number, ack: ChatUpdateAck): boolean {
    if (ack.phase === 'rendered') return this.acknowledgeRendered(targetId, ack)
    const indexed = this.deliveryIndex.get(ack.deliveryId)
    if (!indexed) return this.acknowledgeDuplicateAccepted(targetId, ack)
    if (indexed.targetId !== targetId) return false
    const states = this.statesByTarget.get(targetId)
    const state = states?.get(indexed.chatId)
    const inFlight = state?.inFlight
    if (!state || !inFlight || inFlight.deliveryId !== ack.deliveryId) return false

    const now = this.now()
    const revisionMismatch = typeof ack.revision === 'number' && ack.revision !== inFlight.revision
    const recordHashMismatch =
      typeof ack.recordHash === 'string' &&
      ack.recordHash.length > 0 &&
      ack.recordHash !== inFlight.recordHash
    const transcriptHashMismatch =
      typeof ack.transcriptHash === 'string' &&
      ack.transcriptHash.length > 0 &&
      ack.transcriptHash !== inFlight.compactBaseline.transcriptHash
    const deliveryEpochMismatch =
      ack.deliveryEpoch !== undefined && ack.deliveryEpoch !== inFlight.deliveryEpoch
    const rendererEpochMismatch =
      Boolean(state.rendererEpoch) &&
      Boolean(ack.rendererEpoch) &&
      state.rendererEpoch !== ack.rendererEpoch

    this.deliveryIndex.delete(ack.deliveryId)
    if (state.ackTimer) {
      this.clearTimer(state.ackTimer)
      state.ackTimer = undefined
    }
    state.inFlight = undefined
    state.lastTouchedAt = now
    const applied =
      ack.applied === true &&
      !revisionMismatch &&
      !recordHashMismatch &&
      !transcriptHashMismatch &&
      !deliveryEpochMismatch &&
      !rendererEpochMismatch

    if (applied) {
      // Compact fingerprint only — the full chat is kept in baselineChat for
      // the next patch build, never as a third acknowledged ChatRecord ref.
      // The fingerprint and retained-byte estimate were computed when this
      // delivery was built. Recomputing them here made every successful ACK
      // scan the full transcript again on the main event loop.
      state.acknowledged = inFlight.compactBaseline
      adoptDeliveredRecord(state, inFlight)
      // Scalar copy, taken now. See TargetChatState.baselineRevision.
      const ackedRevision =
        inFlight.producer?.state.persistenceRevision ?? inFlight.chat.persistenceRevision
      state.baselineRevision =
        Number.isSafeInteger(ackedRevision) && (ackedRevision ?? -1) >= 0
          ? ackedRevision
          : undefined
      if (ack.rendererEpoch) state.rendererEpoch = ack.rendererEpoch
      state.lastAccepted = {
        deliveryId: inFlight.deliveryId,
        deliveryEpoch: inFlight.deliveryEpoch,
        revision: inFlight.revision,
        acceptedAtMs: now,
        recordHash: inFlight.recordHash,
        ...(ack.rendererEpoch ? { rendererEpoch: ack.rendererEpoch } : {}),
        ...(inFlight.compactBaseline.transcriptHash
          ? { transcriptHash: inFlight.compactBaseline.transcriptHash }
          : {})
      }
      state.consecutiveRejects = 0
      state.consecutiveSnapshotTimeouts = 0
      state.snapshotRetryNotBefore = Number.NEGATIVE_INFINITY
    } else {
      // Degradation: the renderer could not apply the patch (or the revision /
      // hash did not match), so the baseline is gone and the next delivery must
      // be a full snapshot. This is the transition worth counting.
      if (state.acknowledged || state.baselineChat) this.counters.baselineDrops += 1
      this.countAckRejection(ack, {
        revisionMismatch,
        recordHashMismatch,
        transcriptHashMismatch,
        deliveryEpochMismatch,
        rendererEpochMismatch
      })
      state.acknowledged = undefined
      state.baselineChat = undefined
      state.baselineRevision = undefined
      state.lastAccepted = undefined
      // A changed renderer document must begin from a snapshot, but retain
      // its epoch so that snapshot's ACK becomes the new trusted baseline.
      if (rendererEpochMismatch && ack.rendererEpoch) state.rendererEpoch = ack.rendererEpoch
      state.consecutiveRejects += 1
      // One immediate snapshot retry repairs a missing/stale renderer base.
      // If that snapshot is also rejected, wait for a future producer update
      // instead of creating a deterministic 10 Hz retry loop.
      if (state.consecutiveRejects === 1 && !state.pending) {
        state.pending = {
          revision: inFlight.revision,
          chat: inFlight.chat,
          producer: inFlight.producer,
          retainedBytes: inFlight.retainedBytes,
          priority: inFlight.priority
        }
      }
    }
    this.maybeSend(state)
    this.pruneTarget(targetId)
    return true
  }

  clearTarget(targetId: number): void {
    this.deliveryEpochByTarget.set(targetId, this.deliveryEpochForTarget(targetId) + 1)
    const states = this.statesByTarget.get(targetId)
    if (!states) return
    for (const state of states.values()) this.disposeState(state)
    this.statesByTarget.delete(targetId)
  }

  /**
   * Release one target/chat transport lane when that renderer drops full-record
   * interest. Any late ACK is ignored because disposeState removes its delivery
   * id from the global index; other chats in the renderer keep their baselines.
   */
  clearChat(targetId: number, chatId: string): boolean {
    if (!chatId) return false
    const states = this.statesByTarget.get(targetId)
    const state = states?.get(chatId)
    if (!states || !state) return false
    this.disposeState(state)
    states.delete(chatId)
    if (states.size === 0) this.statesByTarget.delete(targetId)
    return true
  }

  /** Release a deleted chat's retained snapshots from every renderer target. */
  clearChatEverywhere(chatId: string): number {
    if (!chatId) return 0
    let cleared = 0
    for (const targetId of [...this.statesByTarget.keys()]) {
      if (this.clearChat(targetId, chatId)) cleared += 1
    }
    return cleared
  }

  /**
   * Drop one chat's optimistic revision history and send its canonical record
   * as an urgent snapshot. Used when Host CAS recovery reanchors persistence
   * below revisions main had already projected optimistically.
   */
  reseed(target: ChatUpdateDeliveryTarget, chat: ChatRecord): void {
    if (!chat?.appChatId || target.isDestroyed()) return
    const states = this.statesByTarget.get(target.id)
    const previous = states?.get(chat.appChatId)
    if (previous) {
      if (previous.acknowledged || previous.baselineChat || previous.inFlight) {
        this.counters.baselineDrops += 1
      }
      this.disposeState(previous)
      states?.delete(chat.appChatId)
    }
    this.enqueue(target, chat)
    const state = this.statesByTarget.get(target.id)?.get(chat.appChatId)
    if (!state?.pending) return
    state.pending.priority = 'urgent'
    if (state.timer) {
      this.clearTimer(state.timer)
      state.timer = undefined
    }
    this.maybeSend(state)
  }

  private acknowledgeRendered(targetId: number, ack: ChatUpdateAck): boolean {
    if (!ack.applied || !ack.chatId) return false
    const state = this.statesByTarget.get(targetId)?.get(ack.chatId)
    const accepted = state?.lastAccepted
    if (!state || !accepted || accepted.deliveryId !== ack.deliveryId) return false
    if (ack.deliveryEpoch !== undefined && ack.deliveryEpoch !== accepted.deliveryEpoch) {
      return false
    }
    if (ack.revision !== undefined && ack.revision !== accepted.revision) return false
    if (
      accepted.rendererEpoch &&
      ack.rendererEpoch &&
      accepted.rendererEpoch !== ack.rendererEpoch
    ) {
      return false
    }
    if (ack.recordHash && ack.recordHash !== accepted.recordHash) {
      return false
    }
    if (
      accepted.transcriptHash &&
      ack.transcriptHash &&
      accepted.transcriptHash !== ack.transcriptHash
    ) {
      return false
    }
    accepted.renderedAtMs = this.now()
    state.lastTouchedAt = accepted.renderedAtMs
    return true
  }

  /** A same-document duplicate accepted ACK is harmless and should be idempotent. */
  private acknowledgeDuplicateAccepted(targetId: number, ack: ChatUpdateAck): boolean {
    if (!ack.applied || !ack.chatId) return false
    const accepted = this.statesByTarget.get(targetId)?.get(ack.chatId)?.lastAccepted
    if (!accepted || accepted.deliveryId !== ack.deliveryId) return false
    if (ack.deliveryEpoch !== undefined && ack.deliveryEpoch !== accepted.deliveryEpoch) {
      return false
    }
    if (ack.revision !== undefined && ack.revision !== accepted.revision) return false
    if (
      accepted.rendererEpoch &&
      ack.rendererEpoch &&
      accepted.rendererEpoch !== ack.rendererEpoch
    ) {
      return false
    }
    if (ack.recordHash && ack.recordHash !== accepted.recordHash) return false
    if (
      accepted.transcriptHash &&
      ack.transcriptHash &&
      accepted.transcriptHash !== ack.transcriptHash
    ) {
      return false
    }
    return true
  }

  /** Cumulative delivery mix for the whole coordinator. Cheap enough to read
   *  on every sample; a triage window diffs two reads. */
  protocolCounters(): ChatUpdateProtocolCounters {
    return {
      ...this.counters,
      // Copy the reason map so callers cannot mutate internal tallies.
      ackRejectReasons: { ...this.counters.ackRejectReasons },
      ...(this.serializedBytes ? { serializedBytes: { ...this.serializedBytes } } : {})
    }
  }

  /**
   * Tally one rejected ACK under every failing validation check (an ACK can
   * mismatch on more than one axis). A rejection where the renderer itself
   * reported `applied: false` with no main-side mismatch is recorded as
   * 'rendererApplyFailure' — the patch failed to apply in the renderer.
   * Persistent single-reason counts during a live run point at the exact
   * broken link (epoch rebinding, hash drift, revision skew).
   */
  private countAckRejection(
    ack: ChatUpdateAck,
    mismatches: {
      revisionMismatch: boolean
      recordHashMismatch: boolean
      transcriptHashMismatch: boolean
      deliveryEpochMismatch: boolean
      rendererEpochMismatch: boolean
    }
  ): void {
    this.counters.ackRejections += 1
    const reasons: string[] = []
    if (mismatches.revisionMismatch) reasons.push('revisionMismatch')
    if (mismatches.recordHashMismatch) reasons.push('recordHashMismatch')
    if (mismatches.transcriptHashMismatch) reasons.push('transcriptHashMismatch')
    if (mismatches.deliveryEpochMismatch) reasons.push('deliveryEpochMismatch')
    if (mismatches.rendererEpochMismatch) reasons.push('rendererEpochMismatch')
    if (reasons.length === 0 && ack.applied !== true) reasons.push('rendererApplyFailure')
    if (reasons.length === 0) reasons.push('unknown')
    for (const reason of reasons) {
      this.counters.ackRejectReasons[reason] = (this.counters.ackRejectReasons[reason] ?? 0) + 1
    }
  }

  statsForTarget(targetId: number): ChatUpdateDeliveryStats {
    const states = this.statesByTarget.get(targetId)
    if (!states) {
      return {
        trackedChats: 0,
        inFlight: 0,
        pending: 0,
        retainedMessages: 0,
        retainedBaselineBytes: 0,
        inFlightAgeMs: 0,
        renderPending: 0,
        renderReceiptAgeMs: 0
      }
    }
    let inFlight = 0
    let pending = 0
    let retainedMessages = 0
    let retainedBaselineBytes = 0
    let inFlightAgeMs = 0
    let renderPending = 0
    let renderReceiptAgeMs = 0
    const now = this.now()
    for (const state of states.values()) {
      if (state.inFlight) {
        inFlight += 1
        retainedMessages += state.inFlight.chat.messages.length
        retainedBaselineBytes += state.inFlight.compactBaseline.retainedBytes
        if (Number.isFinite(state.lastSentAt)) {
          inFlightAgeMs = Math.max(inFlightAgeMs, Math.max(0, now - state.lastSentAt))
        }
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
      if (state.lastAccepted && state.lastAccepted.renderedAtMs === undefined) {
        renderPending += 1
        renderReceiptAgeMs = Math.max(
          renderReceiptAgeMs,
          Math.max(0, now - state.lastAccepted.acceptedAtMs)
        )
      }
    }
    return {
      trackedChats: states.size,
      inFlight,
      pending,
      retainedMessages,
      retainedBaselineBytes,
      inFlightAgeMs,
      renderPending,
      renderReceiptAgeMs
    }
  }

  private maybeSend(state: TargetChatState): void {
    if (state.inFlight || !state.pending || state.timer) return
    if (state.target.isDestroyed()) {
      this.clearTarget(state.target.id)
      return
    }
    const now = this.now()
    const elapsed = now - state.lastSentAt
    // Terminal/error state must never sit behind the normal 10 Hz stream
    // cadence. It still keeps the same one-in-flight bound, so urgency cannot
    // fan a slow renderer into an unbounded queue.
    const cadenceDelay =
      state.pending.priority === 'urgent' ? 0 : Math.max(0, this.minDeliveryIntervalMs - elapsed)
    // A timed-out snapshot leaves the renderer in an unknown, usually
    // memory-pressured state. Keep coalescing the newest pending canonical chat,
    // but do not let a new producer update bypass the retry circuit. A valid
    // patch baseline proves this is no longer a snapshot retry and therefore
    // keeps ordinary patch behavior unchanged.
    const snapshotRetryDelay =
      !state.acknowledged || !state.baselineChat
        ? Math.max(0, state.snapshotRetryNotBefore - now)
        : 0
    const delay = Math.max(cadenceDelay, snapshotRetryDelay)
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
    let baseline: ChatUpdateBaseline | undefined
    if (state.acknowledged && state.baselineChat) {
      if (
        retainedBaselineMatchesAcknowledged(
          state.acknowledged,
          state.baselineChat,
          state.baselineRevision
        )
      ) {
        baseline = toPatchBaseline(state.acknowledged, state.baselineChat)
      } else {
        // A mutable store/cache caller changed the retained object after its
        // ACK. The renderer never saw that state, so proactively snapshot the
        // pending canonical chat instead of diffing from a counterfeit base.
        this.counters.baselineDrops += 1
        state.acknowledged = undefined
        state.baselineChat = undefined
        state.baselineRevision = undefined
        state.lastAccepted = undefined
      }
    }
    // Project ONCE, here, into the record this target will actually hold. An
    // oversized chat is delivered as a marked shell — one tail page plus
    // `summaryOnly` / `transcriptPaged` / `messageCount` / `runCount` /
    // `runWallMs`, all of which are non-message fields and therefore inside the
    // record hash. Deciding that inside `buildChatUpdateDelivery` and then
    // retaining the canonical record out here is what made the acknowledged
    // hash and the retained base permanently disagree.
    //
    // `projectChatUpdateWindow` returns the same object when no bound applies,
    // so an ordinary chat keeps its producer envelope (a WeakMap lookup on this
    // exact reference) and every existing path is byte-identical.
    //
    // The window is ANCHORED to the one this target acknowledged for as long as
    // that is possible, so appended rows are a pure suffix and the patch is
    // exactly those rows. A sliding window would instead move its own start on
    // every append, leaving no common prefix to splice against — measured as
    // zero patches across 2,000/5,500/9,000-message chats.
    const projection = projectChatUpdateWindow(next.chat, state.windowAnchorMessageId)
    const deliveredChat = projection.chat
    const transcriptWindowed = projection.windowed
    if (
      baseline &&
      transcriptWindowed &&
      projection.anchorMessageId !== (state.windowAnchorMessageId ?? null)
    ) {
      // The window start moved — the anchor was compacted away, the window
      // outgrew its ceiling, or this target held a WHOLE record and the chat
      // has only now crossed the paging threshold. In every case the rows the
      // renderer holds are not a prefix of the rows being sent, and diffing
      // across that is exactly the counterfeit base this lane exists to avoid.
      baseline = undefined
      this.counters.windowReanchors += 1
    }
    const diagnostics: ChatUpdateDeliveryDiagnostics = {
      producerDeltaMissing: false,
      spliceRecovery: false,
      transcriptWindowed: false
    }
    const delivery: ChatUpdateDelivery = buildChatUpdateDelivery({
      deliveryId,
      revision: next.revision,
      chat: deliveredChat,
      baseline,
      // Suppressed when windowed: the producer state's `recordHash` describes
      // the CANONICAL record and its transcript ops describe the canonical
      // array. Both are wrong for a page, and the shell's own sub-revisions are
      // computed from the delivered record instead.
      ...(transcriptWindowed
        ? { transcriptWindowed: true, ...(projection.page ? { transcriptPage: projection.page } : {}) }
        : {
            producerState: next.producer?.state,
            producerDelta: next.producer?.delta ?? undefined
          }),
      protocolVersion: this.emitProtocolVersion,
      diagnostics
    })
    const epochDelivery: ChatUpdateDelivery = {
      ...delivery,
      deliveryEpoch: state.deliveryEpoch
    }
    const snapshotBytes = estimateChatUpdateSnapshotBytes(epochDelivery)
    const deliveryAckTimeoutMs = resolveChatUpdateAckTimeoutMs({
      kind: epochDelivery.kind,
      configuredTimeoutMs: this.ackTimeoutMs,
      ...(epochDelivery.kind === 'snapshot' ? { snapshotBytes } : {})
    })
    const deliveryEnsembleRevision =
      'ensembleRevision' in epochDelivery ? epochDelivery.ensembleRevision : undefined
    const deliveryRunsRevision =
      'runsRevision' in epochDelivery ? epochDelivery.runsRevision : undefined
    // ACK fingerprint is the SENT chat's content hash, never the producer
    // rolling op-hash on the wire. Echoing that roll made every ACK match.
    const revisionInputBytes: ChatUpdateRevisionInputBytes | undefined = this.serializedBytes
      ? { ensemble: 0, runs: 0, nonMessageRecord: 0 }
      : undefined
    // The renderer's applied hash is taken over the record it reconstructs, so
    // main must hash the record it actually sent — never the canonical one.
    const hashSource = epochDelivery.kind === 'snapshot' ? epochDelivery.chat : deliveredChat
    const contentSub = computeChatSubRevisions(hashSource, revisionInputBytes)
    if (this.serializedBytes && revisionInputBytes) {
      const envelope = utf8ByteLength(JSON.stringify(epochDelivery) ?? '')
      this.serializedBytes.envelope += envelope
      this.serializedBytes.peak = Math.max(this.serializedBytes.peak, envelope)
      this.serializedBytes.ensemble += revisionInputBytes.ensemble
      this.serializedBytes.runs += revisionInputBytes.runs
      this.serializedBytes.nonMessageRecord += revisionInputBytes.nonMessageRecord
      this.serializedBytes.messages += utf8ByteLength(
        JSON.stringify(hashSource.messages) ?? ''
      )
    }
    const recordHash = contentSub.recordHash
    const compactBaseline: CompactChatUpdateBaseline = {
      revision: next.revision,
      recordHash,
      ...(epochDelivery.transcriptHash ? { transcriptHash: epochDelivery.transcriptHash } : {}),
      ...(next.producer?.state.transcriptIdsUnique !== undefined
        ? { transcriptIdsUnique: next.producer.state.transcriptIdsUnique }
        : epochDelivery.kind === 'snapshot' && epochDelivery.transcriptIdsUnique !== undefined
          ? { transcriptIdsUnique: epochDelivery.transcriptIdsUnique }
          : state.acknowledged?.transcriptIdsUnique !== undefined
            ? { transcriptIdsUnique: state.acknowledged.transcriptIdsUnique }
            : {}),
      ensembleRevision: deliveryEnsembleRevision ?? contentSub.ensembleRevision,
      runsRevision: deliveryRunsRevision ?? contentSub.runsRevision,
      retainedBytes: next.retainedBytes
    }
    if (epochDelivery.kind === 'snapshot') this.counters.snapshots += 1
    else this.counters.patches += 1
    if (diagnostics.producerDeltaMissing) this.counters.producerDeltaMissing += 1
    if (diagnostics.spliceRecovery) this.counters.spliceRecoveries += 1
    if (diagnostics.transcriptWindowed) this.counters.windowedDeliveries += 1
    state.inFlight = {
      ...next,
      deliveryId,
      deliveryEpoch: state.deliveryEpoch,
      recordHash,
      compactBaseline,
      deliveredChat,
      windowAnchorMessageId: projection.anchorMessageId
    }
    // Drop the patch-base chat once the next full payload is in flight so we
    // never retain acknowledged+baselineChat+inFlight+pending as three+ fulls.
    state.baselineChat = undefined
    state.lastSentAt = this.now()
    state.lastTouchedAt = state.lastSentAt
    this.deliveryIndex.set(deliveryId, { targetId: state.target.id, chatId: state.chatId })
    try {
      state.target.send(CHAT_UPDATE_CHANNEL, epochDelivery)
      if (deliveryAckTimeoutMs > 0) {
        state.ackTimer = this.setTimer(() => {
          state.ackTimer = undefined
          if (state.inFlight?.deliveryId !== deliveryId) return
          this.deliveryIndex.delete(deliveryId)
          state.inFlight = undefined
          // A renderer that cannot ACK cannot share a revision baseline. The
          // newest pending update will therefore repair itself as a snapshot.
          if (state.acknowledged || state.baselineChat) this.counters.baselineDrops += 1
          this.counters.ackRejections += 1
          this.counters.ackRejectReasons.ackTimeout =
            (this.counters.ackRejectReasons.ackTimeout ?? 0) + 1
          state.acknowledged = undefined
          state.baselineChat = undefined
          state.baselineRevision = undefined
          state.lastAccepted = undefined
          state.consecutiveRejects += 1
          if (epochDelivery.kind === 'snapshot') {
            state.consecutiveSnapshotTimeouts += 1
            state.snapshotRetryNotBefore =
              this.now() +
              resolveSnapshotRetryDelayMs({
                consecutiveTimeouts: state.consecutiveSnapshotTimeouts,
                ackTimeoutMs: deliveryAckTimeoutMs
              })
            // A timeout is not evidence that the canonical update can be
            // discarded. Retain this exact snapshot when nothing newer exists;
            // otherwise the existing latest-wins pending slot already carries
            // the record we must eventually deliver.
            if (!state.pending) {
              state.pending = {
                revision: state.nextRevision + 1,
                chat: next.chat,
                producer: next.producer,
                retainedBytes: next.retainedBytes,
                priority: next.priority
              }
              state.nextRevision += 1
            }
          } else if (state.consecutiveRejects === 1 && !state.pending) {
            // Patch behavior is unchanged: one immediate snapshot repairs a
            // renderer that lost its acknowledged patch baseline.
            state.pending = {
              revision: state.nextRevision + 1,
              chat: next.chat,
              producer: next.producer,
              retainedBytes: next.retainedBytes,
              priority: next.priority
            }
            state.nextRevision += 1
          }
          state.lastTouchedAt = this.now()
          this.maybeSend(state)
          this.pruneTarget(state.target.id)
        }, deliveryAckTimeoutMs)
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
    state.baselineRevision = undefined
    state.lastAccepted = undefined
    state.rendererEpoch = undefined
  }

  private deliveryEpochForTarget(targetId: number): number {
    return this.deliveryEpochByTarget.get(targetId) ?? 1
  }
}
