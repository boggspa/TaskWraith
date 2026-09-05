import type { EnsembleAuthorityRole } from '../../shared/ensembleAuthority'
import { providerLabel } from '../EnsemblePrompt'
import type { RosterEditParticipantInput } from '../EnsembleRosterMutation'
import type {
  EnsembleParticipant,
  EnsembleParticipantStatus,
  EnsembleRoundParticipantState,
  EnsembleSeatSnapshot,
  EnsembleStageRole,
  ProviderId,
  SeatChangeSeatState
} from '../store/types'

const ENSEMBLE_SEAT_STAGE_ROLES = new Set<string>(['scout', 'worker', 'reviewer', 'background'])
const BRIEF_SEAT_VALUE_PREVIEW_CHARS = 160

/**
 * Snapshot one side of an authoritative seat change for the transcript row.
 * The preset fallback mirrors the seat-snapshot rule (`|| 'default'`) so the
 * row shows the tier the dispatch layer would actually resolve.
 */
export function seatChangeSeatState(
  participant: EnsembleParticipant,
  grantsCount?: number,
  authority?: EnsembleAuthorityRole
): SeatChangeSeatState {
  return {
    provider: participant.provider,
    model: participant.model || '',
    ...(participant.role ? { role: participant.role } : {}),
    ...(participant.order ? { seatNumber: participant.order } : {}),
    // Captured per side, so a change that moves a seat between stages (or in or
    // out of authority) is visible in the row rather than silently invisible.
    ...(participant.stageRole ? { stageRole: participant.stageRole } : {}),
    ...(authority ? { authority } : {}),
    ...(participant.reasoningEffort ? { reasoningEffort: participant.reasoningEffort } : {}),
    ...(participant.thinkingEnabled === undefined
      ? {}
      : { thinkingEnabled: participant.thinkingEnabled }),
    permissionPresetId: participant.permissionPresetId || 'default',
    ...(grantsCount === undefined ? {} : { grantsCount })
  }
}

export function participantSeatValue(participant: EnsembleParticipant): string {
  const provider = providerLabel(participant.provider)
  const model = participant.model ? ` / ${participant.model}` : ''
  const role = participant.role ? ` (${participant.role})` : ''
  const stage = participant.stageRole ? ` [${participant.stageRole}]` : ''
  const enabled = participant.enabled ? '' : ' [disabled]'
  return `${provider}${model}${role}${stage}${enabled}`
}

export function roundParticipantDisplayFields(
  participant: EnsembleParticipant
): Pick<EnsembleRoundParticipantState, 'provider' | 'role' | 'order'> &
  Partial<
    Pick<
      EnsembleRoundParticipantState,
      | 'model'
      | 'reasoningEffort'
      | 'fastModeEnabled'
      | 'thinkingEnabled'
      | 'serviceTier'
      | 'permissionPresetId'
    >
  > {
  return {
    provider: participant.provider,
    role: participant.role,
    order: participant.order,
    model: participant.model,
    reasoningEffort: participant.reasoningEffort,
    fastModeEnabled: participant.fastModeEnabled,
    thinkingEnabled: participant.thinkingEnabled,
    serviceTier: participant.serviceTier,
    permissionPresetId: participant.permissionPresetId
  }
}

export function ensembleSeatSnapshot(participant: EnsembleParticipant): EnsembleSeatSnapshot {
  return {
    schemaVersion: 1,
    provider: participant.provider,
    ...(participant.model ? { model: participant.model } : {}),
    ...(participant.reasoningEffort !== undefined
      ? { reasoningEffort: participant.reasoningEffort }
      : {}),
    ...(participant.fastModeEnabled !== undefined
      ? { fastModeEnabled: participant.fastModeEnabled }
      : {}),
    ...(participant.provider === 'kimi'
      ? { thinkingEnabled: participant.thinkingEnabled ?? true }
      : participant.thinkingEnabled !== undefined
        ? { thinkingEnabled: participant.thinkingEnabled }
        : {}),
    ...(participant.serviceTier ? { serviceTier: participant.serviceTier } : {}),
    configuredPermissionPresetId: participant.permissionPresetId || 'default'
  }
}

export function roundParticipantStateFromParticipant(
  participant: EnsembleParticipant,
  status: EnsembleParticipantStatus
): EnsembleRoundParticipantState {
  return {
    participantId: participant.id,
    ...roundParticipantDisplayFields(participant),
    initialSeatSnapshot: ensembleSeatSnapshot(participant),
    status
  }
}

function compactBriefValue(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized) return '(empty)'
  return normalized.length > BRIEF_SEAT_VALUE_PREVIEW_CHARS
    ? `${normalized.slice(0, BRIEF_SEAT_VALUE_PREVIEW_CHARS - 3)}...`
    : normalized
}

export function participantSeatChangeValue(
  before: EnsembleParticipant,
  after: EnsembleParticipant,
  participant: EnsembleParticipant
): string {
  if (
    participantSeatValue(before) === participantSeatValue(after) &&
    before.instructions !== after.instructions
  ) {
    return `Brief / Goal: ${compactBriefValue(participant.instructions)}`
  }
  return participantSeatValue(participant)
}

export function hasSeatChangePatch(patch: RosterEditParticipantInput | undefined | null): boolean {
  if (!patch) return false
  return (
    Object.prototype.hasOwnProperty.call(patch, 'provider') ||
    Object.prototype.hasOwnProperty.call(patch, 'enabled') ||
    Object.prototype.hasOwnProperty.call(patch, 'model') ||
    Object.prototype.hasOwnProperty.call(patch, 'runtimeProfileId') ||
    Object.prototype.hasOwnProperty.call(patch, 'geminiAuthProfileId') ||
    Object.prototype.hasOwnProperty.call(patch, 'ollamaRunProfile') ||
    Object.prototype.hasOwnProperty.call(patch, 'role') ||
    Object.prototype.hasOwnProperty.call(patch, 'instructions') ||
    Object.prototype.hasOwnProperty.call(patch, 'reasoningEffort') ||
    Object.prototype.hasOwnProperty.call(patch, 'fastModeEnabled') ||
    Object.prototype.hasOwnProperty.call(patch, 'thinkingEnabled') ||
    Object.prototype.hasOwnProperty.call(patch, 'serviceTier') ||
    Object.prototype.hasOwnProperty.call(patch, 'permissionPresetId') ||
    Object.prototype.hasOwnProperty.call(patch, 'permissionOverrides') ||
    Object.prototype.hasOwnProperty.call(patch, 'stageRole') ||
    Object.prototype.hasOwnProperty.call(patch, 'linkedProviderSessionId')
  )
}

/**
 * User-facing seat equality, used to suppress no-op / duplicate seat changes.
 *
 * Deliberately compares ONLY the fields a user would call "the seat" and
 * ignores the internal side effects `applySeatChangePatch` produces: it nulls
 * `linkedProviderSessionId` even when the provider value is repeated, and it
 * drops the prompt / MCP receipt fields it invalidates. A plain object compare
 * would therefore never read a re-apply of the current seat as "unchanged",
 * which is exactly the case this predicate exists to catch.
 */
export function participantSeatSelectionUnchanged(
  a: EnsembleParticipant,
  b: EnsembleParticipant
): boolean {
  const text = (value: unknown): string =>
    value === undefined || value === null ? '' : String(value)
  const json = (value: unknown): string => {
    try {
      return JSON.stringify(value ?? null)
    } catch {
      return text(value)
    }
  }
  return (
    a.provider === b.provider &&
    a.enabled === b.enabled &&
    text(a.model) === text(b.model) &&
    text(a.role) === text(b.role) &&
    text(a.instructions) === text(b.instructions) &&
    text(a.stageRole) === text(b.stageRole) &&
    text(a.reasoningEffort) === text(b.reasoningEffort) &&
    text(a.serviceTier) === text(b.serviceTier) &&
    text(a.permissionPresetId) === text(b.permissionPresetId) &&
    text(a.runtimeProfileId) === text(b.runtimeProfileId) &&
    text(a.geminiAuthProfileId) === text(b.geminiAuthProfileId) &&
    Boolean(a.fastModeEnabled) === Boolean(b.fastModeEnabled) &&
    Boolean(a.thinkingEnabled) === Boolean(b.thinkingEnabled) &&
    json(a.permissionOverrides) === json(b.permissionOverrides) &&
    json(a.ollamaRunProfile) === json(b.ollamaRunProfile)
  )
}

export function applySeatChangePatch(
  target: EnsembleParticipant,
  patch: RosterEditParticipantInput
): EnsembleParticipant {
  const next: EnsembleParticipant = {
    ...target,
    linkedProviderSessionId: target.linkedProviderSessionId
  }
  let promptReceiptsInvalidated = false
  let mcpProfileReceiptInvalidated = false
  if (
    Object.prototype.hasOwnProperty.call(patch, 'provider') &&
    typeof patch.provider === 'string' &&
    patch.provider
  ) {
    next.provider = patch.provider as ProviderId
    next.linkedProviderSessionId = null
    // The edit path deliberately abandons the previous native session even
    // when the provider value is repeated, so neither prompt receipt remains
    // evidence of what the next session remembers.
    promptReceiptsInvalidated = true
    mcpProfileReceiptInvalidated = true
  }
  if (
    Object.prototype.hasOwnProperty.call(patch, 'enabled') &&
    typeof patch.enabled === 'boolean'
  ) {
    next.enabled = patch.enabled
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'model')) {
    const nextModel = patch.model || undefined
    if ((target.model || '') !== (nextModel || '')) {
      promptReceiptsInvalidated = true
    }
    if (patch.model) next.model = patch.model
    else delete next.model
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'runtimeProfileId')) {
    if (patch.runtimeProfileId) next.runtimeProfileId = patch.runtimeProfileId
    else delete next.runtimeProfileId
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'geminiAuthProfileId')) {
    if (typeof patch.geminiAuthProfileId === 'string' || patch.geminiAuthProfileId === null) {
      next.geminiAuthProfileId = patch.geminiAuthProfileId
    } else {
      delete next.geminiAuthProfileId
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'ollamaRunProfile')) {
    if (patch.ollamaRunProfile) next.ollamaRunProfile = patch.ollamaRunProfile
    else delete next.ollamaRunProfile
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'role') && typeof patch.role === 'string') {
    next.role = patch.role
  }
  if (
    Object.prototype.hasOwnProperty.call(patch, 'instructions') &&
    typeof patch.instructions === 'string'
  ) {
    next.instructions = patch.instructions
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'reasoningEffort')) {
    if (patch.reasoningEffort) next.reasoningEffort = patch.reasoningEffort
    else delete next.reasoningEffort
  }
  if (
    Object.prototype.hasOwnProperty.call(patch, 'fastModeEnabled') &&
    typeof patch.fastModeEnabled === 'boolean'
  ) {
    next.fastModeEnabled = patch.fastModeEnabled
  }
  if (
    Object.prototype.hasOwnProperty.call(patch, 'thinkingEnabled') &&
    typeof patch.thinkingEnabled === 'boolean'
  ) {
    next.thinkingEnabled = patch.thinkingEnabled
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'serviceTier')) {
    if (patch.serviceTier) next.serviceTier = patch.serviceTier
    else delete next.serviceTier
  }
  if (
    Object.prototype.hasOwnProperty.call(patch, 'permissionPresetId') &&
    patch.permissionPresetId
  ) {
    next.permissionPresetId = patch.permissionPresetId as EnsembleParticipant['permissionPresetId']
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'permissionOverrides')) {
    if (patch.permissionOverrides) next.permissionOverrides = patch.permissionOverrides
    else delete next.permissionOverrides
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'stageRole')) {
    if (patch.stageRole && ENSEMBLE_SEAT_STAGE_ROLES.has(String(patch.stageRole))) {
      next.stageRole = patch.stageRole as EnsembleStageRole
    } else {
      delete next.stageRole
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'linkedProviderSessionId')) {
    if (
      typeof patch.linkedProviderSessionId === 'string' ||
      patch.linkedProviderSessionId === null
    ) {
      next.linkedProviderSessionId = patch.linkedProviderSessionId
    } else {
      delete next.linkedProviderSessionId
    }
    if ((next.linkedProviderSessionId || '') !== (target.linkedProviderSessionId || '')) {
      promptReceiptsInvalidated = true
      mcpProfileReceiptInvalidated = true
    }
  }
  if (promptReceiptsInvalidated) {
    delete next.promptShellVersion
    delete next.promptDynamicStateVersion
  }
  if (mcpProfileReceiptInvalidated) {
    delete next.taskWraithMcpProfileReceipt
  }
  return next
}
