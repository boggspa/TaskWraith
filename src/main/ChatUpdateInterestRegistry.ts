import {
  MAX_CHAT_UPDATE_INTEREST_ENTRIES,
  normalizeChatUpdateInterestChatId,
  normalizeChatUpdateInterestSnapshot,
  type ChatUpdateInterestMode,
  type ChatUpdateInterestSnapshot
} from '../shared/chatUpdateInterest'

interface TargetInterestState {
  /** Presence of this state means the renderer completed its first handshake. */
  modes: Map<string, ChatUpdateInterestMode>
}

export interface ChatUpdateInterestRegistryOptions {
  maxEntriesPerTarget?: number
}

function boundedMaxEntries(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return MAX_CHAT_UPDATE_INTEREST_ENTRIES
  }
  return Math.min(MAX_CHAT_UPDATE_INTEREST_ENTRIES, Math.max(0, Math.floor(value)))
}

function validTargetId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

/**
 * Main-owned renderer subscription registry.
 *
 * Compatibility is intentionally asymmetric: a WebContents that has never
 * sent the new handshake remains a legacy full-record subscriber. Once its
 * first valid replacement snapshot arrives, absent chat ids mean no interest.
 * A malformed payload does not silently turn a legacy renderer dark.
 */
export class ChatUpdateInterestRegistry {
  private readonly targets = new Map<number, TargetInterestState>()
  private readonly maxEntriesPerTarget: number

  constructor(options: ChatUpdateInterestRegistryOptions = {}) {
    this.maxEntriesPerTarget = boundedMaxEntries(options.maxEntriesPerTarget)
  }

  /** Replace all interests for one renderer document. */
  update(targetId: number, value: unknown): ChatUpdateInterestSnapshot | null {
    if (!validTargetId(targetId)) return null
    const snapshot = normalizeChatUpdateInterestSnapshot(value, this.maxEntriesPerTarget)
    if (!snapshot) return null
    this.targets.set(targetId, {
      modes: new Map(snapshot.entries.map((entry) => [entry.chatId, entry.mode]))
    })
    return snapshot
  }

  /** Descriptive alias for wiring that treats the IPC value as a replacement. */
  replaceTargetSnapshot(targetId: number, value: unknown): ChatUpdateInterestSnapshot | null {
    return this.update(targetId, value)
  }

  /**
   * Returns `full` for a target that has not handshaken, preserving old
   * renderer behavior. Returns undefined for an absent id after handshake.
   */
  modeFor(targetId: number, chatIdValue: unknown): ChatUpdateInterestMode | undefined {
    if (!validTargetId(targetId)) return undefined
    const chatId = normalizeChatUpdateInterestChatId(chatIdValue)
    if (!chatId) return undefined
    const state = this.targets.get(targetId)
    return state ? state.modes.get(chatId) : 'full'
  }

  hasHandshake(targetId: number): boolean {
    return validTargetId(targetId) && this.targets.has(targetId)
  }

  /** Defensive snapshot for diagnostics/tests; callers cannot mutate registry state. */
  snapshotForTarget(targetId: number): ChatUpdateInterestSnapshot | null {
    const state = this.targets.get(targetId)
    if (!state) return null
    return {
      protocolVersion: 1,
      entries: [...state.modes].map(([chatId, mode]) => ({ chatId, mode }))
    }
  }

  clearTarget(targetId: number): boolean {
    return validTargetId(targetId) && this.targets.delete(targetId)
  }

  /** Remove a deleted chat from every live renderer snapshot. */
  clearChat(chatIdValue: unknown): number {
    const chatId = normalizeChatUpdateInterestChatId(chatIdValue)
    if (!chatId) return 0
    let removed = 0
    for (const state of this.targets.values()) {
      if (state.modes.delete(chatId)) removed += 1
    }
    return removed
  }

  trackedTargetCount(): number {
    return this.targets.size
  }

  trackedChatCountForTarget(targetId: number): number {
    return this.targets.get(targetId)?.modes.size ?? 0
  }
}
