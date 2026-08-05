import type {
  AgentIdentity,
  ChatRecord,
  ChildAgentThread,
  ProviderId,
  ToolActivity
} from '../../../main/store/types'
import { namedAgentIdenticonForName } from './agentIdentityCatalog'

/**
 * Subagent identity registry.
 *
 * Each `ChildAgentThread` (spawned subagent) gets a visual identity — a
 * stable display name + accent color — that persists for the lifetime of the
 * chat it belongs to. Codex's UX assigns these from the platform side; we
 * mirror that semantic for our own purposes since:
 *
 *   1. Tool wire data rarely carries a usable display name (just the parent's
 *      persona prompt, which is for the model, not the UI).
 *   2. For Claude / Gemini / Kimi there's no native concept at all.
 *
 * Identity pairs are unique within a chat (no two "Harmonium"s in the same
 * conversation) and survive reloads via `chat.providerMetadata.agentIdentities`.
 */

const AGENT_NICKNAME_POOL: readonly string[] = [
  'Donny-Davis',
  'Harmonium',
  'Jenkinz',
  'Dexterman',
  'Croxley-Marvin',
  'Wendens-Ambo',
  'Georgioni',
  'Teleminster',
  'Korbis',
  'Wellson',
  'Baxter-Ravens',
  'Brian Brian Brian',
  'Imhotep',
  'Hubert Cumberdale',
  'Phobos',
  'Deimos',
  'Dogsbody',
  'Roboteknik',
  'Zandar',
  'Serafin',
  'Orzwald',
  'Channing',
  'Tobus Maximus',
  'Arxfold',
  'Persia',
  'Jakker',
  'Hilbert',
  'Dufus',
  'Sicklemas',
  'Frankenborg',
  'Chaxim',
  'Tre Solomon',
  'Eloque',
  'Xarxes',
  'Julio',
  'Jeremy Patchman',
  'Malek Malloc',
  'Tommy Tipper',
  'Jim The Mage',
  'Kevin The Karate King',
  'Master Maxwell',
  'Dorribald',
  'Marsham',
  'Yorris',
  'Bennison',
  'La Li Lu Le Lo',
  'Nish',
  'Ozbern',
  'Pendris',
  'Quendrew',
  'Roobis',
  'Uno',
  'Volkarr',
  'Yoodoo'
]

const COLOR_POOL: readonly string[] = [
  '#ff5f5f', // red
  '#5a8cff', // blue
  '#ff974a', // orange
  '#5cd687', // green
  '#b88aff', // purple
  '#e6c14a', // yellow
  '#4ad6cc', // cyan
  '#ff7ed4' // pink
]

/** Field names where Codex (or future providers) might surface a platform-assigned name. */
const PLATFORM_NAME_FIELDS: readonly string[] = [
  'assigned_name',
  'assignedName',
  'display_name',
  'displayName',
  'agent_name',
  'agentName',
  'subagent_label',
  'subagentLabel',
  'codename',
  'nickname'
]

function safeAgentIdentitiesMap(chat: ChatRecord | undefined): Record<string, AgentIdentity> {
  const meta = chat?.providerMetadata as Record<string, unknown> | undefined
  if (!meta) return {}
  const raw = meta.agentIdentities
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  // Defensive shallow-validate: each entry must look like an AgentIdentity.
  const result: Record<string, AgentIdentity> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (
      value &&
      typeof value === 'object' &&
      typeof (value as AgentIdentity).name === 'string' &&
      typeof (value as AgentIdentity).color === 'string'
    ) {
      result[key] = value as AgentIdentity
    }
  }
  return result
}

/**
 * Read-only lookup. Returns the identity for an agent id if it has been
 * assigned, otherwise undefined. Never mutates the chat.
 */
export function findIdentity(
  chat: ChatRecord | undefined,
  agentId: string | undefined
): AgentIdentity | undefined {
  if (!chat || !agentId) return undefined
  const map = safeAgentIdentitiesMap(chat)
  const identity = map[agentId]
  return identity ? enrichIdentityWithNamedIcon(identity) : undefined
}

/**
 * Try to pull a display name from the tool wire data. Returns undefined if no
 * reasonable candidate was found. Only checks an allowlist of known fields so
 * we don't accidentally surface raw prompt content as a name.
 */
function extractPlatformName(activity: ToolActivity | undefined): string | undefined {
  if (!activity) return undefined
  const params = (activity.parameters || {}) as Record<string, unknown>
  for (const key of PLATFORM_NAME_FIELDS) {
    const value = params[key]
    if (typeof value === 'string') {
      const trimmed = value.trim()
      // Sanity bounds: actual names won't be longer than ~32 chars or full of whitespace.
      if (trimmed && trimmed.length > 0 && trimmed.length <= 32 && !trimmed.includes('\n')) {
        return trimmed
      }
    }
  }
  // Sometimes the platform name only surfaces in the result payload after the
  // spawn completes — check known result fields too.
  const rawResult = activity.rawResultEvent as Record<string, unknown> | undefined
  if (rawResult && typeof rawResult === 'object') {
    for (const key of PLATFORM_NAME_FIELDS) {
      const value = rawResult[key]
      if (typeof value === 'string' && value.trim() && value.trim().length <= 32) {
        return value.trim()
      }
    }
  }
  return undefined
}

/**
 * Find the next unused (name, color) pair given the identities already
 * assigned in this chat. Names cycle through `AGENT_NICKNAME_POOL` in order
 * and don't repeat until the pool is exhausted; colors cycle every 8 entries.
 */
function enrichIdentityWithNamedIcon(identity: AgentIdentity): AgentIdentity {
  const named = namedAgentIdenticonForName(identity.name)
  if (!named) return identity
  const next = {
    ...identity,
    color: named.accent,
    slug: named.slug,
    accent: named.accent
  }
  return next
}

/**
 * Used-name sets, keyed by the identities map they describe.
 *
 * Rebuilding `new Set(Object.values(map).map(...))` inside every assignment was
 * the other half of the O(agents^2): each of N assignments walked all N names.
 * The map object is replaced whenever a fresh canonical ChatRecord arrives, so
 * keying on its identity rebuilds exactly once per record — O(agents) per
 * update instead of per agent — and a WeakMap lets dead records be collected.
 * This module is the only writer, so the cached set is kept in sync on insert.
 */
const usedNamesByIdentityMap = new WeakMap<object, Set<string>>()

function usedNamesFor(map: Record<string, AgentIdentity>): Set<string> {
  const cached = usedNamesByIdentityMap.get(map)
  if (cached) return cached
  const names = new Set<string>()
  for (const identity of Object.values(map)) {
    if (identity && typeof identity.name === 'string') names.add(identity.name)
  }
  usedNamesByIdentityMap.set(map, names)
  return names
}

function pickNextPoolPair(usedNames: Set<string>): {
  name: string
  color: string
  slug?: string
  accent?: string
} {
  let chosenName: string | undefined
  for (const candidate of AGENT_NICKNAME_POOL) {
    if (!usedNames.has(candidate)) {
      chosenName = candidate
      break
    }
  }
  // Pool exhausted: append a numeric suffix to keep things unique.
  //
  // The suffix search starts from the count of names already taken rather than
  // from 2. Restarting at 2 every time made the Nth agent walk ~N candidates,
  // so assigning N agents was O(N^2) — measured at 52% of a single transcript
  // update in a fan-out soak once several hundred subagents had accumulated
  // (2026-08-05). Suffixes are only ever appended, so everything below the
  // current size is already taken; starting there makes each assignment
  // amortised O(1) while keeping the exact same name sequence. The loop still
  // probes upward, so any gap or externally-supplied name is still respected.
  if (!chosenName) {
    let suffix = Math.max(2, usedNames.size - AGENT_NICKNAME_POOL.length + 2)
    while (true) {
      const candidate = `${AGENT_NICKNAME_POOL[(suffix - 1) % AGENT_NICKNAME_POOL.length]} ${suffix}`
      if (!usedNames.has(candidate)) {
        chosenName = candidate
        break
      }
      suffix += 1
    }
  }
  // Color cycles by position of the assigned name index.
  const baseIndex = AGENT_NICKNAME_POOL.indexOf(chosenName)
  const colorIndex = (baseIndex >= 0 ? baseIndex : usedNames.size) % COLOR_POOL.length
  const named = namedAgentIdenticonForName(chosenName)
  return {
    name: chosenName,
    color: named?.accent ?? COLOR_POOL[colorIndex],
    slug: named?.slug,
    accent: named?.accent
  }
}

/**
 * Idempotent identity assignment. If `agentId` already has an identity in the
 * chat, returns it unchanged. Otherwise allocates a fresh one (platform name
 * for Codex if available, pool name otherwise) and writes it back to
 * `chat.providerMetadata.agentIdentities`.
 *
 * NOTE: this mutates `chat.providerMetadata` in place. Caller is responsible
 * for triggering a re-render / persistence cycle afterwards.
 */
export function assignAgentIdentity(
  chat: ChatRecord,
  thread: ChildAgentThread,
  activity?: ToolActivity
): AgentIdentity {
  // Lazy-create the providerMetadata + agentIdentities slots.
  if (!chat.providerMetadata) {
    chat.providerMetadata = {}
  }
  const meta = chat.providerMetadata as Record<string, unknown>
  if (!meta.agentIdentities || typeof meta.agentIdentities !== 'object') {
    meta.agentIdentities = {}
  }
  const map = meta.agentIdentities as Record<string, AgentIdentity>

  // Already assigned? Reuse.
  const existing = map[thread.id]
  if (existing && typeof existing.name === 'string' && typeof existing.color === 'string') {
    const enriched = enrichIdentityWithNamedIcon(existing)
    if (
      enriched !== existing &&
      (existing.color !== enriched.color ||
        existing.slug !== enriched.slug ||
        existing.accent !== enriched.accent)
    ) {
      map[thread.id] = enriched
    }
    return enriched
  }

  // For Codex, try the platform name first. Fall back to pool for everyone else.
  const usedNames = usedNamesFor(map)
  let identity: AgentIdentity
  const platformName = thread.provider === 'codex' ? extractPlatformName(activity) : undefined
  if (platformName && !usedNames.has(platformName)) {
    // Color still comes from our pool — Codex's color choices aren't on the wire.
    const colorIndex = Object.keys(map).length % COLOR_POOL.length
    const named = namedAgentIdenticonForName(platformName)
    identity = {
      agentId: thread.id,
      name: platformName,
      color: named?.accent ?? COLOR_POOL[colorIndex],
      slug: named?.slug,
      accent: named?.accent,
      role: thread.role,
      source: 'platform',
      assignedAt: new Date().toISOString()
    }
  } else {
    const pair = pickNextPoolPair(usedNames)
    identity = {
      agentId: thread.id,
      name: pair.name,
      color: pair.color,
      slug: pair.slug,
      accent: pair.accent,
      role: thread.role,
      source: 'pool',
      assignedAt: new Date().toISOString()
    }
  }

  map[thread.id] = identity
  // Keep the cached set in sync so the next assignment stays O(1).
  usedNames.add(identity.name)
  return identity
}

/**
 * Bulk-assign identities for a list of threads against a chat. Mutates
 * `chat.providerMetadata.agentIdentities` and returns the threads with
 * `identity` populated.
 */
export function attachIdentitiesToThreads(
  chat: ChatRecord | undefined,
  threads: ChildAgentThread[],
  activityById?: Map<string, ToolActivity>
): ChildAgentThread[] {
  if (!chat) return threads
  return threads.map((thread) => {
    const activity = activityById?.get(thread.parentToolCallId || thread.id)
    const identity = assignAgentIdentity(chat, thread, activity)
    return { ...thread, identity }
  })
}

/** Exported for tests and UI palettes. */
export const AGENT_NAME_POOL: readonly string[] = AGENT_NICKNAME_POOL
export const AGENT_COLOR_POOL: readonly string[] = COLOR_POOL

/**
 * Get the provider-id of the thread for an identity. Useful for the
 * BackgroundTasksPanel and the @-mention chip to render provider-specific
 * iconography alongside the identity.
 */
export function identityProvider(thread: ChildAgentThread | undefined): ProviderId | undefined {
  return thread?.provider
}
