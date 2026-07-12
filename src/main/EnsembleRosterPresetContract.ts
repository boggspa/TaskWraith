import type {
  EnsembleFanoutPolicy,
  EnsembleOrchestrationMode,
  EnsembleStageRole,
  PermissionOverrides,
  PermissionPresetId,
  PooledAgentIdentitySnapshot,
  ProviderId
} from './store/types'

/**
 * Portable Ensemble roster-preset interchange contract.
 *
 * Settings -> Roster, the composer preset picker, paired devices, and the
 * agent-facing roster importer all use this exact shape. Keep parsing here so
 * an agent-created export cannot be accepted by one surface and silently
 * dropped by another.
 */
export const ENSEMBLE_ROSTER_PRESET_EXPORT_FORMAT = 'taskwraith.ensembleRosterPresets'
export const ENSEMBLE_ROSTER_PRESET_EXPORT_VERSION = 1

export const MIN_ROSTER_PRESET_PARTICIPANTS = 1
export const MAX_ROSTER_PRESET_PARTICIPANTS = 20

const ENSEMBLE_FANOUT_POLICIES = new Set<EnsembleFanoutPolicy>([
  'off',
  'read_only',
  'all',
  'locked_writers_with_boss',
  'locked_writers_user_preflight'
])

const ENSEMBLE_STAGE_ROLES = new Set<EnsembleStageRole>([
  'scout',
  'worker',
  'reviewer',
  'background'
])

export type EnsembleRosterParticipantSnapshot = {
  provider: ProviderId
  enabled: boolean
  role: string
  instructions: string
  order: number
  isBossman?: boolean
  isSecondInCommand?: boolean
  pooledAgentId?: string
  pooledAgentIdentity?: PooledAgentIdentitySnapshot
  model?: string
  runtimeProfileId?: string
  geminiAuthProfileId?: string | null
  permissionPresetId?: PermissionPresetId
  permissionOverrides?: PermissionOverrides
  stageRole?: EnsembleStageRole
  reasoningEffort?: string
  fastModeEnabled?: boolean
  thinkingEnabled?: boolean
  serviceTier?: string
}

export type EnsembleRosterPreset = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  orchestrationMode: EnsembleOrchestrationMode
  maxParticipants: number
  maxContinuationHops?: number
  fanoutPolicy?: EnsembleFanoutPolicy
  concurrentModeEnabled?: boolean
  ensembleContextChars?: number
  participants: EnsembleRosterParticipantSnapshot[]
}

export type EnsembleRosterPresetsExportPayload = {
  format: typeof ENSEMBLE_ROSTER_PRESET_EXPORT_FORMAT
  version: typeof ENSEMBLE_ROSTER_PRESET_EXPORT_VERSION
  exportedAt: string
  presets: EnsembleRosterPreset[]
}

export type EnsembleRosterPresetsImportResult = {
  importedCount: number
  skippedCount: number
  presets: EnsembleRosterPreset[]
}

export type EnsembleRosterPresetImportRequest = {
  requestId: string
  json: string
  source?: string
}

export type EnsembleRosterPresetImportAcknowledgement = {
  requestId: string
  ok: boolean
  importedCount?: number
  presetId?: string
  presetName?: string
  error?: string
}

export function safeRosterPermissionPresetId(
  value: unknown
): PermissionPresetId | undefined {
  if (
    value === 'read_only' ||
    value === 'plan' ||
    value === 'default' ||
    value === 'workspace_write' ||
    value === 'custom'
  ) {
    return value
  }
  // Trusted Session is live lane authority, not portable roster configuration.
  if (value === 'full_access') return 'workspace_write'
  return undefined
}

export function isEnsembleRosterParticipantSnapshot(
  value: unknown
): value is EnsembleRosterParticipantSnapshot {
  if (!value || typeof value !== 'object') return false
  const entry = value as EnsembleRosterParticipantSnapshot
  return (
    typeof entry.provider === 'string' &&
    typeof entry.enabled === 'boolean' &&
    typeof entry.role === 'string' &&
    typeof entry.instructions === 'string' &&
    typeof entry.order === 'number' &&
    Number.isFinite(entry.order) &&
    (entry.stageRole === undefined ||
      ENSEMBLE_STAGE_ROLES.has(entry.stageRole as EnsembleStageRole))
  )
}

export function isEnsembleRosterPreset(value: unknown): value is EnsembleRosterPreset {
  if (!value || typeof value !== 'object') return false
  const entry = value as EnsembleRosterPreset
  return (
    typeof entry.id === 'string' &&
    entry.id.length > 0 &&
    typeof entry.name === 'string' &&
    entry.name.length > 0 &&
    typeof entry.createdAt === 'number' &&
    Number.isFinite(entry.createdAt) &&
    typeof entry.updatedAt === 'number' &&
    Number.isFinite(entry.updatedAt) &&
    (entry.orchestrationMode === 'turn_bound' || entry.orchestrationMode === 'continuous') &&
    (entry.fanoutPolicy === undefined ||
      ENSEMBLE_FANOUT_POLICIES.has(entry.fanoutPolicy as EnsembleFanoutPolicy)) &&
    typeof entry.maxParticipants === 'number' &&
    Number.isInteger(entry.maxParticipants) &&
    entry.maxParticipants >= MIN_ROSTER_PRESET_PARTICIPANTS &&
    entry.maxParticipants <= MAX_ROSTER_PRESET_PARTICIPANTS &&
    (entry.maxContinuationHops === undefined ||
      (typeof entry.maxContinuationHops === 'number' &&
        Number.isFinite(entry.maxContinuationHops))) &&
    (entry.ensembleContextChars === undefined ||
      (typeof entry.ensembleContextChars === 'number' &&
        Number.isFinite(entry.ensembleContextChars))) &&
    Array.isArray(entry.participants) &&
    entry.participants.length >= MIN_ROSTER_PRESET_PARTICIPANTS &&
    entry.participants.length <= MAX_ROSTER_PRESET_PARTICIPANTS &&
    entry.participants.every(isEnsembleRosterParticipantSnapshot)
  )
}

export function ensembleRosterPresetCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []
  const record = value as { presets?: unknown; rosters?: unknown }
  if (Array.isArray(record.presets)) return record.presets
  if (Array.isArray(record.rosters)) return record.rosters
  return []
}

export function parseEnsembleRosterPresetJson(json: string): {
  parsed: unknown
  candidates: unknown[]
  validPresets: EnsembleRosterPreset[]
  skippedCount: number
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('Roster preset import must be valid JSON.')
  }
  const candidates = ensembleRosterPresetCandidates(parsed)
  if (candidates.length === 0) {
    throw new Error('No roster presets were found in that JSON file.')
  }
  const validPresets = candidates.filter(isEnsembleRosterPreset)
  return {
    parsed,
    candidates,
    validPresets,
    skippedCount: candidates.length - validPresets.length
  }
}

export function cloneEnsembleRosterPreset(
  preset: EnsembleRosterPreset
): EnsembleRosterPreset {
  return {
    ...preset,
    participants: preset.participants.map((participant) => ({
      ...participant,
      ...(participant.permissionOverrides
        ? {
            permissionOverrides: {
              ...participant.permissionOverrides,
              ...(participant.permissionOverrides.agenticServices
                ? {
                    agenticServices: {
                      ...participant.permissionOverrides.agenticServices
                    }
                  }
                : {}),
              ...(participant.permissionOverrides.externalPathGrants
                ? {
                    externalPathGrants:
                      participant.permissionOverrides.externalPathGrants.map((grant) => ({
                        ...grant
                      }))
                  }
                : {})
            }
          }
        : {})
    }))
  }
}
