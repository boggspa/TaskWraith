import { createDefaultEnsembleConfig } from './EnsembleDefaults'
import {
  cloneEnsembleRosterPreset,
  ENSEMBLE_ROSTER_PRESET_EXPORT_FORMAT,
  ENSEMBLE_ROSTER_PRESET_EXPORT_VERSION,
  MAX_ROSTER_PRESET_PARTICIPANTS,
  parseEnsembleRosterPresetJson,
  type EnsembleRosterParticipantSnapshot,
  type EnsembleRosterPreset
} from './EnsembleRosterPresetContract'
import { PENDING_PROVIDER_CHANGE_KEY } from './providerChangeQueue'
import type {
  ChatRecord,
  EnsembleFanoutPolicy,
  EnsembleParticipant,
  PermissionPresetId,
  ProviderId
} from './store/types'

export const PENDING_ENSEMBLE_ROSTER_PRESET_APPLY_KEY =
  'pendingEnsembleRosterPresetApply'

export const AGENT_ROSTER_BRIEF_MAX_CHARS = 64_000
export const AGENT_ROSTER_TOTAL_BRIEF_MAX_CHARS = 500_000
export const AGENT_ROSTER_IMPORT_MAX_BYTES = 1_000_000
export const AGENT_ROSTER_CONTEXT_MIN_CHARS = 5_000
export const AGENT_ROSTER_CONTEXT_MAX_CHARS = 256_000
export const AGENT_ROSTER_MAX_CONTINUATION_HOPS = 500

const ASSIGNABLE_PERMISSION_PRESETS = new Set<PermissionPresetId>([
  'read_only',
  'plan',
  'default'
])

// Keep this module browser-safe: App.tsx imports the pending-roster finalizer.
// Pulling selectableProviderIds from MainSanitizers drags main-only policy and
// node:crypto modules into the renderer bundle. Gemini remains decode-only;
// these are the live providers selectable for new runs.
const LIVE_PROVIDERS = new Set<ProviderId>([
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama'
])

export function parseSingleAgentRosterPresetExport(json: string): EnsembleRosterPreset {
  if (new TextEncoder().encode(json).byteLength > AGENT_ROSTER_IMPORT_MAX_BYTES) {
    throw new Error(
      `Roster preset import is larger than ${AGENT_ROSTER_IMPORT_MAX_BYTES.toLocaleString()} bytes.`
    )
  }
  const parsed = parseEnsembleRosterPresetJson(json)
  const envelope =
    parsed.parsed && typeof parsed.parsed === 'object' && !Array.isArray(parsed.parsed)
      ? (parsed.parsed as Record<string, unknown>)
      : null
  if (
    envelope?.format !== ENSEMBLE_ROSTER_PRESET_EXPORT_FORMAT ||
    envelope.version !== ENSEMBLE_ROSTER_PRESET_EXPORT_VERSION ||
    typeof envelope.exportedAt !== 'string' ||
    Number.isNaN(Date.parse(envelope.exportedAt))
  ) {
    throw new Error(
      `Agent roster import must use ${ENSEMBLE_ROSTER_PRESET_EXPORT_FORMAT} version ${ENSEMBLE_ROSTER_PRESET_EXPORT_VERSION}.`
    )
  }
  if (parsed.candidates.length !== 1 || parsed.validPresets.length !== 1) {
    throw new Error('Agent roster import must contain exactly one valid roster preset.')
  }
  return cloneEnsembleRosterPreset(parsed.validPresets[0])
}

export interface PendingEnsembleRosterPresetApply {
  schemaVersion: 1
  presetId: string
  presetName: string
  queuedAt: string
  sourceRunId?: string
  authority: 'solo_inherited_boss' | 'ensemble_boss' | 'ensemble_captain'
  participants: EnsembleParticipant[]
  bossmanParticipantId: string
  secondInCommandParticipantId?: string
  orchestrationMode: 'turn_bound' | 'continuous'
  fanoutPolicy: EnsembleFanoutPolicy
  maxParticipants: number
  maxContinuationHops: number
  ensembleContextChars: number
}

export type BuildEnsembleRosterPresetApplyResult =
  | {
      ok: true
      plan: PendingEnsembleRosterPresetApply
      preset: EnsembleRosterPreset
    }
  | {
      ok: false
      error:
        | 'invalid_preset'
        | 'permission_ceiling'
        | 'provider_unavailable'
        | 'boss_required'
        | 'boss_provider_mismatch'
        | 'bossman_not_configured'
        | 'not_authorized'
        | 'captain_assignment_forbidden'
        | 'work_session_active'
      message: string
    }

export interface BuildEnsembleRosterPresetApplyInput {
  chat: ChatRecord
  preset: EnsembleRosterPreset
  callerParticipantId?: string
  sourceRunId?: string
  queuedAt: string
  makeParticipantId: () => string
}

function fail(
  error: Extract<BuildEnsembleRosterPresetApplyResult, { ok: false }>['error'],
  message: string
): Extract<BuildEnsembleRosterPresetApplyResult, { ok: false }> {
  return { ok: false, error, message }
}

function normalizedFanoutPolicy(preset: EnsembleRosterPreset): EnsembleFanoutPolicy {
  if (
    preset.fanoutPolicy === 'off' ||
    preset.fanoutPolicy === 'read_only' ||
    preset.fanoutPolicy === 'all' ||
    preset.fanoutPolicy === 'locked_writers_with_boss' ||
    preset.fanoutPolicy === 'locked_writers_user_preflight'
  ) {
    return preset.fanoutPolicy
  }
  return preset.concurrentModeEnabled === true ? 'read_only' : 'off'
}

function validatePortableParticipant(
  participant: EnsembleRosterParticipantSnapshot
): Extract<BuildEnsembleRosterPresetApplyResult, { ok: false }> | null {
  if (!LIVE_PROVIDERS.has(participant.provider)) {
    return fail(
      'provider_unavailable',
      `Roster preset import rejected: ${participant.provider} is not a live selectable provider.`
    )
  }
  const role = participant.role.trim()
  if (!role || role.length > 80) {
    return fail(
      'invalid_preset',
      'Roster preset import rejected: every participant role must contain 1-80 characters.'
    )
  }
  if (participant.instructions.length > AGENT_ROSTER_BRIEF_MAX_CHARS) {
    return fail(
      'invalid_preset',
      `Roster preset import rejected: ${role}'s brief exceeds ${AGENT_ROSTER_BRIEF_MAX_CHARS.toLocaleString()} characters.`
    )
  }
  if (
    !participant.permissionPresetId ||
    !ASSIGNABLE_PERMISSION_PRESETS.has(participant.permissionPresetId)
  ) {
    return fail(
      'permission_ceiling',
      `Roster preset import rejected: ${role} must use read_only, plan, or default permissions.`
    )
  }
  if (participant.permissionOverrides) {
    return fail(
      'permission_ceiling',
      `Roster preset import rejected: ${role} contains custom permission overrides; agent-created rosters may only choose read_only, plan, or default.`
    )
  }
  if (participant.model !== undefined && !participant.model.trim()) {
    return fail(
      'invalid_preset',
      `Roster preset import rejected: ${role}'s model must be non-empty when supplied.`
    )
  }
  if (!Number.isFinite(participant.order)) {
    return fail(
      'invalid_preset',
      `Roster preset import rejected: ${role}'s order must be a finite number.`
    )
  }
  return null
}

function materializeParticipant(
  snapshot: EnsembleRosterParticipantSnapshot,
  id: string,
  order: number
): EnsembleParticipant {
  return {
    id,
    provider: snapshot.provider,
    enabled: snapshot.enabled,
    role: snapshot.role.trim(),
    instructions: snapshot.instructions,
    order,
    ...(snapshot.pooledAgentId ? { pooledAgentId: snapshot.pooledAgentId } : {}),
    ...(snapshot.pooledAgentIdentity
      ? { pooledAgentIdentity: { ...snapshot.pooledAgentIdentity } }
      : {}),
    ...(snapshot.model ? { model: snapshot.model.trim() } : {}),
    ...(snapshot.runtimeProfileId ? { runtimeProfileId: snapshot.runtimeProfileId } : {}),
    geminiAuthProfileId:
      snapshot.provider === 'gemini' ? (snapshot.geminiAuthProfileId ?? null) : null,
    permissionPresetId: snapshot.permissionPresetId,
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
}

function nextUniqueParticipantId(
  usedIds: Set<string>,
  makeParticipantId: () => string
): string | null {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = makeParticipantId().trim()
    if (id && !usedIds.has(id)) {
      usedIds.add(id)
      return id
    }
  }
  return null
}

export function buildEnsembleRosterPresetApply(
  input: BuildEnsembleRosterPresetApplyInput
): BuildEnsembleRosterPresetApplyResult {
  const preset = cloneEnsembleRosterPreset(input.preset)
  const presetName = preset.name.trim()
  if (!presetName || presetName.length > 120) {
    return fail('invalid_preset', 'Roster preset import rejected: name must contain 1-120 characters.')
  }
  if (
    !Number.isFinite(preset.maxParticipants) ||
    (preset.maxContinuationHops !== undefined &&
      !Number.isFinite(preset.maxContinuationHops)) ||
    (preset.ensembleContextChars !== undefined &&
      !Number.isFinite(preset.ensembleContextChars))
  ) {
    return fail(
      'invalid_preset',
      'Roster preset import rejected: participant, hop, and CHARS limits must be finite numbers.'
    )
  }
  if (
    preset.participants.length < 1 ||
    preset.participants.length > MAX_ROSTER_PRESET_PARTICIPANTS
  ) {
    return fail(
      'invalid_preset',
      `Roster preset import rejected: include 1-${MAX_ROSTER_PRESET_PARTICIPANTS} participants.`
    )
  }
  const totalBriefChars = preset.participants.reduce(
    (total, participant) => total + participant.instructions.length,
    0
  )
  if (totalBriefChars > AGENT_ROSTER_TOTAL_BRIEF_MAX_CHARS) {
    return fail(
      'invalid_preset',
      `Roster preset import rejected: combined participant briefs exceed ${AGENT_ROSTER_TOTAL_BRIEF_MAX_CHARS.toLocaleString()} characters.`
    )
  }
  for (const participant of preset.participants) {
    const validation = validatePortableParticipant(participant)
    if (validation) return validation
  }

  const bossIndexes = preset.participants
    .map((participant, index) => (participant.isBossman === true ? index : -1))
    .filter((index) => index >= 0)
  if (bossIndexes.length !== 1) {
    return fail(
      'boss_required',
      'Roster preset import rejected: exactly one participant must set isBossman=true.'
    )
  }
  const captainIndexes = preset.participants
    .map((participant, index) => (participant.isSecondInCommand === true ? index : -1))
    .filter((index) => index >= 0)
  if (captainIndexes.length > 1 || captainIndexes[0] === bossIndexes[0]) {
    return fail(
      'invalid_preset',
      'Roster preset import rejected: at most one non-Boss participant may set isSecondInCommand=true.'
    )
  }
  const bossSnapshot = preset.participants[bossIndexes[0]]
  if (!bossSnapshot.enabled) {
    return fail('invalid_preset', 'Roster preset import rejected: the Boss participant must be enabled.')
  }
  if (captainIndexes.length === 1 && !preset.participants[captainIndexes[0]].enabled) {
    return fail('invalid_preset', 'Roster preset import rejected: the Captain participant must be enabled.')
  }

  const isExistingEnsemble = input.chat.chatKind === 'ensemble'
  const currentEnsemble = input.chat.ensemble
  if (
    isExistingEnsemble &&
    (currentEnsemble?.workSession?.status === 'active' ||
      currentEnsemble?.workSession?.status === 'paused')
  ) {
    return fail(
      'work_session_active',
      'Roster preset import rejected: stop the active Work Session before replacing its roster. Agents may configure Turn or Continuous mode, but cannot alter Work Session state.'
    )
  }
  let authority: PendingEnsembleRosterPresetApply['authority']
  let bossmanParticipantId: string
  let preservedCaptainParticipantId: string | undefined

  if (!isExistingEnsemble) {
    const soloProvider = input.chat.provider
    if (!soloProvider || bossSnapshot.provider !== soloProvider) {
      return fail(
        'boss_provider_mismatch',
        `Roster preset import rejected: the marked Boss must use the current solo provider (${soloProvider || 'unknown'}) so that seat can inherit Boss authority.`
      )
    }
    authority = 'solo_inherited_boss'
    bossmanParticipantId = ''
  } else {
    const currentBossId = currentEnsemble?.bossmanParticipantId
    const currentBoss = currentEnsemble?.participants.find(
      (participant) => participant.id === currentBossId && participant.enabled
    )
    if (!currentBossId || !currentBoss) {
      return fail(
        'bossman_not_configured',
        'Roster preset import rejected: this Ensemble has no enabled assigned Boss.'
      )
    }
    const currentCaptainId = currentEnsemble?.secondInCommandParticipantId
    const currentCaptain = currentEnsemble?.participants.find(
      (participant) => participant.id === currentCaptainId && participant.enabled
    )
    if (input.callerParticipantId === currentBossId) {
      authority = 'ensemble_boss'
    } else if (input.callerParticipantId === currentCaptainId && currentCaptain) {
      authority = 'ensemble_captain'
      if (captainIndexes.length !== 1) {
        return fail(
          'captain_assignment_forbidden',
          'Roster preset import rejected: a Captain may refine the roster but must preserve one Captain marker; only the Boss may clear or allocate Captain authority.'
        )
      }
      preservedCaptainParticipantId = currentCaptainId
    } else {
      return fail(
        'not_authorized',
        'Roster preset import rejected: only the assigned Boss or Captain may load an agent-created roster in an existing Ensemble.'
      )
    }
    bossmanParticipantId = currentBossId
    if (authority === 'ensemble_boss' && currentCaptain) {
      preservedCaptainParticipantId = currentCaptain.id
    }
  }

  const sortedSnapshots = preset.participants
    .map((participant, index) => ({ participant, index }))
    .sort((a, b) => a.participant.order - b.participant.order || a.index - b.index)
  const usedIds = new Set<string>()
  if (bossmanParticipantId) usedIds.add(bossmanParticipantId)
  if (preservedCaptainParticipantId) usedIds.add(preservedCaptainParticipantId)
  let secondInCommandParticipantId: string | undefined
  const participants: EnsembleParticipant[] = []

  for (const [index, entry] of sortedSnapshots.entries()) {
    const snapshot = entry.participant
    let id: string | null
    if (snapshot.isBossman === true) {
      id = bossmanParticipantId || nextUniqueParticipantId(usedIds, input.makeParticipantId)
      if (id) {
        bossmanParticipantId = id
        usedIds.add(id)
      }
    } else if (snapshot.isSecondInCommand === true && preservedCaptainParticipantId) {
      id = preservedCaptainParticipantId
    } else {
      id = nextUniqueParticipantId(usedIds, input.makeParticipantId)
    }
    if (!id) {
      return fail(
        'invalid_preset',
        'Roster preset import rejected: could not allocate unique participant ids.'
      )
    }
    if (snapshot.isSecondInCommand === true) secondInCommandParticipantId = id
    participants.push(materializeParticipant(snapshot, id, index + 1))
  }

  const maxParticipants = Math.max(
    participants.length,
    Math.min(MAX_ROSTER_PRESET_PARTICIPANTS, Math.round(preset.maxParticipants))
  )
  const maxContinuationHops = Math.max(
    1,
    Math.min(
      AGENT_ROSTER_MAX_CONTINUATION_HOPS,
      Math.round(preset.maxContinuationHops ?? 6)
    )
  )
  const ensembleContextChars = Math.max(
    AGENT_ROSTER_CONTEXT_MIN_CHARS,
    Math.min(
      AGENT_ROSTER_CONTEXT_MAX_CHARS,
      Math.round(preset.ensembleContextChars ?? 24_000)
    )
  )

  return {
    ok: true,
    preset,
    plan: {
      schemaVersion: 1,
      presetId: preset.id,
      presetName,
      queuedAt: input.queuedAt,
      ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
      authority,
      participants,
      bossmanParticipantId,
      ...(secondInCommandParticipantId ? { secondInCommandParticipantId } : {}),
      orchestrationMode:
        preset.orchestrationMode === 'continuous' ? 'continuous' : 'turn_bound',
      fanoutPolicy: normalizedFanoutPolicy(preset),
      maxParticipants,
      maxContinuationHops,
      ensembleContextChars
    }
  }
}

function isPendingEnsembleRosterPresetApply(
  value: unknown
): value is PendingEnsembleRosterPresetApply {
  if (!value || typeof value !== 'object') return false
  const plan = value as PendingEnsembleRosterPresetApply
  return (
    plan.schemaVersion === 1 &&
    typeof plan.presetId === 'string' &&
    typeof plan.presetName === 'string' &&
    typeof plan.queuedAt === 'string' &&
    Array.isArray(plan.participants) &&
    plan.participants.length >= 1 &&
    plan.participants.length <= MAX_ROSTER_PRESET_PARTICIPANTS &&
    typeof plan.bossmanParticipantId === 'string' &&
    plan.participants.some((participant) => participant.id === plan.bossmanParticipantId) &&
    (plan.orchestrationMode === 'turn_bound' || plan.orchestrationMode === 'continuous') &&
    typeof plan.maxParticipants === 'number' &&
    typeof plan.maxContinuationHops === 'number' &&
    typeof plan.ensembleContextChars === 'number'
  )
}

export function readPendingEnsembleRosterPresetApply(
  chat: ChatRecord
): PendingEnsembleRosterPresetApply | null {
  const value = chat.providerMetadata?.[PENDING_ENSEMBLE_ROSTER_PRESET_APPLY_KEY]
  return isPendingEnsembleRosterPresetApply(value) ? value : null
}

export function hasPendingEnsembleRosterPresetApply(chat: ChatRecord): boolean {
  return readPendingEnsembleRosterPresetApply(chat) !== null
}

export function queuePendingEnsembleRosterPresetApply(
  chat: ChatRecord,
  plan: PendingEnsembleRosterPresetApply
): ChatRecord {
  return {
    ...chat,
    providerMetadata: {
      ...(chat.providerMetadata || {}),
      [PENDING_ENSEMBLE_ROSTER_PRESET_APPLY_KEY]: plan
    }
  }
}

function withoutPendingMetadata(chat: ChatRecord): Record<string, unknown> | undefined {
  const {
    [PENDING_ENSEMBLE_ROSTER_PRESET_APPLY_KEY]: _pending,
    [PENDING_PROVIDER_CHANGE_KEY]: _pendingProviderChange,
    stashedEnsemble: _stashedEnsemble,
    ...rest
  } = chat.providerMetadata || {}
  return Object.keys(rest).length > 0 ? rest : undefined
}

/**
 * Apply a queued roster only at a solo turn or Ensemble round boundary.
 * Callers own persistence and updatedAt. Historical messages/runs remain on the
 * same chat id; provider-native solo/seat sessions are reset for the new roster.
 */
export function applyPendingEnsembleRosterPresetOnFinalize(chat: ChatRecord): ChatRecord {
  const plan = readPendingEnsembleRosterPresetApply(chat)
  if (!plan) return chat
  const nowIso = new Date().toISOString()
  const ensembleBase =
    chat.chatKind === 'ensemble' && chat.ensemble
      ? chat.ensemble
      : createDefaultEnsembleConfig(chat.provider)
  const ensemble = {
    ...ensembleBase,
    orchestrationMode: plan.orchestrationMode,
    maxParticipants: plan.maxParticipants,
    maxContinuationHops: plan.maxContinuationHops,
    fanoutPolicy: plan.fanoutPolicy,
    concurrentModeEnabled: plan.fanoutPolicy !== 'off',
    ensembleContextChars: plan.ensembleContextChars,
    participants: plan.participants.map((participant) => ({ ...participant })),
    bossmanParticipantId: plan.bossmanParticipantId,
    secondInCommandParticipantId: plan.secondInCommandParticipantId,
    bossmanAutoApprovals: undefined,
    updatedAt: nowIso
  }
  const {
    linkedProviderSessionId: _linkedProviderSessionId,
    linkedGeminiSessionId: _linkedGeminiSessionId,
    taskWraithMcpProfileReceipt: _taskWraithMcpProfileReceipt,
    ...restChat
  } = chat
  return {
    ...restChat,
    chatKind: 'ensemble',
    ensemble,
    providerMetadata: withoutPendingMetadata(chat)
  }
}

export function agentRosterPresetContractGuide(activeProvider?: ProviderId): Record<string, unknown> {
  return {
    format: ENSEMBLE_ROSTER_PRESET_EXPORT_FORMAT,
    version: ENSEMBLE_ROSTER_PRESET_EXPORT_VERSION,
    singlePresetRequired: true,
    currentSoloBossProvider: activeProvider,
    requiredExportFields: ['format', 'version', 'exportedAt', 'presets'],
    requiredPresetFields: [
      'id',
      'name',
      'createdAt',
      'updatedAt',
      'orchestrationMode',
      'maxParticipants',
      'participants'
    ],
    requiredParticipantFields: [
      'provider',
      'enabled',
      'role',
      'instructions',
      'order',
      'permissionPresetId'
    ],
    timestampTypes: {
      exportedAt: 'ISO-8601 string',
      createdAt: 'epoch milliseconds',
      updatedAt: 'epoch milliseconds'
    },
    participantRules: {
      count: `1-${MAX_ROSTER_PRESET_PARTICIPANTS}`,
      exactlyOneIsBossman: true,
      atMostOneIsSecondInCommand: true,
      permissions: ['read_only', 'plan', 'default'],
      stages: ['any (omit stageRole)', 'scout', 'worker', 'reviewer', 'background'],
      order: 'Use numeric order; import normalizes it to 1..N.',
      briefField: 'instructions'
    },
    settings: {
      orchestrationMode: ['turn_bound', 'continuous'],
      workSessionSupported: false,
      fanoutPolicy: {
        Off: 'off',
        Read: 'read_only',
        Write: 'locked_writers_with_boss',
        All: 'all'
      },
      maxContinuationHops: `1-${AGENT_ROSTER_MAX_CONTINUATION_HOPS}`,
      ensembleContextChars: `${AGENT_ROSTER_CONTEXT_MIN_CHARS}-${AGENT_ROSTER_CONTEXT_MAX_CHARS}`
    }
  }
}
