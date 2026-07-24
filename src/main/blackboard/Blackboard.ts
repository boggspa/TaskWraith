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
  BlackboardEvictionTombstone,
  BlackboardPoll,
  BlackboardScope
} from '../store/types'
import {
  validateBlackboardPollOptions,
  validateBlackboardPollRecord
} from '../../shared/blackboardPollValidation'
export {
  BLACKBOARD_MAX_POLL_OPTION_LEN,
  BLACKBOARD_MAX_POLL_OPTIONS,
  BLACKBOARD_MIN_POLL_OPTIONS,
  validateBlackboardPollOptions
} from '../../shared/blackboardPollValidation'
export type {
  BlackboardPollOptionsErrorCode,
  BlackboardPollOptionsValidation
} from '../../shared/blackboardPollValidation'

/** Hard caps so the digest can never balloon a prompt. */
export const BLACKBOARD_MAX_ENTRIES = 60
export const BLACKBOARD_MAX_TOMBSTONES = 60
export const BLACKBOARD_MAX_VALUE_LEN = 1000
export const BLACKBOARD_MAX_STORE_LEN = 8000
export const BLACKBOARD_MAX_KEY_LEN = 80

export type BlackboardPostFieldErrorCode = 'blackboard_key_too_long' | 'blackboard_value_too_long'

export interface BlackboardPostFieldError {
  code: BlackboardPostFieldErrorCode
  maxLength: number
  originalLength: number
}

export type BlackboardMissingKeyReason = 'not_found' | 'filtered_by_round_scope' | 'pruned'

export interface BlackboardMissingKey {
  key: string
  reason: BlackboardMissingKeyReason
}

export interface BlackboardCapacityCounts {
  session: number
  chat: number
  round: number
}

export type UpsertBlackboardResult =
  | {
      ok: true
      entries: BlackboardEntry[]
      tombstones: BlackboardEvictionTombstone[]
    }
  | {
      ok: false
      code: 'blackboard_capacity_exhausted'
      counts: BlackboardCapacityCounts
    }

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

function trimField(text: string): string {
  return text.trim()
}

/** Fail closed before persisting — never silently clamp stored key/value. */
export function validateBlackboardPostFields(
  key: string,
  value: string
): BlackboardPostFieldError | null {
  const trimmedKey = trimField(key ?? '')
  const trimmedValue = trimField(value ?? '')
  if (trimmedKey.length > BLACKBOARD_MAX_KEY_LEN) {
    return {
      code: 'blackboard_key_too_long',
      maxLength: BLACKBOARD_MAX_KEY_LEN,
      originalLength: trimmedKey.length
    }
  }
  if (trimmedValue.length > BLACKBOARD_MAX_STORE_LEN) {
    return {
      code: 'blackboard_value_too_long',
      maxLength: BLACKBOARD_MAX_STORE_LEN,
      originalLength: trimmedValue.length
    }
  }
  return null
}

/**
 * Shorten a value for prompt digest injection with an explicit truncation marker
 * that includes the original length and a read hint for the key.
 */
export function formatPromptBlackboardValue(value: string, key: string): string {
  const trimmed = trimField(value)
  if (trimmed.length <= BLACKBOARD_MAX_VALUE_LEN) return trimmed
  const readHint = `read keys:[${key}]`
  const marker = `[truncated origLen=${trimmed.length} ${readHint}]`
  if (marker.length >= BLACKBOARD_MAX_VALUE_LEN) {
    return `${trimmed.slice(0, BLACKBOARD_MAX_VALUE_LEN - 1).trimEnd()}…`
  }
  const prefixMax = BLACKBOARD_MAX_VALUE_LEN - marker.length - 2
  const prefix = trimmed.slice(0, Math.max(0, prefixMax)).trimEnd()
  return `${prefix}… ${marker}`
}

function sortEntriesOldestFirst(entries: BlackboardEntry[]): BlackboardEntry[] {
  return [...entries]
    .map((e, i) => ({ e, i }))
    .sort((a, b) =>
      a.e.createdAt === b.e.createdAt ? a.i - b.i : a.e.createdAt < b.e.createdAt ? -1 : 1
    )
    .map((x) => x.e)
}

function countBlackboardScopes(entries: BlackboardEntry[]): BlackboardCapacityCounts {
  const counts: BlackboardCapacityCounts = { session: 0, chat: 0, round: 0 }
  for (const entry of entries) {
    if (entry.scope === 'session') counts.session += 1
    else if (entry.scope === 'chat') counts.chat += 1
    else counts.round += 1
  }
  return counts
}

/**
 * Explain the hard board limit in language that is useful both in participant
 * prompts and in a failed post response. Session/chat entries are deliberately
 * protected, whereas round entries can be evicted to make room for a new key.
 */
export function formatBlackboardCapacityNotice(entries: BlackboardEntry[]): string | null {
  if (entries.length < BLACKBOARD_MAX_ENTRIES) return null
  const counts = countBlackboardScopes(entries)
  if (counts.round > 0) {
    return `${entries.length}/${BLACKBOARD_MAX_ENTRIES} entries. Before posting a new key, reuse an existing key or delete/retire stale notes; otherwise the oldest round-scoped entry may be evicted.`
  }
  return `${entries.length}/${BLACKBOARD_MAX_ENTRIES} protected session/chat entries. New unique posts will be rejected; reuse an existing key or call blackboard_delete to retire stale notes first.`
}

function boundEvictionTombstones(
  tombstones: BlackboardEvictionTombstone[]
): BlackboardEvictionTombstone[] {
  if (tombstones.length <= BLACKBOARD_MAX_TOMBSTONES) return tombstones
  return [...tombstones]
    .sort((a, b) => a.prunedAt.localeCompare(b.prunedAt))
    .slice(tombstones.length - BLACKBOARD_MAX_TOMBSTONES)
}

function makeEvictionTombstone(
  entry: BlackboardEntry,
  prunedAt: string
): BlackboardEvictionTombstone {
  return {
    key: entry.key,
    scope: entry.scope,
    roundId: entry.roundId,
    participantId: entry.participantId,
    prunedAt,
    reason: 'capacity'
  }
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
  pollOptions?: unknown
  pollEligibleParticipantIds?: string[]
  createdAt: string
}

/**
 * Build a normalized entry. Returns null when key or value is effectively empty
 * — callers (the MCP handler) should treat null as "reject this post" rather
 * than persisting junk.
 */
export function makeBlackboardEntry(input: MakeBlackboardEntryInput): BlackboardEntry | null {
  const key = trimField(input.key ?? '')
  const value = trimField(input.value ?? '')
  if (!key || !value) return null
  if (validateBlackboardPostFields(key, value)) return null
  const pollValidation = validateBlackboardPollOptions(input.pollOptions)
  if (!pollValidation.ok) return null
  const participantId = input.participantId || 'system'
  const eligibleParticipantIds = [
    ...new Set(
      (input.pollEligibleParticipantIds || [])
        .map((candidate) => String(candidate || '').trim())
        .filter(Boolean)
    )
  ]
  const poll: BlackboardPoll | undefined = pollValidation.options
    ? {
        status: 'open',
        options: pollValidation.options,
        votes: [],
        eligibleParticipantIds,
        includeUser: true,
        updatedAt: input.createdAt
      }
    : undefined
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
    seenBy: [participantId],
    ...(poll ? { poll } : {})
  }
}

export interface UpsertBlackboardOptions {
  currentRoundId?: string
  tombstones?: BlackboardEvictionTombstone[]
  /** ISO timestamp stamped on eviction tombstones (tests pass a fixed value). */
  prunedAt?: string
}

/**
 * Insert an entry, upserting on (participantId, key, scope). When over the
 * entry cap, evict foreign then oldest round-scoped entries first; session and
 * chat entries are never silently discarded. Returns a capacity error when all
 * 60 slots are protected durable scopes.
 */
export function upsertBlackboardEntry(
  entries: BlackboardEntry[],
  entry: BlackboardEntry,
  options: UpsertBlackboardOptions = {}
): UpsertBlackboardResult {
  const currentRoundId = (options.currentRoundId || '').trim()
  const prunedAt = options.prunedAt || entry.createdAt
  let tombstones = (options.tombstones || []).filter((t) => t.key !== entry.key)

  const without = entries.filter(
    (e) =>
      !(
        e.participantId === entry.participantId &&
        e.key === entry.key &&
        e.scope === entry.scope
      )
  )
  let working = [...without, entry]
  if (working.length <= BLACKBOARD_MAX_ENTRIES) {
    return { ok: true, entries: working, tombstones }
  }

  const needToEvict = working.length - BLACKBOARD_MAX_ENTRIES
  const pool = working.filter((e) => e.id !== entry.id)
  const foreignRound = sortEntriesOldestFirst(
    pool.filter((e) => e.scope === 'round' && e.roundId !== currentRoundId)
  )
  const currentRoundScoped = sortEntriesOldestFirst(
    pool.filter((e) => e.scope === 'round' && e.roundId === currentRoundId)
  )
  const evictQueue = [...foreignRound, ...currentRoundScoped]
  if (evictQueue.length < needToEvict) {
    return {
      ok: false,
      code: 'blackboard_capacity_exhausted',
      counts: countBlackboardScopes(working)
    }
  }

  const toRemove = new Set(evictQueue.slice(0, needToEvict).map((e) => e.id))
  for (const evicted of evictQueue.slice(0, needToEvict)) {
    tombstones = tombstones.filter(
      (t) =>
        !(
          t.key === evicted.key &&
          t.scope === evicted.scope &&
          t.participantId === evicted.participantId
        )
    )
    tombstones.push(makeEvictionTombstone(evicted, prunedAt))
  }
  working = working.filter((e) => !toRemove.has(e.id))
  return {
    ok: true,
    entries: working,
    tombstones: boundEvictionTombstones(tombstones)
  }
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

export interface BlackboardReadContext {
  allEntries: BlackboardEntry[]
  currentRoundId?: string
  tombstones?: BlackboardEvictionTombstone[]
}

export function resolveBlackboardMissingKeys(
  requestedKeys: string[],
  selected: BlackboardEntry[],
  context: BlackboardReadContext
): BlackboardMissingKey[] {
  const currentRoundId = (context.currentRoundId || '').trim()
  const tombstones = context.tombstones || []
  const hitKeys = new Set(selected.map((entry) => entry.key))
  const seen = new Set<string>()
  const missing: BlackboardMissingKey[] = []

  for (const raw of requestedKeys) {
    const key = trimField(raw)
    if (!key || seen.has(key) || hitKeys.has(key)) continue
    seen.add(key)

    const foreignRound = context.allEntries.find(
      (entry) =>
        entry.key === key && entry.scope === 'round' && entry.roundId !== currentRoundId
    )
    if (foreignRound) {
      missing.push({ key, reason: 'filtered_by_round_scope' })
      continue
    }

    const pruned = tombstones.find((t) => t.key === key)
    if (pruned) {
      missing.push({ key, reason: 'pruned' })
      continue
    }

    missing.push({ key, reason: 'not_found' })
  }
  return missing
}

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
  participantId?: string,
  context?: BlackboardReadContext
): { selected: BlackboardEntry[]; omitted: number; missingKeys: BlackboardMissingKey[] } {
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
    const missingKeys =
      keys.size > 0 && context
        ? resolveBlackboardMissingKeys([...(selector.keys || [])], selected, context)
        : []
    return { selected, omitted: 0, missingKeys }
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
    return {
      selected: filtered.slice(0, first),
      omitted: Math.max(0, filtered.length - first),
      missingKeys: []
    }
  }
  const window = last > 0 ? last : BLACKBOARD_READ_DEFAULT_LAST
  return {
    selected: filtered.slice(Math.max(0, filtered.length - window)),
    omitted: Math.max(0, filtered.length - window),
    missingKeys: []
  }
}

/**
 * Render a compact, category-grouped digest for prompt injection. Returns ''
 * when there are no entries so the caller can omit the section entirely.
 */
function formatBlackboardPollForPrompt(entry: BlackboardEntry): string {
  const rawPoll: unknown = entry.poll
  if (rawPoll === undefined) return ''
  const validation = validateBlackboardPollRecord(rawPoll)
  if (!validation.ok) return ' [poll unavailable: malformed]'

  const { poll } = validation
  const tallies = poll.options.map((option) => {
    const count = poll.votes.filter((vote) => vote.choice === option).length
    return `${JSON.stringify(option)} (${count})`
  })
  const participantVoteCount = poll.votes.filter((vote) => vote.voterId !== 'user').length
  const voteHint =
    poll.status === 'open'
      ? `; vote with ensemble_poll_response({ pollId: ${JSON.stringify(entry.id)}, choice: "<exact option>" })`
      : ''
  return ` [poll ${poll.status}; ${participantVoteCount}/${poll.eligibleParticipantIds.length} participants voted; choices: ${tallies.join(', ')}${voteHint}]`
}

export function formatBlackboardForPrompt(
  entries: BlackboardEntry[],
  options?: { allEntries?: BlackboardEntry[] }
): string {
  const capacityNotice = formatBlackboardCapacityNotice(options?.allEntries || entries)
  if (entries.length === 0 && !capacityNotice) return ''
  const byCategory = new Map<BlackboardCategory, BlackboardEntry[]>()
  for (const entry of entries) {
    const bucket = byCategory.get(entry.category)
    if (bucket) bucket.push(entry)
    else byCategory.set(entry.category, [entry])
  }
  const lines: string[] = ['Ensemble blackboard (shared scratchpad — treat as agreed context):']
  if (capacityNotice) lines.push(`  Capacity notice: ${capacityNotice}`)
  for (const category of BLACKBOARD_CATEGORY_ORDER) {
    const bucket = byCategory.get(category)
    if (!bucket || bucket.length === 0) continue
    lines.push(`  ${CATEGORY_LABEL[category]}:`)
    for (const entry of bucket) {
      const value = formatPromptBlackboardValue(entry.value, entry.key)
      const pollSuffix = formatBlackboardPollForPrompt(entry)
      lines.push(`    - ${entry.key}: ${value}${pollSuffix} (—${entry.participantId})`)
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
