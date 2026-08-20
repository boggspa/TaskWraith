/*
 * EnsembleParticipantsAboveRow — 1.0.3 ship-night.
 *
 * Replaces the bottom-pinned `EnsembleSetupSheet` modal AND the
 * top-of-chat `EnsembleParticipantStrip`, consolidating both into a
 * single composer above-row that sits below the existing file-changes
 * + Create PR row and above the composer textarea.
 *
 * Slice F v2 (1.0.3 — same ship-night rework): instead of opening a
 * per-chip flyout for editing, clicking a chip SELECTS it. The
 * composer's existing `CombinedModelPicker` + `CombinedPermissionsPicker`
 * then rebind to read/write the selected participant's settings. This
 * means there's one set of pickers in the app (the composer's), and
 * the chips just retarget who they configure.
 *
 *   - Click chip → onSelectParticipant(id). The chip gets a thick
 *     accent border to signal selection.
 *   - Drag horizontally → reorder the speaking sequence (HTML5
 *     native drag-and-drop, persisted via onChatChange).
 *   - On the selected chip only, a `⋯` overflow button surfaces an
 *     inline mini-popover for the two affordances that don't have
 *     a natural home in the composer pickers: `enabled` toggle and
 *     `role` rename.
 *   - Disabled participants render dimmed; they're still selectable
 *     so the user can re-enable from the overflow.
 *
 * Selection state lives in the parent (App.tsx) so the composer
 * pickers can read it. Auto-follow-active-speaker logic also lives
 * upstream — this component is otherwise display-only beyond click +
 * drag + the overflow editor.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BossmanCrownIcon,
  CaptainHatIcon,
  EnsembleStageRoleIcon
} from './icons/ParticipantRoleIcon'
import { createPortal } from 'react-dom'
import { MAX_ENSEMBLE_PARTICIPANTS } from '../../../shared/ensembleLimits'
import {
  MAX_ENSEMBLE_CAPTAINS,
  normalizeEnsembleAuthority,
  type EnsembleParticipantAuthority as SharedEnsembleParticipantAuthority
} from '../../../shared/ensembleAuthority'
import type {
  ChatRecord,
  ComposerStyle,
  ConcurrentLane,
  EnsembleParticipant,
  ProviderId
} from '../../../main/store/types'
import type { EnsembleUserRosterMutation } from '../../../main/EnsembleUserRosterMutation'
import {
  buildKimiReasoningPickerPatch,
  getDefaultEnsembleParticipantConfig,
  getDefaultEnsembleRoleName,
  getEnsembleModelDefaults,
  getEnsembleReasoningOptions,
  normalizeProviderModelSelection,
  resolveKimiReasoningPickerSelection
} from '../lib/ensembleProviderDefaults'
import {
  ENSEMBLE_STAGE_ROLE_HINT,
  ENSEMBLE_STAGE_ROLE_OPTIONS,
  normalizeEnsembleStageRole
} from '../lib/ensembleStageRoles'
import {
  ENSEMBLE_ROLE_PRESET_CUSTOM,
  ENSEMBLE_ROLE_PRESETS,
  resolveRolePresetId,
  roleLabelForPresetId
} from '../lib/ensembleRolePresets'
import { ParticipantStatusIcon } from './icons/ParticipantStatusIcon'
import { buildParticipantTokenChipTooltipLine } from '../lib/participantTokenChip'
import { resolveProviderBrandLabel, resolveProviderHueClass } from '../lib/ollamaDisplayBrand'
import { humaniseModelId } from '../lib/modelDisplayName'
import { withSessionActivityLedger } from '../lib/sessionActivityLedger'
import { deriveEnsembleParticipantChipStatus } from '../lib/ensembleParticipantChipStatus'
import {
  resolveEffectiveRoster,
  isExternalSeat,
  type ExternalSeatInput
} from '../../../shared/effectiveEnsembleRoster'
import {
  MIN_LIVE_ENSEMBLE_PARTICIPANTS,
  resolveEnsembleCollapseTarget
} from '../lib/ensembleRosterFloor'
import { isEnsembleActiveRoundDispatchLive } from '../lib/chatBusyState'
import {
  claudeReasoningDisplayLabel,
  codexReasoningDisplayLabel,
  grokReasoningDisplayLabel
} from '../lib/composerChipFormat'
import {
  resolveProviderRows,
  type ProviderPickerAvailability
} from './ComposerProviderPicker'
import {
  CombinedModelPicker,
  type CombinedModelPickerProviderGroup,
  type CombinedModelPickerReasoningOption
} from './CombinedModelPicker'
import {
  ComposerTextareaContextMenu,
  useComposerTextareaContextMenu
} from './ComposerTextareaContextMenu'
import { getProviderName } from './Sidebar'
import { EnsembleBriefEditor } from './EnsembleBriefEditor'
import { PillButton } from './PillButton'
import { SegmentedControl } from './SegmentedControl'
import { FAST_MODEL_IDS, antigravityEffortForModelId } from '../../../shared/antigravityAgyModelGrouping'
import { ProviderBrandLogoIcon } from './icons/ProviderBrandLogo'

// 1.0.4-AR2 — global ceiling raised from 6 → 8 so the panel can host
// the broader then-four-provider roster plus alternates (e.g. two
// Claudes in different roles; the supported roster is nine providers
// today). The hard minimum is enforced in `removeParticipant` below.
//
// 1.0.5-EW1 — Ceiling raised again 8 → 12. The chip strip now wraps
// at 7+ participants instead of overflowing horizontally.
//
// 1.0.5-EW46 — Ceiling raised 12 → 18 (three rows of the then-6-column
// grid).
//
// 1.7.x — The wrapped layout moved from a fixed six-column grid to
// balanced rows of AT MOST 5 chips. The shared ceiling now permits up to
// six rows while keeping role names readable.
// A one-seat roster is a solo chat wearing ensemble chrome, so the live floor
// is TWO — see `ensembleRosterFloor.ts` for the rule and its exemptions.
// Removal does not stop AT the floor: dropping below it switches Ensemble off
// and hands the thread to the surviving seat (`onCollapseToSolo`), which is why
// the trash button stays live all the way down.
const MIN_ENSEMBLE_PARTICIPANTS = MIN_LIVE_ENSEMBLE_PARTICIPANTS
// Threshold at which the chip strip switches from the centered
// content-width flex layout to the balanced-rows grid. 6 is the first
// count that no longer fits the 5-per-row ceiling on a single row.
const ENSEMBLE_CHIPS_WRAP_THRESHOLD = 6
// Ceiling of chips per row in the wrapped layout.
const ENSEMBLE_CHIP_ROW_MAX = 5
// The wrapped strip is one CSS grid with 60 fractional tracks (LCM of
// the possible row lengths 3 / 4 / 5), and every chip spans
// 60 ÷ row-length tracks (20 / 15 / 12 — all exact). Each row's spans
// sum to exactly 60, so `grid-auto-flow: row` breaks lines precisely at
// the intended row boundaries while chips stay DIRECT children of the
// grid — the drag-reorder hit-testing (`resolveReorderDropTarget`) and
// the per-chip `@container ensemble-chip` queries carry over untouched.
export const ENSEMBLE_CHIP_GRID_TRACKS = 60
export const BOSS_AUTO_APPROVAL_CONSENT_MESSAGE =
  'Allow Boss/Captain Auto Approvals for this Ensemble? Boss remains primary; only the current acting Captain can use this consent when Boss is unavailable. Approvals stay one-shot and limited to the selected participant permission preset and workspace policy. If an eligible shell/file request still opens a modal and the authority is idle, TaskWraith opens a read-only Boss/Captain review turn; the first human, authority, or timeout decision wins. This will not grant session/workspace approval, YOLO, policy changes, external-path escapes, or unclassified requests.'

export type EnsembleParticipantAuthority = SharedEnsembleParticipantAuthority
export type EnsembleParticipantStageChoice =
  | 'any'
  | NonNullable<EnsembleParticipant['stageRole']>

const ENSEMBLE_PARTICIPANT_STAGE_OPTIONS: ReadonlyArray<{
  value: EnsembleParticipantStageChoice
  label: string
  title: string
}> = [
  {
    value: 'any',
    label: 'Any',
    title: 'Infer this participant\'s stage from its permissions.'
  },
  ...ENSEMBLE_STAGE_ROLE_OPTIONS.map((option) => ({
    value: option.id,
    label:
      option.id === 'scout'
        ? 'Scout'
        : option.id === 'worker'
          ? 'Work'
          : option.id === 'reviewer'
            ? 'Review'
            : 'BG',
    title: option.description
  }))
]

type EnsembleAuthorityPatch = Pick<
  NonNullable<ChatRecord['ensemble']>,
  | 'bossmanParticipantId'
  | 'captainParticipantIds'
  | 'secondInCommandParticipantId'
  | 'bossmanAutoApprovals'
>

/**
 * Atomically moves one participant between the exclusive Boss role, the
 * bounded Captain set, and ordinary Agent authority. Exactly one configured
 * Boss is retained; Captains are canonicalized in roster order and capped at
 * three. Thread-wide auto approval consent belongs to the configured Boss.
 */
export function resolveEnsembleParticipantAuthorityPatch(
  state: EnsembleAuthorityPatch,
  participantId: string,
  authority: EnsembleParticipantAuthority,
  participants: readonly EnsembleParticipant[]
): EnsembleAuthorityPatch {
  const current = normalizeEnsembleAuthority({
    participants,
    bossmanParticipantId: state.bossmanParticipantId,
    captainParticipantIds: state.captainParticipantIds,
    secondInCommandParticipantId: state.secondInCommandParticipantId
  })
  let bossmanParticipantId = current.bossmanParticipantId
  let captainParticipantIds = current.captainParticipantIds

  // Removing or demoting the only Boss is not a valid single-seat mutation.
  // The user can still replace it atomically by assigning Boss to another seat.
  if (participantId === bossmanParticipantId && authority !== 'boss') {
    return {
      bossmanParticipantId,
      captainParticipantIds,
      secondInCommandParticipantId: captainParticipantIds[0],
      bossmanAutoApprovals: state.bossmanAutoApprovals
    }
  }

  if (authority === 'boss') {
    bossmanParticipantId = participantId
    captainParticipantIds = captainParticipantIds.filter((id) => id !== participantId)
  } else if (authority === 'captain') {
    if (
      !captainParticipantIds.includes(participantId) &&
      captainParticipantIds.length < MAX_ENSEMBLE_CAPTAINS
    ) {
      captainParticipantIds = [...captainParticipantIds, participantId]
    }
  } else {
    captainParticipantIds = captainParticipantIds.filter((id) => id !== participantId)
  }

  const normalized = normalizeEnsembleAuthority({
    participants,
    bossmanParticipantId,
    captainParticipantIds,
    recoverBoss: false
  })

  return {
    bossmanParticipantId: normalized.bossmanParticipantId,
    captainParticipantIds: normalized.captainParticipantIds,
    secondInCommandParticipantId: normalized.secondInCommandParticipantId,
    bossmanAutoApprovals: normalized.bossmanParticipantId
      ? state.bossmanAutoApprovals
      : undefined
  }
}

/**
 * Balanced row distribution for the wrapped chip strip: rows hold at
 * most ENSEMBLE_CHIP_ROW_MAX chips, split as evenly as possible, with
 * the remainder landing on the LATER rows (7 → 3+4, 13 → 4+4+5,
 * 18 → 4+4+5+5 …) so the strip reads top-light per the product spec.
 */
export function computeEnsembleChipRowDistribution(count: number): number[] {
  if (count <= 0) return []
  const rows = Math.ceil(count / ENSEMBLE_CHIP_ROW_MAX)
  const base = Math.floor(count / rows)
  const remainder = count % rows
  return Array.from({ length: rows }, (_, index) =>
    index < rows - remainder ? base : base + 1
  )
}

/** Per-chip `grid-column` span for the wrapped strip (index-aligned
 * with the participants array). */
export function computeEnsembleChipGridSpans(count: number): number[] {
  return computeEnsembleChipRowDistribution(count).flatMap((rowLength) =>
    Array.from({ length: rowLength }, () => ENSEMBLE_CHIP_GRID_TRACKS / rowLength)
  )
}

/**
 * Draft payload owned by the add-participant picker. It intentionally contains
 * only provider/model execution settings: identity, role, permissions, order,
 * and session linkage remain the roster's responsibility when the draft is
 * committed.
 */
export interface EnsembleParticipantAddConfiguration {
  provider: ProviderId
  model: string
  reasoningEffort?: string
  fastModeEnabled?: boolean
  thinkingEnabled?: boolean
  serviceTier?: string
}

export interface EnsembleParticipantAddDetails {
  enabled: boolean
  authority: EnsembleParticipantAuthority
  autoApprovalsEnabled: boolean
  autoApprovalsConfirmedAt?: string
  stageRole?: EnsembleParticipant['stageRole']
  role: string
  instructions: string
}

export type EnsembleParticipantAddDraft = EnsembleParticipantAddConfiguration &
  EnsembleParticipantAddDetails

/** Ordered, synthetic-custom-free catalogs for the Ensemble `+` picker. */
export function buildEnsembleAddProviderGroups(
  grokAvailable: boolean,
  cursorAvailable: boolean,
  availability: ProviderPickerAvailability
): CombinedModelPickerProviderGroup[] {
  return resolveProviderRows(grokAvailable, cursorAvailable, undefined, availability).map((row) => {
    const defaults = getEnsembleModelDefaults(row.id)
    return {
      provider: row.id,
      label: row.label,
      modelOptions: defaults.modelOptions.filter((option) => option.id !== 'custom'),
      fastModeCapableModelIds: defaults.fastModeCapableModelIds,
      ...(row.pauseLabel ? { pauseLabel: row.pauseLabel } : {}),
      ...(row.rerouteLabel ? { rerouteLabel: row.rerouteLabel } : {})
    }
  })
}

export function resolveEnsembleAddProviderGroups(
  providerGroups: readonly CombinedModelPickerProviderGroup[] | undefined,
  grokAvailable: boolean,
  cursorAvailable: boolean
): CombinedModelPickerProviderGroup[] {
  // There is no safe unfiltered fallback: live callers must supply the catalog
  // derived from the configured-provider snapshot. Missing catalog means no
  // add choices, while existing participant chips remain visible and editable.
  void grokAvailable
  void cursorAvailable
  const source = providerGroups ?? []
  return source.map((group) => ({
    ...group,
    modelOptions: group.modelOptions.filter((option) => option.id !== 'custom')
  }))
}

function normalizeReasoningOptionValue(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'light') return 'low'
  if (normalized === 'extra') return 'xhigh'
  if (normalized === 'ultra') return 'ultracode'
  return normalized
}

function reasoningOptionLabel(provider: ProviderId, value: string): string {
  if (provider === 'codex') return codexReasoningDisplayLabel(value)
  if (provider === 'claude') return claudeReasoningDisplayLabel(value)
  if (provider === 'grok' || provider === 'cursor') return grokReasoningDisplayLabel(value)
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function findEnsembleAddModelOption(
  provider: ProviderId,
  model: string,
  modelOptions: CombinedModelPickerProviderGroup['modelOptions']
) {
  return (
    modelOptions.find((option) => option.id === model) ||
    (provider === 'antigravity'
      ? modelOptions.find((option) =>
          option.antigravityVariants?.some((variant) => variant.id === model)
        )
      : undefined)
  )
}

export function getEnsembleAddReasoningOptions(
  provider: ProviderId,
  model: string,
  providerGroups: readonly CombinedModelPickerProviderGroup[]
): CombinedModelPickerReasoningOption[] {
  const modelOptions =
    providerGroups.find((group) => group.provider === provider)?.modelOptions || []
  const modelOption = findEnsembleAddModelOption(provider, model, modelOptions)
  if (provider === 'antigravity' && modelOption?.antigravityVariants) {
    return modelOption.antigravityVariants.map((variant) => ({
      value: variant.effort,
      label: reasoningOptionLabel(provider, variant.effort)
    }))
  }
  if (modelOption?.supportedReasoningEfforts) {
    return modelOption.supportedReasoningEfforts.map((option) => {
      const value = normalizeReasoningOptionValue(option.reasoningEffort)
      return {
        value,
        label: reasoningOptionLabel(provider, value),
        ...(option.disabled ? { disabled: true } : {}),
        ...(option.disabledReason ? { disabledReason: option.disabledReason } : {})
      }
    })
  }
  return getEnsembleReasoningOptions(provider, model, modelOption)
}

/**
 * Resolve a fresh provider/model choice to canonical execution defaults. A
 * model switch starts clean instead of carrying reasoning/Fast state from the
 * previously previewed provider. The user can then tune this draft before the
 * single Add confirmation persists it.
 */
export function createEnsembleParticipantAddConfiguration(
  provider: ProviderId,
  requestedModel?: string,
  providerGroups?: readonly CombinedModelPickerProviderGroup[]
): EnsembleParticipantAddConfiguration {
  const participantDefaults = getDefaultEnsembleParticipantConfig(provider)
  const modelDefaults = getEnsembleModelDefaults(provider)
  const providerGroup = providerGroups?.find((group) => group.provider === provider)
  const modelOptions = providerGroup?.modelOptions.length
    ? providerGroup.modelOptions
    : modelDefaults.modelOptions
  const requestedOption = requestedModel
    ? findEnsembleAddModelOption(provider, requestedModel, modelOptions)
    : undefined
  const selectableRequestedOption =
    requestedOption?.id !== 'custom' && !requestedOption?.disabled ? requestedOption : undefined
  const defaultOption =
    modelOptions.find(
      (option) => option.id === participantDefaults.model && option.id !== 'custom' && !option.disabled
    ) ||
    modelOptions.find(
      (option) =>
        option.id === modelDefaults.defaultModelId && option.id !== 'custom' && !option.disabled
    ) ||
    modelOptions.find((option) => option.id !== 'custom' && !option.disabled)
  const model = selectableRequestedOption
    ? requestedModel!
    : defaultOption?.id || participantDefaults.model
  const modelOption = selectableRequestedOption || defaultOption
  const normalized = normalizeProviderModelSelection(provider, model, modelOption)

  return {
    provider,
    ...normalized,
    model
  }
}

export function createEnsembleParticipantAddDetails(
  provider: ProviderId,
  participants: ReadonlyArray<Pick<EnsembleParticipant, 'role'>>,
  autoApprovals?: NonNullable<ChatRecord['ensemble']>['bossmanAutoApprovals']
): EnsembleParticipantAddDetails {
  const roleName = getDefaultEnsembleRoleName(provider)
  return {
    enabled: true,
    authority: 'agent',
    autoApprovalsEnabled: autoApprovals?.enabled === true,
    autoApprovalsConfirmedAt: autoApprovals?.confirmedAt,
    stageRole: undefined,
    role: nextRoleLabel(roleName, participants),
    instructions: `Contribute as ${roleName} for this ensemble.`
  }
}

export function retargetEnsembleParticipantAddDetails(
  current: EnsembleParticipantAddDetails,
  previousProvider: ProviderId,
  nextProvider: ProviderId,
  participants: ReadonlyArray<Pick<EnsembleParticipant, 'role'>>,
  autoApprovals?: NonNullable<ChatRecord['ensemble']>['bossmanAutoApprovals']
): EnsembleParticipantAddDetails {
  const previousDefaults = createEnsembleParticipantAddDetails(
    previousProvider,
    participants,
    autoApprovals
  )
  const nextDefaults = createEnsembleParticipantAddDetails(
    nextProvider,
    participants,
    autoApprovals
  )
  return {
    ...current,
    role: current.role === previousDefaults.role ? nextDefaults.role : current.role,
    instructions:
      current.instructions === previousDefaults.instructions
        ? nextDefaults.instructions
        : current.instructions
  }
}

/**
 * Copies every setting represented in the Add picker from an existing seat.
 * Models retired from the live catalog fall back to that provider's current
 * default. Runtime identity, permissions, ordering, and session linkage remain
 * fresh-seat concerns; the role is uniquified so the duplicate stays addressable.
 */
export function createEnsembleParticipantDuplicateDraft(
  participant: EnsembleParticipant,
  participants: readonly EnsembleParticipant[],
  authority: EnsembleParticipantAuthority,
  autoApprovals?: NonNullable<ChatRecord['ensemble']>['bossmanAutoApprovals'],
  providerGroups?: readonly CombinedModelPickerProviderGroup[]
): EnsembleParticipantAddDraft {
  const configuration = createEnsembleParticipantAddConfiguration(
    participant.provider,
    participant.model,
    providerGroups
  )
  return {
    ...configuration,
    reasoningEffort: participant.reasoningEffort ?? configuration.reasoningEffort,
    fastModeEnabled: participant.fastModeEnabled ?? configuration.fastModeEnabled,
    thinkingEnabled: participant.thinkingEnabled ?? configuration.thinkingEnabled,
    serviceTier: participant.serviceTier ?? configuration.serviceTier,
    enabled: participant.enabled,
    authority: participant.stageRole === 'background' ? 'agent' : authority,
    autoApprovalsEnabled: autoApprovals?.enabled === true,
    autoApprovalsConfirmedAt: autoApprovals?.confirmedAt,
    stageRole: participant.stageRole,
    role: nextRoleLabel(participant.role, participants),
    instructions: participant.instructions
  }
}

export function resolveEnsembleParticipantAddAuthorityPatch(
  state: EnsembleAuthorityPatch,
  participantId: string,
  authority: EnsembleParticipantAuthority,
  participants: readonly EnsembleParticipant[],
  autoApprovals: NonNullable<ChatRecord['ensemble']>['bossmanAutoApprovals']
): EnsembleAuthorityPatch {
  const authorityPatch = resolveEnsembleParticipantAuthorityPatch(
    state,
    participantId,
    authority,
    participants
  )
  const hasLeadership = Boolean(authorityPatch.bossmanParticipantId)
  return {
    ...authorityPatch,
    bossmanAutoApprovals: hasLeadership ? autoApprovals : undefined
  }
}

/** Pure roster materialization used by the live add flow and focused tests. */
export function buildEnsembleParticipantAddition(
  participants: EnsembleParticipant[],
  selectedParticipantId: string | null,
  configuration: EnsembleParticipantAddConfiguration & Partial<EnsembleParticipantAddDetails>
): { participant: EnsembleParticipant; insertIndex: number } {
  const source =
    participants.find((participant) => participant.id === selectedParticipantId) ||
    participants[participants.length - 1]
  const defaults = getDefaultEnsembleParticipantConfig(configuration.provider)
  const roleName = getDefaultEnsembleRoleName(configuration.provider)
  const sourceIndex = source
    ? participants.findIndex((participant) => participant.id === source.id)
    : participants.length - 1
  return {
    participant: {
      id: nextParticipantId(participants),
      provider: configuration.provider,
      enabled: configuration.enabled ?? true,
      role:
        configuration.role !== undefined
          ? configuration.role
          : nextRoleLabel(roleName, participants),
      instructions:
        configuration.instructions !== undefined
          ? configuration.instructions
          : `Contribute as ${roleName} for this ensemble.`,
      order: participants.length + 1,
      model: configuration.model || defaults.model,
      geminiAuthProfileId: null,
      permissionPresetId: defaults.permissionPresetId,
      stageRole: configuration.stageRole,
      reasoningEffort: configuration.reasoningEffort,
      fastModeEnabled: configuration.fastModeEnabled,
      thinkingEnabled: configuration.thinkingEnabled,
      serviceTier: configuration.serviceTier
    },
    insertIndex: Math.max(0, sourceIndex + 1)
  }
}

function isLiveFanoutLane(lane: ConcurrentLane): boolean {
  return (
    lane.status === 'pending' ||
    lane.status === 'running' ||
    lane.status === 'blocked' ||
    lane.status === 'awaiting-approval'
  )
}

function ParticipantLeadingRoleIcon({
  stageRole,
  isBossman,
  isSecondInCommand
}: {
  stageRole: EnsembleParticipant['stageRole']
  isBossman: boolean
  isSecondInCommand: boolean
}): React.JSX.Element | null {
  if (isBossman) {
    return <BossmanCrownIcon className="ensemble-above-chip-crown" />
  }
  if (isSecondInCommand) {
    return <CaptainHatIcon className="ensemble-above-chip-captain-hat" />
  }
  if (!stageRole) return null

  const stageTitle = ENSEMBLE_STAGE_ROLE_OPTIONS.find((option) => option.id === stageRole)?.label
  // Stage identity wears a tinted badge container so the leading stage
  // vocabulary stays distinct from the bare trailing status marks.
  return (
    <span className={`ensemble-above-chip-stage-badge is-${stageRole}`} title={stageTitle}>
      <EnsembleStageRoleIcon
        stageRole={stageRole}
        className={`ensemble-above-chip-stage-icon is-${stageRole}`}
      />
    </span>
  )
}

interface EnsembleParticipantsAboveRowProps {
  chat: ChatRecord
  /** Visible roster projection, including accepted changes waiting on an active seat boundary. */
  participantProjection?: EnsembleParticipant[]
  /**
   * External human seats, derived from the chat's share. Absent or empty means
   * the strip behaves exactly as it did before externals existed.
   */
  externalSeats?: readonly ExternalSeatInput[]
  selectedParticipantId: string | null
  onSelectParticipant: (id: string) => void
  onChatChange: (next: ChatRecord) => void
  /** Route seat-field edits through the live seat boundary when a round owns the roster. */
  onPatchParticipant?: (participantId: string, patch: Partial<EnsembleParticipant>) => void
  /** Apply structural/authority roster edits immediately or at the active seat boundary. */
  onLiveRosterMutation?: (mutation: EnsembleUserRosterMutation) => void
  /**
   * Switch Ensemble off for this thread because the roster can no longer
   * sustain a panel, handing it to the seat passed in as the solo provider.
   * Fired INSTEAD of `onChatChange` when a removal would drop the roster below
   * `MIN_ENSEMBLE_PARTICIPANTS`; `chatWithSeatRemoved` is the record the caller
   * must save BEFORE the mode change so the stashed roster reflects the
   * removal (null when the removal empties the roster). Omitted in harness
   * tests that don't model the mode change; the trash button goes inert at the
   * floor when it isn't wired.
   */
  onCollapseToSolo?: (
    survivingParticipant: EnsembleParticipant,
    chatWithSeatRemoved: ChatRecord | null
  ) => void
  /**
   * "Skip" the currently-speaking participant. Cancels the active
   * provider run and lets the orchestrator's round-loop advance to
   * the next participant without restarting the round. The composer's
   * existing Stop button (wired to `handleCancel` → `cancelEnsembleRound`)
   * handles full-round cancellation, so the chip strip's previous
   * "Stop Ensemble" button was redundant and got dropped in favour of
   * this gentler Skip affordance.
   */
  onSkipActive?: () => void
  /**
   * Stop the active read-only fan-out phase while preserving the rest
   * of the round. The orchestrator only honors this when live fan-out
   * lanes are read-intent; parallel writer lanes remain protected.
   */
  onSkipReadFanout?: () => void
  /**
   * 1.0.4-AT7 — re-dispatch a single participant whose last turn
   * failed/timed-out/was unreachable. The caller decides how to
   * source the retry prompt (typically the chat's last user
   * prompt) and what dispatch path to use (e.g. DM via
   * `runEnsembleRound({ dmTargetParticipantId })`). When omitted,
   * the overflow popover hides the Retry row.
   */
  onRetryParticipant?: (participantId: string) => void
  /**
   * 1.0.5-N7 — User-initiated Wake-Now from the chip overflow. Fires
   * the wakeup immediately via the orchestrator's handleWakeupFired
   * (same code path as the timer firing naturally). Omitted in
   * harness tests that don't model wakeups.
   */
  onWakeNowParticipant?: (wakeupId: string) => void
  /**
   * 1.0.5-N7 — User-initiated Cancel of a pending wakeup. Marks
   * the persisted record cancelled and flips the participant out
   * of the sleeping state.
   */
  onCancelWakeupParticipant?: (wakeupId: string) => void
  /** Shell token for the portaled add-participant provider picker. */
  composerStyle?: ComposerStyle
  grokAvailable?: boolean
  cursorAvailable?: boolean
  /** Live ordered provider/model catalog shared with the main composer picker. */
  providerGroups?: readonly CombinedModelPickerProviderGroup[]
  /** Slide the row up from behind the composer on mount (workflow Run-as-ensemble
   *  toggle) — scoped so the row doesn't animate on every ensemble chat. */
  animateEntrance?: boolean
}

interface ChipDragGhostState {
  participantId: string
  x: number
  y: number
  width: number
  offsetX: number
  offsetY: number
}

interface ChipDragStartInfo {
  pointerX: number
  pointerY: number
  chipRect: DOMRect
  offsetX: number
  offsetY: number
}

function resolveReorderDropTarget(
  container: HTMLElement | null,
  x: number,
  y: number,
  sourceId: string
): string | null {
  if (!container) return null

  const chips = Array.from(
    container.querySelectorAll('.ensemble-above-chip[data-participant-id]:not(.is-dragging)')
  ) as HTMLElement[]

  const directTarget = document.elementFromPoint(x, y) as HTMLElement | null
  const directChip = directTarget?.closest(
    '.ensemble-above-chip[data-participant-id]:not(.is-dragging)'
  ) as HTMLElement | null
  const directId = directChip?.getAttribute('data-participant-id')
  if (directId && directId !== sourceId) {
    return directId
  }

  const containerRect = container.getBoundingClientRect()
  const verticalTolerance = 56
  if (
    y < containerRect.top - verticalTolerance ||
    y > containerRect.bottom + verticalTolerance ||
    x < containerRect.left - 80 ||
    x > containerRect.right + 80
  ) {
    return null
  }

  let nearestId: string | null = null
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const chip of chips) {
    const id = chip.getAttribute('data-participant-id')
    if (!id || id === sourceId) continue
    const rect = chip.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    const distance = Math.hypot(x - centerX, y - centerY)
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearestId = id
    }
  }
  return nearestId
}

function escapeSelectorAttributeValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}

export function resolveParticipantSelectionAfterRemoval(
  participants: EnsembleParticipant[],
  removedId: string,
  selectedParticipantId: string | null
): string | null {
  if (selectedParticipantId !== removedId) return selectedParticipantId
  const removedIndex = participants.findIndex((participant) => participant.id === removedId)
  if (removedIndex === -1) return null
  return participants[removedIndex - 1]?.id ?? participants[removedIndex + 1]?.id ?? null
}

export function EnsembleParticipantsAboveRow({
  chat,
  participantProjection,
  externalSeats,
  selectedParticipantId,
  onSelectParticipant,
  onChatChange,
  onPatchParticipant,
  onLiveRosterMutation,
  onCollapseToSolo,
  onSkipActive,
  onSkipReadFanout,
  onRetryParticipant,
  onWakeNowParticipant,
  onCancelWakeupParticipant,
  composerStyle = 'default',
  grokAvailable = false,
  cursorAvailable = false,
  providerGroups,
  animateEntrance = false
}: EnsembleParticipantsAboveRowProps): React.JSX.Element | null {
  const chipsContainerRef = useRef<HTMLDivElement | null>(null)
  const pendingFocusParticipantIdRef = useRef<string | null>(null)
  const [overflowOpenId, setOverflowOpenId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dragGhost, setDragGhost] = useState<ChipDragGhostState | null>(null)

  const participants =
    chat.chatKind === 'ensemble' && chat.ensemble
      ? [...(participantProjection || chat.ensemble.participants || [])].sort(
          (a, b) => a.order - b.order
        )
      : []
  const participantIdsKey = participants.map((participant) => participant.id).join('\u001f')

  /**
   * The panel as it is SEEN: model seats plus external human seats, in one
   * shared order. Externals are never rows in `chat.ensemble.participants` —
   * see effectiveEnsembleRoster.ts for why deriving won — so this is the only
   * place the two halves meet for display.
   *
   * The model chips below are NOT restructured to iterate this. They keep their
   * own map, and both kinds are positioned with CSS `order` instead; the strip
   * is a flex row (and a grid when wrapped), so both honour it. That keeps a
   * thousand lines of chip internals untouched, and it means an empty
   * `externalSeats` produces byte-identical output to before.
   */
  const effectiveRoster = useMemo(
    () => resolveEffectiveRoster({ participants, externals: externalSeats ?? [] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [participantIdsKey, externalSeats]
  )
  const seatPositionById = useMemo(() => {
    const positions = new Map<string, number>()
    effectiveRoster.seats.forEach((seat, index) => positions.set(seat.seatId, index + 1))
    return positions
  }, [effectiveRoster])
  const externalSeatChips = effectiveRoster.seats.filter(isExternalSeat)
  const totalSeatCount = effectiveRoster.seats.length

  useEffect(() => {
    const pendingParticipantId = pendingFocusParticipantIdRef.current
    if (!pendingParticipantId || selectedParticipantId !== pendingParticipantId) return
    pendingFocusParticipantIdRef.current = null
    const selector = `[data-participant-id="${escapeSelectorAttributeValue(pendingParticipantId)}"] .ensemble-above-chip-body`
    const focusTarget = chipsContainerRef.current?.querySelector<HTMLElement>(selector)
    focusTarget?.focus({ preventScroll: true })
  }, [participantIdsKey, selectedParticipantId])

  if (chat.chatKind !== 'ensemble' || !chat.ensemble) return null

  const configuredAuthority = normalizeEnsembleAuthority({
    participants,
    bossmanParticipantId: chat.ensemble.bossmanParticipantId,
    captainParticipantIds: chat.ensemble.captainParticipantIds,
    secondInCommandParticipantId: chat.ensemble.secondInCommandParticipantId
  })
  const captainParticipantIdSet = new Set(configuredAuthority.captainParticipantIds)
  const activeRound = chat.ensemble.activeRound
  const isRoundRunning = isEnsembleActiveRoundDispatchLive(activeRound)
  const hasLeadership = participants.some(
    (participant) =>
      participant.stageRole !== 'background' &&
      participant.id === configuredAuthority.bossmanParticipantId
  )
  const liveFanoutLanes = Object.values(activeRound?.lanes || {}).filter(isLiveFanoutLane)
  const canSkipReadFanout =
    isRoundRunning &&
    liveFanoutLanes.length > 0 &&
    liveFanoutLanes.some((lane) => lane.intent === 'read') &&
    liveFanoutLanes.every((lane) => lane.intent === 'read')
  // A phase-specific skip is more precise than the generic active-speaker
  // action. When it is wired, render only that action so read fan-out does not
  // surface two adjacent Skip buttons for the same orchestration moment.
  const hasContextualSkipAction = canSkipReadFanout && onSkipReadFanout !== undefined
  const canEditLiveParticipants = !isRoundRunning || onPatchParticipant !== undefined
  const canMutateLiveRoster = !isRoundRunning || onLiveRosterMutation !== undefined
  const canAddParticipant =
    canMutateLiveRoster && participants.length < MAX_ENSEMBLE_PARTICIPANTS
  // Seat-position-aligned `grid-column` spans for the wrapped balanced-rows
  // layout; null in single-row flex mode (≤5 chips) where chips size to their
  // content instead.
  //
  // Keyed on `totalSeatCount` — models AND externals — because that is the
  // count that decides the mode below. Keying it on `participants.length`
  // meant a 5-model panel plus one human went into the 60-track grid with NO
  // spans computed at all, so every chip, models included, collapsed to one
  // track of sixty. The strip fell apart because somebody joined.
  const chipGridSpans =
    totalSeatCount >= ENSEMBLE_CHIPS_WRAP_THRESHOLD
      ? computeEnsembleChipGridSpans(totalSeatCount)
      : null

  const updateParticipant = (id: string, patch: Partial<EnsembleParticipant>): void => {
    if (
      id === configuredAuthority.bossmanParticipantId &&
      patch.stageRole === 'background'
    ) {
      return
    }
    if (onPatchParticipant) {
      onPatchParticipant(id, patch)
      return
    }
    if (isRoundRunning) return
    const next = participants.map((p) => (p.id === id ? { ...p, ...patch } : p))
    persist(next)
  }

  const patchEnsemble = (
    patch: Partial<NonNullable<ChatRecord['ensemble']>>,
    source: ChatRecord = chat
  ): void => {
    if (source.chatKind !== 'ensemble' || !source.ensemble) return
    const nextChat: ChatRecord = {
      ...source,
      ensemble: {
        ...source.ensemble,
        ...patch,
        updatedAt: new Date().toISOString()
      }
    }
    onChatChange(withSessionActivityLedger(source, nextChat))
  }

  const setParticipantAuthority = (
    participantId: string,
    authority: EnsembleParticipantAuthority
  ): void => {
    if (
      !participants.some(
        (participant) =>
          participant.id === participantId && participant.stageRole !== 'background'
      )
    ) {
      return
    }
    if (
      (participantId === configuredAuthority.bossmanParticipantId && authority !== 'boss') ||
      (authority === 'captain' &&
        !captainParticipantIdSet.has(participantId) &&
        configuredAuthority.captainParticipantIds.length >= MAX_ENSEMBLE_CAPTAINS)
    ) {
      return
    }
    if (isRoundRunning) {
      onLiveRosterMutation?.({ action: 'set_authority', participantId, authority })
      return
    }
    patchEnsemble(
      resolveEnsembleParticipantAuthorityPatch(
        {
          bossmanParticipantId: chat.ensemble?.bossmanParticipantId,
          captainParticipantIds: chat.ensemble?.captainParticipantIds,
          secondInCommandParticipantId: chat.ensemble?.secondInCommandParticipantId,
          bossmanAutoApprovals: chat.ensemble?.bossmanAutoApprovals
        },
        participantId,
        authority,
        participants
      )
    )
  }

  const setBossmanAutoApprovals = (enabled: boolean): void => {
    if (!hasLeadership) {
      return
    }
    if (enabled) {
      const confirmed = window.confirm(BOSS_AUTO_APPROVAL_CONSENT_MESSAGE)
      if (!confirmed) return
    }
    if (isRoundRunning) {
      onLiveRosterMutation?.({ action: 'set_auto_approvals', enabled })
      return
    }
    patchEnsemble({
      bossmanAutoApprovals: enabled
        ? {
            enabled: true,
            mode: 'permission_preset_once',
            confirmedAt: new Date().toISOString()
          }
        : undefined
    })
  }

  const buildPersistedChat = (
    nextParticipants: EnsembleParticipant[],
    authorityOverride?: EnsembleAuthorityPatch
  ): ChatRecord => {
    // 1.0.4-AR2 — preserve any existing per-chat `maxParticipants`
    // override that's already in range [MIN, MAX]. Pre-AR2 every
    // persist clobbered the cap to the global ceiling, silently
    // expanding a user's deliberately-tightened 3-of-N panel back
    // to the default whenever they toggled a participant. Fall back
    // to the ceiling only when the stored value is missing /
    // nonsensical / out of range.
    //
    // 1.0.5-EW5 — Bump the stored cap up to at least the current
    // participant count. Pre-EW5 a chat created on the 8-cap build
    // (or 6-cap pre-AR2) kept its stale stored cap forever even
    // after the user added participants past that cap via the
    // chip strip (the chip strip's add button uses the GLOBAL
    // MAX_ENSEMBLE_PARTICIPANTS, not the chat's stored max). The
    // chat ended up with participants.length=12 and
    // maxParticipants=6 — the chip strip showed all 12 but the
    // prompt builder's slice cut at 6, so participants 7-12
    // silently never spoke and never ran the pre-flight health
    // probe. Ratchet the stored cap up here so the two stay in
    // sync; we only ever GROW, never shrink, so a user's
    // deliberately-tightened panel still survives normal toggles.
    //
    // The lower bound here is the smallest cap a STORED value may express (1),
    // deliberately not MIN_ENSEMBLE_PARTICIPANTS: an Agent-MCP or imported
    // one-seat roster is exempt from the live floor, and widening its cap to
    // the global ceiling behind its back would undo that exemption.
    const existingMax = chat.ensemble?.maxParticipants
    const preservedMax =
      Number.isFinite(existingMax) &&
      (existingMax as number) >= 1 &&
      (existingMax as number) <= MAX_ENSEMBLE_PARTICIPANTS
        ? (existingMax as number)
        : MAX_ENSEMBLE_PARTICIPANTS
    const clampedMax = Math.min(
      MAX_ENSEMBLE_PARTICIPANTS,
      Math.max(preservedMax, nextParticipants.length)
    )
    const orderedNextParticipants = nextParticipants.map((participant, index) => ({
      ...participant,
      order: index + 1
    }))
    const authorityState = authorityOverride || {
      bossmanParticipantId: chat.ensemble?.bossmanParticipantId,
      captainParticipantIds: chat.ensemble?.captainParticipantIds,
      secondInCommandParticipantId: chat.ensemble?.secondInCommandParticipantId,
      bossmanAutoApprovals: chat.ensemble?.bossmanAutoApprovals
    }
    const authority = normalizeEnsembleAuthority({
      participants: orderedNextParticipants,
      bossmanParticipantId: authorityState.bossmanParticipantId,
      captainParticipantIds: authorityState.captainParticipantIds,
      secondInCommandParticipantId: authorityState.secondInCommandParticipantId
    })
    const existingSynthesizerParticipantId = chat.ensemble?.synthesizerParticipantId
    const synthesizerParticipantId =
      existingSynthesizerParticipantId &&
      nextParticipants.some(
        (participant) =>
          participant.id === existingSynthesizerParticipantId &&
          participant.stageRole !== 'background'
      )
        ? existingSynthesizerParticipantId
        : undefined
    const nextChat: ChatRecord = {
      ...chat,
      ensemble: {
        ...chat.ensemble!,
        maxParticipants: clampedMax,
        participants: orderedNextParticipants,
        bossmanParticipantId: authority.bossmanParticipantId,
        captainParticipantIds: authority.captainParticipantIds,
        secondInCommandParticipantId: authority.secondInCommandParticipantId,
        synthesizerParticipantId,
        bossmanAutoApprovals: authority.bossmanParticipantId
          ? authorityState.bossmanAutoApprovals
          : undefined,
        updatedAt: new Date().toISOString()
      }
    }
    return withSessionActivityLedger(chat, nextChat)
  }

  const persist = (
    nextParticipants: EnsembleParticipant[],
    authorityOverride?: EnsembleAuthorityPatch
  ): void => {
    onChatChange(buildPersistedChat(nextParticipants, authorityOverride))
  }

  const addParticipant = (configuration: EnsembleParticipantAddDraft): void => {
    if (!canAddParticipant) return
    // The selected (or last) chip decides only WHERE the new chip is
    // inserted — never what it contains. Cloning it used to leak
    // cross-provider config onto the new seat (a Grok model id on a Codex
    // participant, the previous chip's role name, its permission preset,
    // its runtime profile). Identity/permission fields come from canonical
    // provider defaults while model/reasoning/Fast settings come from the
    // explicit add-picker draft; roster presets and the Agent Pool remain the
    // only inheritance paths.
    const { participant: newParticipant, insertIndex } = buildEnsembleParticipantAddition(
      participants,
      selectedParticipantId,
      configuration
    )
    const next = [...participants]
    next.splice(insertIndex, 0, newParticipant)
    const desiredAutoApprovals =
      configuration.autoApprovalsEnabled && configuration.autoApprovalsConfirmedAt
        ? {
            enabled: true as const,
            mode: 'permission_preset_once' as const,
            confirmedAt: configuration.autoApprovalsConfirmedAt
          }
        : undefined
    const authorityPatch = resolveEnsembleParticipantAddAuthorityPatch(
      {
        bossmanParticipantId: chat.ensemble?.bossmanParticipantId,
        captainParticipantIds: chat.ensemble?.captainParticipantIds,
        secondInCommandParticipantId: chat.ensemble?.secondInCommandParticipantId,
        bossmanAutoApprovals: chat.ensemble?.bossmanAutoApprovals
      },
      newParticipant.id,
      configuration.authority,
      next,
      desiredAutoApprovals
    )
    if (isRoundRunning) {
      onLiveRosterMutation?.({
        action: 'add',
        participant: newParticipant,
        authority: configuration.authority,
        autoApprovalsEnabled: configuration.autoApprovalsEnabled
      })
      onSelectParticipant(newParticipant.id)
      return
    }
    persist(next, authorityPatch)
    onSelectParticipant(newParticipant.id)
  }

  const removeParticipant = (id: string): void => {
    if (id === configuredAuthority.bossmanParticipantId) return
    const nextSelectedParticipantId = resolveParticipantSelectionAfterRemoval(
      participants,
      id,
      selectedParticipantId
    )
    if (isRoundRunning) {
      onLiveRosterMutation?.({ action: 'remove', participantId: id })
      if (selectedParticipantId === id && nextSelectedParticipantId) {
        pendingFocusParticipantIdRef.current = nextSelectedParticipantId
        onSelectParticipant(nextSelectedParticipantId)
      }
      if (overflowOpenId === id) setOverflowOpenId(null)
      return
    }
    // At (or below) the floor the roster cannot shrink any further and stay an
    // Ensemble, so the removal becomes a mode change instead: hand the thread
    // to the seat that survives and switch Ensemble off. Same transcript, same
    // thread — see `handleCollapseEnsembleToSolo` in App.tsx.
    // Externals count toward the floor: one agent plus one person IS a panel,
    // and collapsing it would switch Ensemble off under somebody who is sitting
    // in the thread. Muted seats still count — they hold their position.
    const collapseTarget = resolveEnsembleCollapseTarget(
      participants,
      id,
      externalSeatChips.length
    )
    if (collapseTarget) {
      // Hand over the post-removal roster too. Ensemble-off stashes whatever
      // roster it finds so a later Ensemble-on can restore it, so collapsing
      // without recording the removal first would resurrect the seat the user
      // just deleted. Null when nothing survives the removal — an empty roster
      // would trip normalizeChatRecord's default-panel auto-fill on save.
      const remaining = participants.filter((participant) => participant.id !== id)
      onCollapseToSolo?.(collapseTarget, remaining.length > 0 ? buildPersistedChat(remaining) : null)
      return
    }
    const next = participants.filter((participant) => participant.id !== id)
    persist(next)
    if (selectedParticipantId === id && nextSelectedParticipantId) {
      pendingFocusParticipantIdRef.current = nextSelectedParticipantId
      onSelectParticipant(nextSelectedParticipantId)
    }
    if (overflowOpenId === id) {
      setOverflowOpenId(null)
    }
  }

  const handleReorder = (sourceId: string, targetId: string | null): void => {
    setDragId(null)
    setDragOverId(null)
    setDragGhost(null)
    if (!targetId || sourceId === targetId) return
    const fromIdx = participants.findIndex((p) => p.id === sourceId)
    const toIdx = participants.findIndex((p) => p.id === targetId)
    if (fromIdx === -1 || toIdx === -1) return
    const next = [...participants]
    const [moved] = next.splice(fromIdx, 1)
    next.splice(toIdx, 0, moved)
    if (isRoundRunning) {
      onLiveRosterMutation?.({
        action: 'reorder',
        participantIds: next.map((participant) => participant.id)
      })
      return
    }
    persist(next)
  }

  return (
    <div
      className={`ensemble-above-row${animateEntrance ? ' ensemble-above-row-entering' : ''}`}
      role="region"
      aria-label="Ensemble participants"
    >
      <div
        ref={chipsContainerRef}
        className={`ensemble-above-row-chips ${
          // Switch to the balanced-rows grid at 6+ SEATS — models plus
          // externals (the first count exceeding the 5-per-row ceiling) so the strip
          // never clips. Below the threshold we keep the centred
          // content-width flex layout — most ensembles live there.
          totalSeatCount >= ENSEMBLE_CHIPS_WRAP_THRESHOLD ? 'is-wrapped' : ''
        } ${dragGhost ? 'is-chip-dragging' : ''}`}
        data-participant-count={totalSeatCount}
      >
        {participants.map((participant, participantIndex) => {
          const {
            active,
            lane,
            laneFailureSuperseded,
            participantState: state,
            statusLabel
          } = deriveEnsembleParticipantChipStatus(activeRound, participant.id)
          const isSelected = participant.id === selectedParticipantId
          // 1.0.4-AD — surface the pre-flight probe's failure reason
          // (or any subsequent failure reason stamped on the round
          // state) so the chip's status pill tooltip explains WHY a
          // participant is unreachable / failed without diving into
          // the transcript. Empty string when the round state has no
          // failure metadata so the chip falls back to the bare
          // status label.
          const statusTooltip =
            (laneFailureSuperseded ? '' : lane?.reason) ||
            state?.lastFailureReason ||
            (state?.status === 'failed' ? state?.reason : '') ||
            ''
          const wakeupTooltip = state?.status === 'sleeping' ? state.reason || '' : ''
          // 1.0.4-AT7 — retryable when the participant's last turn
          // exited in a failure state. The Retry row in the overflow
          // popover re-dispatches the chat's last user prompt as a
          // DM to this participant via the AT4-extended
          // `runEnsembleRound` IPC path. Active and idle participants
          // don't get a Retry row (active = currently speaking, idle
          // = ready to go on next dispatch).
          const isRetryable =
            !active &&
            (state?.status === 'failed' || state?.status === 'unreachable') &&
            !isRoundRunning
          // 1.0.5-N7 — Look up this participant's pending wakeup (if
          // any) from the chat's persisted wakeups map. The
          // sleeping chip shows Wake-Now + Cancel rows in the
          // overflow popover. We rely on the persisted record
          // because in-memory runtime state isn't visible to the
          // renderer.
          const pendingWakeup = activeRound
            ? Object.values(chat.ensemble?.wakeups || {}).find(
                (wakeup) =>
                  wakeup.status === 'pending' &&
                  wakeup.roundId === activeRound.roundId &&
                  wakeup.participantId === participant.id
              )
            : undefined
          return (
            <ParticipantChip
              key={participant.id}
              participant={participant}
              mentionParticipants={participants}
              turnOrder={seatPositionById.get(participant.id) ?? participantIndex + 1}
              /* By merged seat position, not the model-only index: a human
                 seated mid-panel shifts every later model's placement slot. */
              gridSpan={chipGridSpans?.[(seatPositionById.get(participant.id) ?? participantIndex + 1) - 1]}
              statusLabel={statusLabel}
              statusTooltip={wakeupTooltip || statusTooltip}
              dimmed={!participant.enabled}
              isSelected={isSelected}
              isDragOver={dragOverId === participant.id && dragId !== participant.id}
              isDragging={dragId === participant.id}
              overflowOpen={overflowOpenId === participant.id}
              onClick={() => {
                // 1.0.5-EW22 — Second-click-on-selected opens the
                // popover (replacing the ⋯ overflow button that
                // used to live inline on the chip and overlapped
                // into the next chip). First click selects.
                // Click outside the chip + popover dismisses
                // (handled by OverflowPopover's outside-click).
                if (participant.id === selectedParticipantId) {
                  setOverflowOpenId((curr) => (curr === participant.id ? null : participant.id))
                } else {
                  onSelectParticipant(participant.id)
                  if (overflowOpenId && overflowOpenId !== participant.id) {
                    setOverflowOpenId(null)
                  }
                }
              }}
              onCloseOverflow={() => setOverflowOpenId(null)}
              onPatch={(patch) => updateParticipant(participant.id, patch)}
              isBossman={
                participant.stageRole !== 'background' &&
                configuredAuthority.bossmanParticipantId === participant.id
              }
              isSecondInCommand={
                participant.stageRole !== 'background' &&
                captainParticipantIdSet.has(participant.id) &&
                configuredAuthority.bossmanParticipantId !== participant.id
              }
              captainAssignmentDisabled={
                !captainParticipantIdSet.has(participant.id) &&
                configuredAuthority.captainParticipantIds.length >= MAX_ENSEMBLE_CAPTAINS
              }
              hasLeadership={hasLeadership}
              autoApprovalsEnabled={chat.ensemble?.bossmanAutoApprovals?.enabled === true}
              onSetAuthority={setParticipantAuthority}
              onToggleBossmanAutoApprovals={setBossmanAutoApprovals}
              locked={!canEditLiveParticipants}
              seatBoundaryMessage={
                active
                  ? 'This participant is executing. Changes are accepted now and apply when its current execution finishes.'
                  : undefined
              }
              onDragStart={(info) => {
                setDragId(participant.id)
                setDragGhost({
                  participantId: participant.id,
                  x: info.pointerX - info.offsetX,
                  y: info.pointerY - info.offsetY,
                  width: info.chipRect.width,
                  offsetX: info.offsetX,
                  offsetY: info.offsetY
                })
              }}
              onDragMove={(pointerX, pointerY) => {
                setDragGhost((current) =>
                  current
                    ? {
                        ...current,
                        x: pointerX - current.offsetX,
                        y: pointerY - current.offsetY
                      }
                    : null
                )
                const overId = resolveReorderDropTarget(
                  chipsContainerRef.current,
                  pointerX,
                  pointerY,
                  participant.id
                )
                setDragOverId(overId)
              }}
              onDragEnd={(pointerX, pointerY) => {
                const droppedOnId = resolveReorderDropTarget(
                  chipsContainerRef.current,
                  pointerX,
                  pointerY,
                  participant.id
                )
                handleReorder(participant.id, droppedOnId)
              }}
              onRetry={
                isRetryable && onRetryParticipant
                  ? () => onRetryParticipant(participant.id)
                  : undefined
              }
              onWakeNow={
                pendingWakeup && onWakeNowParticipant
                  ? () => onWakeNowParticipant(pendingWakeup.wakeupId)
                  : undefined
              }
              onCancelWakeup={
                pendingWakeup && onCancelWakeupParticipant
                  ? () => onCancelWakeupParticipant(pendingWakeup.wakeupId)
                  : undefined
              }
              wakeAt={pendingWakeup?.wakeAt}
            />
          )
        })}
        {externalSeatChips.map((seat) => {
          const seatPosition = seatPositionById.get(seat.seatId)
          return (
          <div
            key={seat.seatId}
            /**
             * DELIBERATELY NOT `data-participant-id`. That attribute is the
             * drag-reorder hit-test selector, and `resolveReorderDropTarget`
             * falls back to the NEAREST match by centre distance — so an
             * external carrying it would swallow drops meant for the model seat
             * beside it, and `handleReorder` would then silently do nothing
             * because the id resolves to -1 in the participants array.
             */
            data-seat-id={seat.seatId}
            data-seat-kind="external"
            data-turn-order={seatPosition}
            className={`ensemble-above-chip ensemble-above-chip--external${
              seat.enabled ? '' : ' is-muted'
            }${seat.present ? '' : ' is-away'}`}
            style={{
              order: seatPosition,
              // An external is a chip like any other in grid mode. Without a
              // span it took ONE of sixty tracks — a sliver with its name and
              // badge clipped to a few pixels — while the model chips beside it
              // spanned twenty.
              ...(chipGridSpans && seatPosition !== undefined
                ? { gridColumn: `span ${chipGridSpans[seatPosition - 1]}` }
                : {})
            }}
            title={
              seat.present
                ? `${seat.label} — external collaborator`
                : `${seat.label} — external collaborator (not connected)`
            }
          >
            <div className="ensemble-above-chip-body">
              <span className="ensemble-above-chip-turn-order">{seatPosition}</span>
              <span className="ensemble-above-chip-role">{seat.label}</span>
              <span className="ensemble-above-chip-external-badge">External</span>
            </div>
          </div>
          )
        })}
      </div>
      {dragGhost
        ? (() => {
            const ghostParticipant = participants.find(
              (participant) => participant.id === dragGhost.participantId
            )
            if (!ghostParticipant) return null
            // Merged position, matching the chip under the cursor. The
            // model-only index disagreed with it the moment an external was
            // seated ahead of this model, so the floating ghost showed a
            // different turn number than the chip it was dragged from.
            const ghostTurnOrder =
              seatPositionById.get(ghostParticipant.id) ??
              participants.findIndex((participant) => participant.id === ghostParticipant.id) + 1
            return createPortal(
              <div
                className={`ensemble-above-chip ensemble-above-chip-drag-ghost provider-${resolveProviderHueClass(ghostParticipant.provider, ghostParticipant.model)} is-selected`}
                style={{
                  position: 'fixed',
                  left: `${dragGhost.x}px`,
                  top: `${dragGhost.y}px`,
                  width: `${dragGhost.width}px`,
                  zIndex: 10050
                }}
                aria-hidden
              >
                <div className="ensemble-above-chip-body">
                  <span className="ensemble-above-chip-turn-order">{ghostTurnOrder}</span>
                  <span className="ensemble-above-chip-role">
                    {ghostParticipant.role || getProviderName(ghostParticipant.provider)}
                  </span>
                </div>
              </div>,
              document.body
            )
          })()
        : null}
      {/*
        The control rail keeps transient round actions from changing
        the chip grid's width. With 1–5 participants it remains the
        existing inline add / remove / Skip sequence. At 6+ (the first
        wrapped roster), Skip actions occupy a reserved row above
        add/remove, so mounting or unmounting an action cannot make the
        participant columns jump.
      */}
      <div
        className={`ensemble-above-row-controls${
          totalSeatCount >= ENSEMBLE_CHIPS_WRAP_THRESHOLD ? ' is-stacked' : ''
        }`}
      >
        <div className="ensemble-above-row-roster-actions">
          <EnsembleAddParticipantButton
            disabled={!canAddParticipant}
            title={
              participants.length >= MAX_ENSEMBLE_PARTICIPANTS
                ? `Ensembles support up to ${MAX_ENSEMBLE_PARTICIPANTS} participants.`
                : isRoundRunning
                  ? 'Add this participant to the remaining live roster.'
                  : 'Add another participant'
            }
            composerStyle={composerStyle}
            grokAvailable={grokAvailable}
            cursorAvailable={cursorAvailable}
            providerGroups={providerGroups}
            participants={participants}
            hasLeadership={hasLeadership}
            bossmanParticipantId={configuredAuthority.bossmanParticipantId}
            captainParticipantIds={configuredAuthority.captainParticipantIds}
            captainAssignmentDisabled={
              configuredAuthority.captainParticipantIds.length >= MAX_ENSEMBLE_CAPTAINS
            }
            bossmanAutoApprovals={chat.ensemble?.bossmanAutoApprovals}
            initialProvider={
              participants.find((participant) => participant.id === selectedParticipantId)
                ?.provider ||
              participants[participants.length - 1]?.provider ||
              'codex'
            }
            onAdd={addParticipant}
          />
          <button
            type="button"
            className="ensemble-above-remove-participant"
            onClick={() => {
              if (selectedParticipantId) removeParticipant(selectedParticipantId)
            }}
            disabled={
              !selectedParticipantId ||
              selectedParticipantId === configuredAuthority.bossmanParticipantId ||
              (isRoundRunning
                ? onLiveRosterMutation === undefined || participants.length <= 1
                : participants.length <= MIN_ENSEMBLE_PARTICIPANTS && !onCollapseToSolo)
            }
            title={
              !selectedParticipantId
                ? 'Select a participant chip first.'
                : selectedParticipantId === configuredAuthority.bossmanParticipantId
                  ? 'Assign another Boss before removing this participant.'
                : isRoundRunning
                  ? participants.length <= 1
                    ? 'An Ensemble must retain one participant.'
                    : 'Remove this participant from the live roster. An executing seat is removed when its current execution finishes.'
                  : participants.length <= MIN_ENSEMBLE_PARTICIPANTS
                    ? 'Removing this leaves no panel — the thread switches Ensemble off and continues with the remaining agent.'
                    : 'Remove the selected participant'
            }
            aria-label="Remove selected Ensemble participant"
          >
            −
          </button>
        </div>
        <div className="ensemble-above-row-actions">
          {/* "Queued next round" label intentionally not rendered here —
              the queued-messages above-row (sibling in the composer
              above-bar stack) now surfaces ensemble `queuedPrompt`
              entries as a full row with Edit / Delete / Steer actions,
              so duplicating the bare label here would be noise. See
              `QueuedMessagesAboveRow.tsx` + the
              `queuedMessagesAboveRowEntries` builder in App.tsx for
              the ensemble-queued branch. */}
          {isRoundRunning &&
            activeRound?.activeParticipantId &&
            onSkipActive &&
            !hasContextualSkipAction && (
              <PillButton
                size="compact"
                className="ensemble-above-row-skip"
                onClick={onSkipActive}
                title="Skip the currently-speaking participant and let the round continue with the next one. The composer's Stop button still cancels the whole round."
              >
                Skip
              </PillButton>
            )}
          {canSkipReadFanout && onSkipReadFanout && (
            <PillButton
              size="compact"
              className="ensemble-above-row-skip"
              onClick={onSkipReadFanout}
              title="Stop the active read-only fan-out lanes and continue the round with the remaining serial step. Parallel writer lanes cannot be skipped here."
            >
              Skip
            </PillButton>
          )}
        </div>
      </div>
    </div>
  )
}

function EnsembleAddParticipantButton({
  disabled,
  title,
  composerStyle,
  grokAvailable,
  cursorAvailable,
  providerGroups,
  participants,
  hasLeadership,
  bossmanParticipantId,
  captainParticipantIds,
  captainAssignmentDisabled,
  bossmanAutoApprovals,
  initialProvider,
  onAdd
}: {
  disabled: boolean
  title: string
  composerStyle: ComposerStyle
  grokAvailable: boolean
  cursorAvailable: boolean
  providerGroups?: readonly CombinedModelPickerProviderGroup[]
  participants: EnsembleParticipant[]
  hasLeadership: boolean
  bossmanParticipantId?: string
  captainParticipantIds: readonly string[]
  captainAssignmentDisabled: boolean
  bossmanAutoApprovals?: NonNullable<ChatRecord['ensemble']>['bossmanAutoApprovals']
  initialProvider: ProviderId
  onAdd: (configuration: EnsembleParticipantAddDraft) => void
}): React.JSX.Element {
  const availableProviderGroups = useMemo(
    () => resolveEnsembleAddProviderGroups(providerGroups, grokAvailable, cursorAvailable),
    [cursorAvailable, grokAvailable, providerGroups]
  )
  const pickerDisabled = disabled || availableProviderGroups.length === 0
  const duplicableProviderIds = useMemo(
    () =>
      new Set(
        availableProviderGroups
          .filter((group) => group.modelOptions.some((option) => !option.disabled))
          .map((group) => group.provider)
      ),
    [availableProviderGroups]
  )
  const resolvedInitialProvider = availableProviderGroups.some(
    (group) => group.provider === initialProvider
  )
    ? initialProvider
    : availableProviderGroups[0]?.provider || 'codex'
  const [draft, setDraft] = useState<EnsembleParticipantAddConfiguration>(() =>
    createEnsembleParticipantAddConfiguration(
      resolvedInitialProvider,
      undefined,
      availableProviderGroups
    )
  )
  const initialDetails = createEnsembleParticipantAddDetails(
    resolvedInitialProvider,
    participants,
    bossmanAutoApprovals
  )
  const [detailsDraft, setDetailsDraft] = useState<EnsembleParticipantAddDetails>(initialDetails)
  const [rolePresetId, setRolePresetId] = useState(() => resolveRolePresetId(initialDetails.role))
  const [duplicateSourceId, setDuplicateSourceId] = useState<string | null>(null)
  const displayProviderGroups = useMemo(
    () =>
      availableProviderGroups.map((group) =>
        group.provider !== 'antigravity' || draft.provider !== 'antigravity'
          ? group
          : {
              ...group,
              modelOptions: group.modelOptions.map((option) =>
                option.antigravityVariants?.some((variant) => variant.id === draft.model)
                  ? { ...option, id: draft.model }
                  : option
              )
            }
      ),
    [availableProviderGroups, draft.model, draft.provider]
  )
  const selectedGroup =
    displayProviderGroups.find((group) => group.provider === draft.provider) ||
    displayProviderGroups[0]
  const selectedDefaults = getEnsembleModelDefaults(draft.provider)
  const reasoningOptions = useMemo(
    () =>
      getEnsembleAddReasoningOptions(
        draft.provider,
        draft.model,
        availableProviderGroups
      ),
    [availableProviderGroups, draft.model, draft.provider]
  )
  const selectedReasoning =
    draft.provider === 'antigravity'
      ? (antigravityEffortForModelId(draft.model) ?? '')
      : draft.provider === 'kimi'
        ? resolveKimiReasoningPickerSelection(draft.model, draft.reasoningEffort)
        : draft.reasoningEffort || ''
  const fastModeEnabled =
    draft.provider === 'codex'
      ? draft.serviceTier === 'fast'
      : draft.provider === 'grok'
        ? true
        : draft.provider === 'antigravity' && FAST_MODEL_IDS.has(draft.model)
          ? true
          : Boolean(draft.fastModeEnabled)

  const resetDraft = useCallback(
    (
      provider: ProviderId,
      roleSources: ReadonlyArray<Pick<EnsembleParticipant, 'role'>> = participants
    ) => {
      const nextDetails = createEnsembleParticipantAddDetails(
        provider,
        roleSources,
        bossmanAutoApprovals
      )
      setDraft(
        createEnsembleParticipantAddConfiguration(provider, undefined, availableProviderGroups)
      )
      setDetailsDraft(nextDetails)
      setRolePresetId(resolveRolePresetId(nextDetails.role))
      setDuplicateSourceId(null)
    },
    [availableProviderGroups, bossmanAutoApprovals, participants]
  )

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) resetDraft(resolvedInitialProvider)
    },
    [resetDraft, resolvedInitialProvider]
  )
  const handleProviderModelSelection = useCallback(
    (provider: ProviderId, model: string) => {
      setDuplicateSourceId(null)
      if (provider !== draft.provider) {
        setDetailsDraft((current) =>
          retargetEnsembleParticipantAddDetails(
            current,
            draft.provider,
            provider,
            participants,
            bossmanAutoApprovals
          )
        )
      }
      setDraft(
        createEnsembleParticipantAddConfiguration(provider, model, availableProviderGroups)
      )
    },
    [availableProviderGroups, bossmanAutoApprovals, draft.provider, participants]
  )
  const handleReasoningSelection = useCallback(
    (value: string) => {
      setDuplicateSourceId(null)
      setDraft((current) => {
        if (current.provider === 'antigravity') {
          const modelOptions =
            availableProviderGroups.find((group) => group.provider === 'antigravity')
              ?.modelOptions || []
          const target = findEnsembleAddModelOption(
            'antigravity',
            current.model,
            modelOptions
          )?.antigravityVariants?.find((variant) => variant.effort === value)
          return target && target.id !== current.model
            ? createEnsembleParticipantAddConfiguration(
                'antigravity',
                target.id,
                availableProviderGroups
              )
            : current
        }
        return current.provider === 'kimi'
          ? { ...current, ...buildKimiReasoningPickerPatch(current.model, value) }
          : { ...current, reasoningEffort: value }
      })
    },
    [availableProviderGroups]
  )
  const handleToggleFastMode = useCallback(() => {
    setDuplicateSourceId(null)
    setDraft((current) => {
      if (current.provider === 'codex') {
        const nextFast = current.serviceTier !== 'fast'
        return {
          ...current,
          fastModeEnabled: nextFast,
          serviceTier: nextFast ? 'fast' : ''
        }
      }
      if (current.provider === 'cursor') {
        if (current.model === 'composer-2.5' || current.model === 'composer-2.5-fast') {
          const nextModel =
            current.model === 'composer-2.5-fast' ? 'composer-2.5' : 'composer-2.5-fast'
          return createEnsembleParticipantAddConfiguration(
            'cursor',
            nextModel,
            availableProviderGroups
          )
        }
        return { ...current, fastModeEnabled: !current.fastModeEnabled }
      }
      if (current.provider === 'kimi') {
        const nextFast = !current.fastModeEnabled
        return {
          ...current,
          fastModeEnabled: nextFast,
          serviceTier: nextFast ? 'fast' : 'standard'
        }
      }
      return { ...current, fastModeEnabled: !current.fastModeEnabled }
    })
  }, [availableProviderGroups])

  const patchDetails = useCallback(
    (patch: Partial<EnsembleParticipantAddDetails>) => {
      setDuplicateSourceId(null)
      setDetailsDraft((current) => {
        const next = { ...current, ...patch }
        if (patch.stageRole === 'background' && next.authority !== 'agent') {
          next.authority = 'agent'
          if (!hasLeadership) next.autoApprovalsEnabled = false
        }
        return next
      })
    },
    [hasLeadership]
  )

  const handleAutoApprovalsChange = useCallback(
    (enabled: boolean) => {
      if (!enabled) {
        patchDetails({ autoApprovalsEnabled: false })
        return
      }
      if (detailsDraft.autoApprovalsConfirmedAt) {
        patchDetails({ autoApprovalsEnabled: true })
        return
      }
      const confirmed = window.confirm(BOSS_AUTO_APPROVAL_CONSENT_MESSAGE)
      if (!confirmed) return
      patchDetails({
        autoApprovalsEnabled: true,
        autoApprovalsConfirmedAt: new Date().toISOString()
      })
    },
    [detailsDraft.autoApprovalsConfirmedAt, patchDetails]
  )

  const handleRolePresetIdChange = useCallback((nextRolePresetId: string) => {
    setDuplicateSourceId(null)
    setRolePresetId(nextRolePresetId)
  }, [])

  const commitDraft = useCallback((): boolean => {
    if (pickerDisabled) return false
    onAdd({ ...draft, ...detailsDraft })
    return true
  }, [detailsDraft, draft, onAdd, pickerDisabled])

  const handleAddAnother = useCallback(() => {
    if (!commitDraft()) return
    resetDraft(draft.provider, [...participants, { role: detailsDraft.role }])
  }, [commitDraft, detailsDraft.role, draft.provider, participants, resetDraft])

  const handleDuplicate = useCallback(
    (participant: EnsembleParticipant) => {
      if (!duplicableProviderIds.has(participant.provider)) return
      const sourceAuthority: EnsembleParticipantAuthority =
        participant.id === bossmanParticipantId
          ? 'boss'
          : captainParticipantIds.includes(participant.id) && !captainAssignmentDisabled
            ? 'captain'
            : 'agent'
      const duplicateDraft = createEnsembleParticipantDuplicateDraft(
        participant,
        participants,
        sourceAuthority,
        bossmanAutoApprovals,
        availableProviderGroups
      )
      setDraft({
        provider: duplicateDraft.provider,
        model: duplicateDraft.model,
        reasoningEffort: duplicateDraft.reasoningEffort,
        fastModeEnabled: duplicateDraft.fastModeEnabled,
        thinkingEnabled: duplicateDraft.thinkingEnabled,
        serviceTier: duplicateDraft.serviceTier
      })
      setDetailsDraft({
        enabled: duplicateDraft.enabled,
        authority: duplicateDraft.authority,
        autoApprovalsEnabled: duplicateDraft.autoApprovalsEnabled,
        autoApprovalsConfirmedAt: duplicateDraft.autoApprovalsConfirmedAt,
        stageRole: duplicateDraft.stageRole,
        role: duplicateDraft.role,
        instructions: duplicateDraft.instructions
      })
      setRolePresetId(resolveRolePresetId(duplicateDraft.role))
      setDuplicateSourceId(participant.id)
    },
    [
      availableProviderGroups,
      bossmanAutoApprovals,
      bossmanParticipantId,
      captainAssignmentDisabled,
      captainParticipantIds,
      duplicableProviderIds,
      participants
    ]
  )

  return (
    <CombinedModelPicker
      provider={draft.provider}
      composerStyle={composerStyle}
      modelOptions={selectedGroup?.modelOptions || selectedDefaults.modelOptions}
      selectedModelId={draft.model}
      onSelectModel={(model) => handleProviderModelSelection(draft.provider, model)}
      providerGroups={displayProviderGroups}
      onSelectProviderModel={handleProviderModelSelection}
      reasoningOptions={reasoningOptions}
      selectedReasoning={selectedReasoning}
      onSelectReasoning={handleReasoningSelection}
      codexReasoningEffort={draft.provider === 'codex' ? draft.reasoningEffort : undefined}
      claudeReasoningEffort={draft.provider === 'claude' ? draft.reasoningEffort : undefined}
      grokReasoningEffort={draft.provider === 'grok' ? draft.reasoningEffort : undefined}
      cursorReasoningEffort={draft.provider === 'cursor' ? draft.reasoningEffort : undefined}
      kimiThinkingEnabled={draft.provider === 'kimi' ? draft.thinkingEnabled : undefined}
      kimiReasoningEffort={draft.provider === 'kimi' ? draft.reasoningEffort : undefined}
      fastModeCapableModelIds={
        selectedGroup?.fastModeCapableModelIds || selectedDefaults.fastModeCapableModelIds
      }
      fastModeEnabled={fastModeEnabled}
      onToggleFastMode={
        draft.provider === 'codex' ||
        draft.provider === 'claude' ||
        draft.provider === 'kimi' ||
        draft.provider === 'cursor'
          ? handleToggleFastMode
          : undefined
      }
      disabled={pickerDisabled}
      repositionOnScroll
      topContent={
        <EnsembleAddParticipantFields
          provider={draft.provider}
          participants={participants}
          details={detailsDraft}
          rolePresetId={rolePresetId}
          hasLeadership={hasLeadership || detailsDraft.authority !== 'agent'}
          captainAssignmentDisabled={captainAssignmentDisabled}
          disabled={pickerDisabled}
          onDetailsChange={patchDetails}
          onRolePresetIdChange={handleRolePresetIdChange}
          onAutoApprovalsChange={handleAutoApprovalsChange}
        />
      }
      bottomContent={
        participants.length > 0 ? (
          <EnsembleParticipantDuplicateRow
            participants={participants}
            selectedSourceId={duplicateSourceId}
            duplicableProviderIds={duplicableProviderIds}
            disabled={pickerDisabled}
            onDuplicate={handleDuplicate}
          />
        ) : undefined
      }
      popoverClassName="is-ensemble-add-participant"
      dialogAriaLabel="Configure and add Ensemble participant"
      customTrigger={{
        className: 'ensemble-above-add-participant',
        content: '+',
        title:
          !disabled && availableProviderGroups.length === 0
            ? 'Connect a provider before adding a participant.'
            : title,
        ariaLabel: 'Add Ensemble participant'
      }}
      confirmActions={[
        {
          label: 'Add',
          onConfirm: handleAddAnother,
          keepOpen: true
        },
        {
          label: 'Done',
          onConfirm: commitDraft,
          submitOnEnter: true
        }
      ]}
      onOpenChange={handleOpenChange}
    />
  )
}

export function EnsembleParticipantDuplicateRow({
  participants,
  selectedSourceId,
  duplicableProviderIds,
  disabled,
  onDuplicate
}: {
  participants: readonly EnsembleParticipant[]
  selectedSourceId: string | null
  duplicableProviderIds?: ReadonlySet<ProviderId>
  disabled: boolean
  onDuplicate: (participant: EnsembleParticipant) => void
}): React.JSX.Element {
  return (
    <div className="ensemble-add-participant-duplicate-row">
      <span className="ensemble-add-participant-duplicate-label">Duplicate</span>
      <div
        className="ensemble-add-participant-duplicate-list"
        aria-label="Duplicate configuration from an existing participant"
      >
        {participants.map((participant) => {
          const role = participant.role || getProviderName(participant.provider)
          const model = participant.model
            ? humaniseModelId(participant.provider, participant.model)
            : getProviderName(participant.provider)
          const selected = participant.id === selectedSourceId
          const providerHue = resolveProviderHueClass(participant.provider, participant.model)
          const providerUnavailable =
            duplicableProviderIds !== undefined && !duplicableProviderIds.has(participant.provider)
          return (
            <button
              key={participant.id}
              type="button"
              className={`ensemble-add-participant-duplicate-chip${selected ? ' is-selected' : ''}`}
              data-participant-id={participant.id}
              data-provider={participant.provider}
              style={
                {
                  '--duplicate-participant-accent': `var(--provider-${providerHue}-color, var(--accent))`
                } as React.CSSProperties
              }
              disabled={disabled || providerUnavailable}
              aria-pressed={selected}
              aria-label={
                providerUnavailable
                  ? `Cannot duplicate configuration from ${role}: provider unavailable`
                  : `Duplicate configuration from ${role}`
              }
              title={
                providerUnavailable
                  ? `${getProviderName(participant.provider)} is not available for a new participant.`
                  : `Copy ${role}'s picker configuration into this new participant draft.`
              }
              onClick={() => onDuplicate(participant)}
            >
              <ProviderBrandLogoIcon
                provider={participant.provider}
                accentProvider={providerHue}
                wrapperClassName="ensemble-add-participant-duplicate-provider"
              />
              <span className="ensemble-add-participant-duplicate-role">{role}</span>
              <span className="ensemble-add-participant-duplicate-model">{model}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function EnsembleAddParticipantFields({
  provider,
  participants,
  details,
  rolePresetId,
  hasLeadership,
  captainAssignmentDisabled,
  disabled,
  onDetailsChange,
  onRolePresetIdChange,
  onAutoApprovalsChange
}: {
  provider: ProviderId
  participants: EnsembleParticipant[]
  details: EnsembleParticipantAddDetails
  rolePresetId: string
  hasLeadership: boolean
  captainAssignmentDisabled: boolean
  disabled: boolean
  onDetailsChange: (patch: Partial<EnsembleParticipantAddDetails>) => void
  onRolePresetIdChange: (presetId: string) => void
  onAutoApprovalsChange: (enabled: boolean) => void
}): React.JSX.Element {
  const instructionsTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const instructionsContextMenu = useComposerTextareaContextMenu()
  const participantLabel = getProviderName(provider)

  return (
    <div className="ensemble-add-participant-fields">
      <div className="ensemble-add-participant-fields-primary">
        <EnsembleParticipantAuthorityControls
          participantLabel={participantLabel}
          enabled={details.enabled}
          authority={details.authority}
          backgroundRestricted={details.stageRole === 'background'}
          captainAssignmentDisabled={captainAssignmentDisabled}
          hasLeadership={hasLeadership}
          autoApprovalsEnabled={details.autoApprovalsEnabled}
          locked={disabled}
          onEnabledChange={(enabled) => onDetailsChange({ enabled })}
          onAuthorityChange={(authority) => onDetailsChange({ authority })}
          onAutoApprovalsChange={onAutoApprovalsChange}
        />
        <EnsembleParticipantStageControl
          participantLabel={participantLabel}
          stageRole={details.stageRole}
          locked={disabled}
          onStageRoleChange={(stageRole) => onDetailsChange({ stageRole })}
        />
        <label className="ensemble-above-overflow-role">
          <span className="ensemble-above-overflow-label">Role</span>
          <select
            className="ensemble-above-overflow-role-picker"
            value={rolePresetId}
            disabled={disabled}
            onChange={(event) => {
              const nextPresetId = event.target.value
              onRolePresetIdChange(nextPresetId)
              const presetLabel = roleLabelForPresetId(nextPresetId)
              if (presetLabel) onDetailsChange({ role: presetLabel })
            }}
          >
            {ENSEMBLE_ROLE_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id} title={preset.description}>
                {preset.label}
              </option>
            ))}
            <option value={ENSEMBLE_ROLE_PRESET_CUSTOM}>Custom…</option>
          </select>
          {rolePresetId === ENSEMBLE_ROLE_PRESET_CUSTOM ? (
            <input
              type="text"
              value={details.role}
              disabled={disabled}
              onChange={(event) => onDetailsChange({ role: event.target.value })}
              placeholder={`${participantLabel} role`}
            />
          ) : null}
        </label>
      </div>
      <EnsembleBriefEditor
        label="Goal / brief"
        value={details.instructions}
        participants={participants}
        disabled={disabled}
        rows={5}
        editorClassName="ensemble-above-overflow-instructions ensemble-add-participant-brief"
        labelClassName="ensemble-above-overflow-label"
        textareaClassName="ensemble-above-overflow-instructions-field"
        textareaRef={instructionsTextareaRef}
        syncEpoch={`add:${provider}:${participants.length}`}
        onChange={(instructions) => onDetailsChange({ instructions })}
        onContextMenu={instructionsContextMenu.handleContextMenu}
        placeholder="Optional focus for this participant's turns…"
      />
      <ComposerTextareaContextMenu
        anchor={instructionsContextMenu.anchor}
        spellcheckContext={instructionsContextMenu.spellcheckContext}
        textareaRef={instructionsTextareaRef}
        onValueChange={(instructions) => onDetailsChange({ instructions })}
        onOpenFromElectron={instructionsContextMenu.openContextMenu}
        onClose={() => instructionsContextMenu.setAnchor(null)}
      />
    </div>
  )
}

interface ParticipantChipProps {
  participant: EnsembleParticipant
  mentionParticipants: EnsembleParticipant[]
  /** One-based order in the sorted roster; this is the normal dispatch order. */
  turnOrder: number
  /** `grid-column` span in the wrapped balanced-rows strip (see
   * computeEnsembleChipGridSpans); undefined in single-row flex mode. */
  gridSpan?: number
  statusLabel: string
  /**
   * 1.0.4-AD — optional human-readable explanation surfaced in the
   * status-pill `title` tooltip. Populated from the round state's
   * `lastFailureReason` for `unreachable` (and `failed`) participants
   * so the user sees, e.g. "Codex app-server probe timed out after
   * 1000ms" without opening the transcript. Empty string falls back
   * to the bare status label.
   */
  statusTooltip: string
  dimmed: boolean
  isSelected: boolean
  isDragOver: boolean
  isDragging: boolean
  overflowOpen: boolean
  onClick: () => void
  /* 1.0.5-EW22 — `onToggleOverflow` removed; the parent now toggles
   * overflowOpenId directly when the user clicks an already-selected
   * chip. `onRemove` / `canRemove` removed too because the popover's
   * Remove row moved to the row's "-" sibling button (which has
   * direct access to `removeParticipant` from this component). */
  onCloseOverflow: () => void
  onPatch: (patch: Partial<EnsembleParticipant>) => void
  isBossman: boolean
  isSecondInCommand: boolean
  captainAssignmentDisabled: boolean
  hasLeadership: boolean
  autoApprovalsEnabled: boolean
  onSetAuthority: (
    participantId: string,
    authority: EnsembleParticipantAuthority
  ) => void
  onToggleBossmanAutoApprovals: (enabled: boolean) => void
  locked: boolean
  seatBoundaryMessage?: string
  /**
   * Pointer-based drag callbacks (replaces HTML5 native drag).
   *
   * The HTML5 `draggable` attribute on a button — even one with a
   * working onClick handler — suppresses click events in Electron's
   * Chromium build. Tried wrapper-only draggable + button-only
   * draggable across two commits; both kept the symptom. Switched
   * to pointer events:
   *   - `pointerdown` on the chip starts a potential drag
   *   - if the pointer moves > 6px while held, it becomes a real
   *     drag (`onDragStart` fires)
   *   - `pointermove` updates the hover target via
   *     `document.elementFromPoint`
   *   - `pointerup` either fires `onClick` (pure tap, no movement)
   *     or `onDragEnd` with the chip id under the release point
   *     (a real drop)
   * Click events on the chip body now land reliably because no
   * native drag is competing for the pointer stream.
   */
  onDragStart: (info: ChipDragStartInfo) => void
  onDragMove: (pointerX: number, pointerY: number) => void
  onDragEnd: (pointerX: number, pointerY: number) => void
  /**
   * 1.0.4-AT7 — re-dispatch this participant after a failed /
   * unreachable turn. The chip strip computes whether retry is
   * applicable (status is failure-ish, no round running, etc.)
   * and only passes a callback when the action is valid; undefined
   * means "no retry row in the overflow popover".
   */
  onRetry?: () => void
  /**
   * 1.0.5-N7 — Wake-Now + Cancel for a sleeping participant. The
   * parent computes the pending wakeup record and only passes the
   * callbacks when there's actually a pending wakeup. wakeAt is
   * forwarded for the popover tooltip.
   */
  onWakeNow?: () => void
  onCancelWakeup?: () => void
  wakeAt?: string
}

function ParticipantChip({
  participant,
  mentionParticipants,
  turnOrder,
  gridSpan,
  statusLabel,
  statusTooltip,
  dimmed,
  isSelected,
  isDragOver,
  isDragging,
  overflowOpen,
  onClick,
  onCloseOverflow,
  onPatch,
  isBossman,
  isSecondInCommand,
  captainAssignmentDisabled,
  hasLeadership,
  autoApprovalsEnabled,
  onSetAuthority,
  onToggleBossmanAutoApprovals,
  locked,
  seatBoundaryMessage,
  onDragStart,
  onDragMove,
  onDragEnd,
  onRetry,
  onWakeNow,
  onCancelWakeup,
  wakeAt
}: ParticipantChipProps): React.JSX.Element {
  const [chipAnchor, setChipAnchor] = useState<HTMLDivElement | null>(null)
  // Custom hover tooltip (2026-07 chip polish). Replaces BOTH the
  // native `title` on the chip wrapper AND the inline token-spend
  // badge: hovering the chip for 500ms surfaces one portaled card
  // with the participant identity, current status (incl. failure
  // reason), the token-spend estimate, and linked-session id. A
  // custom implementation (vs native title) because the 0.5s delay
  // is part of the spec and native tooltip timing isn't controllable
  // — and because chips previously grew THREE stacked native titles
  // (wrapper, role, status pill) that fired inconsistently.
  const [tooltipPosition, setTooltipPosition] = useState<{ x: number; y: number } | null>(null)
  const tooltipTimerRef = useRef<number | null>(null)
  const clearTooltipTimer = useCallback(() => {
    if (tooltipTimerRef.current !== null) {
      window.clearTimeout(tooltipTimerRef.current)
      tooltipTimerRef.current = null
    }
  }, [])
  const dismissTooltip = useCallback(() => {
    clearTooltipTimer()
    setTooltipPosition(null)
  }, [clearTooltipTimer])
  useEffect(() => clearTooltipTimer, [clearTooltipTimer])
  const handleTooltipPointerEnter = useCallback(
    (event: React.PointerEvent) => {
      const chipElement = event.currentTarget as HTMLElement
      clearTooltipTimer()
      tooltipTimerRef.current = window.setTimeout(() => {
        tooltipTimerRef.current = null
        const rect = chipElement.getBoundingClientRect()
        setTooltipPosition({ x: rect.left + rect.width / 2, y: rect.top })
      }, 500)
    },
    [clearTooltipTimer]
  )
  // Slug the status onto the class so CSS can colour-code the pill
  // (running=warm, yielded=amber, answered=green, cancelled=muted, etc.).
  const statusClass = `status-${statusLabel.toLowerCase().replace(/\s+/g, '-')}`
  const providerClass = resolveProviderHueClass(participant.provider, participant.model)
  // 2026-08 chip polish — the actively-working participant's role
  // name runs the transcript's shared text-shimmer-sweep in its
  // provider hue (Ollama chips inherit the spoofed upstream brand hue
  // via `providerClass`, same as the role tint); a failed/unreachable
  // turn re-inks the leading stage/authority icon in the danger hue
  // beside the trailing warning triangle. The round state holding
  // these statuses is replaced wholesale when the next round starts,
  // so the failure accent naturally resets — the failure may be
  // fixed or irrelevant by the next turn.
  const normalizedStatus = statusLabel.toLowerCase()
  const isLiveShimmer =
    !dimmed && (normalizedStatus === 'speaking' || normalizedStatus === 'running')
  const isFailedAccent = normalizedStatus === 'failed' || normalizedStatus === 'unreachable'
  const providerDisplayName =
    resolveProviderBrandLabel(participant.provider, participant.model) ||
    getProviderName(participant.provider)
  const authorityPrefix = isBossman
    ? 'Boss · '
    : isSecondInCommand
      ? 'Captain · '
      : ''
  const authorityAriaPrefix = isBossman
    ? 'Boss '
    : isSecondInCommand
      ? 'Captain '
      : ''
  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      // Left-click only. Right-click / middle-click fall through to
      // the browser default — no drag, no select.
      if (event.button !== 0) return
      // 1.0.5-EW40 — Skip when the event originated inside the
      // portaled popover. React portals propagate synthetic events
      // through the React tree, not the DOM tree — so a pointerdown
      // on the popover's Role input (or any input/button inside the
      // popover) bubbles up to THIS handler even though the popover
      // lives at <body> in the actual DOM. Without this guard, the
      // chip's pointerup-fires-onClick logic treats the popover
      // input click as a second tap on the selected chip and toggles
      // the popover closed before the user can type a character.
      // We check the DOM target's ancestry (not React's) because the
      // popover root is `.ensemble-above-overflow` regardless of
      // which chip anchored it, and that selector is collision-free
      // with everything else in the strip.
      //
      // The brief's textarea context menu (`.composer-textarea-context-menu`)
      // is portaled to <body> the same way and is likewise a React
      // descendant of this chip, so its pointerdowns bubble here too.
      // Without covering it, clicking any menu row (spelling fix, Cut/
      // Copy/Paste, Select All) reads as that second-tap and toggles
      // the popover shut before the menu action runs — leaving every
      // context-menu option inert.
      const target = event.target as HTMLElement | null
      if (target?.closest('.ensemble-above-overflow, .composer-textarea-context-menu')) return
      // A press means the user is selecting/dragging — the hover
      // tooltip (pending or shown) would just get in the way.
      dismissTooltip()
      // 1.0.5-EW22 — Pre-EW22 there was a guard here for the inline
      // `⋯` overflow button. With that button removed (the popover
      // is now opened by clicking the selected chip a second time),
      // the guard is no longer needed.
      if (locked) {
        onClick()
        return
      }

      const startX = event.clientX
      const startY = event.clientY
      let dragged = false

      const chipElement = event.currentTarget as HTMLElement

      const handleMove = (moveEvent: PointerEvent): void => {
        const dx = Math.abs(moveEvent.clientX - startX)
        const dy = Math.abs(moveEvent.clientY - startY)
        // 6px movement threshold — under this is a tap, over is a drag.
        // Same magnitude HTML5 native drag uses; feels right on a
        // trackpad without making intentional drags feel sluggish.
        if (!dragged && (dx > 6 || dy > 6)) {
          dragged = true
          const chipRect = chipElement.getBoundingClientRect()
          onDragStart({
            pointerX: moveEvent.clientX,
            pointerY: moveEvent.clientY,
            chipRect,
            offsetX: moveEvent.clientX - chipRect.left,
            offsetY: moveEvent.clientY - chipRect.top
          })
        }
        if (dragged) {
          onDragMove(moveEvent.clientX, moveEvent.clientY)
        }
      }

      const handleUp = (upEvent: PointerEvent): void => {
        document.removeEventListener('pointermove', handleMove)
        document.removeEventListener('pointerup', handleUp)
        document.removeEventListener('pointercancel', handleUp)
        if (dragged) {
          onDragEnd(upEvent.clientX, upEvent.clientY)
        } else {
          // Pure tap: no significant movement → fire the click handler.
          onClick()
        }
      }

      document.addEventListener('pointermove', handleMove)
      document.addEventListener('pointerup', handleUp)
      document.addEventListener('pointercancel', handleUp)
    },
    [dismissTooltip, locked, onClick, onDragStart, onDragMove, onDragEnd]
  )

  return (
    <div
      ref={setChipAnchor}
      data-participant-id={participant.id}
      data-turn-order={turnOrder}
      data-linked-session={participant.linkedProviderSessionId ? 'true' : undefined}
      onPointerDown={handlePointerDown}
      onPointerEnter={handleTooltipPointerEnter}
      onPointerLeave={dismissTooltip}
      className={`ensemble-above-chip provider-${providerClass} ${isSelected ? 'is-selected' : ''} ${dimmed ? 'is-dimmed' : ''} ${isDragOver ? 'is-drag-over' : ''} ${isDragging ? 'is-dragging' : ''} ${isLiveShimmer ? 'is-live-shimmer' : ''} ${isFailedAccent ? 'is-failed-accent' : ''}`}
      // `order` places the chip in the MERGED roster slot, so an external
      // seated between two model seats pushes the later one along visually
      // without the model map having to know it exists.
      style={{ order: turnOrder, ...(gridSpan !== undefined ? { gridColumn: `span ${gridSpan}` } : {}) }}
      // 1.0.4-AT1 surfaced identity + linked-session via a native
      // `title` here. 2026-07 chip polish — that (and the role /
      // status-pill titles) folded into the single custom hover
      // tooltip below so the chip never shows two tooltips at once.
    >
      {/*
        Body is a `<div role="button">`, not a `<button>` element.
        Buttons + the surrounding pointerdown-based drag detection
        had subtle interactions (browser default mousedown handling
        on a button can interfere with capture-phase listeners),
        and a role-button div behaves identically for screen
        readers + keyboard while keeping the pointer pipeline
        completely under our control.
      */}
      <div
        className="ensemble-above-chip-body"
        role="button"
        tabIndex={0}
        aria-pressed={isSelected}
        aria-label={`${authorityAriaPrefix}${participant.role || providerDisplayName}`}
        aria-description={`Turn ${turnOrder} in roster order`}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onClick()
          }
        }}
      >
        {/*
          1.0.5-EW24 removed the old leading `<ProviderBadgeIcon>` as
          ambiguous; a later 2026-07 polish briefly reinstated a leading
          `<ProviderGlyph>` provider mark. That mark is now dropped too —
          provider identity already reads from the chip's hue and the
          hover tooltip, so the role label leads on its own (behind any
          Boss/Captain/stage authority icon). Keeps the chip face lean
          and gives the role name back the reclaimed width.
        */}
        <span className="ensemble-above-chip-turn-order" aria-hidden="true">
          {turnOrder}
        </span>
        <span className="ensemble-above-chip-role">
          <ParticipantLeadingRoleIcon
            stageRole={participant.stageRole}
            isBossman={isBossman}
            isSecondInCommand={isSecondInCommand}
          />
          {participant.role || getProviderName(participant.provider)}
        </span>
        {/* 1.0.4-AV2's inline token-spend badge lived here between the
          role label and the status icon. 2026-07 chip polish moved the
          estimate into the chip's 500ms hover tooltip (below) so the
          strip stays lean and role names get the reclaimed width. */}
        <span
          className={`ensemble-above-chip-status ${statusClass}`}
          aria-label={statusTooltip ? `${statusLabel}: ${statusTooltip}` : statusLabel}
        >
          <ParticipantStatusIcon status={statusLabel} />
        </span>
        {/*
          Inline retry affordance for failed/unreachable participants.
          The parent only passes `onRetry` when retry is actually
          applicable (failure status + no round running), so its mere
          presence gates visibility — no extra status check needed
          here. Surfacing it on the chip avoids the two-click dig
          (select → open popover → Retry). `stopPropagation` on
          pointerdown keeps the chip's drag/select pipeline from
          treating the click as a chip tap or drag start.
        */}
        {onRetry && (
          <button
            type="button"
            className="ensemble-above-chip-retry"
            title="Retry this participant's last turn"
            aria-label="Retry participant"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onRetry()
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              marginLeft: 2,
              border: 'none',
              background: 'transparent',
              color: 'currentColor',
              cursor: 'pointer',
              opacity: 0.85
            }}
          >
            <svg
              width={13}
              height={13}
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M13 8a5 5 0 1 1-1.5-3.6" />
              <path d="M13 2.5V5h-2.5" />
            </svg>
          </button>
        )}
      </div>
      {/*
        1.0.5-EW22 — The inline ⋯ overflow button used to live here.
        It overlapped into the next chip on dense rows and was an
        easy mis-click target. Replaced with a "click-twice-on-
        selected" gesture handled by the parent's chip onClick
        (see `EnsembleParticipantsAboveRow.tsx` near line 574).
      */}
      {overflowOpen && (
        <EnsembleParticipantOverflowPopover
          anchor={chipAnchor}
          participant={participant}
          mentionParticipants={mentionParticipants}
          onPatch={onPatch}
          isBossman={isBossman}
          isSecondInCommand={isSecondInCommand}
          captainAssignmentDisabled={captainAssignmentDisabled}
          hasLeadership={hasLeadership}
          autoApprovalsEnabled={autoApprovalsEnabled}
          onSetAuthority={onSetAuthority}
          onToggleBossmanAutoApprovals={onToggleBossmanAutoApprovals}
          locked={locked}
          seatBoundaryMessage={seatBoundaryMessage}
          onClose={onCloseOverflow}
          onRetry={onRetry}
          onWakeNow={onWakeNow}
          onCancelWakeup={onCancelWakeup}
          wakeAt={wakeAt}
        />
      )}
      {/*
        2026-07 chip polish — single custom hover tooltip (500ms
        delay, armed in handleTooltipPointerEnter). Consolidates what
        used to be three separate native titles plus the inline token
        badge: identity, status (+ failure reason), token-spend
        estimate, linked session. Suppressed while the overflow
        popover is open or a drag is in flight — both would fight it
        for the same screen space. Portaled to <body> (fixed
        positioning above the chip) so it can't be clipped by the
        strip's overflow — app-global CSS tokens only, per the other
        body-portaled composer popovers.
      */}
      {tooltipPosition && !overflowOpen && !isDragging
        ? createPortal(
            <div
              className={`ensemble-above-chip-tooltip provider-${providerClass}`}
              style={{ left: `${tooltipPosition.x}px`, top: `${tooltipPosition.y}px` }}
              role="tooltip"
            >
              <span className="ensemble-above-chip-tooltip-title">
                {`${authorityPrefix}${providerDisplayName} — ${participant.role || 'Participant'}`}
              </span>
              <span className="ensemble-above-chip-tooltip-line">
                {buildParticipantTokenChipTooltipLine(participant)}
              </span>
              <span className="ensemble-above-chip-tooltip-line is-muted">
                {statusTooltip ? `${statusLabel} — ${statusTooltip}` : statusLabel}
              </span>
              {participant.linkedProviderSessionId ? (
                <span className="ensemble-above-chip-tooltip-line is-muted">
                  {`Linked session: ${participant.linkedProviderSessionId}`}
                </span>
              ) : null}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

interface OverflowPopoverProps {
  anchor: HTMLElement | null
  participant: EnsembleParticipant
  mentionParticipants: EnsembleParticipant[]
  onPatch: (patch: Partial<EnsembleParticipant>) => void
  isBossman: boolean
  isSecondInCommand: boolean
  captainAssignmentDisabled: boolean
  hasLeadership: boolean
  autoApprovalsEnabled: boolean
  onSetAuthority: (
    participantId: string,
    authority: EnsembleParticipantAuthority
  ) => void
  onToggleBossmanAutoApprovals: (enabled: boolean) => void
  /* 1.0.5-EW22 — `onRemove` / `canRemove` removed. Remove gesture
   * moved to the row's "-" sibling button. */
  locked: boolean
  seatBoundaryMessage?: string
  onClose: () => void
  /** 1.0.4-AT7 — re-dispatch the participant when their last turn
   * failed. Optional; when omitted, the Retry row is hidden. */
  onRetry?: () => void
  /** 1.0.5-N7 — Wake-Now + Cancel rows for a sleeping participant.
   * Hidden when no callback (no pending wakeup). */
  onWakeNow?: () => void
  onCancelWakeup?: () => void
  wakeAt?: string
}

interface EnsembleParticipantAuthorityControlsProps {
  participantLabel: string
  enabled: boolean
  authority: EnsembleParticipantAuthority
  backgroundRestricted?: boolean
  bossDemotionDisabled?: boolean
  captainAssignmentDisabled?: boolean
  hasLeadership: boolean
  autoApprovalsEnabled: boolean
  locked: boolean
  onEnabledChange: (enabled: boolean) => void
  onAuthorityChange: (authority: EnsembleParticipantAuthority) => void
  onAutoApprovalsChange: (enabled: boolean) => void
}

/**
 * The compact, reusable-control cluster at the top of the participant popover.
 * Enabled and Auto are independent actions; authority is one exclusive value.
 */
export function EnsembleParticipantAuthorityControls({
  participantLabel,
  enabled,
  authority,
  backgroundRestricted = false,
  bossDemotionDisabled = false,
  captainAssignmentDisabled = false,
  hasLeadership,
  autoApprovalsEnabled,
  locked,
  onEnabledChange,
  onAuthorityChange,
  onAutoApprovalsChange
}: EnsembleParticipantAuthorityControlsProps): React.JSX.Element {
  const effectiveAutoApprovalsEnabled = hasLeadership && autoApprovalsEnabled

  return (
    <div className="ensemble-above-overflow-control-stack">
      <div
        className="ensemble-above-overflow-quick-toggles"
        role="group"
        aria-label={`Round participation and approvals for ${participantLabel}`}
      >
        <PillButton
          size="compact"
          className="ensemble-above-overflow-toggle is-enabled"
          aria-label={`Enabled in ensemble rounds for ${participantLabel}`}
          aria-pressed={enabled}
          title={
            enabled
              ? 'Included in Ensemble rounds.'
              : 'Excluded from Ensemble rounds.'
          }
          disabled={locked}
          onClick={() => onEnabledChange(!enabled)}
        >
          Enabled
        </PillButton>
        <PillButton
          size="compact"
          className="ensemble-above-overflow-toggle is-auto"
          aria-label="Thread-wide Auto Approvals"
          aria-pressed={effectiveAutoApprovalsEnabled}
          title={
            hasLeadership
              ? effectiveAutoApprovalsEnabled
                ? 'Disable thread-wide Boss/Captain Auto Approvals.'
                : 'Enable thread-wide Boss/Captain Auto Approvals.'
              : 'Assign a Boss before enabling Auto Approvals.'
          }
          disabled={locked || !hasLeadership}
          onClick={() => onAutoApprovalsChange(!effectiveAutoApprovalsEnabled)}
        >
          Auto
        </PillButton>
      </div>
      <SegmentedControl
        className="ensemble-above-overflow-authority"
        size="compact"
        value={authority}
        ariaLabel={`Authority role for ${participantLabel}`}
        disabled={locked}
        onValueChange={onAuthorityChange}
        options={[
          {
            value: 'boss',
            disabled: backgroundRestricted,
            title: backgroundRestricted
              ? 'BG seats cannot own Boss or Captain authority.'
              : 'Assign as the thread\'s only Boss.',
            label: (
              <span className="ensemble-above-overflow-authority-label">
                <BossmanCrownIcon className="ensemble-above-overflow-crown" />
                Boss
              </span>
            )
          },
          {
            value: 'captain',
            disabled:
              backgroundRestricted || bossDemotionDisabled || captainAssignmentDisabled,
            title: backgroundRestricted
              ? 'BG seats cannot own Boss or Captain authority.'
              : bossDemotionDisabled
                ? 'Assign another Boss before changing this participant\'s authority.'
                : captainAssignmentDisabled
                  ? `This panel already has ${MAX_ENSEMBLE_CAPTAINS} Captains.`
                  : `Assign as one of up to ${MAX_ENSEMBLE_CAPTAINS} Captains.`,
            label: (
              <span className="ensemble-above-overflow-authority-label">
                <CaptainHatIcon className="ensemble-above-overflow-captain-hat" />
                Captain
              </span>
            )
          },
          {
            value: 'agent',
            disabled: bossDemotionDisabled,
            title: bossDemotionDisabled
              ? 'Assign another Boss before changing this participant\'s authority.'
              : 'Use standard Agent authority.',
            label: 'Agent'
          }
        ]}
      />
    </div>
  )
}

interface EnsembleParticipantStageControlProps {
  participantLabel: string
  stageRole?: EnsembleParticipant['stageRole']
  backgroundDisabled?: boolean
  locked: boolean
  onStageRoleChange: (stageRole: EnsembleParticipant['stageRole'] | undefined) => void
}

/** Shared four-way staged-dispatch selector for the participant popover. */
export function EnsembleParticipantStageControl({
  participantLabel,
  stageRole,
  backgroundDisabled = false,
  locked,
  onStageRoleChange
}: EnsembleParticipantStageControlProps): React.JSX.Element {
  return (
    <div className="ensemble-above-overflow-stage" title={ENSEMBLE_STAGE_ROLE_HINT}>
      <span className="ensemble-above-overflow-label">Stage</span>
      <SegmentedControl
        className="ensemble-above-overflow-stage-control"
        size="compact"
        value={stageRole || 'any'}
        ariaLabel={`Stage for ${participantLabel}`}
        disabled={locked}
        options={ENSEMBLE_PARTICIPANT_STAGE_OPTIONS.map((option) =>
          option.value === 'background' && backgroundDisabled
            ? {
                ...option,
                disabled: true,
                title: 'Assign another Boss before moving this participant to background.'
              }
            : option
        )}
        onValueChange={(value) => onStageRoleChange(normalizeEnsembleStageRole(value))}
      />
    </div>
  )
}

export function EnsembleParticipantOverflowPopover({
  anchor,
  participant,
  mentionParticipants,
  onPatch,
  isBossman,
  isSecondInCommand,
  captainAssignmentDisabled,
  hasLeadership,
  autoApprovalsEnabled,
  onSetAuthority,
  onToggleBossmanAutoApprovals,
  locked,
  seatBoundaryMessage,
  onClose,
  onRetry,
  onWakeNow,
  onCancelWakeup,
  wakeAt
}: OverflowPopoverProps): React.JSX.Element | null {
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const instructionsTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const instructionsContextMenu = useComposerTextareaContextMenu()
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [rolePresetId, setRolePresetId] = useState(() => resolveRolePresetId(participant.role))

  useEffect(() => {
    setRolePresetId(resolveRolePresetId(participant.role))
  }, [participant.id, participant.role])

  // Buffer the freely-typed fields (custom Role + Goal/Brief) in LOCAL state so a
  // keystroke doesn't round-trip the whole chat through onChatChange + a saveChat
  // IPC. That round-trip echoes a stale chat back (chat-updated → setCurrentChat)
  // mid-typing — reverting the controlled value and DROPPING characters — and
  // also forced a full composer re-render per key. We persist on blur + on close
  // instead (mirrors RosterSettingsPanel's local-draft-until-blur).
  const [roleDraft, setRoleDraft] = useState(participant.role)
  const [instructionsDraft, setInstructionsDraft] = useState(participant.instructions)
  // Re-sync from the COMMITTED value only when it actually changes (participant
  // switch / external edit) — never on our own keystrokes, since the drafts are
  // local and participant.* doesn't move while typing, so typing isn't clobbered.
  useEffect(() => {
    setRoleDraft(participant.role)
  }, [participant.id, participant.role])
  useEffect(() => {
    setInstructionsDraft(participant.instructions)
  }, [participant.id, participant.instructions])

  // Latest-value refs so the unmount flush commits the final draft even though
  // the popover closes via outside-click / Escape / unmount WITHOUT blurring.
  const onPatchRef = useRef(onPatch)
  onPatchRef.current = onPatch
  const lockedRef = useRef(locked)
  lockedRef.current = locked
  const roleDraftRef = useRef(roleDraft)
  roleDraftRef.current = roleDraft
  const instructionsDraftRef = useRef(instructionsDraft)
  instructionsDraftRef.current = instructionsDraft
  const committedRef = useRef({ role: participant.role, instructions: participant.instructions })
  committedRef.current = { role: participant.role, instructions: participant.instructions }

  const commitDrafts = useCallback((): void => {
    if (lockedRef.current) return
    const patch: Partial<EnsembleParticipant> = {}
    if (roleDraftRef.current !== committedRef.current.role) patch.role = roleDraftRef.current
    if (instructionsDraftRef.current !== committedRef.current.instructions) {
      patch.instructions = instructionsDraftRef.current
    }
    if (Object.keys(patch).length > 0) onPatchRef.current(patch)
  }, [])

  // Safety net: flush any unsaved draft when the popover unmounts — its close
  // paths (capture-phase outside mousedown, Escape, programmatic unmount) don't
  // blur the field first, so without this, closing would silently drop the text.
  useEffect(() => {
    return () => {
      commitDrafts()
    }
  }, [commitDrafts])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled || !anchor) return
      const rect = anchor.getBoundingClientRect()
      const flyoutWidth = Math.min(296, window.innerWidth - 16)
      const left = Math.max(8, Math.min(window.innerWidth - flyoutWidth - 8, rect.left))
      const top = rect.top - 8
      setPosition({ left, top })
    })
    return () => {
      cancelled = true
    }
  }, [anchor])

  useEffect(() => {
    const handleClick = (event: MouseEvent): void => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target)) return
      if (
        target instanceof Element &&
        target.closest('.composer-textarea-context-menu')
      ) {
        return
      }
      // 1.0.5-EW22 — Clicks on the chip the popover is anchored to
      // are handled by the chip's own onClick (toggle the popover).
      // Without this early-return, the mousedown closes the popover
      // before the pointerup re-opens it — net result of a click-
      // to-close gesture was visible flicker then re-open. Anchor-
      // chip clicks fall through; everything else closes.
      if (anchor && anchor.contains(target)) return
      onClose()
    }
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClick, true)
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [onClose, anchor])

  if (!position) return null

  const content = (
    <div
      ref={popoverRef}
      className={`ensemble-above-overflow provider-${resolveProviderHueClass(participant.provider, participant.model)}`}
      style={{
        position: 'fixed',
        left: `${position.left}px`,
        top: `${position.top}px`,
        transform: 'translateY(-100%)'
      }}
      role="dialog"
      aria-label={`Edit ${
        isBossman ? 'Boss ' : isSecondInCommand ? 'Captain ' : ''
      }${getProviderName(participant.provider)} role and enabled state`}
    >
      <EnsembleParticipantAuthorityControls
        participantLabel={getProviderName(participant.provider)}
        enabled={participant.enabled}
        authority={isBossman ? 'boss' : isSecondInCommand ? 'captain' : 'agent'}
        backgroundRestricted={participant.stageRole === 'background'}
        bossDemotionDisabled={isBossman}
        captainAssignmentDisabled={captainAssignmentDisabled}
        hasLeadership={hasLeadership}
        autoApprovalsEnabled={autoApprovalsEnabled}
        locked={locked}
        onEnabledChange={(enabled) => onPatch({ enabled })}
        onAuthorityChange={(authority) => onSetAuthority(participant.id, authority)}
        onAutoApprovalsChange={onToggleBossmanAutoApprovals}
      />
      <EnsembleParticipantStageControl
        participantLabel={getProviderName(participant.provider)}
        stageRole={participant.stageRole}
        backgroundDisabled={isBossman}
        locked={locked}
        onStageRoleChange={(stageRole) => onPatch({ stageRole })}
      />
      <label className="ensemble-above-overflow-role">
        <span className="ensemble-above-overflow-label">Role</span>
        <select
          className="ensemble-above-overflow-role-picker"
          value={rolePresetId}
          disabled={locked}
          onChange={(event) => {
            const nextPresetId = event.target.value
            setRolePresetId(nextPresetId)
            const presetLabel = roleLabelForPresetId(nextPresetId)
            if (presetLabel) {
              onPatch({ role: presetLabel })
            }
          }}
        >
          {ENSEMBLE_ROLE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id} title={preset.description}>
              {preset.label}
            </option>
          ))}
          <option value={ENSEMBLE_ROLE_PRESET_CUSTOM}>Custom…</option>
        </select>
        {rolePresetId === ENSEMBLE_ROLE_PRESET_CUSTOM ? (
          <input
            type="text"
            value={roleDraft}
            disabled={locked}
            onChange={(event) => setRoleDraft(event.target.value)}
            onBlur={commitDrafts}
            placeholder={`${getProviderName(participant.provider)} role`}
          />
        ) : null}
      </label>
      <EnsembleBriefEditor
        label="Goal / brief"
        value={instructionsDraft}
        participants={mentionParticipants}
        disabled={locked}
        rows={6}
        editorClassName="ensemble-above-overflow-instructions"
        labelClassName="ensemble-above-overflow-label"
        textareaClassName="ensemble-above-overflow-instructions-field"
        textareaRef={instructionsTextareaRef}
        syncEpoch={`${participant.id}:${mentionParticipants.length}`}
        commitLabel="Save"
        commitTitle="Save this role and brief to the active chat"
        onCommit={commitDrafts}
        onChange={setInstructionsDraft}
        onContextMenu={instructionsContextMenu.handleContextMenu}
        onBlur={commitDrafts}
        placeholder="Optional focus for this participant's turns…"
      />
      <ComposerTextareaContextMenu
        anchor={instructionsContextMenu.anchor}
        spellcheckContext={instructionsContextMenu.spellcheckContext}
        textareaRef={instructionsTextareaRef}
        onValueChange={setInstructionsDraft}
        onOpenFromElectron={instructionsContextMenu.openContextMenu}
        onClose={() => instructionsContextMenu.setAnchor(null)}
      />
      {onRetry && (
        // 1.0.4-AT7 — Retry the participant's last turn. The strip
        // gates visibility on `status === 'failed' || 'unreachable'`
        // and `!isRoundRunning`, so this button only appears when
        // retry is actually a sensible action. Clicking it
        // re-dispatches as a DM via the AT4-extended
        // `runEnsembleRound` IPC path; the round closes on this
        // single participant's response.
        <button
          type="button"
          className="ensemble-above-overflow-retry"
          onClick={() => {
            onRetry()
            onClose()
          }}
        >
          Retry participant
        </button>
      )}
      {onWakeNow && (
        // 1.0.5-N7 — Wake the sleeping participant immediately,
        // bypassing the scheduled wakeAt. Same orchestrator path
        // as the timer firing naturally; the participant resumes
        // with the standard [Scheduled wakeup] prompt block.
        <button
          type="button"
          className="ensemble-above-overflow-wake-now"
          title={wakeAt ? `Originally scheduled for ${wakeAt}` : undefined}
          onClick={() => {
            onWakeNow()
            onClose()
          }}
        >
          Wake now
        </button>
      )}
      {onCancelWakeup && (
        // 1.0.5-N7 — Cancel the pending wakeup. The participant
        // exits the sleeping state but the round continues with
        // other participants. If you want the round itself to
        // stop, use the round-level Stop button instead.
        <button
          type="button"
          className="ensemble-above-overflow-cancel-wakeup"
          title={wakeAt ? `Cancels the scheduled wakeup at ${wakeAt}` : undefined}
          onClick={() => {
            onCancelWakeup()
            onClose()
          }}
        >
          Cancel wakeup
        </button>
      )}
      {/*
        1.0.5-EW22 — "Remove participant" moved to a sibling "-"
        button next to the row's "+" button, so the popover no
        longer carries the destructive row. Removing from the
        right-edge sibling is closer to the visual locus where
        users mentally bind "participant roster controls".
      */}
      <p className="ensemble-above-overflow-hint">
        {seatBoundaryMessage ||
          (locked
            ? 'Participant membership is locked while a round is running.'
            : 'Model, provider, reasoning, fast mode, and permissions live in the composer pickers below — they apply to the chip selected here.')}
      </p>
    </div>
  )

  return createPortal(content, document.body)
}

function nextParticipantId(participants: EnsembleParticipant[]): string {
  const existing = new Set(participants.map((participant) => participant.id))
  for (let index = participants.length + 1; index < participants.length + 32; index += 1) {
    const id = `ensemble-participant-${index}`
    if (!existing.has(id)) return id
  }
  return `ensemble-participant-${Date.now().toString(36)}`
}

function nextRoleLabel(
  baseRole: string,
  participants: ReadonlyArray<Pick<EnsembleParticipant, 'role'>>
): string {
  const base = (baseRole || 'Participant').replace(/\s+\d+$/, '').trim() || 'Participant'
  const existing = new Set(
    participants.map((participant) =>
      String(participant.role || '')
        .trim()
        .toLowerCase()
    )
  )
  if (!existing.has(base.toLowerCase())) return base
  for (let index = 2; index < 32; index += 1) {
    const candidate = `${base} ${index}`
    if (!existing.has(candidate.toLowerCase())) return candidate
  }
  return `${base} ${participants.length + 1}`
}

/*
 * `defaultEnsembleParticipants()` + `defaultRole()` deleted in 1.0.3.
 * The main process owns ensemble defaults via `EnsembleDefaults.ts` —
 * the renderer had a parallel implementation here from Slice D when
 * the setup-sheet modal seeded its own state, but with that modal
 * retired in Slice F there are no consumers in the renderer. Default
 * shape is whatever `chatService.createEnsembleChat()` returns from
 * the main process.
 */
