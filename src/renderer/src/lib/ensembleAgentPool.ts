import type {
  EnsembleParticipant,
  PermissionOverrides,
  PermissionPresetId,
  PooledAgentIdentitySnapshot,
  ProviderId
} from '../../../main/store/types'
import { agentIdenticonHash } from './agentIdenticon'
import { AGENT_NAME_POOL } from './agentIdentity'
import { namedAgentIdenticonForSlug } from './agentIdentityCatalog'
import {
  clonePermissionOverrides,
  listEnsembleRosterPresets,
  upsertEnsembleRosterPreset,
  type EnsembleRosterParticipantSnapshot
} from './ensembleRosterPresets'

/**
 * Agent Pool store (Settings → Roster only, renderer-local).
 *
 * A structural twin of `ensembleRosterPresets.ts`: a separate-keyed localStorage
 * array with its OWN cross-window storage bridge and synchronous same-window
 * listener fan-out. It is deliberately NOT folded into the preset store — the
 * preset validators/readers are shape-locked to `EnsembleRosterPreset` and the
 * preset bridge is closed over the preset key — and pooled Agents need a STABLE
 * `agentId` that the preset's id-less, positional participants cannot anchor.
 *
 * A `PooledAgent` is a reusable participant definition (a roster snapshot minus
 * the preset-positional `order`/`isBossman`/`enabled` fields) plus a stable id
 * and a pool-namespaced identity (nickname + icon + hue). The identity lives in
 * the SEPARATE pool namespace — never the chat-scoped subagent identity registry
 * in `agentIdentity.ts` (which is keyed by `ChildAgentThread.id` on a single
 * transcript) — so the two never collide.
 *
 * LINKED reuse: when an Agent is added to a roster preset, the resulting
 * participant snapshot carries `pooledAgentId`. Editing the Agent later
 * propagates its config to every linked snapshot (`upsertPooledAgent` →
 * `propagatePooledAgentToPresets`); positional fields (order / boss / enabled)
 * are preserved. The same `pooledAgentId` is the stats-attribution key.
 */

const STORAGE_KEY = 'taskwraith-ensemble-agent-pool'
const POOLED_AGENT_ID_PREFIX = 'pooled-agent-'

/** DnD MIME for dragging a pool Agent card into a preset participant list. */
export const POOLED_AGENT_DRAG_MIME = 'application/x-tw-pooled-agent'
/** DnD MIME for dragging a preset participant onto the pool (save-to-pool). */
export const ROSTER_PARTICIPANT_DRAG_MIME = 'application/x-tw-roster-participant'

export type PooledAgentIdentity = {
  /** Display name, pool namespace. */
  nickname: string
  /** Named-identicon slug when the icon was picked from the identicon catalog. */
  slug?: string
  /**
   * 'named' => `slug` drives a named-identicon SVG; 'seed' => procedural
   * AgentIdenticon; 'asset' => `assetKey` drives an app-wide pool icon
   * (agent-pool-icons / provider logo or Ensemble glyph / ghost / action /
   * command).
   */
  iconKind: 'named' | 'seed' | 'asset'
  /** App-wide icon-pool key (group-namespaced) when iconKind === 'asset'. */
  assetKey?: string
  /** Stable seed for the procedural icon (defaults to agentId). */
  seed?: string
  /** 0-359, drives the accent (mirrors the manifest hue spirit). */
  hue: number
  /** 0-100 HSL saturation control for the derived accent. Absent => legacy 65. */
  saturation?: number
  /** 0-100 lightness control for the derived accent. Absent => legacy 58. */
  brightness?: number
  /** Optional explicit #RRGGBB override; otherwise derived from hue. */
  accent?: string
  /** When false, render the icon monochrome (ignore accent/hue) — for pool
   * icons that carry their own colour. Absent ⇒ tinted (pre-toggle default). */
  hueEnabled?: boolean
}

export type PooledAgentConfig = {
  // `EnsembleRosterParticipantSnapshot` MINUS order / isBossman / enabled /
  // pooledAgentId / pooledAgentIdentity (all preset-positional or link metadata).
  provider: ProviderId
  role: string
  instructions: string
  model?: string
  runtimeProfileId?: string
  geminiAuthProfileId?: string | null
  permissionPresetId?: PermissionPresetId
  permissionOverrides?: PermissionOverrides
  reasoningEffort?: string
  fastModeEnabled?: boolean
  thinkingEnabled?: boolean
  serviceTier?: string
}

export type PooledAgent = {
  /** STABLE `pooled-agent-<uuid>` — pool identity AND stats-attribution key. */
  agentId: string
  createdAt: number
  updatedAt: number
  schemaVersion: 1
  identity: PooledAgentIdentity
  config: PooledAgentConfig
}

/** Config keys propagated to linked preset snapshots on an Agent edit. */
const POOLED_AGENT_CONFIG_KEYS: readonly (keyof PooledAgentConfig)[] = [
  'provider',
  'role',
  'instructions',
  'model',
  'runtimeProfileId',
  'geminiAuthProfileId',
  'permissionPresetId',
  'permissionOverrides',
  'reasoningEffort',
  'fastModeEnabled',
  'thinkingEnabled',
  'serviceTier'
]

/**
 * True for a pooled-Agent id. Guards the `pooledAgentId` write sites so a
 * per-chat participant id (`ensemble-participant-N`) can never be conflated with
 * a pool identity and fragment an Agent's stats history.
 */
export function isPooledAgentId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(POOLED_AGENT_ID_PREFIX) && id.length > POOLED_AGENT_ID_PREFIX.length
}

function newAgentId(): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `${POOLED_AGENT_ID_PREFIX}${uuid}`
}

// ── identity helpers ────────────────────────────────────────────────────────

/** Stable 0-359 hue from a seed (reuses the FNV-1a identicon hash). */
export function hueForSeed(seed: string | null | undefined): number {
  return agentIdenticonHash(seed) % 360
}

export const DEFAULT_POOL_ICON_BRIGHTNESS = 58
export const DEFAULT_POOL_ICON_SATURATION = 65

export type RgbColor = {
  r: number
  g: number
  b: number
}

export type ParsedPoolColor = {
  accent: string
  hue: number
  saturation: number
  brightness: number
}

export function normalizePoolIconBrightness(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_POOL_ICON_BRIGHTNESS
  return Math.max(0, Math.min(100, Math.round(value)))
}

export function normalizePoolIconSaturation(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_POOL_ICON_SATURATION
  return Math.max(0, Math.min(100, Math.round(value)))
}

function normalizedHue(hue: number): number {
  return ((Math.round(hue) % 360) + 360) % 360
}

function hexByte(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0')
}

function rgbToHex({ r, g, b }: RgbColor): string {
  return `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`.toUpperCase()
}

export function normalizeHexColor(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  const match = trimmed.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!match) return undefined
  const raw = match[1]
  const expanded =
    raw.length === 3
      ? raw
          .split('')
          .map((part) => `${part}${part}`)
          .join('')
      : raw
  return `#${expanded.toUpperCase()}`
}

export function rgbFromHexColor(value: string | null | undefined): RgbColor | undefined {
  const hex = normalizeHexColor(value)
  if (!hex) return undefined
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16)
  }
}

export function rgbStringFromHexColor(value: string | null | undefined): string {
  const rgb = rgbFromHexColor(value)
  return rgb ? `${rgb.r}, ${rgb.g}, ${rgb.b}` : ''
}

function parseRgbColorInput(value: string): RgbColor | undefined {
  const trimmed = value.trim()
  const match = trimmed.match(/^rgba?\(\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i)
  const parts = match ? [match[1], match[2], match[3]] : trimmed.split(/\s*,\s*/)
  if (parts.length !== 3) return undefined
  const channels = parts.map((part) => Number(part))
  if (!channels.every((part) => Number.isFinite(part) && part >= 0 && part <= 255)) {
    return undefined
  }
  return {
    r: Math.round(channels[0]),
    g: Math.round(channels[1]),
    b: Math.round(channels[2])
  }
}

function hslFromRgb({ r, g, b }: RgbColor): Pick<ParsedPoolColor, 'hue' | 'saturation' | 'brightness'> {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const delta = max - min
  const lightness = (max + min) / 2
  let hue = 0
  let saturation = 0
  if (delta !== 0) {
    if (max === rn) hue = 60 * (((gn - bn) / delta) % 6)
    else if (max === gn) hue = 60 * ((bn - rn) / delta + 2)
    else hue = 60 * ((rn - gn) / delta + 4)
    saturation = delta / (1 - Math.abs(2 * lightness - 1))
  }
  return {
    hue: normalizedHue(hue),
    saturation: normalizePoolIconSaturation(saturation * 100),
    brightness: normalizePoolIconBrightness(lightness * 100)
  }
}

export function parsePoolColorInput(value: string | null | undefined): ParsedPoolColor | undefined {
  if (typeof value !== 'string') return undefined
  const hex = normalizeHexColor(value)
  const rgb = hex ? rgbFromHexColor(hex) : parseRgbColorInput(value)
  if (!rgb) return undefined
  return {
    accent: rgbToHex(rgb),
    ...hslFromRgb(rgb)
  }
}

/** HSL(hue, saturation%, brightness%) -> uppercase #RRGGBB. AgentIdentityIcon only accepts hex. */
export function accentFromHue(
  hue: number,
  brightness = DEFAULT_POOL_ICON_BRIGHTNESS,
  saturation = DEFAULT_POOL_ICON_SATURATION
): string {
  const h = normalizedHue(hue)
  const s = normalizePoolIconSaturation(saturation) / 100
  const l = normalizePoolIconBrightness(brightness) / 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return rgbToHex({ r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 })
}

/** Neutral ink for a de-tinted (monochrome) pool icon. */
export const POOL_ICON_NEUTRAL = '#8A8F98'

/**
 * Resolve the ink for a pool icon, collapsing to a neutral tone when hue tinting
 * is switched off. Used by every colour path in {@link PooledAgentIcon} so the
 * toggle can't silently no-op for one icon kind.
 */
export function pooledIconColor(
  accent: string | undefined,
  hue: number,
  hueEnabled?: boolean,
  brightness?: number,
  saturation?: number
): string {
  if (hueEnabled === false) return POOL_ICON_NEUTRAL
  return normalizeHexColor(accent) || accentFromHue(hue, brightness, saturation)
}

export function pooledAgentIdentitySnapshot(agent: PooledAgent): PooledAgentIdentitySnapshot {
  const identity = agent.identity
  const nickname = identity.nickname.trim() || agent.config.role || 'Agent'
  const accent = normalizeHexColor(identity.accent)
  return {
    schemaVersion: 1,
    agentId: agent.agentId,
    nickname,
    iconKind: identity.iconKind,
    hue: normalizedHue(identity.hue),
    ...(typeof identity.saturation === 'number' && Number.isFinite(identity.saturation)
      ? { saturation: normalizePoolIconSaturation(identity.saturation) }
      : {}),
    ...(typeof identity.brightness === 'number' && Number.isFinite(identity.brightness)
      ? { brightness: normalizePoolIconBrightness(identity.brightness) }
      : {}),
    ...(accent ? { accent } : {}),
    ...(identity.slug ? { slug: identity.slug } : {}),
    ...(identity.assetKey ? { assetKey: identity.assetKey } : {}),
    ...(identity.seed ? { seed: identity.seed } : {}),
    ...(typeof identity.hueEnabled === 'boolean' ? { hueEnabled: identity.hueEnabled } : {})
  }
}

/**
 * Pick a fresh pool nickname. Prefers a non-blank `preferred` (the participant's
 * role) when it isn't already used in the pool, else walks the exported
 * `AGENT_NAME_POOL` for the first unused name, else appends a numeric suffix.
 * Pool-LOCAL — never the module-private chat-scoped picker in agentIdentity.ts —
 * so the pool and subagent name namespaces stay decoupled.
 */
export function pickNextPoolNickname(used: Set<string>, preferred?: string): string {
  const want = (preferred || '').trim()
  if (want && !used.has(want)) return want
  for (const candidate of AGENT_NAME_POOL) {
    if (!used.has(candidate)) return candidate
  }
  let suffix = 2
  while (true) {
    const candidate = `${AGENT_NAME_POOL[(suffix - 1) % AGENT_NAME_POOL.length]} ${suffix}`
    if (!used.has(candidate)) return candidate
    suffix += 1
  }
}

/**
 * Props for `<AgentIdentityIcon />` for a pooled Agent. Resolves a named asset
 * by slug; FALLS BACK to procedural seed rendering when `iconKind === 'named'`
 * but the slug no longer resolves (a real persistence failure if a future
 * release renames/removes an asset — the subagent registry is immune because it
 * reassigns every chat). Hue drives the procedural accent so "regenerate
 * procedural" rerolls glyph + hue together.
 */
export function pooledAgentIconProps(agent: PooledAgent): {
  name?: string
  seed?: string
  color: string
} {
  const { identity, agentId } = agent
  if (identity.iconKind === 'named' && identity.slug) {
    const entry = namedAgentIdenticonForSlug(identity.slug)
    if (entry) {
      return {
        name: entry.name,
        color: pooledIconColor(
          identity.accent,
          identity.hue,
          identity.hueEnabled,
          identity.brightness,
          identity.saturation
        )
      }
    }
    // Dangling slug — fall through to procedural rendering below.
  }
  return {
    seed: identity.seed || agentId,
    color: pooledIconColor(
      identity.accent,
      identity.hue,
      identity.hueEnabled,
      identity.brightness,
      identity.saturation
    )
  }
}

function seedIdentityForAgent(agentId: string, role: string, usedNicknames: Set<string>): PooledAgentIdentity {
  return {
    nickname: pickNextPoolNickname(usedNicknames, role),
    iconKind: 'seed',
    seed: agentId,
    hue: hueForSeed(agentId)
  }
}

// ── converters ──────────────────────────────────────────────────────────────

function cloneConfig(config: PooledAgentConfig): PooledAgentConfig {
  return {
    ...config,
    ...(config.permissionOverrides
      ? { permissionOverrides: clonePermissionOverrides(config.permissionOverrides) }
      : {})
  }
}

/** Strip a roster snapshot down to a reusable pooled-Agent config. */
export function participantSnapshotToPooledAgentConfig(
  snapshot: EnsembleRosterParticipantSnapshot
): PooledAgentConfig {
  return pooledAgentConfigFromLike(snapshot)
}

/**
 * Pick the config fields off any participant-like object (a live
 * `EnsembleParticipant` or a persisted snapshot). Permission overrides are
 * deep-cloned so the Agent never aliases a preset's mutable grant objects.
 */
export function pooledAgentConfigFromLike(
  source: Pick<EnsembleParticipant, keyof PooledAgentConfig>
): PooledAgentConfig {
  const config: PooledAgentConfig = {
    provider: source.provider,
    role: source.role,
    instructions: source.instructions
  }
  if (source.model) config.model = source.model
  if (source.runtimeProfileId) config.runtimeProfileId = source.runtimeProfileId
  if (source.geminiAuthProfileId != null) config.geminiAuthProfileId = source.geminiAuthProfileId
  if (source.permissionPresetId) config.permissionPresetId = source.permissionPresetId
  if (source.permissionOverrides)
    config.permissionOverrides = clonePermissionOverrides(source.permissionOverrides)
  if (source.reasoningEffort) config.reasoningEffort = source.reasoningEffort
  if (typeof source.fastModeEnabled === 'boolean') config.fastModeEnabled = source.fastModeEnabled
  if (typeof source.thinkingEnabled === 'boolean') config.thinkingEnabled = source.thinkingEnabled
  if (source.serviceTier) config.serviceTier = source.serviceTier
  return config
}

/**
 * Materialize a pooled Agent into a roster participant snapshot at `order`.
 * Always `enabled: true`, `isBossman: false` (an Agent never carries a stale
 * Boss flag), and carries `pooledAgentId` so the participant stays LINKED to the
 * Agent (config propagation + stats attribution).
 */
export function pooledAgentToParticipantSnapshot(
  agent: PooledAgent,
  order: number
): EnsembleRosterParticipantSnapshot {
  const config = cloneConfig(agent.config)
  return {
    provider: config.provider,
    enabled: true,
    role: config.role,
    instructions: config.instructions,
    order,
    pooledAgentId: agent.agentId,
    pooledAgentIdentity: pooledAgentIdentitySnapshot(agent),
    ...(config.model ? { model: config.model } : {}),
    ...(config.runtimeProfileId ? { runtimeProfileId: config.runtimeProfileId } : {}),
    ...(config.geminiAuthProfileId != null
      ? { geminiAuthProfileId: config.geminiAuthProfileId }
      : {}),
    ...(config.permissionPresetId ? { permissionPresetId: config.permissionPresetId } : {}),
    ...(config.permissionOverrides ? { permissionOverrides: config.permissionOverrides } : {}),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(typeof config.fastModeEnabled === 'boolean'
      ? { fastModeEnabled: config.fastModeEnabled }
      : {}),
    ...(typeof config.thinkingEnabled === 'boolean'
      ? { thinkingEnabled: config.thinkingEnabled }
      : {}),
    ...(config.serviceTier ? { serviceTier: config.serviceTier } : {})
  }
}

// ── validation ──────────────────────────────────────────────────────────────

function isPooledAgentIdentity(value: unknown): value is PooledAgentIdentity {
  if (!value || typeof value !== 'object') return false
  const entry = value as PooledAgentIdentity
  return (
    typeof entry.nickname === 'string' &&
    (entry.iconKind === 'named' || entry.iconKind === 'seed' || entry.iconKind === 'asset') &&
    typeof entry.hue === 'number' &&
    Number.isFinite(entry.hue) &&
    (entry.saturation === undefined ||
      (typeof entry.saturation === 'number' && Number.isFinite(entry.saturation))) &&
    (entry.brightness === undefined ||
      (typeof entry.brightness === 'number' && Number.isFinite(entry.brightness)))
  )
}

function isPooledAgentConfig(value: unknown): value is PooledAgentConfig {
  if (!value || typeof value !== 'object') return false
  const entry = value as PooledAgentConfig
  return (
    typeof entry.provider === 'string' &&
    typeof entry.role === 'string' &&
    typeof entry.instructions === 'string'
  )
}

function isPooledAgent(value: unknown): value is PooledAgent {
  if (!value || typeof value !== 'object') return false
  const entry = value as PooledAgent
  return (
    isPooledAgentId(entry.agentId) &&
    typeof entry.createdAt === 'number' &&
    Number.isFinite(entry.createdAt) &&
    typeof entry.updatedAt === 'number' &&
    Number.isFinite(entry.updatedAt) &&
    entry.schemaVersion === 1 &&
    isPooledAgentIdentity(entry.identity) &&
    isPooledAgentConfig(entry.config)
  )
}

// ── persistence + cross-window sync ─────────────────────────────────────────

function readRawPool(): PooledAgent[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isPooledAgent)
  } catch {
    return []
  }
}

function writeRawPool(agents: PooledAgent[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(agents))
}

/*
 * Same discipline as the preset store: synchronous in-window fan-out PLUS a
 * cross-window `storage` event bridge, both funneling into `poolListeners`.
 * The bridge is its OWN module-scoped, key-filtered handler — it must NOT be
 * shared with the preset bridge (that one filters on the preset key). Same-
 * window writes never get a `storage` event, so the synchronous fan-out is the
 * only thing that re-renders the pool band after a same-window edit/drop.
 * Listener callbacks MUST be read-only (re-read + setState), never write.
 */
const poolListeners = new Set<() => void>()
let storageBridged = false

function notifyPoolListeners(): void {
  for (const listener of [...poolListeners]) {
    try {
      listener()
    } catch {
      // A misbehaving subscriber must never break a persist.
    }
  }
}

function ensureStorageBridge(): void {
  if (storageBridged) return
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  storageBridged = true
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== window.localStorage) return
    if (event.key !== STORAGE_KEY || event.newValue === null) return
    notifyPoolListeners()
  })
}

/**
 * Subscribe to pool changes (this window's writes + other windows' `storage`
 * events). Returns an unsubscribe for a `useEffect` cleanup. The callback should
 * re-read via `listPooledAgents()` and must not itself write.
 */
export function subscribeEnsembleAgentPool(listener: () => void): () => void {
  ensureStorageBridge()
  poolListeners.add(listener)
  return () => {
    poolListeners.delete(listener)
  }
}

export function listPooledAgents(): PooledAgent[] {
  return readRawPool().sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getPooledAgent(agentId: string): PooledAgent | null {
  return readRawPool().find((agent) => agent.agentId === agentId) ?? null
}

/**
 * Replace (or insert) an Agent by id. Clobber-safe: FRESH-READS immediately
 * before writing and splices only the target, so a concurrent edit to a
 * DIFFERENT Agent in another window is preserved. `updatedAt` is stamped here.
 * By default, propagates the (possibly edited) config to every LINKED roster
 * preset participant; pass `{ propagate: false }` to skip (e.g. unit tests or a
 * pure-create path with no links yet).
 */
export function upsertPooledAgent(
  agent: PooledAgent,
  options: { propagate?: boolean } = {}
): PooledAgent {
  if (!isPooledAgent(agent)) {
    throw new Error('Refusing to persist an invalid pooled agent.')
  }
  const stamped: PooledAgent = { ...agent, updatedAt: Date.now() }
  const agents = readRawPool()
  const index = agents.findIndex((existing) => existing.agentId === stamped.agentId)
  if (index >= 0) {
    agents[index] = stamped
  } else {
    agents.unshift(stamped)
  }
  writeRawPool(agents)
  notifyPoolListeners()
  if (options.propagate !== false) {
    propagatePooledAgentToPresets(stamped)
  }
  return stamped
}

export function removePooledAgent(agentId: string): void {
  const next = readRawPool().filter((agent) => agent.agentId !== agentId)
  writeRawPool(next)
  notifyPoolListeners()
}

/**
 * Mint a new pooled Agent from a participant-like config. Reads the current pool
 * to seed a non-colliding nickname + a deterministic procedural icon/hue from
 * the fresh agentId, persists, notifies, and returns the Agent.
 */
export function createPooledAgentFromParticipant(
  source: Pick<EnsembleParticipant, keyof PooledAgentConfig>
): PooledAgent {
  const config = pooledAgentConfigFromLike(source)
  const now = Date.now()
  const agentId = newAgentId()
  const used = new Set(listPooledAgents().map((agent) => agent.identity.nickname))
  const agent: PooledAgent = {
    agentId,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
    identity: seedIdentityForAgent(agentId, config.role, used),
    config
  }
  // A brand-new Agent has no linked presets yet — skip the propagation sweep.
  return upsertPooledAgent(agent, { propagate: false })
}

// ── linked propagation ──────────────────────────────────────────────────────

/** Deterministic JSON with recursively-sorted keys, so two structurally-equal
 *  objects compare equal regardless of key insertion order (e.g. a permission
 *  grant map rebuilt via delete+reassign). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',')}}`
}

function configFieldsEqual(a: PooledAgentConfig, b: PooledAgentConfig): boolean {
  for (const key of POOLED_AGENT_CONFIG_KEYS) {
    if (key === 'permissionOverrides') {
      // Structural (key-order-insensitive) — a JSON.stringify mismatch from a
      // reordered grant map would otherwise force a spurious propagation write.
      if (stableStringify(a.permissionOverrides) !== stableStringify(b.permissionOverrides)) {
        return false
      }
    } else if (a[key] !== b[key]) {
      return false
    }
  }
  return true
}

function pooledAgentIdentityEqual(
  a: PooledAgentIdentitySnapshot | undefined,
  b: PooledAgentIdentitySnapshot
): boolean {
  return stableStringify(a) === stableStringify(b)
}

export function applyPooledAgentIdentityToParticipant(
  participant: EnsembleParticipant
): EnsembleParticipant {
  if (!participant.pooledAgentId) return participant
  const agent = getPooledAgent(participant.pooledAgentId)
  if (!agent) return participant
  const identity = pooledAgentIdentitySnapshot(agent)
  return pooledAgentIdentityEqual(participant.pooledAgentIdentity, identity)
    ? participant
    : { ...participant, pooledAgentId: agent.agentId, pooledAgentIdentity: identity }
}

export function hydrateParticipantsWithPooledAgentIdentity(
  participants: EnsembleParticipant[]
): EnsembleParticipant[] {
  let changed = false
  const next = participants.map((participant) => {
    const hydrated = applyPooledAgentIdentityToParticipant(participant)
    if (hydrated !== participant) changed = true
    return hydrated
  })
  return changed ? next : participants
}

/**
 * Reconcile a LIVE participant against its linked pooled Agent: if it carries a
 * `pooledAgentId` that resolves to a current Agent whose config differs, return
 * a new participant with the Agent's config overwritten (preserving id / order /
 * enabled / pooledAgentId). Returns the SAME reference when nothing changed, so
 * a settings editor can patch its working copy only when the Agent actually
 * moved — keeping the open editor from clobbering a propagation on its next
 * commit. Permission overrides are deep-cloned (no aliasing the Agent's).
 */
export function applyPooledAgentToParticipant(participant: EnsembleParticipant): EnsembleParticipant {
  if (!participant.pooledAgentId) return participant
  const agent = getPooledAgent(participant.pooledAgentId)
  if (!agent) return participant
  const identity = pooledAgentIdentitySnapshot(agent)
  if (
    configFieldsEqual(pooledAgentConfigFromLike(participant), agent.config) &&
    pooledAgentIdentityEqual(participant.pooledAgentIdentity, identity)
  ) {
    return participant
  }
  const config = cloneConfig(agent.config)
  return {
    ...participant,
    pooledAgentId: agent.agentId,
    pooledAgentIdentity: identity,
    provider: config.provider,
    role: config.role,
    instructions: config.instructions,
    model: config.model,
    runtimeProfileId: config.runtimeProfileId,
    geminiAuthProfileId: config.geminiAuthProfileId ?? null,
    permissionPresetId: config.permissionPresetId,
    permissionOverrides: config.permissionOverrides,
    reasoningEffort: config.reasoningEffort,
    fastModeEnabled: config.fastModeEnabled,
    thinkingEnabled: config.thinkingEnabled,
    serviceTier: config.serviceTier
  }
}

/**
 * Overwrite a linked snapshot's config fields from the Agent, PRESERVING the
 * preset-positional fields (order / isBossman / enabled) and the link itself
 * (pooledAgentId). Returns the same reference when nothing changed so callers
 * can skip a needless preset write.
 */
function applyAgentConfigToSnapshot(
  snapshot: EnsembleRosterParticipantSnapshot,
  agent: PooledAgent
): EnsembleRosterParticipantSnapshot {
  const desired = pooledAgentToParticipantSnapshot(agent, snapshot.order)
  const identity = pooledAgentIdentitySnapshot(agent)
  const next: EnsembleRosterParticipantSnapshot = {
    ...desired,
    order: snapshot.order,
    enabled: snapshot.enabled,
    ...(snapshot.isBossman ? { isBossman: true } : {}),
    pooledAgentId: agent.agentId,
    pooledAgentIdentity: identity
  }
  const before = participantSnapshotToPooledAgentConfig(snapshot)
  const after = participantSnapshotToPooledAgentConfig(next)
  return configFieldsEqual(before, after) &&
    pooledAgentIdentityEqual(snapshot.pooledAgentIdentity, identity)
    ? snapshot
    : next
}

/**
 * Propagate a pooled Agent's config to every roster-preset participant linked to
 * it (LINKED reuse). Reads the preset store fresh, rewrites only presets that
 * actually changed (each via the clobber-safe `upsertEnsembleRosterPreset`,
 * which bumps `updatedAt` and notifies preset listeners). One-way dependency
 * pool -> presets; the preset store never imports the pool, so no cycle.
 */
export function propagatePooledAgentToPresets(agent: PooledAgent): void {
  if (typeof window === 'undefined') return
  for (const preset of listEnsembleRosterPresets()) {
    let changed = false
    const participants = preset.participants.map((snapshot) => {
      if (snapshot.pooledAgentId !== agent.agentId) return snapshot
      const next = applyAgentConfigToSnapshot(snapshot, agent)
      if (next !== snapshot) changed = true
      return next
    })
    if (changed) {
      try {
        upsertEnsembleRosterPreset({ ...preset, participants, updatedAt: Date.now() })
      } catch {
        // A single malformed preset must not abort the rest of the sweep.
      }
    }
  }
}

/** Exported for tests. */
export const POOLED_AGENT_STORAGE_KEY = STORAGE_KEY
