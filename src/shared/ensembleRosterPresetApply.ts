import type { ChatRecord, EnsembleFanoutPolicy, EnsembleParticipant } from '../main/store/types'
import type { EnsembleRosterPreset } from './EnsembleRosterPresetContract'
import { normalizeEnsembleAuthority } from './ensembleAuthority'
import { MAX_ENSEMBLE_PARTICIPANTS } from './ensembleLimits'

export const PENDING_ENSEMBLE_ROSTER_PRESET_APPLY_KEY = 'pendingEnsembleRosterPresetApply'

export const AGENT_ROSTER_CONTEXT_MIN_CHARS = 5_000
export const AGENT_ROSTER_CONTEXT_MAX_CHARS = 256_000
export const AGENT_ROSTER_MAX_CONTINUATION_HOPS = 1200

export interface PendingEnsembleRosterPresetApply {
  schemaVersion: 1
  presetId: string
  presetName: string
  queuedAt: string
  /**
   * The user-authored configuration signature of the ensemble this plan was
   * queued AGAINST — see `ensembleAuthoredConfigurationSignature`.
   *
   * A queued plan is a roster REPLACEMENT that lands at the next round
   * boundary, which can be minutes later. If the user reshapes the panel by
   * hand in that window, replaying the preset would silently undo them, and the
   * seats they edited are not even the seats the preset installs. Comparing
   * this against the signature at finalize time is how that is detected;
   * `queuedAt` cannot do it, because main re-stamps the ensemble clock for its
   * own writes. Optional so a plan queued before this existed keeps its old
   * unconditional behaviour rather than being dropped.
   */
  queuedConfigurationSignature?: string
  sourceRunId?: string
  authority: 'user' | 'solo_inherited_boss' | 'ensemble_boss' | 'ensemble_captain'
  participants: EnsembleParticipant[]
  bossmanParticipantId: string
  captainParticipantIds?: string[]
  secondInCommandParticipantId?: string
  orchestrationMode: 'turn_bound' | 'continuous'
  fanoutPolicy: EnsembleFanoutPolicy
  maxParticipants: number
  maxContinuationHops: number
  ensembleContextChars: number
}

export interface BuildUserEnsembleRosterPresetApplyPlanInput {
  preset: EnsembleRosterPreset
  participants: EnsembleParticipant[]
  bossmanParticipantId: string
  captainParticipantIds?: string[]
  secondInCommandParticipantId?: string
  queuedAt: string
}

function normalizedFanoutPolicy(preset: EnsembleRosterPreset): EnsembleFanoutPolicy {
  // Fan-out collapsed to On/Off (On = the old 'all'); the retired graded
  // levels and the legacy boolean concurrent flag normalize on apply.
  if (preset.fanoutPolicy === 'off') return 'off'
  if (
    preset.fanoutPolicy === 'read_only' ||
    preset.fanoutPolicy === 'all' ||
    preset.fanoutPolicy === 'locked_writers_with_boss' ||
    preset.fanoutPolicy === 'locked_writers_user_preflight'
  ) {
    return 'all'
  }
  return preset.concurrentModeEnabled === true ? 'all' : 'off'
}

/** Build a boundary-deferred roster change from an explicit renderer action. */
export function buildUserEnsembleRosterPresetApplyPlan(
  input: BuildUserEnsembleRosterPresetApplyPlanInput
): PendingEnsembleRosterPresetApply {
  const preset = input.preset
  const authority = normalizeEnsembleAuthority({
    participants: input.participants,
    bossmanParticipantId: input.bossmanParticipantId,
    captainParticipantIds: input.captainParticipantIds,
    secondInCommandParticipantId: input.secondInCommandParticipantId,
    recoverBoss: false
  })
  if (!authority.bossmanParticipantId) {
    throw new Error('A roster preset apply plan requires exactly one foreground Boss.')
  }
  const maxParticipants = Math.min(
    MAX_ENSEMBLE_PARTICIPANTS,
    Math.max(input.participants.length, Math.round(preset.maxParticipants), 2)
  )
  const maxContinuationHops = Math.max(
    1,
    Math.min(AGENT_ROSTER_MAX_CONTINUATION_HOPS, Math.round(preset.maxContinuationHops ?? 6))
  )
  const ensembleContextChars = Math.max(
    AGENT_ROSTER_CONTEXT_MIN_CHARS,
    Math.min(AGENT_ROSTER_CONTEXT_MAX_CHARS, Math.round(preset.ensembleContextChars ?? 24_000))
  )
  return {
    schemaVersion: 1,
    presetId: preset.id,
    presetName: preset.name,
    queuedAt: input.queuedAt,
    authority: 'user',
    participants: input.participants.map((participant) => ({
      ...participant,
      linkedProviderSessionId: null
    })),
    bossmanParticipantId: authority.bossmanParticipantId,
    captainParticipantIds: authority.captainParticipantIds,
    ...(authority.secondInCommandParticipantId
      ? { secondInCommandParticipantId: authority.secondInCommandParticipantId }
      : {}),
    // Continuous-only: legacy 'turn_bound' presets normalize on apply.
    orchestrationMode: 'continuous',
    fanoutPolicy: normalizedFanoutPolicy(preset),
    maxParticipants,
    maxContinuationHops,
    ensembleContextChars
  }
}

export function parsePendingEnsembleRosterPresetApply(
  value: unknown
): PendingEnsembleRosterPresetApply | null {
  if (!value || typeof value !== 'object') return null
  const plan = value as PendingEnsembleRosterPresetApply
  const authority = normalizeEnsembleAuthority({
    participants: Array.isArray(plan.participants) ? plan.participants : [],
    bossmanParticipantId: plan.bossmanParticipantId,
    captainParticipantIds: plan.captainParticipantIds,
    secondInCommandParticipantId: plan.secondInCommandParticipantId,
    recoverBoss: false
  })
  const valid =
    plan.schemaVersion === 1 &&
    typeof plan.presetId === 'string' &&
    typeof plan.presetName === 'string' &&
    typeof plan.queuedAt === 'string' &&
    (plan.authority === 'user' ||
      plan.authority === 'solo_inherited_boss' ||
      plan.authority === 'ensemble_boss' ||
      plan.authority === 'ensemble_captain') &&
    Array.isArray(plan.participants) &&
    plan.participants.length >= 1 &&
    plan.participants.length <= MAX_ENSEMBLE_PARTICIPANTS &&
    typeof plan.bossmanParticipantId === 'string' &&
    authority.bossmanParticipantId === plan.bossmanParticipantId &&
    (plan.captainParticipantIds === undefined ||
      (Array.isArray(plan.captainParticipantIds) &&
        plan.captainParticipantIds.every((participantId) => typeof participantId === 'string'))) &&
    (plan.orchestrationMode === 'turn_bound' || plan.orchestrationMode === 'continuous') &&
    typeof plan.maxParticipants === 'number' &&
    typeof plan.maxContinuationHops === 'number' &&
    typeof plan.ensembleContextChars === 'number'
  return valid
    ? {
        ...plan,
        bossmanParticipantId: authority.bossmanParticipantId as string,
        captainParticipantIds: authority.captainParticipantIds,
        secondInCommandParticipantId: authority.secondInCommandParticipantId
      }
    : null
}

export function readPendingEnsembleRosterPresetApply(
  chat: ChatRecord
): PendingEnsembleRosterPresetApply | null {
  const value = chat.providerMetadata?.[PENDING_ENSEMBLE_ROSTER_PRESET_APPLY_KEY]
  return parsePendingEnsembleRosterPresetApply(value)
}

export function hasPendingEnsembleRosterPresetApply(chat: ChatRecord): boolean {
  return readPendingEnsembleRosterPresetApply(chat) !== null
}
