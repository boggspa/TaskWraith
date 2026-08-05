import type { ChatRecord } from './store/types'
import {
  CHAT_UPDATE_CHANNEL,
  CHAT_UPDATE_PROTOCOL_V1,
  CHAT_UPDATE_PROTOCOL_V2,
  buildChatUpdateDelivery,
  type ChatUpdateAck,
  type ChatUpdateBaseline,
  type ChatUpdateDelivery,
  type ChatUpdateProtocolVersion
} from '../shared/chatUpdateTransport'

export interface ChatUpdateDeliveryTarget {
  id: number
  isDestroyed: () => boolean
  send: (channel: string, payload: unknown) => void
}

interface PendingChatUpdate {
  revision: number
  chat: ChatRecord
}

interface InFlightChatUpdate extends PendingChatUpdate {
  deliveryId: string
}

interface TargetChatState {
  target: ChatUpdateDeliveryTarget
  chatId: string
  nextRevision: number
  acknowledged?: ChatUpdateBaseline
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

function resolveEmitProtocolVersion(
  requested?: ChatUpdateProtocolVersion
): ChatUpdateProtocolVersion {
  if (requested === CHAT_UPDATE_PROTOCOL_V1 || requested === CHAT_UPDATE_PROTOCOL_V2) {
    return requested
  }
  const fromEnv = process.env.TASKWRAITH_CHAT_UPDATE_PROTOCOL?.trim()
  if (fromEnv === '2') return CHAT_UPDATE_PROTOCOL_V2
  return CHAT_UPDATE_PROTOCOL_V1
}

/**
 * ACK-gated, latest-wins delivery for main-owned chat projections.
 *
 * Each renderer/chat may own at most one native IPC payload in flight and one
 * replaceable pending ChatRecord. A slow or hung renderer therefore creates a
 * fixed-size backlog instead of an unbounded queue of multi-megabyte clones.
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
    state.nextRevision += 1
    state.pending = { revision: state.nextRevision, chat }
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
    if (ack.applied) {
      state.acknowledged = { revision: inFlight.revision, chat: inFlight.chat }
      state.consecutiveRejects = 0
    } else {
      state.acknowledged = undefined
      state.consecutiveRejects += 1
      // One immediate snapshot retry repairs a missing/stale renderer base.
      // If that snapshot is also rejected, wait for a future producer update
      // instead of creating a deterministic 10 Hz retry loop.
      if (state.consecutiveRejects === 1 && !state.pending) {
        state.pending = { revision: inFlight.revision, chat: inFlight.chat }
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

  statsForTarget(targetId: number): ChatUpdateDeliveryStats {
    const states = this.statesByTarget.get(targetId)
    if (!states) return { trackedChats: 0, inFlight: 0, pending: 0, retainedMessages: 0 }
    let inFlight = 0
    let pending = 0
    let retainedMessages = 0
    for (const state of states.values()) {
      if (state.inFlight) inFlight += 1
      if (state.pending) pending += 1
      retainedMessages += state.acknowledged?.chat.messages.length ?? 0
      retainedMessages += state.inFlight?.chat.messages.length ?? 0
      retainedMessages += state.pending?.chat.messages.length ?? 0
    }
    return { trackedChats: states.size, inFlight, pending, retainedMessages }
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
    const delivery: ChatUpdateDelivery = buildChatUpdateDelivery({
      deliveryId,
      revision: next.revision,
      chat: next.chat,
      baseline: state.acknowledged,
      protocolVersion: this.emitProtocolVersion
    })
    state.inFlight = { ...next, deliveryId }
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
          state.acknowledged = undefined
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
  }
}
