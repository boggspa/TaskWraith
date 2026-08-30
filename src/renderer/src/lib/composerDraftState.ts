// External store for composer draft text ("typed-but-unsent prompt"), keyed by
// appChatId.
//
// WHY THIS EXISTS — the draft used to live in App-level `usePerChatState`, so
// every keystroke allocated a new map at the React root and re-executed App
// (~32.5k lines) then MainAppLayout (~3k lines, unmemoized) then Composer.
// That is a fixed, content-independent tax on every character typed in every
// chat, and it is the baseline cost behind the long-standing "text appears in
// chunks, caret freezes" report. Moving the draft to an external store lets the
// focused Composer subscribe to its own chat alone, so a keystroke re-renders
// the Composer and nothing above it.
//
// The sparse-map invariants are UNCHANGED: this delegates to
// `nextPerChatValues`, the same reducer the hook used, so an empty draft still
// deletes its entry and a sent prompt still persists as "gone" and cannot
// resurrect on next launch. Persistence itself stays in `composerDraftStore`
// (localStorage); this module owns only the in-memory reactive grain.
//
// Pure and DOM-free by construction — the renderer suite runs jsdom-free, and
// the React binding lives in `useComposerDraft`, not here.

import { nextPerChatValues, type PerChatStateAction } from '../hooks/usePerChatState'

export type ComposerDraftMap = Readonly<Record<string, string>>

type Listener = () => void

/**
 * A chat counts as "holding a draft" only when its text has non-whitespace
 * content. This mirrors the predicate the old App-level `composerDraftChatIds`
 * memo used for the sidebar indicator — a whitespace-only draft is storable but
 * must not light the dot.
 */
export const holdsDraft = (text: string | undefined): boolean =>
  typeof text === 'string' && text.trim().length > 0

/**
 * Pure: does the sidebar-visible draft membership differ between two maps for
 * this one chat? Extracted so the identity-stability contract below is testable
 * without a store instance.
 */
export const draftMembershipChanged = (
  previous: ComposerDraftMap,
  next: ComposerDraftMap,
  chatId: string
): boolean => holdsDraft(previous[chatId]) !== holdsDraft(next[chatId])

export interface ComposerDraftState {
  /** Non-reactive read. Safe from callbacks and effects; never subscribes. */
  getDraft(chatId: string | null | undefined): string
  /** Non-reactive snapshot of the whole sparse map (for persistence/flush). */
  getDraftMap(): ComposerDraftMap
  /**
   * The set of chats showing a draft indicator. Identity is STABLE across
   * keystrokes that do not change membership — that stability is the whole
   * point of this module, so App can subscribe without re-rendering per
   * character.
   */
  getDraftChatIds(): ReadonlySet<string>
  setDraft(chatId: string | null | undefined, value: PerChatStateAction<string>): void
  /** Wholesale replace (hydration/seed). Notifies every affected subscriber. */
  replaceAll(next: Record<string, string>): void
  /** Fires only when THIS chat's text changes. */
  subscribeToChat(chatId: string, listener: Listener): () => void
  /** Fires only when the draft-holding SET changes, not on every keystroke. */
  subscribeToDraftChatIds(listener: Listener): () => void
}

export const createComposerDraftState = (
  initialMap: Record<string, string> = {}
): ComposerDraftState => {
  let map: ComposerDraftMap = { ...initialMap }
  let cachedIds: ReadonlySet<string> | null = null
  const chatListeners = new Map<string, Set<Listener>>()
  const idListeners = new Set<Listener>()

  const computeIds = (source: ComposerDraftMap): ReadonlySet<string> => {
    const ids = new Set<string>()
    for (const [chatId, text] of Object.entries(source)) {
      if (holdsDraft(text)) ids.add(chatId)
    }
    return ids
  }

  const notifyChat = (chatId: string): void => {
    const listeners = chatListeners.get(chatId)
    if (!listeners) return
    // Copy before iterating: a listener may unsubscribe during notification.
    for (const listener of [...listeners]) listener()
  }

  const notifyIds = (): void => {
    for (const listener of [...idListeners]) listener()
  }

  return {
    getDraft(chatId) {
      if (!chatId) return ''
      return map[chatId] || ''
    },

    getDraftMap() {
      return map
    },

    getDraftChatIds() {
      if (cachedIds === null) cachedIds = computeIds(map)
      return cachedIds
    },

    setDraft(chatId, value) {
      if (!chatId) return
      const previous = map
      const next = nextPerChatValues(previous, chatId, value, '')
      // Same reference means the reducer bailed: no text change, so no
      // subscriber may be woken. This is what keeps a no-op keystroke
      // (re-typing the same character over a selection) free.
      if (next === previous) return
      map = next
      if (draftMembershipChanged(previous, next, chatId)) {
        cachedIds = null
        notifyIds()
      }
      notifyChat(chatId)
    },

    replaceAll(nextMap) {
      const previous = map
      map = { ...nextMap }
      cachedIds = null
      const touched = new Set([...Object.keys(previous), ...Object.keys(map)])
      for (const chatId of touched) {
        if (previous[chatId] !== map[chatId]) notifyChat(chatId)
      }
      notifyIds()
    },

    subscribeToChat(chatId, listener) {
      let listeners = chatListeners.get(chatId)
      if (!listeners) {
        listeners = new Set()
        chatListeners.set(chatId, listeners)
      }
      listeners.add(listener)
      return () => {
        const current = chatListeners.get(chatId)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) chatListeners.delete(chatId)
      }
    },

    subscribeToDraftChatIds(listener) {
      idListeners.add(listener)
      return () => {
        idListeners.delete(listener)
      }
    }
  }
}
