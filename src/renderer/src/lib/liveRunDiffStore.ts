import type { DiffFileSummary } from '../../../main/store/types'

interface LiveRunDiffState {
  byPath: Map<string, DiffFileSummary>
  snapshot: DiffFileSummary[]
}

type Listener = () => void

/** Path-keyed live write projection; only mounted Diff Studio leaves subscribe. */
export class LiveRunDiffStore {
  private readonly states = new Map<string, LiveRunDiffState>()
  private readonly listeners = new Map<string, Set<Listener>>()

  getSnapshot(chatId: string | null | undefined): DiffFileSummary[] | null {
    if (!chatId) return null
    return this.states.get(chatId)?.snapshot ?? null
  }

  subscribe(chatId: string | null | undefined, listener: Listener): () => void {
    if (!chatId) return () => {}
    const listeners = this.listeners.get(chatId) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(chatId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(chatId)
    }
  }

  upsert(chatId: string, change: DiffFileSummary): void {
    if (!chatId || !change.path) return
    const previous = this.states.get(chatId)
    const byPath = new Map(previous?.byPath)
    const existing = byPath.get(change.path)
    if (existing) {
      const status =
        existing.status === 'created'
          ? 'created'
          : change.status === 'created'
            ? 'created'
            : change.status === 'deleted'
              ? 'deleted'
              : 'modified'
      byPath.set(change.path, {
        ...existing,
        status,
        additions: (existing.additions || 0) + (change.additions || 0),
        deletions: (existing.deletions || 0) + (change.deletions || 0),
        previewKind: existing.previewKind || change.previewKind || 'none'
      })
    } else {
      byPath.set(change.path, { ...change, previewKind: change.previewKind || 'none' })
    }
    this.states.delete(chatId)
    this.states.set(chatId, { byPath, snapshot: Array.from(byPath.values()) })
    while (this.states.size > 256) {
      const oldestChatId = this.states.keys().next().value
      if (!oldestChatId || oldestChatId === chatId) break
      this.states.delete(oldestChatId)
    }
    this.emit(chatId)
  }

  clear(chatId: string | null | undefined): void {
    if (!chatId || !this.states.delete(chatId)) return
    this.emit(chatId)
  }

  private emit(chatId: string): void {
    for (const listener of this.listeners.get(chatId) ?? []) listener()
  }
}

export const liveRunDiffStore = new LiveRunDiffStore()
