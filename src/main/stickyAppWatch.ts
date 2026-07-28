/**
 * M11 (1.0.7) — sticky AppWatch attachment snapshots.
 *
 * AU (1.0.5 `d221558`) shipped conservative auto-detach: attach a window in
 * Chat A, switch to Chat B, and the attachment is released so B can't observe
 * A's stream. M11 adds the *remember* half: when a chat auto-detaches, we stash
 * a compact snapshot of WHAT it was watching, keyed by chat id, persisted so it
 * survives an app restart. When the user returns to that chat, the renderer can
 * offer a one-tap "Resume watching <app>".
 *
 * macOS constraint (important): the bridge daemon attaches via the interactive
 * `SCContentSharingPicker` and has NO reattach-by-windowID verb — macOS
 * requires a user gesture to grant a window. So "resume" re-opens the picker
 * (pre-targeted by the remembered app), it does NOT silently re-stream. The
 * snapshot is metadata for the affordance + restart survival, never a live
 * grant.
 *
 * This module is pure data logic (no Electron/daemon deps) so the
 * stash/prune/serialise rules are unit-testable.
 */

/** The remembered display metadata for a chat's last AppWatch attachment.
 * Native identities are intentionally absent: resuming always reopens the
 * system picker and never reuses a PID, window id, handle, scope, or lease. */
export interface StickyAppWatchSnapshot {
  /** Chat that owned the attachment. */
  chatId: string
  windowMeta: {
    title: string
    bundleID: string
    applicationName: string
  }
  /** When the attachment was originally created (ISO). */
  attachedAt: string
  /** When it was stashed on auto-detach (ISO) — drives LRU pruning. */
  stashedAt: string
  /** Whether OCR/streaming was active at detach time (restored as the
   * resume default). */
  wasStreaming: boolean
}

/** Hard cap on remembered chats so the store can't grow unbounded across a long
 * session. LRU by `stashedAt`. */
export const MAX_STICKY_APPWATCH_SNAPSHOTS = 50

export type StickyAppWatchStore = Record<string, StickyAppWatchSnapshot>

export interface StashInput {
  chatId: string
  windowMeta: StickyAppWatchSnapshot['windowMeta']
  attachedAt: string
  wasStreaming: boolean
  stashedAt: string
}

export interface StickyAppWatchPersistence {
  load(): Promise<unknown>
  persist(store: StickyAppWatchStore): Promise<void>
  onPersistError?(error: unknown): void
}

/**
 * Lazy, serialized persistence boundary for renderer-driven resume hints.
 *
 * Stash and clear are read-modify-write operations over one JSON file. Keeping
 * one load promise and one mutation tail prevents concurrent chats from
 * overwriting each other's snapshots while preserving the existing best-effort
 * disk behavior.
 */
export class StickyAppWatchStoreController {
  private store: StickyAppWatchStore | null = null
  private loadPromise: Promise<StickyAppWatchStore> | null = null
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(private readonly persistence: StickyAppWatchPersistence) {}

  async get(chatId: string): Promise<StickyAppWatchSnapshot | null> {
    return getStickyAppWatch(await this.load(), chatId)
  }

  async stash(input: StashInput): Promise<void> {
    await this.mutate((store) => stashStickyAppWatch(store, input))
  }

  async clear(chatId: string): Promise<boolean> {
    let changed = false
    await this.mutate((store) => {
      const next = clearStickyAppWatch(store, chatId)
      changed = next !== store
      return next
    })
    return changed
  }

  private async load(): Promise<StickyAppWatchStore> {
    if (this.store) return this.store
    if (!this.loadPromise) {
      this.loadPromise = this.persistence.load().then((raw) => {
        const loaded = normalizeStickyAppWatchStore(raw)
        if (!this.store) this.store = loaded
        return this.store
      })
    }
    return this.loadPromise
  }

  private mutate(mutator: (store: StickyAppWatchStore) => StickyAppWatchStore): Promise<void> {
    const operation = this.mutationTail.then(async () => {
      const current = await this.load()
      const next = mutator(current)
      if (next === current) return
      this.store = next
      try {
        await this.persistence.persist(next)
      } catch (error) {
        this.persistence.onPersistError?.(error)
      }
    })
    this.mutationTail = operation.catch(() => undefined)
    return operation
  }
}

/**
 * Upsert a chat's stashed snapshot, then LRU-prune to the cap. Pure: returns a
 * NEW store object, never mutates the input. Rejects an input with no chatId or
 * no bounded display identity by returning the store unchanged.
 */
export function stashStickyAppWatch(
  store: StickyAppWatchStore,
  input: StashInput
): StickyAppWatchStore {
  const windowMeta = normalizeWindowMeta(input.windowMeta)
  if (!input.chatId || !windowMeta) {
    return store
  }
  const next: StickyAppWatchStore = {
    ...store,
    [input.chatId]: {
      chatId: input.chatId,
      windowMeta,
      attachedAt: input.attachedAt,
      stashedAt: input.stashedAt,
      wasStreaming: Boolean(input.wasStreaming)
    }
  }
  return pruneStickyAppWatch(next)
}

/** Remove a chat's stashed snapshot (e.g. the user explicitly detaches, or
 * resumes and re-attaches). Returns a new store; no-op if absent. */
export function clearStickyAppWatch(
  store: StickyAppWatchStore,
  chatId: string
): StickyAppWatchStore {
  if (!chatId || !(chatId in store)) return store
  const next = { ...store }
  delete next[chatId]
  return next
}

/** The remembered snapshot for a chat, or null. */
export function getStickyAppWatch(
  store: StickyAppWatchStore,
  chatId: string
): StickyAppWatchSnapshot | null {
  if (!chatId) return null
  return store[chatId] || null
}

/**
 * LRU-prune to MAX_STICKY_APPWATCH_SNAPSHOTS, dropping the oldest `stashedAt`
 * first. Pure. Returns the same reference when no pruning is needed.
 */
export function pruneStickyAppWatch(store: StickyAppWatchStore): StickyAppWatchStore {
  const entries = Object.values(store)
  if (entries.length <= MAX_STICKY_APPWATCH_SNAPSHOTS) return store
  const keep = entries
    .slice()
    .sort((a, b) => (a.stashedAt < b.stashedAt ? 1 : a.stashedAt > b.stashedAt ? -1 : 0))
    .slice(0, MAX_STICKY_APPWATCH_SNAPSHOTS)
  const next: StickyAppWatchStore = {}
  for (const snap of keep) next[snap.chatId] = snap
  return next
}

/**
 * Coerce arbitrary parsed JSON (from the persisted file) into a clean store,
 * dropping malformed entries. Defensive against hand-edited / corrupt data.
 */
export function normalizeStickyAppWatchStore(raw: unknown): StickyAppWatchStore {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: StickyAppWatchStore = {}
  for (const [chatId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!chatId || !value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    const meta = v.windowMeta as Record<string, unknown> | undefined
    const windowMeta = normalizeWindowMeta(meta)
    if (!windowMeta) continue
    out[chatId] = {
      chatId,
      windowMeta,
      attachedAt: typeof v.attachedAt === 'string' ? v.attachedAt : '',
      stashedAt: typeof v.stashedAt === 'string' ? v.stashedAt : '',
      wasStreaming: Boolean(v.wasStreaming)
    }
  }
  return pruneStickyAppWatch(out)
}

function normalizeWindowMeta(value: unknown): StickyAppWatchSnapshot['windowMeta'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const title = boundedDisplayText(record.title)
  const bundleID = boundedDisplayText(record.bundleID)
  const applicationName = boundedDisplayText(record.applicationName)
  if (!title && !bundleID && !applicationName) return null
  return { title, bundleID, applicationName }
}

function boundedDisplayText(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 159)}…`
}
