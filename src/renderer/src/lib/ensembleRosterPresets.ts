import type {
  EnsembleConfig,
  EnsembleFanoutPolicy,
  EnsembleParticipant,
  PermissionOverrides,
  ProviderId
} from '../../../main/store/types'
import {
  cloneEnsembleRosterPreset,
  ENSEMBLE_ROSTER_PRESET_EXPORT_FORMAT,
  ENSEMBLE_ROSTER_PRESET_EXPORT_VERSION,
  isEnsembleRosterPreset,
  MAX_ROSTER_PRESET_PARTICIPANTS,
  MIN_ROSTER_PRESET_PARTICIPANTS,
  parseEnsembleRosterPresetJson,
  safeRosterPermissionPresetId,
  type EnsembleRosterParticipantSnapshot,
  type EnsembleRosterPreset,
  type EnsembleRosterPresetsExportPayload,
  type EnsembleRosterPresetsImportResult
} from '../../../main/EnsembleRosterPresetContract'
import {
  getDefaultEnsembleParticipantConfig,
  getDefaultEnsembleRoleName
} from './ensembleProviderDefaults'

export {
  MAX_ROSTER_PRESET_PARTICIPANTS,
  MIN_ROSTER_PRESET_PARTICIPANTS,
  type EnsembleRosterParticipantSnapshot,
  type EnsembleRosterPreset,
  type EnsembleRosterPresetsExportPayload,
  type EnsembleRosterPresetsImportResult
} from '../../../main/EnsembleRosterPresetContract'

const STORAGE_KEY = 'taskwraith-ensemble-roster-presets'
const ENSEMBLE_FANOUT_POLICIES = new Set<EnsembleFanoutPolicy>([
  'off',
  'read_only',
  'all',
  'locked_writers_with_boss',
  'locked_writers_user_preflight'
])

const DEFAULT_ROSTER_PRESET_MAX_PARTICIPANTS = 6

function newPresetId(now: number): string {
  return `ensemble-roster-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function clonePermissionOverrides(
  overrides: PermissionOverrides | undefined
): PermissionOverrides | undefined {
  if (!overrides) return undefined
  return {
    // `approvalMode` (string) and `networkAccess` ('allow' | 'deny' string
    // union) are primitives, carried safely by the spread. `agenticServices`
    // is a string→string map, so a one-level clone fully isolates it. Only
    // `externalPathGrants` holds nested objects — its ELEMENTS must each be
    // cloned. A bare `[...arr]` copies the array but aliases the grant
    // objects, so an in-place edit of one snapshot's grant would mutate every
    // other copy AND any live chat the preset was applied to.
    ...overrides,
    ...(overrides.agenticServices
      ? { agenticServices: { ...overrides.agenticServices } }
      : {}),
    ...(overrides.externalPathGrants
      ? { externalPathGrants: overrides.externalPathGrants.map((grant) => ({ ...grant })) }
      : {})
  }
}

function readRawPresets(): EnsembleRosterPreset[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEnsembleRosterPreset)
  } catch {
    return []
  }
}

function normalizeRosterFanoutPolicy(
  value: unknown,
  legacyEnabled?: boolean
): EnsembleFanoutPolicy {
  return ENSEMBLE_FANOUT_POLICIES.has(value as EnsembleFanoutPolicy)
    ? (value as EnsembleFanoutPolicy)
    : legacyEnabled
      ? 'read_only'
      : 'off'
}

function writeRawPresets(presets: EnsembleRosterPreset[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets))
}

function cloneRosterPreset(preset: EnsembleRosterPreset): EnsembleRosterPreset {
  return cloneEnsembleRosterPreset(preset)
}

function uniqueImportedRosterName(name: string, usedNames: Set<string>): string {
  const base = name.trim() || 'Imported roster'
  if (!usedNames.has(base)) return base
  const importedBase = `${base} imported`
  if (!usedNames.has(importedBase)) return importedBase
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${importedBase} ${n}`
    if (!usedNames.has(candidate)) return candidate
  }
  return `${importedBase} ${usedNames.size + 1}`
}

function uniqueImportedRosterId(now: number, usedIds: Set<string>): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const id = newPresetId(now + attempt)
    if (!usedIds.has(id)) {
      usedIds.add(id)
      return id
    }
  }
  const fallback = `ensemble-roster-import-${now.toString(36)}-${usedIds.size}`
  usedIds.add(fallback)
  return fallback
}

function importedRosterPreset(
  preset: EnsembleRosterPreset,
  now: number,
  usedNames: Set<string>,
  usedIds: Set<string>
): EnsembleRosterPreset {
  const next = cloneRosterPreset(preset)
  const name = uniqueImportedRosterName(next.name, usedNames)
  usedNames.add(name)
  return {
    ...next,
    id: uniqueImportedRosterId(now, usedIds),
    name,
    createdAt: now,
    updatedAt: now
  }
}

/*
 * Cross-surface refresh. Presets are renderer-local (localStorage), but two
 * surfaces read them — the composer's `EnsembleRosterPresetPicker` and the
 * Settings → Roster tab — and Electron multiview / chat pop-out windows share
 * the same origin (hence the same localStorage). Same-window writers fan out
 * synchronously via `notifyPresetListeners`; other windows are reached by the
 * browser's `storage` event (which fires only in OTHER documents, never the
 * writer's own — so both paths are required). Listener callbacks MUST be
 * read-only (re-read + setState); they must never write, or a storage-driven
 * refresh in window B could write and ping-pong back to window A.
 */
const presetListeners = new Set<() => void>()
let storageBridged = false

function notifyPresetListeners(): void {
  for (const listener of [...presetListeners]) {
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
    notifyPresetListeners()
  })
}

/**
 * Subscribe to roster-preset changes (this window's writes + other windows'
 * `storage` events). Returns an unsubscribe to call from a `useEffect`
 * cleanup. The callback should re-read via `listEnsembleRosterPresets()` and
 * must not itself write.
 */
export function subscribeEnsembleRosterPresets(listener: () => void): () => void {
  ensureStorageBridge()
  presetListeners.add(listener)
  return () => {
    presetListeners.delete(listener)
  }
}

export function listEnsembleRosterPresets(): EnsembleRosterPreset[] {
  return readRawPresets().sort((a, b) => b.updatedAt - a.updatedAt)
}

export function saveEnsembleRosterPreset(
  name: string,
  ensemble: EnsembleConfig
): EnsembleRosterPreset {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error('Preset name is required.')
  }
  const now = Date.now()
  const preset = buildEnsembleRosterPresetFromConfig(trimmed, ensemble, now)
  const presets = readRawPresets()
  presets.unshift(preset)
  writeRawPresets(presets)
  notifyPresetListeners()
  return preset
}

export function renameEnsembleRosterPreset(id: string, name: string): EnsembleRosterPreset | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  const presets = readRawPresets()
  const index = presets.findIndex((preset) => preset.id === id)
  if (index < 0) return null
  const next: EnsembleRosterPreset = {
    ...presets[index],
    name: trimmed,
    updatedAt: Date.now()
  }
  presets[index] = next
  writeRawPresets(presets)
  notifyPresetListeners()
  return next
}

export function deleteEnsembleRosterPreset(id: string): void {
  writeRawPresets(readRawPresets().filter((preset) => preset.id !== id))
  notifyPresetListeners()
}

export function buildEnsembleRosterPresetFromConfig(
  name: string,
  ensemble: EnsembleConfig,
  now = Date.now()
): EnsembleRosterPreset {
  return {
    id: newPresetId(now),
    name: name.trim(),
    createdAt: now,
    updatedAt: now,
    orchestrationMode:
      ensemble.orchestrationMode === 'continuous' ? 'continuous' : 'turn_bound',
    maxParticipants: Math.max(
      MIN_ROSTER_PRESET_PARTICIPANTS,
      Math.min(MAX_ROSTER_PRESET_PARTICIPANTS, ensemble.maxParticipants)
    ),
    ...(typeof ensemble.maxContinuationHops === 'number'
      ? { maxContinuationHops: ensemble.maxContinuationHops }
      : {}),
    fanoutPolicy: normalizeRosterFanoutPolicy(
      ensemble.fanoutPolicy,
      ensemble.concurrentModeEnabled
    ),
    ...(typeof ensemble.concurrentModeEnabled === 'boolean'
      ? { concurrentModeEnabled: ensemble.concurrentModeEnabled }
      : {}),
    ...(typeof ensemble.ensembleContextChars === 'number'
      ? { ensembleContextChars: ensemble.ensembleContextChars }
      : {}),
    participants: snapshotParticipantsForPreset(
      ensemble.participants || [],
      ensemble.bossmanParticipantId,
      ensemble.secondInCommandParticipantId
    )
  }
}

/**
 * Snapshot a working list of live participants into preset snapshots,
 * densely renumbering `order` to 1..N (sorted by current order) so a
 * reorder/add/remove never persists fractional or duplicate orders. Reused by
 * `buildEnsembleRosterPresetFromConfig` and the Settings → Roster editor.
 */
export function snapshotParticipantsForPreset(
  participants: EnsembleParticipant[],
  bossmanParticipantId?: string,
  secondInCommandParticipantId?: string
): EnsembleRosterParticipantSnapshot[] {
  const sorted = [...participants].sort((a, b) => a.order - b.order)
  return sorted.map((participant, index) =>
    snapshotParticipant(
      participant,
      index + 1,
      participant.id === bossmanParticipantId,
      participant.id === secondInCommandParticipantId && participant.id !== bossmanParticipantId
    )
  )
}

function snapshotParticipant(
  participant: EnsembleParticipant,
  order: number,
  isBossman = false,
  isSecondInCommand = false
): EnsembleRosterParticipantSnapshot {
  return {
    provider: participant.provider,
    enabled: participant.enabled,
    role: participant.role,
    instructions: participant.instructions,
    order,
    ...(isBossman ? { isBossman: true } : {}),
    ...(isSecondInCommand ? { isSecondInCommand: true } : {}),
    ...(participant.pooledAgentId ? { pooledAgentId: participant.pooledAgentId } : {}),
    ...(participant.pooledAgentIdentity
      ? { pooledAgentIdentity: participant.pooledAgentIdentity }
      : {}),
    ...(participant.model ? { model: participant.model } : {}),
    ...(participant.runtimeProfileId ? { runtimeProfileId: participant.runtimeProfileId } : {}),
    ...(participant.geminiAuthProfileId != null
      ? { geminiAuthProfileId: participant.geminiAuthProfileId }
      : {}),
    ...(safeRosterPermissionPresetId(participant.permissionPresetId)
      ? { permissionPresetId: safeRosterPermissionPresetId(participant.permissionPresetId) }
      : {}),
    ...(participant.permissionOverrides
      ? { permissionOverrides: clonePermissionOverrides(participant.permissionOverrides) }
      : {}),
    ...(participant.stageRole ? { stageRole: participant.stageRole } : {}),
    ...(participant.reasoningEffort ? { reasoningEffort: participant.reasoningEffort } : {}),
    ...(typeof participant.fastModeEnabled === 'boolean'
      ? { fastModeEnabled: participant.fastModeEnabled }
      : {}),
    ...(typeof participant.thinkingEnabled === 'boolean'
      ? { thinkingEnabled: participant.thinkingEnabled }
      : {}),
    ...(participant.serviceTier ? { serviceTier: participant.serviceTier } : {})
  }
}

function nextParticipantId(existing: Set<string>, index: number): string {
  for (let attempt = index; attempt < index + 32; attempt += 1) {
    const id = `ensemble-participant-${attempt}`
    if (!existing.has(id)) return id
  }
  return `ensemble-participant-${Date.now().toString(36)}`
}

export function materializeParticipantsFromPreset(
  snapshots: EnsembleRosterParticipantSnapshot[]
): EnsembleParticipant[] {
  return materializeParticipantsFromPresetWithBossman(snapshots).participants
}

export function materializeParticipantsFromPresetWithBossman(
  snapshots: EnsembleRosterParticipantSnapshot[]
): {
  participants: EnsembleParticipant[]
  bossmanParticipantId?: string
  secondInCommandParticipantId?: string
} {
  const sorted = [...snapshots].sort((a, b) => a.order - b.order)
  const existing = new Set<string>()
  let bossmanParticipantId: string | undefined
  let secondInCommandParticipantId: string | undefined
  const participants = sorted.map((snapshot, index) => {
    const id = nextParticipantId(existing, index + 1)
    existing.add(id)
    if (snapshot.isBossman === true && !bossmanParticipantId) {
      bossmanParticipantId = id
    }
    if (
      snapshot.isSecondInCommand === true &&
      !secondInCommandParticipantId &&
      snapshot.isBossman !== true
    ) {
      secondInCommandParticipantId = id
    }
    return {
      id,
      provider: snapshot.provider,
      enabled: snapshot.enabled,
      role: snapshot.role,
      instructions: snapshot.instructions,
      order: index + 1,
      ...(snapshot.pooledAgentId ? { pooledAgentId: snapshot.pooledAgentId } : {}),
      ...(snapshot.pooledAgentIdentity
        ? { pooledAgentIdentity: snapshot.pooledAgentIdentity }
        : {}),
      ...(snapshot.model ? { model: snapshot.model } : {}),
      ...(snapshot.runtimeProfileId ? { runtimeProfileId: snapshot.runtimeProfileId } : {}),
      geminiAuthProfileId:
        snapshot.provider === 'gemini' ? (snapshot.geminiAuthProfileId ?? null) : null,
      ...(safeRosterPermissionPresetId(snapshot.permissionPresetId)
        ? { permissionPresetId: safeRosterPermissionPresetId(snapshot.permissionPresetId) }
        : {}),
      ...(snapshot.permissionOverrides
        ? { permissionOverrides: clonePermissionOverrides(snapshot.permissionOverrides) }
        : {}),
      ...(snapshot.stageRole ? { stageRole: snapshot.stageRole } : {}),
      ...(snapshot.reasoningEffort ? { reasoningEffort: snapshot.reasoningEffort } : {}),
      ...(typeof snapshot.fastModeEnabled === 'boolean'
        ? { fastModeEnabled: snapshot.fastModeEnabled }
        : {}),
      ...(typeof snapshot.thinkingEnabled === 'boolean'
        ? { thinkingEnabled: snapshot.thinkingEnabled }
        : {}),
      ...(snapshot.serviceTier ? { serviceTier: snapshot.serviceTier } : {}),
      linkedProviderSessionId: null
    }
  })
  return { participants, bossmanParticipantId, secondInCommandParticipantId }
}

function cloneSnapshot(
  snapshot: EnsembleRosterParticipantSnapshot
): EnsembleRosterParticipantSnapshot {
  return {
    ...snapshot,
    ...(snapshot.permissionOverrides
      ? { permissionOverrides: clonePermissionOverrides(snapshot.permissionOverrides) }
      : {})
  }
}

export function defaultParticipantForProvider(
  provider: ProviderId,
  id: string,
  order: number
): EnsembleParticipant {
  const defaults = getDefaultEnsembleParticipantConfig(provider)
  return {
    id,
    provider,
    enabled: true,
    role: getDefaultEnsembleRoleName(provider),
    instructions: '',
    order,
    model: defaults.model,
    geminiAuthProfileId: null,
    permissionPresetId: defaults.permissionPresetId,
    ...(defaults.reasoningEffort ? { reasoningEffort: defaults.reasoningEffort } : {}),
    ...(typeof defaults.fastModeEnabled === 'boolean'
      ? { fastModeEnabled: defaults.fastModeEnabled }
      : {}),
    ...(typeof defaults.thinkingEnabled === 'boolean'
      ? { thinkingEnabled: defaults.thinkingEnabled }
      : {}),
    ...(defaults.serviceTier ? { serviceTier: defaults.serviceTier } : {}),
    linkedProviderSessionId: null
  }
}

/** Look up a single preset by id (null if unknown). */
export function getEnsembleRosterPreset(id: string): EnsembleRosterPreset | null {
  return readRawPresets().find((preset) => preset.id === id) ?? null
}

/**
 * Save a roster preset from a paired device's participant list (iOS Roster
 * page → bridge → main → here). The participants arrive in the roster-update
 * wire shape (provider / role / brief / model / permission / reasoning / …);
 * we map them to snapshots and persist via the clobber-safe upsert, whose
 * notify re-syncs the projected list back to iOS.
 */
export function saveEnsembleRosterPresetFromParticipants(
  name: string,
  participants: Array<{
    provider: string
    role?: string
    brief?: string
    model?: string
    enabled?: boolean
    permissionPresetId?: string
    reasoningEffort?: string
    fastModeEnabled?: boolean
    thinkingEnabled?: boolean
    /** Staged fan-out stage; other values are ignored. */
    stageRole?: string
    isBossman?: boolean
    isSecondInCommand?: boolean
  }>
): EnsembleRosterPreset {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error('Preset name is required.')
  }
  const bossmanIndex = participants.findIndex((participant) => participant.isBossman === true)
  const secondInCommandIndex = participants.findIndex(
    (participant, index) => participant.isSecondInCommand === true && index !== bossmanIndex
  )
  const snapshots: EnsembleRosterParticipantSnapshot[] = participants
    .slice(0, MAX_ROSTER_PRESET_PARTICIPANTS)
    .map((participant, index) => ({
      provider: participant.provider as ProviderId,
      enabled: participant.enabled ?? true,
      role: participant.role || '',
      instructions: participant.brief || '',
      order: index + 1,
      ...(index === bossmanIndex ? { isBossman: true } : {}),
      ...(index === secondInCommandIndex ? { isSecondInCommand: true } : {}),
      ...(participant.model ? { model: participant.model } : {}),
      ...(safeRosterPermissionPresetId(participant.permissionPresetId)
        ? { permissionPresetId: safeRosterPermissionPresetId(participant.permissionPresetId) }
        : {}),
      ...(participant.reasoningEffort ? { reasoningEffort: participant.reasoningEffort } : {}),
      ...(typeof participant.fastModeEnabled === 'boolean'
        ? { fastModeEnabled: participant.fastModeEnabled }
        : {}),
      ...(typeof participant.thinkingEnabled === 'boolean'
        ? { thinkingEnabled: participant.thinkingEnabled }
        : {}),
      ...(participant.stageRole === 'scout' ||
      participant.stageRole === 'worker' ||
      participant.stageRole === 'reviewer' ||
      participant.stageRole === 'background'
        ? { stageRole: participant.stageRole }
        : {})
    }))
  const now = Date.now()
  const preset: EnsembleRosterPreset = {
    id: newPresetId(now),
    name: trimmed,
    createdAt: now,
    updatedAt: now,
    orchestrationMode: 'turn_bound',
    maxParticipants: Math.max(MIN_ROSTER_PRESET_PARTICIPANTS, snapshots.length),
    participants: snapshots
  }
  return upsertEnsembleRosterPreset(preset)
}

/**
 * Create + persist a new roster preset seeded with a practical
 * two-participant starter lineup. The returned preset already passes
 * `isEnsembleRosterPreset`, so it survives the next `readRawPresets`.
 */
export function createEmptyEnsembleRosterPreset(name: string): EnsembleRosterPreset {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error('Preset name is required.')
  }
  const now = Date.now()
  const seeded: EnsembleParticipant[] = [
    defaultParticipantForProvider('claude', 'ensemble-participant-1', 1),
    defaultParticipantForProvider('codex', 'ensemble-participant-2', 2)
  ]
  const preset: EnsembleRosterPreset = {
    id: newPresetId(now),
    name: trimmed,
    createdAt: now,
    updatedAt: now,
    orchestrationMode: 'turn_bound',
    maxParticipants: DEFAULT_ROSTER_PRESET_MAX_PARTICIPANTS,
    participants: snapshotParticipantsForPreset(seeded)
  }
  const presets = readRawPresets()
  presets.unshift(preset)
  writeRawPresets(presets)
  notifyPresetListeners()
  return preset
}

/**
 * Duplicate an existing preset under a fresh id + timestamps + a " copy"
 * suffix. Participants are deep-cloned so the copy and original never share
 * mutable permission objects. Returns null if the source id is unknown.
 */
export function duplicateEnsembleRosterPreset(id: string): EnsembleRosterPreset | null {
  const presets = readRawPresets()
  const source = presets.find((preset) => preset.id === id)
  if (!source) return null
  const now = Date.now()
  const copy: EnsembleRosterPreset = {
    ...source,
    id: newPresetId(now),
    name: `${source.name} copy`,
    createdAt: now,
    updatedAt: now,
    participants: source.participants.map(cloneSnapshot)
  }
  presets.unshift(copy)
  writeRawPresets(presets)
  notifyPresetListeners()
  return copy
}

/**
 * Replace (or insert) a preset by id. Clobber-safe: it FRESH-READS the array
 * immediately before writing and splices only the target preset, so a
 * concurrent edit to a DIFFERENT preset in another window is preserved
 * (mirrors the read-modify-write discipline in workspaceRemoteAccess.ts).
 * `updatedAt` is caller-controlled so the editor can bump it on structural
 * changes only, not every keystroke. Throws on an invalid preset rather than
 * letting `readRawPresets` silently drop it on the next read.
 */
export function upsertEnsembleRosterPreset(preset: EnsembleRosterPreset): EnsembleRosterPreset {
  if (!isEnsembleRosterPreset(preset)) {
    throw new Error('Refusing to persist an invalid ensemble roster preset.')
  }
  const presets = readRawPresets()
  const index = presets.findIndex((existing) => existing.id === preset.id)
  if (index >= 0) {
    presets[index] = preset
  } else {
    presets.unshift(preset)
  }
  writeRawPresets(presets)
  notifyPresetListeners()
  return preset
}

export function serializeEnsembleRosterPresetsForExport(
  presets = listEnsembleRosterPresets()
): string {
  const payload: EnsembleRosterPresetsExportPayload = {
    format: ENSEMBLE_ROSTER_PRESET_EXPORT_FORMAT,
    version: ENSEMBLE_ROSTER_PRESET_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    presets: presets.map(cloneRosterPreset)
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

export function importEnsembleRosterPresetsFromJson(
  json: string,
  now = Date.now()
): EnsembleRosterPresetsImportResult {
  const { candidates } = parseEnsembleRosterPresetJson(json)

  const existing = readRawPresets()
  const usedNames = new Set(existing.map((preset) => preset.name))
  const usedIds = new Set(existing.map((preset) => preset.id))
  const imported: EnsembleRosterPreset[] = []
  let skippedCount = 0

  for (const candidate of candidates) {
    if (!isEnsembleRosterPreset(candidate)) {
      skippedCount += 1
      continue
    }
    imported.push(importedRosterPreset(candidate, now - imported.length, usedNames, usedIds))
  }

  if (imported.length === 0) {
    throw new Error('No valid roster presets were found in that JSON file.')
  }

  writeRawPresets([...imported, ...existing])
  notifyPresetListeners()
  return {
    importedCount: imported.length,
    skippedCount,
    presets: imported
  }
}
