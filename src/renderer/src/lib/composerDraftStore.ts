// Persistent composer drafts — typed-but-unsent prompt text, keyed by appChatId,
// so a draft survives thread-switch, window reloads, AND app restart.
//
// Storage is renderer-local `localStorage` (NOT AppSettings): AppSettings goes
// through the main process's synchronous full-rewrite `writeJson` — the "freeze
// class" we deliberately bound elsewhere — and persisting on every keystroke
// there would stutter the main thread. Drafts are also per-window-origin scratch,
// which is exactly localStorage's grain (mirrors the popout-handoff + roster-preset
// modules). The parse/serialize core is split out as pure string<->map functions
// so it unit-tests without a DOM (the renderer suite runs jsdom-free).

const STORAGE_KEY = 'taskwraith.composerDrafts.v1'
/** Skip persisting absurd pastes — keep the in-memory draft, just don't write a
 *  multi-hundred-KB blob to localStorage on every debounce. */
const MAX_PERSISTED_DRAFT_CHARS = 100_000

interface DraftBlob {
  v: 1
  drafts: Record<string, string>
}

/**
 * Pure: a stored blob string (or null) → a sparse `{ [chatId]: text }` map.
 * Safe against a corrupt / legacy / null blob (returns `{}`), and drops
 * empty/whitespace-only entries so a blank draft never round-trips.
 */
export function parseDraftBlob(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  const drafts = (parsed as Partial<DraftBlob> | null)?.drafts
  if (!drafts || typeof drafts !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [chatId, text] of Object.entries(drafts)) {
    if (typeof chatId === 'string' && typeof text === 'string' && text.trim().length > 0) {
      out[chatId] = text
    }
  }
  return out
}

/**
 * Pure: a draft map → the blob string to persist. Drops empty/whitespace entries
 * and clamps any single draft to a sane size so one giant paste can't bloat the
 * store.
 */
export function serializeDraftBlob(map: Record<string, string>): string {
  const drafts: Record<string, string> = {}
  for (const [chatId, text] of Object.entries(map)) {
    if (typeof text !== 'string' || text.trim().length === 0) continue
    drafts[chatId] =
      text.length > MAX_PERSISTED_DRAFT_CHARS ? text.slice(0, MAX_PERSISTED_DRAFT_CHARS) : text
  }
  const blob: DraftBlob = { v: 1, drafts }
  return JSON.stringify(blob)
}

function getStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

/** Read the persisted drafts (sparse, empties dropped). `{}` if none / unavailable. */
export function readComposerDrafts(): Record<string, string> {
  return parseDraftBlob(getStorage()?.getItem(STORAGE_KEY) ?? null)
}

/** Persist the draft map (best-effort; swallows quota / unavailable errors). */
export function writeComposerDrafts(map: Record<string, string>): void {
  try {
    getStorage()?.setItem(STORAGE_KEY, serializeDraftBlob(map))
  } catch {
    // localStorage unavailable or over quota — drafts are best-effort scratch.
  }
}
