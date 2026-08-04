import { MAX_ENSEMBLE_PARTICIPANTS } from '../shared/ensembleLimits'
import { MAX_ENSEMBLE_CAPTAINS, normalizeEnsembleAuthority } from '../shared/ensembleAuthority'
import type { ChatRecord, EnsembleParticipant, PermissionPresetId } from './store/types'

type EnsembleConfig = NonNullable<ChatRecord['ensemble']>
type BossmanAutoApprovals = EnsembleConfig['bossmanAutoApprovals']

export type EnsembleParticipantAuthority = 'boss' | 'captain' | 'agent'

export type EnsembleUserRosterMutationInput =
  | {
      chatId: string
      action: 'add'
      participant: EnsembleParticipant
      authority?: EnsembleParticipantAuthority
      autoApprovalsEnabled?: boolean
    }
  | {
      chatId: string
      action: 'remove'
      participantId: string
    }
  | {
      chatId: string
      action: 'reorder'
      participantIds: string[]
    }
  | {
      chatId: string
      action: 'set_authority'
      participantId: string
      authority: EnsembleParticipantAuthority
    }
  | {
      chatId: string
      action: 'set_auto_approvals'
      enabled: boolean
    }

type WithoutChatId<T> = T extends unknown ? Omit<T, 'chatId'> : never
export type EnsembleUserRosterMutation = WithoutChatId<EnsembleUserRosterMutationInput>

export type EnsembleUserRosterMutationError =
  | 'invalid_request'
  | 'not_ensemble'
  | 'roster_max'
  | 'roster_min'
  | 'stale_target'
  | 'unknown_provider'

export interface ResolvedEnsembleUserRosterMutation {
  action: EnsembleUserRosterMutationInput['action']
  participants: EnsembleParticipant[]
  bossmanParticipantId?: string
  captainParticipantIds: string[]
  secondInCommandParticipantId?: string
  bossmanAutoApprovals?: BossmanAutoApprovals
  maxParticipants: number
  affectedParticipantId?: string
}

export type ResolveEnsembleUserRosterMutationResult =
  | { ok: true; value: ResolvedEnsembleUserRosterMutation }
  | { ok: false; error: EnsembleUserRosterMutationError; message: string }

const PERMISSION_PRESET_IDS = new Set<PermissionPresetId>([
  'read_only',
  'plan',
  'default',
  'workspace_write',
  'full_access',
  'custom'
])
const STAGE_ROLE_IDS = new Set(['scout', 'worker', 'reviewer', 'background'])
const PARTICIPANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

function fail(
  error: EnsembleUserRosterMutationError,
  message: string
): ResolveEnsembleUserRosterMutationResult {
  return { ok: false, error, message }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  return value.trim()
}

export function parseEnsembleUserRosterMutationInput(
  payload: unknown
): EnsembleUserRosterMutationInput {
  const raw = requireRecord(payload, 'Ensemble roster mutation')
  const chatId = requireString(raw.chatId, 'Ensemble chat id')
  const action = requireString(raw.action, 'Ensemble roster mutation action')
  if (action === 'add') {
    const authority =
      raw.authority === undefined
        ? undefined
        : requireString(raw.authority, 'Participant authority')
    if (
      authority !== undefined &&
      authority !== 'boss' &&
      authority !== 'captain' &&
      authority !== 'agent'
    ) {
      throw new Error('Participant authority is invalid.')
    }
    if (raw.autoApprovalsEnabled !== undefined && typeof raw.autoApprovalsEnabled !== 'boolean') {
      throw new Error('Auto Approvals enabled state must be a boolean.')
    }
    return {
      chatId,
      action,
      participant: requireRecord(
        raw.participant,
        'Ensemble roster participant'
      ) as unknown as EnsembleParticipant,
      ...(authority ? { authority } : {}),
      ...(typeof raw.autoApprovalsEnabled === 'boolean'
        ? { autoApprovalsEnabled: raw.autoApprovalsEnabled }
        : {})
    }
  }
  if (action === 'remove') {
    return {
      chatId,
      action,
      participantId: requireString(raw.participantId, 'Participant id')
    }
  }
  if (action === 'reorder') {
    if (
      !Array.isArray(raw.participantIds) ||
      raw.participantIds.some((participantId) => typeof participantId !== 'string')
    ) {
      throw new Error('Participant order must be a string array.')
    }
    return { chatId, action, participantIds: raw.participantIds }
  }
  if (action === 'set_authority') {
    const authority = requireString(raw.authority, 'Participant authority')
    if (authority !== 'boss' && authority !== 'captain' && authority !== 'agent') {
      throw new Error('Participant authority is invalid.')
    }
    return {
      chatId,
      action,
      participantId: requireString(raw.participantId, 'Participant id'),
      authority
    }
  }
  if (action === 'set_auto_approvals') {
    if (typeof raw.enabled !== 'boolean') {
      throw new Error('Auto Approvals enabled state must be a boolean.')
    }
    return { chatId, action, enabled: raw.enabled }
  }
  throw new Error('Ensemble roster mutation action is invalid.')
}

function normalizeOrder(participants: EnsembleParticipant[]): EnsembleParticipant[] {
  return participants.map((participant, index) => ({
    ...participant,
    order: index + 1
  }))
}

function normalizedMaxParticipants(config: EnsembleConfig, participantCount: number): number {
  const stored = Number.isFinite(config.maxParticipants)
    ? Math.floor(Number(config.maxParticipants))
    : MAX_ENSEMBLE_PARTICIPANTS
  return Math.min(MAX_ENSEMBLE_PARTICIPANTS, Math.max(1, participantCount, stored))
}

function normalizeAuthority(
  participants: EnsembleParticipant[],
  bossmanParticipantId: string | undefined,
  captainParticipantIds: string[] | undefined,
  secondInCommandParticipantId: string | undefined,
  bossmanAutoApprovals: BossmanAutoApprovals
): Pick<
  ResolvedEnsembleUserRosterMutation,
  | 'bossmanParticipantId'
  | 'captainParticipantIds'
  | 'secondInCommandParticipantId'
  | 'bossmanAutoApprovals'
> {
  const authority = normalizeEnsembleAuthority({
    participants,
    bossmanParticipantId,
    captainParticipantIds,
    secondInCommandParticipantId
  })
  return {
    bossmanParticipantId: authority.bossmanParticipantId,
    captainParticipantIds: authority.captainParticipantIds,
    secondInCommandParticipantId: authority.secondInCommandParticipantId,
    bossmanAutoApprovals: authority.bossmanParticipantId ? bossmanAutoApprovals : undefined
  }
}

function validateAddedParticipant(
  participant: EnsembleParticipant,
  isProviderSelectable: (provider: string) => boolean
): ResolveEnsembleUserRosterMutationResult | EnsembleParticipant {
  const id = typeof participant?.id === 'string' ? participant.id.trim() : ''
  if (!PARTICIPANT_ID_PATTERN.test(id)) {
    return fail('invalid_request', 'Participant add rejected: participant id is invalid.')
  }
  if (
    !participant ||
    typeof participant.provider !== 'string' ||
    !participant.provider ||
    !isProviderSelectable(participant.provider)
  ) {
    return fail(
      'unknown_provider',
      'Participant add rejected: provider is not currently selectable.'
    )
  }
  if (
    typeof participant.role !== 'string' ||
    typeof participant.instructions !== 'string' ||
    typeof participant.enabled !== 'boolean'
  ) {
    return fail('invalid_request', 'Participant add rejected: seat details are incomplete.')
  }
  if (participant.stageRole !== undefined && !STAGE_ROLE_IDS.has(String(participant.stageRole))) {
    return fail('invalid_request', 'Participant add rejected: stage role is invalid.')
  }
  if (
    participant.permissionPresetId !== undefined &&
    !PERMISSION_PRESET_IDS.has(participant.permissionPresetId)
  ) {
    return fail('invalid_request', 'Participant add rejected: permission preset is invalid.')
  }
  return {
    ...participant,
    id
  }
}

export function resolveEnsembleUserRosterMutation(
  config: EnsembleConfig,
  input: EnsembleUserRosterMutationInput,
  options: {
    nowIso: string
    isProviderSelectable: (provider: string) => boolean
  }
): ResolveEnsembleUserRosterMutationResult {
  const participants = normalizeOrder(config.participants || [])
  const baseAuthority = normalizeAuthority(
    participants,
    config.bossmanParticipantId,
    config.captainParticipantIds,
    config.secondInCommandParticipantId,
    config.bossmanAutoApprovals
  )

  if (input.action === 'add') {
    if (participants.length >= MAX_ENSEMBLE_PARTICIPANTS) {
      return fail(
        'roster_max',
        `Participant add rejected: Ensembles support up to ${MAX_ENSEMBLE_PARTICIPANTS} participants.`
      )
    }
    const validated = validateAddedParticipant(input.participant, options.isProviderSelectable)
    if ('ok' in validated) return validated
    if (participants.some((participant) => participant.id === validated.id)) {
      return fail('invalid_request', 'Participant add rejected: participant id already exists.')
    }
    if (
      input.authority !== undefined &&
      input.authority !== 'agent' &&
      validated.stageRole === 'background'
    ) {
      return fail(
        'invalid_request',
        'Participant add rejected: BG seats cannot own Boss or Captain authority.'
      )
    }
    const requestedIndex = Number.isFinite(validated.order)
      ? Math.floor(validated.order) - 1
      : participants.length
    const insertIndex = Math.max(0, Math.min(participants.length, requestedIndex))
    const next = [...participants]
    next.splice(insertIndex, 0, validated)
    const normalized = normalizeOrder(next)
    let bossmanParticipantId = baseAuthority.bossmanParticipantId
    let captainParticipantIds = [...baseAuthority.captainParticipantIds]
    if (input.authority === 'boss') {
      bossmanParticipantId = validated.id
      captainParticipantIds = captainParticipantIds.filter(
        (participantId) => participantId !== validated.id
      )
    } else if (input.authority === 'captain') {
      if (captainParticipantIds.length >= MAX_ENSEMBLE_CAPTAINS) {
        return fail(
          'invalid_request',
          `Participant add rejected: Ensembles support up to ${MAX_ENSEMBLE_CAPTAINS} Captains.`
        )
      }
      captainParticipantIds.push(validated.id)
    }
    const authority = normalizeAuthority(
      normalized,
      bossmanParticipantId,
      captainParticipantIds,
      undefined,
      baseAuthority.bossmanAutoApprovals
    )
    if (!authority.bossmanParticipantId) {
      return fail(
        'invalid_request',
        'Participant add rejected: an Ensemble must retain exactly one foreground Boss.'
      )
    }
    return {
      ok: true,
      value: {
        action: input.action,
        participants: normalized,
        ...authority,
        bossmanAutoApprovals:
          input.autoApprovalsEnabled === undefined
            ? authority.bossmanAutoApprovals
            : input.autoApprovalsEnabled
              ? (authority.bossmanAutoApprovals ?? {
                  enabled: true,
                  mode: 'permission_preset_once',
                  confirmedAt: options.nowIso
                })
              : undefined,
        maxParticipants: normalizedMaxParticipants(config, normalized.length),
        affectedParticipantId: validated.id
      }
    }
  }

  if (input.action === 'remove') {
    const participantId = input.participantId?.trim()
    if (!participantId || !participants.some((participant) => participant.id === participantId)) {
      return fail('stale_target', 'Participant remove rejected: participant is not in the roster.')
    }
    if (participants.length <= 1) {
      return fail('roster_min', 'Participant remove rejected: an Ensemble must retain one seat.')
    }
    if (participantId === baseAuthority.bossmanParticipantId) {
      return fail(
        'invalid_request',
        'Participant remove rejected: replace the configured Boss before removing that seat.'
      )
    }
    const next = normalizeOrder(
      participants.filter((participant) => participant.id !== participantId)
    )
    return {
      ok: true,
      value: {
        action: input.action,
        participants: next,
        ...normalizeAuthority(
          next,
          baseAuthority.bossmanParticipantId,
          baseAuthority.captainParticipantIds,
          baseAuthority.secondInCommandParticipantId,
          baseAuthority.bossmanAutoApprovals
        ),
        maxParticipants: normalizedMaxParticipants(config, next.length),
        affectedParticipantId: participantId
      }
    }
  }

  if (input.action === 'reorder') {
    const participantIds = Array.isArray(input.participantIds)
      ? input.participantIds.map((id) => id.trim())
      : []
    const expectedIds = new Set(participants.map((participant) => participant.id))
    if (
      participantIds.length !== participants.length ||
      new Set(participantIds).size !== participantIds.length ||
      participantIds.some((id) => !expectedIds.has(id))
    ) {
      return fail(
        'invalid_request',
        'Participant reorder rejected: order must name every current participant exactly once.'
      )
    }
    const byId = new Map(participants.map((participant) => [participant.id, participant]))
    const next = normalizeOrder(participantIds.map((participantId) => byId.get(participantId)!))
    const authority = normalizeAuthority(
      next,
      baseAuthority.bossmanParticipantId,
      baseAuthority.captainParticipantIds,
      baseAuthority.secondInCommandParticipantId,
      baseAuthority.bossmanAutoApprovals
    )
    return {
      ok: true,
      value: {
        action: input.action,
        participants: next,
        ...authority,
        maxParticipants: normalizedMaxParticipants(config, next.length)
      }
    }
  }

  if (input.action === 'set_authority') {
    const participantId = input.participantId?.trim()
    const target = participants.find((participant) => participant.id === participantId)
    if (!target) {
      return fail('stale_target', 'Authority change rejected: participant is not in the roster.')
    }
    if (
      input.authority !== 'boss' &&
      input.authority !== 'captain' &&
      input.authority !== 'agent'
    ) {
      return fail('invalid_request', 'Authority change rejected: authority is invalid.')
    }
    if (input.authority !== 'agent' && target.stageRole === 'background') {
      return fail('invalid_request', 'Authority change rejected: BG seats cannot lead the roster.')
    }
    let bossmanParticipantId = baseAuthority.bossmanParticipantId
    let captainParticipantIds = [...baseAuthority.captainParticipantIds]
    if (input.authority === 'boss') {
      bossmanParticipantId = participantId
      captainParticipantIds = captainParticipantIds.filter(
        (captainParticipantId) => captainParticipantId !== participantId
      )
    } else if (input.authority === 'captain') {
      if (bossmanParticipantId === participantId) {
        return fail(
          'invalid_request',
          'Authority change rejected: install a replacement Boss in the same mutation before demoting the current Boss.'
        )
      }
      if (
        !captainParticipantIds.includes(participantId) &&
        captainParticipantIds.length >= MAX_ENSEMBLE_CAPTAINS
      ) {
        return fail(
          'invalid_request',
          `Authority change rejected: Ensembles support up to ${MAX_ENSEMBLE_CAPTAINS} Captains.`
        )
      }
      captainParticipantIds.push(participantId)
    } else {
      if (bossmanParticipantId === participantId) {
        return fail(
          'invalid_request',
          'Authority change rejected: install a replacement Boss in the same mutation before demoting the current Boss.'
        )
      }
      captainParticipantIds = captainParticipantIds.filter(
        (captainParticipantId) => captainParticipantId !== participantId
      )
    }
    return {
      ok: true,
      value: {
        action: input.action,
        participants,
        ...normalizeAuthority(
          participants,
          bossmanParticipantId,
          captainParticipantIds,
          undefined,
          baseAuthority.bossmanAutoApprovals
        ),
        maxParticipants: normalizedMaxParticipants(config, participants.length),
        affectedParticipantId: participantId
      }
    }
  }

  if (input.enabled && !baseAuthority.bossmanParticipantId) {
    return fail(
      'invalid_request',
      'Auto Approvals change rejected: assign a configured Boss first.'
    )
  }
  return {
    ok: true,
    value: {
      action: input.action,
      participants,
      ...baseAuthority,
      bossmanAutoApprovals: input.enabled
        ? {
            enabled: true,
            mode: 'permission_preset_once',
            confirmedAt: options.nowIso
          }
        : undefined,
      maxParticipants: normalizedMaxParticipants(config, participants.length)
    }
  }
}
