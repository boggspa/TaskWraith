/**
 * M4 — Ensemble Blackboard (cross-participant shared scratchpad).
 *
 * Pure, dependency-free helpers over a `BlackboardEntry[]`. The orchestrator
 * owns persistence (entries live on `chat.ensemble.blackboard`, round-tripped
 * via `saveAndBroadcastChat`); this module is the logic, kept pure so it's
 * exhaustively unit-testable without an Electron/main harness.
 *
 * Design intent (blueprint M4): participants consume a *compact, scoped digest*
 * of shared facts/risks/decisions rather than dumping full transcript memory
 * into every prompt. Entries carry a TTL scope (round/session/chat); round-
 * scoped entries are pruned when the round changes.
 */
import type {
  BlackboardCategory,
  BlackboardEntry,
  BlackboardScope
} from '../store/types'

/** Hard caps so the digest can never balloon a prompt. */
export const BLACKBOARD_MAX_ENTRIES = 60
export const BLACKBOARD_MAX_VALUE_LEN = 1000
export const BLACKBOARD_MAX_STORE_LEN = 4000
export const BLACKBOARD_MAX_KEY_LEN = 80

/** Stable render/derive order — decisions first, throwaway notes last. */
export const BLACKBOARD_CATEGORY_ORDER: BlackboardCategory[] = [
  'decision',
  'fact',
  'risk',
  'do-not-repeat',
  'note'
]

const CATEGORY_LABEL: Record<BlackboardCategory, string> = {
  decision: 'Decisions',
  fact: 'Verified facts',
  risk: 'Open risks',
  'do-not-repeat': 'Do not repeat',
  note: 'Notes'
}

const VALID_CATEGORIES = new Set<BlackboardCategory>(BLACKBOARD_CATEGORY_ORDER)
const VALID_SCOPES = new Set<BlackboardScope>(['round', 'session', 'chat'])

function clamp(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed
}

export function normalizeBlackboardCategory(value: unknown): BlackboardCategory {
  return typeof value === 'string' && VALID_CATEGORIES.has(value as BlackboardCategory)
    ? (value as BlackboardCategory)
    : 'note'
}

export function normalizeBlackboardScope(value: unknown): BlackboardScope {
  return typeof value === 'string' && VALID_SCOPES.has(value as BlackboardScope)
    ? (value as BlackboardScope)
    : 'session'
}

/**
 * Sentinel roundId stamped on a post made with no active round (session/chat
 * scope between rounds). Inert for pruning/read selection, which key only on
 * `scope === 'round'`.
 */
export const BLACKBOARD_MANUAL_ROUND_ID = 'manual'

export interface BlackboardPostRoundResolution {
  ok: boolean
  scope: BlackboardScope
  /** Only meaningful when ok — the roundId to stamp on the entry. */
  roundId: string
  /** Present only when ok is false. */
  error?: string
}

/**
 * Decide whether a blackboard post is allowed given the current round state,
 * and which roundId to stamp on it. Only ROUND-scoped posts require an active
 * round to attach to; session/chat notes are durable shared memory and post
 * between rounds with a `manual` roundId fallback (matching `blackboard_read`,
 * which surfaces non-round entries when no round is active).
 *
 * Single source of truth for BOTH the `blackboard_post` MCP tool (agents) and
 * the `post-blackboard-entry` IPC path (the user's composer button), so an
 * agent and the human obey exactly the same rule and cannot drift apart.
 */
export function resolveBlackboardPostRound(input: {
  scope?: unknown
  activeRoundId?: string | null
}): BlackboardPostRoundResolution {
  const scope = normalizeBlackboardScope(input.scope)
  const activeRoundId = (input.activeRoundId || '').trim()
  if (scope === 'round' && !activeRoundId) {
    return {
      ok: false,
      scope,
      roundId: '',
      error:
        'Round-scoped blackboard entries require an active Ensemble round. Use scope "session" or "chat" for durable notes.'
    }
  }
  return { ok: true, scope, roundId: activeRoundId || BLACKBOARD_MANUAL_ROUND_ID }
}

export interface MakeBlackboardEntryInput {
  id: string
  chatId: string
  roundId: string
  participantId: string
  key: string
  value: string
  category?: unknown
  scope?: unknown
  derivedFrom?: string
  createdAt: string
}

/**
 * Build a normalized entry. Returns null when key or value is effectively empty
 * — callers (the MCP handler) should treat null as "reject this post" rather
 * than persisting junk.
 */
export function makeBlackboardEntry(input: MakeBlackboardEntryInput): BlackboardEntry | null {
  const key = clamp(input.key ?? '', BLACKBOARD_MAX_KEY_LEN)
  const value = clamp(input.value ?? '', BLACKBOARD_MAX_STORE_LEN)
  if (!key || !value) return null
  const participantId = input.participantId || 'system'
  return {
    id: input.id,
    chatId: input.chatId,
    roundId: input.roundId,
    participantId,
    key,
    value,
    category: normalizeBlackboardCategory(input.category),
    scope: normalizeBlackboardScope(input.scope),
    ...(input.derivedFrom ? { derivedFrom: input.derivedFrom } : {}),
    createdAt: input.createdAt,
    // The author has, by definition, seen their own post. Upserts mint a NEW
    // entry object, so a rewritten key resets to author-only — the fresh
    // content is correctly "unseen" for everyone else.
    seenBy: [participantId]
  }
}

/**
 * Insert an entry, upserting on (participantId, key, scope): a participant
 * rewriting the same key under the same scope replaces its prior note instead
 * of stacking duplicates. The list is then capped to BLACKBOARD_MAX_ENTRIES,
 * dropping the OLDEST entries first (by createdAt, then array order).
 */
export function upsertBlackboardEntry(
  entries: BlackboardEntry[],
  entry: BlackboardEntry
): BlackboardEntry[] {
  const without = entries.filter(
    (e) =>
      !(
        e.participantId === entry.participantId &&
        e.key === entry.key &&
        e.scope === entry.scope
      )
  )
  const next = [...without, entry]
  if (next.length <= BLACKBOARD_MAX_ENTRIES) return next
  // Stable oldest-first sort, then keep the newest N.
  const sorted = [...next]
    .map((e, i) => ({ e, i }))
    .sort((a, b) =>
      a.e.createdAt === b.e.createdAt ? a.i - b.i : a.e.createdAt < b.e.createdAt ? -1 : 1
    )
    .map((x) => x.e)
  return sorted.slice(sorted.length - BLACKBOARD_MAX_ENTRIES)
}

/**
 * Drop entries that have expired relative to `currentRoundId`:
 * round-scoped entries from any OTHER round are removed. session/chat survive.
 * Call this when a new round starts.
 */
export function pruneBlackboard(
  entries: BlackboardEntry[],
  currentRoundId: string
): BlackboardEntry[] {
  return entries.filter((e) => e.scope !== 'round' || e.roundId === currentRoundId)
}

/**
 * Entries visible to participants in `currentRoundId`: everything except
 * round-scoped entries belonging to a different round. (Same predicate as
 * prune, but expressed as a read-time selector so callers can choose to prune
 * eagerly or filter lazily.)
 */
export function selectBlackboardForRound(
  entries: BlackboardEntry[],
  currentRoundId: string
): BlackboardEntry[] {
  return entries.filter((e) => e.scope !== 'round' || e.roundId === currentRoundId)
}

/** Has `participantId` seen this entry (via injection or an explicit read)? */
export function isBlackboardEntrySeenBy(entry: BlackboardEntry, participantId: string): boolean {
  return Boolean(participantId) && (entry.seenBy || []).includes(participantId)
}

/**
 * Entries `participantId` has NOT yet seen. Drives the slim resumed-turn
 * digest: the seat's provider session already holds every entry it was shown
 * before, so only unseen entries are new information.
 */
export function selectUnseenBlackboard(
  entries: BlackboardEntry[],
  participantId: string
): BlackboardEntry[] {
  return entries.filter((entry) => !isBlackboardEntrySeenBy(entry, participantId))
}

/**
 * Mark `entryIds` as seen by `participantId`. Pure — returns the SAME array
 * reference when nothing changes so callers can cheaply skip a persist.
 */
export function markBlackboardEntriesSeen(
  entries: BlackboardEntry[],
  entryIds: Iterable<string>,
  participantId: string
): BlackboardEntry[] {
  if (!participantId) return entries
  const ids = entryIds instanceof Set ? entryIds : new Set(entryIds)
  if (ids.size === 0) return entries
  let changed = false
  const next = entries.map((entry) => {
    if (!ids.has(entry.id) || isBlackboardEntrySeenBy(entry, participantId)) return entry
    changed = true
    return { ...entry, seenBy: [...(entry.seenBy || []), participantId] }
  })
  return changed ? next : entries
}

export interface BlackboardRemovalSelector {
  ids?: string[]
  keys?: string[]
  category?: unknown
  /** Explicit clear-the-board switch; combines with category as a filter. */
  all?: boolean
}

/**
 * Hygiene: remove entries matched by ids / keys / category (or everything
 * when `all`). Pure — `{ next, removed }`, with `next === entries` (same ref)
 * when nothing matched. A selector must be present: an EMPTY selector removes
 * nothing (never an implicit clear).
 */
export function removeBlackboardEntries(
  entries: BlackboardEntry[],
  selector: BlackboardRemovalSelector
): { next: BlackboardEntry[]; removed: BlackboardEntry[] } {
  const ids = new Set((selector.ids || []).filter(Boolean))
  const keys = new Set((selector.keys || []).map((key) => String(key).trim()).filter(Boolean))
  const category =
    typeof selector.category === 'string' && VALID_CATEGORIES.has(selector.category as BlackboardCategory)
      ? (selector.category as BlackboardCategory)
      : null
  const hasSelector = selector.all === true || ids.size > 0 || keys.size > 0 || category !== null
  if (!hasSelector) return { next: entries, removed: [] }
  const matches = (entry: BlackboardEntry): boolean => {
    if (category && entry.category !== category) return false
    if (selector.all === true) return true
    if (ids.has(entry.id)) return true
    if (keys.has(entry.key)) return true
    // category-only selector: category filter alone selects the whole bucket.
    return ids.size === 0 && keys.size === 0 && category !== null
  }
  const removed = entries.filter(matches)
  if (removed.length === 0) return { next: entries, removed: [] }
  return { next: entries.filter((entry) => !matches(entry)), removed }
}

export interface BlackboardReadSelector {
  ids?: string[]
  keys?: string[]
  category?: unknown
  unseenOnly?: boolean
  /** Oldest-N window (chronological). */
  first?: number
  /** Newest-N window (chronological output). Default window when no selector. */
  last?: number
}

export const BLACKBOARD_READ_DEFAULT_LAST = 10

/**
 * Deterministic, bounded read for the `blackboard_read` tool. Explicit
 * ids/keys return exactly those entries; otherwise category / unseen filters
 * apply and the `first`/`last` window bounds the result (defaulting to the
 * newest {@link BLACKBOARD_READ_DEFAULT_LAST} so a bare read can never flood a
 * small context window). Output is chronological; `omitted` reports how many
 * in-filter entries fell outside the window.
 */
export function selectBlackboardReadWindow(
  entries: BlackboardEntry[],
  selector: BlackboardReadSelector,
  participantId?: string
): { selected: BlackboardEntry[]; omitted: number } {
  const ids = new Set((selector.ids || []).filter(Boolean))
  const keys = new Set((selector.keys || []).map((key) => String(key).trim()).filter(Boolean))
  const chronological = [...entries]
    .map((e, i) => ({ e, i }))
    .sort((a, b) =>
      a.e.createdAt === b.e.createdAt ? a.i - b.i : a.e.createdAt < b.e.createdAt ? -1 : 1
    )
    .map((x) => x.e)
  if (ids.size > 0 || keys.size > 0) {
    const selected = chronological.filter((entry) => ids.has(entry.id) || keys.has(entry.key))
    return { selected, omitted: 0 }
  }
  const category =
    typeof selector.category === 'string' && VALID_CATEGORIES.has(selector.category as BlackboardCategory)
      ? (selector.category as BlackboardCategory)
      : null
  let filtered = chronological
  if (category) filtered = filtered.filter((entry) => entry.category === category)
  if (selector.unseenOnly && participantId) {
    filtered = filtered.filter((entry) => !isBlackboardEntrySeenBy(entry, participantId))
  }
  const first = Number.isFinite(selector.first) ? Math.max(0, Math.floor(selector.first!)) : 0
  const last = Number.isFinite(selector.last) ? Math.max(0, Math.floor(selector.last!)) : 0
  if (first > 0) {
    return { selected: filtered.slice(0, first), omitted: Math.max(0, filtered.length - first) }
  }
  const window = last > 0 ? last : BLACKBOARD_READ_DEFAULT_LAST
  return {
    selected: filtered.slice(Math.max(0, filtered.length - window)),
    omitted: Math.max(0, filtered.length - window)
  }
}

/**
 * Render a compact, category-grouped digest for prompt injection. Returns ''
 * when there are no entries so the caller can omit the section entirely.
 */
export function formatBlackboardForPrompt(entries: BlackboardEntry[]): string {
  if (entries.length === 0) return ''
  const byCategory = new Map<BlackboardCategory, BlackboardEntry[]>()
  for (const entry of entries) {
    const bucket = byCategory.get(entry.category)
    if (bucket) bucket.push(entry)
    else byCategory.set(entry.category, [entry])
  }
  const lines: string[] = ['Ensemble blackboard (shared scratchpad — treat as agreed context):']
  for (const category of BLACKBOARD_CATEGORY_ORDER) {
    const bucket = byCategory.get(category)
    if (!bucket || bucket.length === 0) continue
    lines.push(`  ${CATEGORY_LABEL[category]}:`)
    for (const entry of bucket) {
      const value = clamp(entry.value, BLACKBOARD_MAX_VALUE_LEN)
      lines.push(`    - ${entry.key}: ${value} (—${entry.participantId})`)
    }
  }
  return lines.join('\n')
}

/**
 * M4 — map a synthesizer round-summary block onto blackboard entries.
 *
 * The summary block (produced by the AT8 synthesizer machinery and parsed by
 * `extractRoundSummaryBlock` in EnsembleRoundSummary.ts) carries four labelled
 * sections — Decisions / Corrections / Open risks / Next action. We turn each
 * non-empty section into ONE session-scoped entry under a stable key, so each
 * round's summary UPSERTS over the previous (the blackboard reflects the panel's
 * *current* agreed state, while `roundSummaries` keeps the full history). Pure +
 * deterministic: the caller injects `makeId` so there's no Date/random here.
 */
const SUMMARY_SECTIONS: { label: string; category: BlackboardCategory; key: string }[] = [
  { label: 'Decisions', category: 'decision', key: 'round-decisions' },
  { label: 'Corrections', category: 'do-not-repeat', key: 'round-corrections' },
  { label: 'Open risks', category: 'risk', key: 'round-open-risks' },
  { label: 'Next action', category: 'note', key: 'round-next-action' }
]

export interface DeriveBlackboardInput {
  summary: string
  chatId: string
  roundId: string
  participantId: string
  createdAt: string
  /** Deterministic id factory — called with a 0-based section index. */
  makeId: (seq: number) => string
}

export function deriveBlackboardFromRoundSummary(input: DeriveBlackboardInput): BlackboardEntry[] {
  if (!input.summary || typeof input.summary !== 'string') return []
  const lines = input.summary.replace(/\r\n/g, '\n').split('\n')
  const sectionText = new Map<string, string[]>()
  let current: string | null = null
  for (const raw of lines) {
    const line = raw.trim().replace(/^#{1,6}\s*/, '').replace(/^[-*]\s*/, '')
    if (!line) continue
    const lower = line.toLowerCase()
    if (/^round summary\s*:/.test(lower)) {
      current = null
      continue
    }
    let matched = false
    for (const section of SUMMARY_SECTIONS) {
      const prefix = `${section.label.toLowerCase()}:`
      if (lower.startsWith(prefix)) {
        const after = line.slice(section.label.length + 1).trim()
        sectionText.set(section.label, after ? [after] : [])
        current = section.label
        matched = true
        break
      }
    }
    if (matched) continue
    if (current) sectionText.get(current)?.push(line)
  }

  const entries: BlackboardEntry[] = []
  let seq = 0
  for (const section of SUMMARY_SECTIONS) {
    const value = (sectionText.get(section.label) || []).join(' ').trim()
    if (!value) continue
    const entry = makeBlackboardEntry({
      id: input.makeId(seq),
      chatId: input.chatId,
      roundId: input.roundId,
      participantId: input.participantId,
      key: section.key,
      value,
      category: section.category,
      scope: 'session',
      derivedFrom: `round-summary:${input.roundId}`,
      createdAt: input.createdAt
    })
    if (entry) {
      entries.push(entry)
      seq += 1
    }
  }
  return entries
}
