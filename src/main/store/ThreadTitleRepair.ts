import { isPlaceholderThreadTitle, normalizeThreadTitle } from '../../shared/threadTitles'
import { isRetiredExternalChannelInboundMessage } from '../LegacyExternalChannelHistory'
import type { ChatListItem, ChatRecord } from './types'

/**
 * Pure selection and derivation for the bounded placeholder-title repair pass.
 *
 * The first-prompt title gates (`EnsembleOrchestrator.beginRound`,
 * `prepareIosComposerPromptChat`) only fire while `messages.length === 0`, so a
 * thread that took its first prompt through a path that did not derive a title
 * keeps its create-factory placeholder forever and only a manual rename fixes
 * it. This module decides which stored threads qualify and what title they
 * should get; `ThreadTitleRepairRunner` owns the effects.
 *
 * Everything here is a pure function of its arguments — no fs, no Electron, no
 * timers, no clock — so the selection rules can be pinned without a harness.
 */

export const THREAD_TITLE_REPAIR_STATE_VERSION = 1

export const THREAD_TITLE_REPAIR_STATE_FILENAME = 'thread-title-repair.json'

/**
 * Records repaired per slice, and the record bytes a slice will read.
 *
 * Measured on a real 448-thread profile: 28 candidates, 3.1 MB average and
 * 38 MB largest. Eight records is a typical ~25 MB slice; the byte budget stops
 * a slice that draws several large records at once.
 */
export const MAX_TITLE_REPAIRS_PER_SLICE = 8
export const MAX_TITLE_REPAIR_BYTES_PER_SLICE = 32 * 1024 * 1024

/**
 * A chat that fails to repair this many times is quarantined rather than
 * retried forever. `sanitizeChatForSave` throws for a chat whose workspace is
 * no longer registered, and `ChatService.saveChat` silently returns the current
 * record on a workspace or revision mismatch, so a permanently unwritable
 * candidate is a real class and needs its own ceiling.
 *
 * The ceiling is deliberately per-chat rather than per-pass. A global terminal
 * latch would be wrong: the placeholder-minting paths are still live (an
 * attachment-only first prompt from the phone appends a message and leaves
 * 'New Chat' in place), so new candidates keep appearing after any given pass
 * finishes, and there is no manual trigger to fall back on.
 */
export const MAX_TITLE_REPAIR_FAILURES_PER_CHAT = 3

/**
 * The ledger is the only record of what a repair overwrote — there is no title
 * history, no soft delete, and no in-app undo. So it is a stop condition, not a
 * ring buffer: at capacity the pass stops repairing rather than dropping the
 * evidence of a change it already made.
 */
export const MAX_TITLE_REPAIR_LEDGER_ENTRIES = 500

export interface ThreadTitleRepairCandidate {
  chatId: string
  /** The placeholder currently on the record, for the ledger's undo entry. */
  placeholderTitle: string
  messageCount: number
  updatedAt: number
  /** Record size from the chat-list index when it vouched, else 0. */
  approxBytes: number
}

export interface ThreadTitleRepairLedgerEntry {
  chatId: string
  previousTitle: string
  derivedTitle: string
  at: number
}

export interface ThreadTitleRepairState {
  version: number
  /** Drains started, including ones that repaired nothing. Diagnostics only. */
  attempts: number
  repaired: number
  lastDrainAt: number
  /** Consecutive failures per chat id; cleared on success. */
  failures: Record<string, number>
  entries: ThreadTitleRepairLedgerEntry[]
}

export interface ThreadTitleRepairSliceBudget {
  maxRecords: number
  maxBytes: number
}

export const DEFAULT_THREAD_TITLE_REPAIR_SLICE_BUDGET: ThreadTitleRepairSliceBudget = {
  maxRecords: MAX_TITLE_REPAIRS_PER_SLICE,
  maxBytes: MAX_TITLE_REPAIR_BYTES_PER_SLICE
}

export function emptyThreadTitleRepairState(): ThreadTitleRepairState {
  return {
    version: THREAD_TITLE_REPAIR_STATE_VERSION,
    attempts: 0,
    repaired: 0,
    lastDrainAt: 0,
    failures: {},
    entries: []
  }
}

/**
 * The state file lives in the userData root, never inside `chats/`. The Host's
 * `sweepChatRecords` throws `Unsafe chat directory entry` for anything in there
 * that is not a plain `.json` chat record, and that throw aborts the listing
 * for every thread — one stray file would take the whole corpus down.
 */
export function defaultThreadTitleRepairStatePath(userDataPath: string): string {
  return `${userDataPath.replace(/[\\/]+$/, '')}/${THREAD_TITLE_REPAIR_STATE_FILENAME}`
}

/**
 * A placeholder this pass is allowed to overwrite.
 *
 * Narrower than `isPlaceholderThreadTitle` in exactly one way: an empty or
 * whitespace-only title is excluded. The rename UI refuses to set one back
 * (`handleRenameChat` returns early on a falsy normalized title, and the
 * sidebar's commit path refuses it too), so an empty title is the one
 * pre-state a user could not restore by hand if the derivation were wrong.
 * Membership itself still comes from the shared set, so this is not a second
 * definition of what a placeholder is.
 */
export function isRepairablePlaceholderTitle(title: string | null | undefined): boolean {
  const normalized = (title ?? '').replace(/\s+/g, ' ').trim()
  if (!normalized) return false
  return isPlaceholderThreadTitle(normalized)
}

/**
 * Candidates from a chat-list projection, cheapest-possible discovery.
 *
 * The index line carries `title` and `messageCount` and always empties
 * `messages`, so this costs zero record reads. `messageCount > 0` is what keeps
 * the pass strictly disjoint from both live first-prompt gates, which require
 * `messages.length === 0`.
 *
 * Oldest first: `saveChat` stamps `updatedAt` unconditionally, so repairing in
 * ascending order preserves the relative order of the threads it touches.
 */
export function selectThreadTitleRepairCandidates(
  items: readonly ChatListItem[],
  state: ThreadTitleRepairState
): ThreadTitleRepairCandidate[] {
  const candidates: ThreadTitleRepairCandidate[] = []
  for (const item of items) {
    if (!item || item.summaryOnly !== true) continue
    if (!isRepairablePlaceholderTitle(item.title)) continue
    if (!(item.messageCount > 0)) continue
    if ((state.failures[item.appChatId] ?? 0) >= MAX_TITLE_REPAIR_FAILURES_PER_CHAT) continue
    candidates.push({
      chatId: item.appChatId,
      placeholderTitle: item.title,
      messageCount: item.messageCount,
      updatedAt: item.updatedAt,
      approxBytes: typeof item.sourceChatSize === 'number' ? item.sourceChatSize : 0
    })
  }
  return candidates.sort((left, right) => left.updatedAt - right.updatedAt)
}

/** Re-checked against the freshly read record immediately before the write. */
export function isThreadTitleRepairTarget(chat: ChatRecord): boolean {
  return isRepairablePlaceholderTitle(chat.title) && (chat.messages?.length ?? 0) > 0
}

/**
 * Liveness, from in-memory run state only.
 *
 * Deliberately ignores `chat.runs` and `chat.ensemble.activeRound`. Measured on
 * a real profile, 14 of 28 candidates carry a persisted `ensemble.activeRound`
 * on records last written between 4 and 75 days ago, and none of them carried a
 * run in an active status — `activeRound` survives restart by design, so an
 * on-disk idle gate would refuse half the corpus forever.
 */
export function isThreadTitleRepairBlocked(chat: ChatRecord, busy: boolean): boolean {
  void chat
  return busy
}

/**
 * The title a repaired thread gets: the first real user message, whitespace
 * collapsed, capped at 160 characters, no ellipsis.
 *
 * `normalizeThreadTitle` is the shared, tested primitive three of the four
 * existing derivation sites already use; hand-rolling the Ensemble gate's
 * 30-char-plus-ellipsis shape would add a fifth derivation rule to a repo that
 * already has four.
 *
 * Retired external-gateway rows are skipped. They persist with `role: 'user'`
 * but are not a human compose action in this app, and every other
 * "find the real user message" consumer excludes them.
 *
 * Returns null when there is nothing to derive from — an attachment-only first
 * message can reach disk with empty content, and a title must never be derived
 * from an empty string.
 */
export function deriveThreadTitleFromTranscript(chat: ChatRecord): string | null {
  const first = (chat.messages ?? []).find(
    (message) =>
      Boolean(message) &&
      message.role === 'user' &&
      !isRetiredExternalChannelInboundMessage(message)
  )
  if (!first) return null
  return normalizeThreadTitle(first.content, '') || null
}

/**
 * The next slice to repair.
 *
 * The first candidate is admitted whatever its size. The largest candidate on
 * the measured profile is 38 MB, which exceeds the whole byte budget on its
 * own; a strictly-enforced budget would leave it unrepairable forever.
 */
export function sliceRepairBatch(
  candidates: readonly ThreadTitleRepairCandidate[],
  budget: ThreadTitleRepairSliceBudget = DEFAULT_THREAD_TITLE_REPAIR_SLICE_BUDGET
): ThreadTitleRepairCandidate[] {
  const slice: ThreadTitleRepairCandidate[] = []
  let bytes = 0
  for (const candidate of candidates) {
    if (slice.length >= budget.maxRecords) break
    if (slice.length > 0 && bytes + candidate.approxBytes > budget.maxBytes) break
    slice.push(candidate)
    bytes += candidate.approxBytes
  }
  return slice
}

/** The ledger is full, so no further repair may be applied. */
export function isThreadTitleRepairLedgerFull(state: ThreadTitleRepairState): boolean {
  return state.entries.length >= MAX_TITLE_REPAIR_LEDGER_ENTRIES
}

export function appendThreadTitleRepairLedger(
  state: ThreadTitleRepairState,
  entry: ThreadTitleRepairLedgerEntry
): ThreadTitleRepairState {
  return {
    ...state,
    repaired: state.repaired + 1,
    entries: [...state.entries, entry]
  }
}

export function recordThreadTitleRepairFailure(
  state: ThreadTitleRepairState,
  chatId: string
): ThreadTitleRepairState {
  return {
    ...state,
    failures: { ...state.failures, [chatId]: (state.failures[chatId] ?? 0) + 1 }
  }
}

export function clearThreadTitleRepairFailure(
  state: ThreadTitleRepairState,
  chatId: string
): ThreadTitleRepairState {
  if (!(chatId in state.failures)) return state
  const failures = { ...state.failures }
  delete failures[chatId]
  return { ...state, failures }
}

export function stampThreadTitleRepairAttempt(
  state: ThreadTitleRepairState,
  now: number
): ThreadTitleRepairState {
  return { ...state, attempts: state.attempts + 1, lastDrainAt: now }
}

/** Tolerant read of a state file that may be absent, truncated, or older. */
export function parseThreadTitleRepairState(raw: unknown): ThreadTitleRepairState {
  const empty = emptyThreadTitleRepairState()
  if (!raw || typeof raw !== 'object') return empty
  const candidate = raw as Partial<ThreadTitleRepairState>
  if (candidate.version !== THREAD_TITLE_REPAIR_STATE_VERSION) return empty
  const failures: Record<string, number> = {}
  if (candidate.failures && typeof candidate.failures === 'object') {
    for (const [chatId, count] of Object.entries(candidate.failures)) {
      if (typeof count === 'number' && Number.isFinite(count) && count > 0) failures[chatId] = count
    }
  }
  return {
    version: THREAD_TITLE_REPAIR_STATE_VERSION,
    attempts: typeof candidate.attempts === 'number' ? candidate.attempts : 0,
    repaired: typeof candidate.repaired === 'number' ? candidate.repaired : 0,
    lastDrainAt: typeof candidate.lastDrainAt === 'number' ? candidate.lastDrainAt : 0,
    failures,
    entries: Array.isArray(candidate.entries)
      ? candidate.entries.filter(
          (entry): entry is ThreadTitleRepairLedgerEntry =>
            Boolean(entry) &&
            typeof entry.chatId === 'string' &&
            typeof entry.previousTitle === 'string' &&
            typeof entry.derivedTitle === 'string'
        )
      : []
  }
}
