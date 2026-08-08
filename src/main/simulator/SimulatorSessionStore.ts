/**
 * Chat-scoped Simulator Canvas session / preview records (hybrid ownership fork 2C).
 *
 * Survives across runs inside the process (like Mesh scenes are chat-owned),
 * independently of the run-owned controller lease. Frame PNG bytes are never
 * retained — only last-frame metadata for dock restore.
 */
import type { SimulatorRotateDirection } from '../../shared/simulatorCanvas'

export interface SimulatorSessionFrameMeta {
  /** Screenshot pixel extents. */
  width: number
  height: number
  /** Device-point extents for idb (not PNG IHDR pixels). */
  pointWidth: number
  pointHeight: number
  capturedAt: string
  udid: string
}

export interface SimulatorSessionRecord {
  chatId: string
  udid?: string
  lastFrame?: SimulatorSessionFrameMeta
  /**
   * Last absolute orientation applied via IPC/MCP rotate. Used so the dock
   * Rotate control stays in sync after agent/host rotates.
   */
  orientation?: SimulatorRotateDirection
  simulatorAppOpen?: boolean
  ownedSimulatorPid?: number | null
  updatedAt: string
}

export type SimulatorSessionPatch = Partial<Omit<SimulatorSessionRecord, 'chatId' | 'updatedAt'>>

export interface SimulatorSessionStoreDeps {
  now?: () => string
}

function requireChatId(chatId: unknown): string {
  if (typeof chatId !== 'string' || !chatId.trim() || chatId.trim() !== chatId) {
    throw new Error('Simulator session chatId is invalid.')
  }
  return chatId
}

export class SimulatorSessionStore {
  private readonly now: () => string
  private readonly byChat = new Map<string, SimulatorSessionRecord>()

  constructor(deps: SimulatorSessionStoreDeps = {}) {
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  get(chatId: string): SimulatorSessionRecord | null {
    const id = requireChatId(chatId)
    const record = this.byChat.get(id)
    return record
      ? { ...record, lastFrame: record.lastFrame ? { ...record.lastFrame } : undefined }
      : null
  }

  upsert(chatId: string, patch: SimulatorSessionPatch): SimulatorSessionRecord {
    const id = requireChatId(chatId)
    const previous = this.byChat.get(id)
    const next: SimulatorSessionRecord = {
      chatId: id,
      ...(previous ?? {}),
      ...patch,
      ...(patch.lastFrame ? { lastFrame: { ...patch.lastFrame } } : {}),
      updatedAt: this.now()
    }
    this.byChat.set(id, next)
    return {
      ...next,
      lastFrame: next.lastFrame ? { ...next.lastFrame } : undefined
    }
  }

  clear(chatId: string): void {
    this.byChat.delete(requireChatId(chatId))
  }
}
