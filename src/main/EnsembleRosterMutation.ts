import type {
  EnsembleParticipant,
  PermissionOverrides,
  PermissionPresetId,
  ProviderId
} from './store/types'

export const MIN_ENSEMBLE_PARTICIPANTS = 2
export const MAX_ENSEMBLE_PARTICIPANTS = 18

export const ASSIGNABLE_PERMISSION_PRESETS = [
  'read_only',
  'plan',
  'default'
] as const

export type AssignablePermissionPresetId = (typeof ASSIGNABLE_PERMISSION_PRESETS)[number]

export type RosterEditAction = 'add_participant' | 'remove_participant' | 'edit_participant'

export type RosterEditError =
  | 'auto_approvals_disabled'
  | 'bossman_not_configured'
  | 'invalid_request'
  | 'no_provider'
  | 'permission_ceiling'
  | 'tool_grant_widen'
  | 'external_path_forbidden'
  | 'read_only_posture'
  | 'roster_max'
  | 'roster_min'
  | 'remove_boss'
  | 'stale_target'

export interface RosterEditParticipantInput {
  provider?: ProviderId | string
  model?: string | null
  role?: string
  instructions?: string
  reasoningEffort?: string | null
  fastModeEnabled?: boolean
  thinkingEnabled?: boolean
  permissionPresetId?: PermissionPresetId | string | null
  permissionOverrides?: PermissionOverrides | null
}

export interface RosterEditRequest {
  action: RosterEditAction | string
  targetParticipantId?: string
  participant?: RosterEditParticipantInput | null
}

export interface RosterEditContext {
  participants: EnsembleParticipant[]
  bossmanParticipantId: string | undefined
  autoApprovals: { enabled?: boolean; mode?: string } | undefined
  roundReadOnly: boolean
  nextParticipantId: () => string
}

export type RosterEditResolution =
  | {
      ok: true
      nextParticipants: EnsembleParticipant[]
      affectedParticipantId: string
      summary: string
    }
  | {
      ok: false
      error: RosterEditError
      message: string
    }

const ASSIGNABLE_PERMISSION_PRESET_SET = new Set<string>(ASSIGNABLE_PERMISSION_PRESETS)
const READ_ONLY_ROUND_PERMISSION_PRESET_SET = new Set<string>(['read_only', 'plan'])
const PATCH_FIELDS = [
  'provider',
  'model',
  'role',
  'instructions',
  'reasoningEffort',
  'fastModeEnabled',
  'thinkingEnabled',
  'permissionPresetId',
  'permissionOverrides'
] as const

const hasOwn = Object.prototype.hasOwnProperty

export function evaluateRosterEdit(
  req: RosterEditRequest,
  ctx: RosterEditContext
): RosterEditResolution {
  if (ctx.autoApprovals?.enabled !== true || ctx.autoApprovals.mode !== 'permission_preset_once') {
    return fail(
      'auto_approvals_disabled',
      'Roster edit rejected: Boss Auto Approvals must be enabled in permission_preset_once mode.'
    )
  }
  if (!ctx.bossmanParticipantId || !participantExists(ctx.participants, ctx.bossmanParticipantId)) {
    return fail('bossman_not_configured', 'Roster edit rejected: no live Boss participant is configured.')
  }

  const action = req.action
  if (!isRosterEditAction(action)) {
    return fail('invalid_request', 'Roster edit rejected: action is not supported.')
  }

  if (action === 'add_participant') return evaluateAdd(req, ctx)
  if (action === 'remove_participant') return evaluateRemove(req, ctx)
  return evaluateEdit(req, ctx)
}

function evaluateAdd(req: RosterEditRequest, ctx: RosterEditContext): RosterEditResolution {
  const participant = req.participant
  if (!participant || !isNonEmptyString(participant.provider)) {
    return fail('no_provider', 'Roster add rejected: participant.provider is required.')
  }

  const ceiling = validateParticipantPermissionInput(participant, ctx.roundReadOnly)
  if (ceiling) return ceiling
  if (ctx.participants.length >= MAX_ENSEMBLE_PARTICIPANTS) {
    return fail('roster_max', 'Roster add rejected: the Ensemble roster is already at the maximum size.')
  }

  const id = mintUniqueParticipantId(ctx)
  if (!id) {
    return fail('invalid_request', 'Roster add rejected: nextParticipantId did not produce a usable id.')
  }

  const provider = participant.provider as ProviderId
  const permissionOverrides = clonePermissionOverrides(participant.permissionOverrides)
  const nextParticipant: EnsembleParticipant = {
    id,
    provider,
    enabled: true,
    role: participant.role || provider,
    instructions: participant.instructions || '',
    order: nextAppendOrder(ctx.participants),
    ...(participant.model ? { model: participant.model } : {}),
    permissionPresetId:
      (participant.permissionPresetId as PermissionPresetId | undefined) ||
      (ctx.roundReadOnly ? 'read_only' : 'default'),
    ...(participant.reasoningEffort ? { reasoningEffort: participant.reasoningEffort } : {}),
    ...(typeof participant.fastModeEnabled === 'boolean'
      ? { fastModeEnabled: participant.fastModeEnabled }
      : {}),
    ...(typeof participant.thinkingEnabled === 'boolean'
      ? { thinkingEnabled: participant.thinkingEnabled }
      : {}),
    ...(permissionOverrides ? { permissionOverrides } : {})
  }
  const nextParticipants = normalizeParticipantOrder([...ctx.participants, nextParticipant])
  return {
    ok: true,
    nextParticipants,
    affectedParticipantId: id,
    summary: `Added ${participantLabel(nextParticipant)} to the Ensemble roster.`
  }
}

function evaluateRemove(req: RosterEditRequest, ctx: RosterEditContext): RosterEditResolution {
  if (!req.targetParticipantId) {
    return fail('invalid_request', 'Roster remove rejected: targetParticipantId is required.')
  }
  const target = ctx.participants.find((participant) => participant.id === req.targetParticipantId)
  if (!target) {
    return fail('stale_target', 'Roster remove rejected: target participant is not in the roster.')
  }
  if (target.id === ctx.bossmanParticipantId) {
    return fail('remove_boss', 'Roster remove rejected: the configured Boss participant cannot be removed.')
  }
  if (ctx.participants.length <= MIN_ENSEMBLE_PARTICIPANTS) {
    return fail('roster_min', 'Roster remove rejected: the Ensemble roster is already at the minimum size.')
  }

  return {
    ok: true,
    nextParticipants: normalizeParticipantOrder(
      ctx.participants.filter((participant) => participant.id !== target.id)
    ),
    affectedParticipantId: target.id,
    summary: `Removed ${participantLabel(target)} from the Ensemble roster.`
  }
}

function evaluateEdit(req: RosterEditRequest, ctx: RosterEditContext): RosterEditResolution {
  if (!req.targetParticipantId) {
    return fail('invalid_request', 'Roster edit rejected: targetParticipantId is required.')
  }
  const participant = req.participant
  if (!participant || !hasAnyPatchField(participant)) {
    return fail('invalid_request', 'Roster edit rejected: at least one participant field is required.')
  }
  if (hasOwn.call(participant, 'provider') && !isNonEmptyString(participant.provider)) {
    return fail('no_provider', 'Roster edit rejected: participant.provider must be non-empty when provided.')
  }

  const ceiling = validateParticipantPermissionInput(participant, ctx.roundReadOnly)
  if (ceiling) return ceiling

  const targetIndex = ctx.participants.findIndex(
    (participant) => participant.id === req.targetParticipantId
  )
  if (targetIndex < 0) {
    return fail('stale_target', 'Roster edit rejected: target participant is not in the roster.')
  }

  const target = ctx.participants[targetIndex]
  const nextTarget = applyParticipantPatch(target, participant)
  const monotonicFineOverrides = validateFineOverridesRemainMonotonic(
    target.permissionOverrides,
    nextTarget.permissionOverrides
  )
  if (monotonicFineOverrides) return monotonicFineOverrides

  const nextParticipants = normalizeParticipantOrder(
    ctx.participants.map((existing, index) => (index === targetIndex ? nextTarget : existing))
  )
  return {
    ok: true,
    nextParticipants,
    affectedParticipantId: target.id,
    summary: `Edited ${participantLabel(nextTarget)} in the Ensemble roster.`
  }
}

function validateParticipantPermissionInput(
  participant: RosterEditParticipantInput,
  roundReadOnly: boolean
): Extract<RosterEditResolution, { ok: false }> | null {
  if (
    participant.permissionPresetId !== undefined &&
    !ASSIGNABLE_PERMISSION_PRESET_SET.has(String(participant.permissionPresetId))
  ) {
    return fail(
      'permission_ceiling',
      'Roster edit rejected: permissionPresetId must be read_only, plan, or default.'
    )
  }
  if (
    roundReadOnly &&
    participant.permissionPresetId !== undefined &&
    !READ_ONLY_ROUND_PERMISSION_PRESET_SET.has(String(participant.permissionPresetId))
  ) {
    return fail('read_only_posture', 'Roster edit rejected: a read-only round cannot assign write permissions.')
  }

  const overrides = participant.permissionOverrides
  if (overrides) {
    const grants = Array.isArray(overrides.externalPathGrants) ? overrides.externalPathGrants : []
    if (grants.length > 0) {
      return fail(
        'external_path_forbidden',
        'Roster edit rejected: external path grants cannot be assigned by roster edit.'
      )
    }
    const services = overrides.agenticServices || {}
    for (const policy of Object.values(services)) {
      if (policy !== undefined && policy !== 'deny') {
        return fail(
          'tool_grant_widen',
          'Roster edit rejected: participant service overrides may only narrow to deny.'
        )
      }
    }
    if (overrides.networkAccess !== undefined && overrides.networkAccess !== 'deny') {
      return fail(
        'tool_grant_widen',
        'Roster edit rejected: participant network overrides may only narrow to deny.'
      )
    }
    if (overrides.approvalMode !== undefined && overrides.approvalMode !== 'plan') {
      return fail(
        'tool_grant_widen',
        'Roster edit rejected: participant approvalMode overrides may only narrow to plan.'
      )
    }
  }

  return null
}

function applyParticipantPatch(
  target: EnsembleParticipant,
  patch: RosterEditParticipantInput
): EnsembleParticipant {
  const next: EnsembleParticipant = { ...target }
  if (hasOwn.call(patch, 'provider') && isNonEmptyString(patch.provider)) {
    next.provider = patch.provider as ProviderId
  }
  if (hasOwn.call(patch, 'model')) {
    if (patch.model) next.model = patch.model
    else delete next.model
  }
  if (hasOwn.call(patch, 'role') && typeof patch.role === 'string') {
    next.role = patch.role
  }
  if (hasOwn.call(patch, 'instructions') && typeof patch.instructions === 'string') {
    next.instructions = patch.instructions
  }
  if (hasOwn.call(patch, 'reasoningEffort')) {
    if (patch.reasoningEffort) next.reasoningEffort = patch.reasoningEffort
    else delete next.reasoningEffort
  }
  if (hasOwn.call(patch, 'fastModeEnabled') && typeof patch.fastModeEnabled === 'boolean') {
    next.fastModeEnabled = patch.fastModeEnabled
  }
  if (hasOwn.call(patch, 'thinkingEnabled') && typeof patch.thinkingEnabled === 'boolean') {
    next.thinkingEnabled = patch.thinkingEnabled
  }
  if (hasOwn.call(patch, 'permissionPresetId') && patch.permissionPresetId) {
    next.permissionPresetId = patch.permissionPresetId as PermissionPresetId
  }
  if (hasOwn.call(patch, 'permissionOverrides')) {
    const overrides = clonePermissionOverrides(patch.permissionOverrides)
    if (overrides) next.permissionOverrides = overrides
    else delete next.permissionOverrides
  }
  return next
}

function validateFineOverridesRemainMonotonic(
  before: PermissionOverrides | undefined,
  after: PermissionOverrides | undefined
): Extract<RosterEditResolution, { ok: false }> | null {
  const beforeServices = before?.agenticServices || {}
  const afterServices = after?.agenticServices || {}
  const afterServicePolicies = afterServices as Record<string, string | undefined>
  for (const [service, policy] of Object.entries(beforeServices)) {
    if (policy === 'deny' && afterServicePolicies[service] !== 'deny') {
      return fail(
        'tool_grant_widen',
        'Roster edit rejected: existing participant service denies cannot be removed by roster edit.'
      )
    }
  }
  if (before?.networkAccess === 'deny' && after?.networkAccess !== 'deny') {
    return fail(
      'tool_grant_widen',
      'Roster edit rejected: an existing participant network deny cannot be removed by roster edit.'
    )
  }
  if (before?.approvalMode === 'plan' && after?.approvalMode !== 'plan') {
    return fail(
      'tool_grant_widen',
      'Roster edit rejected: an existing participant read-only approval override cannot be removed by roster edit.'
    )
  }
  return null
}

function clonePermissionOverrides(
  overrides: PermissionOverrides | null | undefined
): PermissionOverrides | undefined {
  if (!overrides) return undefined
  const next: PermissionOverrides = {}
  if (overrides.approvalMode !== undefined) next.approvalMode = overrides.approvalMode
  if (overrides.networkAccess !== undefined) next.networkAccess = overrides.networkAccess
  if (overrides.agenticServices) {
    next.agenticServices = { ...overrides.agenticServices }
  }
  if (Array.isArray(overrides.externalPathGrants) && overrides.externalPathGrants.length > 0) {
    next.externalPathGrants = overrides.externalPathGrants.map((grant) => ({ ...grant }))
  }
  return Object.keys(next).length > 0 ? next : undefined
}

function mintUniqueParticipantId(ctx: RosterEditContext): string | undefined {
  const existing = new Set(ctx.participants.map((participant) => participant.id))
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = ctx.nextParticipantId()
    if (isNonEmptyString(id) && !existing.has(id)) return id
  }
  return undefined
}

function normalizeParticipantOrder(participants: EnsembleParticipant[]): EnsembleParticipant[] {
  return participants
    .map((participant, index) => ({ participant, index }))
    .sort(
      (a, b) =>
        a.participant.order - b.participant.order ||
        a.index - b.index ||
        participantLabel(a.participant).localeCompare(participantLabel(b.participant))
    )
    .map(({ participant }, index) => ({ ...participant, order: index + 1 }))
}

function nextAppendOrder(participants: EnsembleParticipant[]): number {
  return participants.reduce((max, participant) => Math.max(max, participant.order || 0), 0) + 1
}

function hasAnyPatchField(participant: RosterEditParticipantInput): boolean {
  return PATCH_FIELDS.some((field) => hasOwn.call(participant, field))
}

function participantExists(participants: EnsembleParticipant[], participantId: string): boolean {
  return participants.some((participant) => participant.id === participantId)
}

function participantLabel(participant: Pick<EnsembleParticipant, 'role' | 'provider'>): string {
  return participant.role || participant.provider
}

function isRosterEditAction(action: string): action is RosterEditAction {
  return (
    action === 'add_participant' ||
    action === 'remove_participant' ||
    action === 'edit_participant'
  )
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function fail(error: RosterEditError, message: string): Extract<RosterEditResolution, { ok: false }> {
  return { ok: false, error, message }
}
