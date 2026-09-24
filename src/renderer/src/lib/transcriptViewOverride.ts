import type { TranscriptView } from '../../../main/store/types'

export type { TranscriptView }

export type TranscriptViewByChatId = ReadonlyMap<string, TranscriptView>

/**
 * How much of a turn the transcript renders when the user has expressed no
 * preference at all.
 *
 * `standard` is today's transcript byte for byte, so an install that upgrades
 * into this feature sees no change until it asks for one. Read it through
 * `resolveTranscriptView` rather than comparing against `'standard'` directly:
 * a seam that hard-codes the default keeps rendering everything without
 * failing to compile or to render, which is exactly the class of miss that
 * `resolveFanoutLaneLayout` exists to prevent.
 */
export const DEFAULT_TRANSCRIPT_VIEW: TranscriptView = 'standard'

/**
 * Narrow a persisted, transferred, or absent value to a view the renderer can
 * carry.
 *
 * Absence is the COMMON case and must mean "follow the default", never
 * "minimal" — an unreadable settings file, a chat popout that opened before
 * the sender captured anything, and a build that later grows a fourth view all
 * arrive here, and every one of them should show the reader MORE rather than
 * less. Silently hiding a turn's work is the only failure mode of this feature
 * that a user cannot diagnose from the screen.
 */
export function resolveTranscriptView(value: unknown): TranscriptView {
  return value === 'minimal' || value === 'tools' || value === 'standard'
    ? value
    : DEFAULT_TRANSCRIPT_VIEW
}

// Session-only external store, keyed by `appChatId`.
//
// Per-CHAT rather than per-PANE, and outside the React tree for two reasons
// the round-expansion store (`ensembleRoundCards`) already documents: the
// transcript swaps between separate welcome/transcript trees, so component
// state dies on a chat -> welcome -> chat navigation; and one chat can be open
// in the main pane, the side chat and a multiview pane at the same time, which
// a `:root` attribute cannot serve and three separate `useState` calls would
// let drift apart. A module-level snapshot gives all three mounts one answer.
//
// Session-only is deliberate. This is a reading preference, not a property of
// the conversation, so it does not belong on the chat record — that would drag
// it through thread-catalogue writes, the chat-updated delivery envelope and
// paged records that carry `messages` empty. The durable half of the feature
// is the Appearance default; this store only holds "for now, in this window".
let transcriptViewSnapshot: TranscriptViewByChatId = new Map()
const transcriptViewListeners = new Set<() => void>()

export function getTranscriptViewSnapshot(): TranscriptViewByChatId {
  return transcriptViewSnapshot
}

export function subscribeTranscriptView(listener: () => void): () => void {
  transcriptViewListeners.add(listener)
  return () => transcriptViewListeners.delete(listener)
}

/**
 * Record a per-chat override, or clear it back to the Appearance default.
 *
 * The snapshot is replaced rather than mutated so `useSyncExternalStore` sees
 * a new reference; mutating the existing Map would leave every subscriber
 * reading a value it believes it has already rendered.
 *
 * THIS FUNCTION IS ONLY CORRECT AGAINST A FOUR-ITEM MENU, and that coupling is
 * invisible from here, so it is written down rather than left to be
 * rediscovered.
 *
 * The menu offers `Follow default / Minimal / Tools / Standard`, and only the
 * last three call this with a view; "Follow default" calls it with `null`. A
 * chat with no entry is therefore ticked on "Follow default", so the idempotent
 * click a user is most likely to make — opening the menu and choosing what is
 * already selected — arrives here as `null` and no-ops.
 *
 * Collapse that menu to three items and the defect is immediate and silent:
 * the ticked item on an un-overridden chat becomes whichever view the default
 * resolves to, clicking it writes an explicit entry, and that chat is pinned
 * forever. A later Appearance default of `minimal` then reaches every chat
 * EXCEPT the ones whose menu the user happened to open. Nothing on screen
 * distinguishes the two states, and there is no production bulk-clear to
 * recover with.
 *
 * A three-item menu is still buildable, but it must pass the resolved default
 * in and write `null` on a match — at the cost that a user can then never pin
 * `standard` deliberately against a future `minimal` default, which is the
 * state `hasTranscriptViewOverride` exists to distinguish.
 */
export function setTranscriptViewOverride(chatId: string, view: TranscriptView | null): void {
  const current = transcriptViewSnapshot.get(chatId)
  if (view === null ? current === undefined : current === view) return
  const next = new Map(transcriptViewSnapshot)
  if (view === null) next.delete(chatId)
  else next.set(chatId, view)
  transcriptViewSnapshot = next
  for (const listener of transcriptViewListeners) listener()
}

/**
 * The view a given chat renders at: its own override if it has one, otherwise
 * the Appearance default.
 *
 * `defaultView` is threaded rather than read from a module global so this stays
 * a pure function of its arguments — the settings half of the feature lands
 * after the menu, and until it does every caller passes the resolved default
 * it already holds.
 */
export function transcriptViewForChat(
  viewByChatId: TranscriptViewByChatId,
  chatId: string | null,
  defaultView: TranscriptView
): TranscriptView {
  const override = chatId ? viewByChatId.get(chatId) : undefined
  return override ?? defaultView
}

/**
 * The explicit override `chatId` carries, or `undefined` when it follows the
 * default — for handing the per-chat view to a window that cannot share this
 * module (a chat popout is a second BrowserWindow with its own JS realm).
 *
 * Reads the snapshot directly, mirroring `captureSessionRoundExpansionForChat`,
 * and is deliberately PARTIAL: `transcriptViewForChat` and
 * `resolveTranscriptView` are both total, so capturing through either would
 * hand the other window an explicit `'standard'` for a chat that has no
 * override at all, pinning it against the Appearance default forever.
 */
export function captureTranscriptViewOverrideForChat(chatId: string): TranscriptView | undefined {
  return chatId ? transcriptViewSnapshot.get(chatId) : undefined
}

/** Whether `chatId` carries an explicit override, for a menu that marks it. */
export function hasTranscriptViewOverride(
  viewByChatId: TranscriptViewByChatId,
  chatId: string | null
): boolean {
  return chatId ? viewByChatId.has(chatId) : false
}

/** Test-only: drop every override so one case cannot leak into the next. */
export function resetTranscriptViewOverridesForTest(): void {
  transcriptViewSnapshot = new Map()
  for (const listener of transcriptViewListeners) listener()
}
