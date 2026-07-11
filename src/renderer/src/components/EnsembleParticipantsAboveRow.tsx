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
import { createPortal } from 'react-dom'
import type {
  ChatRecord,
  ComposerStyle,
  ConcurrentLane,
  EnsembleParticipant,
  ProviderId
} from '../../../main/store/types'
import {
  getDefaultEnsembleParticipantConfig,
  getDefaultEnsembleRoleName,
  getEnsembleModelDefaults,
  getEnsembleReasoningOptions,
  normalizeProviderModelSelection
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
import { buildParticipantTokenChipTooltipLine } from '../lib/participantTokenChip'
import { resolveProviderBrandLabel, resolveProviderHueClass } from '../lib/ollamaDisplayBrand'
import { withSessionActivityLedger } from '../lib/sessionActivityLedger'
import { isEnsembleActiveRoundDispatchLive } from '../lib/chatBusyState'
import {
  claudeReasoningDisplayLabel,
  codexReasoningDisplayLabel,
  grokReasoningDisplayLabel
} from '../lib/composerChipFormat'
import { resolveProviderRows } from './ComposerProviderPicker'
import { ProviderGlyph } from './icons/ProviderGlyph'
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

// 1.0.4-AR2 — global ceiling raised from 6 → 8 so the panel can host
// the broader four-provider roster plus alternates (e.g. two Claudes
// in different roles). The hard minimum is enforced in
// `removeParticipant` below at `<= 1` so a panel is never reduced to
// zero participants.
//
// 1.0.5-EW1 — Ceiling raised again 8 → 12. The chip strip now wraps
// at 7+ participants instead of overflowing horizontally.
//
// 1.0.5-EW46 — Ceiling raised 12 → 18 (three rows of the then-6-column
// grid).
//
// 1.7.x — Ceiling 18 → 20 and the wrapped layout reworked from a fixed
// 6-column grid to balanced rows of AT MOST 5 chips (4 rows max at the
// 20 cap), so role names truncate less. Keep in sync with the
// main-process copies (EnsembleRosterMutation.ts, EnsemblePrompt.ts)
// and MAX_ROSTER_PRESET_PARTICIPANTS in ensembleRosterPresets.ts.
const MAX_ENSEMBLE_PARTICIPANTS = 20
const MIN_ENSEMBLE_PARTICIPANTS = 1
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

export type EnsembleParticipantAuthority = 'boss' | 'captain' | 'agent'
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
          : 'Review',
    title: option.description
  }))
]

type EnsembleAuthorityPatch = Pick<
  NonNullable<ChatRecord['ensemble']>,
  'bossmanParticipantId' | 'secondInCommandParticipantId' | 'bossmanAutoApprovals'
>

/**
 * Atomically moves one participant between the three exclusive authority
 * roles. The ensemble stores singular Boss/Captain ids, so assigning either
 * role replaces its previous owner and Agent clears this participant's special
 * role. Thread-wide auto approval consent survives while any leader remains.
 */
export function resolveEnsembleParticipantAuthorityPatch(
  state: EnsembleAuthorityPatch,
  participantId: string,
  authority: EnsembleParticipantAuthority
): EnsembleAuthorityPatch {
  let bossmanParticipantId = state.bossmanParticipantId
  let secondInCommandParticipantId = state.secondInCommandParticipantId

  // Normalize any malformed legacy overlap before applying the next choice.
  // Boss remains authoritative when both ids point at the same participant.
  if (
    bossmanParticipantId &&
    secondInCommandParticipantId === bossmanParticipantId
  ) {
    secondInCommandParticipantId = undefined
  }

  if (authority === 'boss') {
    bossmanParticipantId = participantId
    if (secondInCommandParticipantId === participantId) secondInCommandParticipantId = undefined
  } else if (authority === 'captain') {
    secondInCommandParticipantId = participantId
    if (bossmanParticipantId === participantId) bossmanParticipantId = undefined
  } else {
    if (bossmanParticipantId === participantId) bossmanParticipantId = undefined
    if (secondInCommandParticipantId === participantId) secondInCommandParticipantId = undefined
  }

  return {
    bossmanParticipantId,
    secondInCommandParticipantId,
    bossmanAutoApprovals:
      bossmanParticipantId || secondInCommandParticipantId
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
  cursorAvailable: boolean
): CombinedModelPickerProviderGroup[] {
  return resolveProviderRows(grokAvailable, cursorAvailable).map((row) => {
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
  const source = providerGroups?.length
    ? providerGroups
    : buildEnsembleAddProviderGroups(grokAvailable, cursorAvailable)
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

function getEnsembleAddReasoningOptions(
  provider: ProviderId,
  model: string,
  providerGroups: readonly CombinedModelPickerProviderGroup[]
): CombinedModelPickerReasoningOption[] {
  const modelOption = providerGroups
    .find((group) => group.provider === provider)
    ?.modelOptions.find((option) => option.id === model)
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
  return getEnsembleReasoningOptions(provider, model)
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
  const requestedOption = modelOptions.find(
    (option) => option.id === requestedModel && option.id !== 'custom' && !option.disabled
  )
  const defaultOption =
    modelOptions.find(
      (option) => option.id === participantDefaults.model && option.id !== 'custom' && !option.disabled
    ) ||
    modelOptions.find(
      (option) =>
        option.id === modelDefaults.defaultModelId && option.id !== 'custom' && !option.disabled
    ) ||
    modelOptions.find((option) => option.id !== 'custom' && !option.disabled)
  const model = requestedOption?.id || defaultOption?.id || participantDefaults.model
  const modelOption = requestedOption || defaultOption
  const normalized = normalizeProviderModelSelection(provider, model, modelOption)

  return {
    provider,
    ...normalized,
    model
  }
}

export function createEnsembleParticipantAddDetails(
  provider: ProviderId,
  participants: EnsembleParticipant[],
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
  participants: EnsembleParticipant[],
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

export function resolveEnsembleParticipantAddAuthorityPatch(
  state: EnsembleAuthorityPatch,
  participantId: string,
  authority: EnsembleParticipantAuthority,
  autoApprovals: NonNullable<ChatRecord['ensemble']>['bossmanAutoApprovals']
): EnsembleAuthorityPatch {
  const authorityPatch = resolveEnsembleParticipantAuthorityPatch(
    state,
    participantId,
    authority
  )
  const hasLeadership = Boolean(
    authorityPatch.bossmanParticipantId || authorityPatch.secondInCommandParticipantId
  )
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

function laneStatusToParticipantLabel(status: ConcurrentLane['status']): string {
  switch (status) {
    case 'pending':
      return 'idle'
    case 'running':
      return 'speaking'
    case 'completed':
      return 'answered'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'blocked':
      return 'failed'
    case 'awaiting-approval':
      return 'running'
    default:
      return 'idle'
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

function latestLaneForParticipant(
  lanes: Record<string, ConcurrentLane> | undefined,
  participantId: string
): ConcurrentLane | undefined {
  const matches = Object.values(lanes || {}).filter((lane) => lane.participantId === participantId)
  return (
    matches.find(
      (lane) =>
        lane.status === 'running' ||
        lane.status === 'pending' ||
        lane.status === 'awaiting-approval' ||
        lane.status === 'blocked'
    ) || matches[matches.length - 1]
  )
}

/**
 * Monoline status icon for a participant chip (1.0.3 polish).
 *
 * Replaces the pre-existing uppercase text labels ("IDLE", "SPEAKING",
 * "YIELDED", etc.) inside the chip's `.ensemble-above-chip-status`
 * pill. Each icon uses `stroke="currentColor"` so the existing
 * `.status-{name}` colour rules in main.css continue to drive the
 * tint — the icon naturally reads "yielded amber", "answered green",
 * etc. without per-icon hard-coded fills.
 *
 * 16x16 viewBox with 1.5 stroke width keeps the glyphs visually
 * consistent with the rest of the chip-strip iconography (the
 * provider badge SVGs use the same density). 13×13 rendered size is
 * roughly the visual weight of a single uppercase letter in the
 * pre-existing label — small enough to feel like a status hint, big
 * enough to read at glance.
 *
 * Status taxonomy mirrors `EnsembleParticipantStatus` plus the
 * synthetic `'speaking'` label the parent uses for the currently-
 * active participant:
 *   - speaking / running → megaphone (active output)
 *   - idle              → ZZZ stack (waiting its turn)
 *   - yielded           → curved-rightward handoff arrow (deliberate
 *                          pass — distinct from skip which is
 *                          involuntary)
 *   - answered          → checkmark (turn complete, content delivered)
 *   - failed            → warning triangle with !
 *   - skipped           → skip-forward double-triangle (passed over)
 *   - sleeping          → alarm clock (scheduled wakeup pending)
 *   - cancelled         → circle-slash (round-level cancel)
 *   - default           → ZZZ (unknown status falls through to idle
 *                          glyph for safety)
 */
function ParticipantStatusIcon({ status }: { status: string }): React.JSX.Element {
  const key = status.toLowerCase()
  const baseSvgProps = {
    width: 13,
    height: 13,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const
  }
  if (key === 'speaking' || key === 'running') {
    // Megaphone: rectangular body + flared mouth + two sound waves.
    return (
      <svg {...baseSvgProps}>
        <path d="M3 6.5h2L10 4v8L5 9.5H3Z" />
        <path d="M3 6.5v3" />
        <path d="M12 6c.7 1 .7 3 0 4" />
        <path d="M13.8 4.5c1.1 1.6 1.1 5.4 0 7" />
      </svg>
    )
  }
  if (key === 'yielded') {
    // Curved handoff arrow: small leftward stem rises then arcs
    // rightward — "I'm done, the next person can go". Distinct from
    // a plain rightward arrow (which we use for skipped) so the
    // glyph reads as deliberate handoff vs forced skip.
    return (
      <svg {...baseSvgProps}>
        <path d="M3 12V8a3 3 0 0 1 3-3h7" />
        <path d="m10 2.5 3 2.5-3 2.5" />
      </svg>
    )
  }
  if (key === 'answered') {
    // Plain checkmark. The .status-answered colour rule gives it the
    // success-green tint.
    return (
      <svg {...baseSvgProps}>
        <path d="m3 8.5 3.5 3.5L13 5" />
      </svg>
    )
  }
  if (key === 'failed') {
    // Warning triangle with exclamation.
    return (
      <svg {...baseSvgProps}>
        <path d="M8 2.5 14.5 13.5h-13z" />
        <path d="M8 7v3" />
        <path d="M8 12h.01" strokeWidth={2} />
      </svg>
    )
  }
  if (key === 'skipped') {
    // Skip-forward: two right-pointing triangles. Solid fill so it
    // reads as a media-control glyph even at 13px.
    return (
      <svg {...baseSvgProps}>
        <path d="M3 4v8l5-4z" fill="currentColor" stroke="none" />
        <path d="M8.5 4v8l5-4z" fill="currentColor" stroke="none" />
      </svg>
    )
  }
  if (key === 'cancelled') {
    // Circle-slash. The .status-cancelled colour rule keeps it in
    // the danger-tinted family.
    return (
      <svg {...baseSvgProps}>
        <circle cx="8" cy="8" r="5" />
        <path d="m4.7 11.3 6.6-6.6" />
      </svg>
    )
  }
  if (key === 'unreachable') {
    // 1.0.4-AD — broken-chain icon for participants the pre-flight
    // probe couldn't verify at round start. Two staggered link-shaped
    // ovals with a clear gap between them: reads as "connection
    // severed" at glance. The .status-unreachable colour rule (added
    // in main.css) carries the danger-amber tint so the pill stands
    // apart from `answered` (green) and `failed` (also amber but
    // mid-round rather than pre-flight). Hover tooltip wires the
    // `lastFailureReason` from the round state.
    return (
      <svg {...baseSvgProps}>
        <path d="M5.5 6.5a2 2 0 0 0-2 2v0a2 2 0 0 0 2 2h1.2" />
        <path d="M10.5 9.5a2 2 0 0 0 2-2v0a2 2 0 0 0-2-2H9.3" />
        <path d="m3 13 10-10" strokeWidth={1.3} />
      </svg>
    )
  }
  if (key === 'sleeping') {
    return (
      <svg {...baseSvgProps}>
        <circle cx="8" cy="8.5" r="4.5" />
        <path d="M5 2.5 3.5 4" />
        <path d="m11 2.5 1.5 1.5" />
        <path d="M8 6.5v2.2l1.6 1.2" />
        <path d="M5.5 14 4.7 15" />
        <path d="m10.5 14 .8 1" />
      </svg>
    )
  }
  // idle (default fall-through): three Z marks descending — dormant
  // / waiting. Drawn as nested polylines so the staircase is the
  // shape, not glyphs (avoids font-rendering inconsistencies).
  return (
    <svg {...baseSvgProps}>
      <path d="M9 3h3l-3 3h3" strokeWidth={1.2} />
      <path d="M5 7h4l-4 4h4" />
      <path d="M3 12h2l-2 2h2" strokeWidth={1.2} />
    </svg>
  )
}

function BossmanCrownIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4.7 17.8h14.6l1.2-9.1-4.8 3.4-3.7-6-3.7 6-4.8-3.4 1.2 9.1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M5.4 20h13.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function CaptainHatIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M5.2 15.8c2.3 1.2 11.3 1.2 13.6 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path
        d="M6.8 14.8 8 9.7c.3-1.1 1.2-1.8 2.3-1.8h3.4c1.1 0 2 .7 2.3 1.8l1.2 5.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path
        d="M9.3 8c.7-1.2 1.6-1.9 2.7-1.9s2 .7 2.7 1.9M10.1 11.4h3.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M4 16.4c1.9 1.3 4.6 2 8 2s6.1-.7 8-2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * Runtime copies of the designer SVGs in
 * `design-assets/ensemble-stage-roles/icons`. These intentionally do not use
 * ToolFamilyIcon: stage roles need distinct silhouettes at the chip's 14px
 * size and are a separate visual concept from transcript tool calls.
 */
function EnsembleStageRoleIcon({
  stageRole,
  className
}: {
  stageRole: NonNullable<EnsembleParticipant['stageRole']>
  className?: string
}): React.JSX.Element {
  const baseSvgProps = {
    className,
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
    focusable: 'false' as const
  }

  if (stageRole === 'scout') {
    return (
      <svg {...baseSvgProps}>
        <circle cx="10.1" cy="10.1" r="5.8" />
        <path d="m14.4 14.4 5.8 5.8" />
      </svg>
    )
  }
  if (stageRole === 'worker') {
    return (
      <svg {...baseSvgProps}>
        <path d="M15.2 4.1a5 5 0 0 0-6.1 6.4l-5.3 5.3a2.7 2.7 0 0 0 3.8 3.8l5.3-5.3a5 5 0 0 0 6.4-6.1" />
        <path d="m15.2 4.1-3.1 3.1.9 3.3 3.3.9 3-3.2" />
      </svg>
    )
  }
  return (
    <svg {...baseSvgProps}>
      <circle cx="7.3" cy="13.1" r="3.6" />
      <circle cx="16.7" cy="13.1" r="3.6" />
      <path d="M10.9 12.4c.7-.8 1.5-.8 2.2 0" />
      <path d="m3.8 11.7-1.3-3.2M20.2 11.7l1.3-3.2" />
    </svg>
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

  return (
    <EnsembleStageRoleIcon
      stageRole={stageRole}
      className={`ensemble-above-chip-stage-icon is-${stageRole}`}
    />
  )
}

interface EnsembleParticipantsAboveRowProps {
  chat: ChatRecord
  selectedParticipantId: string | null
  onSelectParticipant: (id: string) => void
  onChatChange: (next: ChatRecord) => void
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
   * 1.0.4-AK2 — Stop the active Work Session. Cancels the in-flight
   * round + clears queued continuations + flips
   * `workSession.status` to `'cancelled'`. Wired to
   * `handleStopWorkSession` in App.tsx; omitted in non-Work-Session
   * surfaces (e.g. older harness tests) so the strip degrades to
   * disabled.
   */
  onStopWorkSession?: () => void
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
  selectedParticipantId,
  onSelectParticipant,
  onChatChange,
  onSkipActive,
  onSkipReadFanout,
  onStopWorkSession,
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
  const [workSessionNow, setWorkSessionNow] = useState(() => Date.now())

  const participants =
    chat.chatKind === 'ensemble' && chat.ensemble
      ? [...(chat.ensemble.participants || [])].sort((a, b) => a.order - b.order)
      : []
  const participantIdsKey = participants.map((participant) => participant.id).join('\u001f')
  const workSession = chat.chatKind === 'ensemble' ? chat.ensemble?.workSession : undefined
  const workSessionStatus = workSession?.status
  // Live = the session is still consuming its duration budget. Only
  // then does a "… left" countdown make sense; ended sessions show
  // elapsed time + their ended reason instead of a stale "0s left".
  const isWorkSessionLive = workSessionStatus === 'active' || workSessionStatus === 'paused'
  const showWorkSessionStrip =
    workSession?.enabled &&
    (workSessionStatus === 'active' ||
      workSessionStatus === 'paused' ||
      workSessionStatus === 'completed' ||
      workSessionStatus === 'cancelled' ||
      workSessionStatus === 'limit_reached')

  useEffect(() => {
    if (!showWorkSessionStrip) return
    const handle = window.setInterval(() => setWorkSessionNow(Date.now()), 30_000)
    return () => window.clearInterval(handle)
  }, [showWorkSessionStrip, workSession?.startedAt, workSession?.maxDurationMs])

  useEffect(() => {
    const pendingParticipantId = pendingFocusParticipantIdRef.current
    if (!pendingParticipantId || selectedParticipantId !== pendingParticipantId) return
    pendingFocusParticipantIdRef.current = null
    const selector = `[data-participant-id="${escapeSelectorAttributeValue(pendingParticipantId)}"] .ensemble-above-chip-body`
    const focusTarget = chipsContainerRef.current?.querySelector<HTMLElement>(selector)
    focusTarget?.focus({ preventScroll: true })
  }, [participantIdsKey, selectedParticipantId])

  if (chat.chatKind !== 'ensemble' || !chat.ensemble) return null

  const activeRound = chat.ensemble.activeRound
  const isRoundRunning = isEnsembleActiveRoundDispatchLive(activeRound)
  const hasLeadership = participants.some(
    (participant) =>
      participant.id === chat.ensemble?.bossmanParticipantId ||
      participant.id === chat.ensemble?.secondInCommandParticipantId
  )
  const liveFanoutLanes = Object.values(activeRound?.lanes || {}).filter(isLiveFanoutLane)
  const canSkipReadFanout =
    isRoundRunning &&
    liveFanoutLanes.length > 0 &&
    liveFanoutLanes.some((lane) => lane.intent === 'read') &&
    liveFanoutLanes.every((lane) => lane.intent === 'read')
  const canAddParticipant = !isRoundRunning && participants.length < MAX_ENSEMBLE_PARTICIPANTS
  // Index-aligned `grid-column` spans for the wrapped balanced-rows
  // layout; null in single-row flex mode (≤5 chips) where chips size
  // to their content instead.
  const chipGridSpans =
    participants.length >= ENSEMBLE_CHIPS_WRAP_THRESHOLD
      ? computeEnsembleChipGridSpans(participants.length)
      : null

  const updateParticipant = (id: string, patch: Partial<EnsembleParticipant>): void => {
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
      isRoundRunning ||
      !participants.some((participant) => participant.id === participantId)
    ) {
      return
    }
    patchEnsemble(
      resolveEnsembleParticipantAuthorityPatch(
        {
          bossmanParticipantId: chat.ensemble?.bossmanParticipantId,
          secondInCommandParticipantId: chat.ensemble?.secondInCommandParticipantId,
          bossmanAutoApprovals: chat.ensemble?.bossmanAutoApprovals
        },
        participantId,
        authority
      )
    )
  }

  const setBossmanAutoApprovals = (enabled: boolean): void => {
    if (isRoundRunning || !hasLeadership) {
      return
    }
    if (enabled) {
      const confirmed = window.confirm(
        'Allow Boss/Captain Auto Approvals for this Ensemble? Boss remains primary; Captain can only use this consent when Boss is unavailable. Approvals stay one-shot and limited to the selected participant permission preset and workspace policy. This will not grant session/workspace approval, YOLO, policy changes, external-path escapes, or unclassified requests.'
      )
      if (!confirmed) return
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

  const persist = (
    nextParticipants: EnsembleParticipant[],
    authorityOverride?: EnsembleAuthorityPatch
  ): void => {
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
    const existingMax = chat.ensemble?.maxParticipants
    const preservedMax =
      Number.isFinite(existingMax) &&
      (existingMax as number) >= MIN_ENSEMBLE_PARTICIPANTS &&
      (existingMax as number) <= MAX_ENSEMBLE_PARTICIPANTS
        ? (existingMax as number)
        : MAX_ENSEMBLE_PARTICIPANTS
    const clampedMax = Math.min(
      MAX_ENSEMBLE_PARTICIPANTS,
      Math.max(preservedMax, nextParticipants.length)
    )
    const authorityState = authorityOverride || {
      bossmanParticipantId: chat.ensemble?.bossmanParticipantId,
      secondInCommandParticipantId: chat.ensemble?.secondInCommandParticipantId,
      bossmanAutoApprovals: chat.ensemble?.bossmanAutoApprovals
    }
    const existingBossmanParticipantId = authorityState.bossmanParticipantId
    const bossmanParticipantId =
      existingBossmanParticipantId &&
      nextParticipants.some((participant) => participant.id === existingBossmanParticipantId)
        ? existingBossmanParticipantId
        : undefined
    const existingSecondInCommandParticipantId = authorityState.secondInCommandParticipantId
    const secondInCommandParticipantId =
      existingSecondInCommandParticipantId &&
      existingSecondInCommandParticipantId !== bossmanParticipantId &&
      nextParticipants.some((participant) => participant.id === existingSecondInCommandParticipantId)
        ? existingSecondInCommandParticipantId
        : undefined
    const nextChat: ChatRecord = {
      ...chat,
      ensemble: {
        ...chat.ensemble!,
        maxParticipants: clampedMax,
        participants: nextParticipants.map((p, idx) => ({ ...p, order: idx + 1 })),
        bossmanParticipantId,
        secondInCommandParticipantId,
        bossmanAutoApprovals: bossmanParticipantId || secondInCommandParticipantId
          ? authorityState.bossmanAutoApprovals
          : undefined,
        updatedAt: new Date().toISOString()
      }
    }
    onChatChange(withSessionActivityLedger(chat, nextChat))
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
        secondInCommandParticipantId: chat.ensemble?.secondInCommandParticipantId,
        bossmanAutoApprovals: chat.ensemble?.bossmanAutoApprovals
      },
      newParticipant.id,
      configuration.authority,
      desiredAutoApprovals
    )
    persist(next, authorityPatch)
    onSelectParticipant(newParticipant.id)
  }

  const removeParticipant = (id: string): void => {
    // Keep a live ensemble roster non-empty. The chip strip already
    // renders the trash button disabled at the floor; this guard is
    // the defense-in-depth for IPC-driven roster edits.
    if (isRoundRunning || participants.length <= MIN_ENSEMBLE_PARTICIPANTS) return
    const nextSelectedParticipantId = resolveParticipantSelectionAfterRemoval(
      participants,
      id,
      selectedParticipantId
    )
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
    if (isRoundRunning) return
    if (!targetId || sourceId === targetId) return
    const fromIdx = participants.findIndex((p) => p.id === sourceId)
    const toIdx = participants.findIndex((p) => p.id === targetId)
    if (fromIdx === -1 || toIdx === -1) return
    const next = [...participants]
    const [moved] = next.splice(fromIdx, 1)
    next.splice(toIdx, 0, moved)
    persist(next)
  }

  // 1.0.4-AK2 — Work Session status strip. Renders ABOVE the chip
  // strip when a Work Session exists in any non-idle state so the
  // user always knows the round is running autonomously vs.
  // interactively. The strip surfaces the objective, current
  // budget consumption, elapsed/remaining time, and a Stop action.
  // Below-budget hops + statuses fall through with muted styling.
  // Elapsed / remaining time computed from startedAt + maxDurationMs.
  // Cached on the render to avoid jitter; the parent re-renders
  // every 30s while the strip is visible (cheap interval).
  const workSessionTime = (() => {
    if (!workSession?.startedAt) return null
    const started = new Date(workSession.startedAt).getTime()
    if (!Number.isFinite(started)) return null
    // For an ended session, freeze elapsed at the actual run duration
    // (startedAt → endedAt) instead of letting it keep ticking up with
    // the live clock. Live sessions measure against `now`.
    const endedAt =
      !isWorkSessionLive && workSession.endedAt ? new Date(workSession.endedAt).getTime() : NaN
    const endpoint = Number.isFinite(endedAt) ? endedAt : workSessionNow
    const elapsedMs = Math.max(0, endpoint - started)
    const remainingMs = Math.max(0, (workSession.maxDurationMs || 0) - elapsedMs)
    return { elapsedMs, remainingMs }
  })()

  const formatDuration = (ms: number): string => {
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
    const minutes = Math.floor(ms / 60_000)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    const remMinutes = minutes % 60
    return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`
  }

  // Per-provider budget summary — picks the provider with the
  // highest usage so the strip shows the participant closest to
  // its cap. "Codex 8/38" reads more usefully than a sum.
  const workSessionBudget = (() => {
    if (!workSession) return null
    const entries = Object.entries(workSession.roundsUsed || {}).filter(
      ([, used]) => (used || 0) > 0
    )
    if (entries.length === 0) {
      return `0 / ${workSession.maxRoundsPerProvider}`
    }
    entries.sort((a, b) => (b[1] || 0) - (a[1] || 0))
    const [provider, used] = entries[0]
    return `${used} / ${workSession.maxRoundsPerProvider} (${provider})`
  })()

  const workSessionStatusLabel = (() => {
    switch (workSessionStatus) {
      case 'active':
        return '🎯 Working on'
      case 'paused':
        return '⏸ Paused'
      case 'completed':
        return '✓ Completed'
      case 'cancelled':
        return '✕ Stopped'
      case 'limit_reached':
        return '⏱ Limit reached'
      default:
        return '🎯 Work Session'
    }
  })()

  return (
    <div
      className={`ensemble-above-row${animateEntrance ? ' ensemble-above-row-entering' : ''}`}
      role="region"
      aria-label="Ensemble participants"
    >
      {showWorkSessionStrip && workSession && (
        <div
          className="work-session-strip"
          data-status={workSessionStatus}
          role="status"
          aria-live="polite"
        >
          <span className="work-session-strip-glyph" aria-hidden="true" />
          <span className="work-session-strip-objective" title={workSession.objective}>
            <strong>{workSessionStatusLabel}:</strong> {workSession.objective}
          </span>
          <span className="work-session-strip-meta">
            <span>Rounds {workSessionBudget}</span>
            {workSessionTime && (
              <span>
                {formatDuration(workSessionTime.elapsedMs)} elapsed
                {isWorkSessionLive && <> · {formatDuration(workSessionTime.remainingMs)} left</>}
              </span>
            )}
          </span>
          {workSessionStatus === 'active' || workSessionStatus === 'paused' ? (
            <span className="work-session-strip-actions">
              <button
                type="button"
                className="work-session-strip-action work-session-strip-action--stop"
                onClick={() => onStopWorkSession?.()}
                disabled={!onStopWorkSession}
                title="Stop the Work Session and cancel any queued continuations."
              >
                Stop
              </button>
            </span>
          ) : (
            workSession.endedReason && (
              <span className="work-session-strip-meta" title={workSession.endedReason}>
                <em>{workSession.endedReason}</em>
              </span>
            )
          )}
        </div>
      )}
      <div
        ref={chipsContainerRef}
        className={`ensemble-above-row-chips ${
          // Switch to the balanced-rows grid at 6+ participants (the
          // first count exceeding the 5-per-row ceiling) so the strip
          // never clips. Below the threshold we keep the centred
          // content-width flex layout — most ensembles live there.
          participants.length >= ENSEMBLE_CHIPS_WRAP_THRESHOLD ? 'is-wrapped' : ''
        } ${dragGhost ? 'is-chip-dragging' : ''}`}
        data-participant-count={participants.length}
      >
        {participants.map((participant, participantIndex) => {
          const state = activeRound?.participants.find(
            (item) => item.participantId === participant.id
          )
          const lane = latestLaneForParticipant(activeRound?.lanes, participant.id)
          const laneStatusLabel = lane ? laneStatusToParticipantLabel(lane.status) : null
          const active =
            activeRound?.activeParticipantId === participant.id ||
            lane?.status === 'running' ||
            lane?.status === 'awaiting-approval'
          const statusLabel = laneStatusLabel || (active ? 'speaking' : state?.status || 'idle')
          const isSelected = participant.id === selectedParticipantId
          // 1.0.4-AD — surface the pre-flight probe's failure reason
          // (or any subsequent failure reason stamped on the round
          // state) so the chip's status pill tooltip explains WHY a
          // participant is unreachable / failed without diving into
          // the transcript. Empty string when the round state has no
          // failure metadata so the chip falls back to the bare
          // status label.
          const statusTooltip =
            lane?.reason ||
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
              gridSpan={chipGridSpans?.[participantIndex]}
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
              isBossman={chat.ensemble?.bossmanParticipantId === participant.id}
              isSecondInCommand={
                chat.ensemble?.secondInCommandParticipantId === participant.id &&
                chat.ensemble?.bossmanParticipantId !== participant.id
              }
              hasLeadership={hasLeadership}
              autoApprovalsEnabled={chat.ensemble?.bossmanAutoApprovals?.enabled === true}
              onSetAuthority={setParticipantAuthority}
              onToggleBossmanAutoApprovals={setBossmanAutoApprovals}
              locked={isRoundRunning}
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
      </div>
      {/*
        1.0.5-EW2 — The "+ add participant" button lives OUTSIDE
        the chip strip / grid. Pre-EW2 the button was inside
        `.ensemble-above-row-chips`, which took a grid cell in the
        wrapped layout and forced an extra row at the previous participant
        cap
        (6 + 6 chips + 1 standalone "+" cell). Sibling placement
        + flex layout on the parent `.ensemble-above-row` pins
        the button to the right edge of the row at all counts,
        matching the existing `.ensemble-above-row-actions`
        right-justified pattern. At low counts (1-6) the button
        sits at the far-right while chips stay centred in their
        flex slot — same visual logic as Stop Ensemble + queued-
        prompt indicator.
      */}
      <EnsembleAddParticipantButton
        disabled={!canAddParticipant}
        title={
          isRoundRunning
            ? 'Participant changes are locked while a round is running.'
            : participants.length >= MAX_ENSEMBLE_PARTICIPANTS
              ? `Ensembles support up to ${MAX_ENSEMBLE_PARTICIPANTS} participants.`
              : 'Add another participant'
        }
        composerStyle={composerStyle}
        grokAvailable={grokAvailable}
        cursorAvailable={cursorAvailable}
        providerGroups={providerGroups}
        participants={participants}
        hasLeadership={hasLeadership}
        bossmanAutoApprovals={chat.ensemble?.bossmanAutoApprovals}
        initialProvider={
          participants.find((participant) => participant.id === selectedParticipantId)?.provider ||
          participants[participants.length - 1]?.provider ||
          'codex'
        }
        onAdd={addParticipant}
      />
      {dragGhost
        ? (() => {
            const ghostParticipant = participants.find(
              (participant) => participant.id === dragGhost.participantId
            )
            if (!ghostParticipant) return null
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
                  <span className="ensemble-above-chip-role">
                    <ProviderGlyph
                      provider={ghostParticipant.provider}
                      accentProvider={resolveProviderHueClass(
                        ghostParticipant.provider,
                        ghostParticipant.model
                      )}
                      className="ensemble-above-chip-provider-glyph"
                    />
                    {ghostParticipant.role || getProviderName(ghostParticipant.provider)}
                  </span>
                </div>
              </div>,
              document.body
            )
          })()
        : null}
      {/*
        1.0.5-EW22 — "-" remove-selected sibling button. Pairs with
        "+" on the right edge so the roster's add/remove controls
        live in one visual locus, freeing the popover from
        carrying a destructive row. Disabled when no chip is
        selected, when at the 1-participant floor, or when a round
        is running (matches `removeParticipant`'s own guards).
      */}
      <button
        type="button"
        className="ensemble-above-remove-participant"
        onClick={() => {
          if (selectedParticipantId) removeParticipant(selectedParticipantId)
        }}
        disabled={
          isRoundRunning ||
          !selectedParticipantId ||
          participants.length <= MIN_ENSEMBLE_PARTICIPANTS
        }
        title={
          isRoundRunning
            ? 'Participant changes are locked while a round is running.'
            : !selectedParticipantId
              ? 'Select a participant chip first.'
              : participants.length <= MIN_ENSEMBLE_PARTICIPANTS
                ? 'Ensembles need at least one participant.'
                : 'Remove the selected participant'
        }
        aria-label="Remove selected Ensemble participant"
      >
        −
      </button>
      <div className="ensemble-above-row-actions">
        {/* "Queued next round" label intentionally not rendered here —
            the queued-messages above-row (sibling in the composer
            above-bar stack) now surfaces ensemble `queuedPrompt`
            entries as a full row with Edit / Delete / Steer actions,
            so duplicating the bare label here would be noise. See
            `QueuedMessagesAboveRow.tsx` + the
            `queuedMessagesAboveRowEntries` builder in App.tsx for
            the ensemble-queued branch. */}
        {isRoundRunning && activeRound?.activeParticipantId && onSkipActive && (
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
            Skip reads
          </PillButton>
        )}
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
  bossmanAutoApprovals?: NonNullable<ChatRecord['ensemble']>['bossmanAutoApprovals']
  initialProvider: ProviderId
  onAdd: (configuration: EnsembleParticipantAddDraft) => void
}): React.JSX.Element {
  const availableProviderGroups = useMemo(
    () => resolveEnsembleAddProviderGroups(providerGroups, grokAvailable, cursorAvailable),
    [cursorAvailable, grokAvailable, providerGroups]
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
  const selectedGroup =
    availableProviderGroups.find((group) => group.provider === draft.provider) ||
    availableProviderGroups[0]
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
    draft.provider === 'kimi' ? (draft.thinkingEnabled ? 'on' : 'off') : draft.reasoningEffort || ''
  const fastModeEnabled =
    draft.provider === 'codex' ? draft.serviceTier === 'fast' : Boolean(draft.fastModeEnabled)

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        const nextDetails = createEnsembleParticipantAddDetails(
          resolvedInitialProvider,
          participants,
          bossmanAutoApprovals
        )
        setDraft(
          createEnsembleParticipantAddConfiguration(
            resolvedInitialProvider,
            undefined,
            availableProviderGroups
          )
        )
        setDetailsDraft(nextDetails)
        setRolePresetId(resolveRolePresetId(nextDetails.role))
      }
    },
    [availableProviderGroups, bossmanAutoApprovals, participants, resolvedInitialProvider]
  )
  const handleProviderModelSelection = useCallback(
    (provider: ProviderId, model: string) => {
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
  const handleReasoningSelection = useCallback((value: string) => {
    setDraft((current) =>
      current.provider === 'kimi'
        ? { ...current, thinkingEnabled: value !== 'off' }
        : { ...current, reasoningEffort: value }
    )
  }, [])
  const handleToggleFastMode = useCallback(() => {
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
      return { ...current, fastModeEnabled: !current.fastModeEnabled }
    })
  }, [availableProviderGroups])

  const patchDetails = useCallback((patch: Partial<EnsembleParticipantAddDetails>) => {
    setDetailsDraft((current) => ({ ...current, ...patch }))
  }, [])

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
      const confirmed = window.confirm(
        'Allow Boss/Captain Auto Approvals for this Ensemble? Boss remains primary; Captain can only use this consent when Boss is unavailable. Approvals stay one-shot and limited to the selected participant permission preset and workspace policy. This will not grant session/workspace approval, YOLO, policy changes, external-path escapes, or unclassified requests.'
      )
      if (!confirmed) return
      patchDetails({
        autoApprovalsEnabled: true,
        autoApprovalsConfirmedAt: new Date().toISOString()
      })
    },
    [detailsDraft.autoApprovalsConfirmedAt, patchDetails]
  )

  return (
    <CombinedModelPicker
      provider={draft.provider}
      composerStyle={composerStyle}
      modelOptions={selectedGroup?.modelOptions || selectedDefaults.modelOptions}
      selectedModelId={draft.model}
      onSelectModel={(model) => handleProviderModelSelection(draft.provider, model)}
      providerGroups={availableProviderGroups}
      onSelectProviderModel={handleProviderModelSelection}
      reasoningOptions={reasoningOptions}
      selectedReasoning={selectedReasoning}
      onSelectReasoning={handleReasoningSelection}
      codexReasoningEffort={draft.provider === 'codex' ? draft.reasoningEffort : undefined}
      claudeReasoningEffort={draft.provider === 'claude' ? draft.reasoningEffort : undefined}
      grokReasoningEffort={draft.provider === 'grok' ? draft.reasoningEffort : undefined}
      cursorReasoningEffort={draft.provider === 'cursor' ? draft.reasoningEffort : undefined}
      kimiThinkingEnabled={draft.provider === 'kimi' ? draft.thinkingEnabled : undefined}
      fastModeCapableModelIds={
        selectedGroup?.fastModeCapableModelIds || selectedDefaults.fastModeCapableModelIds
      }
      fastModeEnabled={fastModeEnabled}
      onToggleFastMode={
        draft.provider === 'codex' || draft.provider === 'claude' || draft.provider === 'cursor'
          ? handleToggleFastMode
          : undefined
      }
      disabled={disabled}
      repositionOnScroll
      topContent={
        <EnsembleAddParticipantFields
          provider={draft.provider}
          participants={participants}
          details={detailsDraft}
          rolePresetId={rolePresetId}
          hasLeadership={hasLeadership || detailsDraft.authority !== 'agent'}
          disabled={disabled}
          onDetailsChange={patchDetails}
          onRolePresetIdChange={setRolePresetId}
          onAutoApprovalsChange={handleAutoApprovalsChange}
        />
      }
      popoverClassName="is-ensemble-add-participant"
      dialogAriaLabel="Configure and add Ensemble participant"
      customTrigger={{
        className: 'ensemble-above-add-participant',
        content: '+',
        title,
        ariaLabel: 'Add Ensemble participant'
      }}
      confirmAction={{
        label: 'Add',
        onConfirm: () => onAdd({ ...draft, ...detailsDraft })
      }}
      onOpenChange={handleOpenChange}
    />
  )
}

export function EnsembleAddParticipantFields({
  provider,
  participants,
  details,
  rolePresetId,
  hasLeadership,
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
  hasLeadership: boolean
  autoApprovalsEnabled: boolean
  onSetAuthority: (
    participantId: string,
    authority: EnsembleParticipantAuthority
  ) => void
  onToggleBossmanAutoApprovals: (enabled: boolean) => void
  locked: boolean
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
  hasLeadership,
  autoApprovalsEnabled,
  onSetAuthority,
  onToggleBossmanAutoApprovals,
  locked,
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
  // 2026-07 chip polish — the actively-working participant's role
  // name glows in its provider hue (Ollama chips inherit the spoofed
  // upstream brand hue via `providerClass`, same as the role tint);
  // a failed/unreachable turn glows red instead. The round state
  // holding these statuses is replaced wholesale when the next round
  // starts, so the red glow naturally resets — the failure may be
  // fixed or irrelevant by the next turn.
  const normalizedStatus = statusLabel.toLowerCase()
  const isLiveGlow = !dimmed && (normalizedStatus === 'speaking' || normalizedStatus === 'running')
  const isFailedGlow = normalizedStatus === 'failed' || normalizedStatus === 'unreachable'
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
      const target = event.target as HTMLElement | null
      if (target?.closest('.ensemble-above-overflow')) return
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
      data-linked-session={participant.linkedProviderSessionId ? 'true' : undefined}
      onPointerDown={handlePointerDown}
      onPointerEnter={handleTooltipPointerEnter}
      onPointerLeave={dismissTooltip}
      className={`ensemble-above-chip provider-${providerClass} ${isSelected ? 'is-selected' : ''} ${dimmed ? 'is-dimmed' : ''} ${isDragOver ? 'is-drag-over' : ''} ${isDragging ? 'is-dragging' : ''} ${isLiveGlow ? 'is-live-glow' : ''} ${isFailedGlow ? 'is-failed-glow' : ''}`}
      style={gridSpan !== undefined ? { gridColumn: `span ${gridSpan}` } : undefined}
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
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onClick()
          }
        }}
      >
        {/*
          1.0.5-EW24 removed the old leading `<ProviderBadgeIcon>` as
          ambiguous. 2026-07 chip polish reinstates a leading provider
          mark — but as the shared `<ProviderGlyph>` (the hue-accurate
          mnemonic used by the transcript filter rail), sized to the
          role text. It replaces the identification job the removed
          token badge's colouring incidentally helped with, and
          `accentProvider` keeps Ollama-backed display brands on their
          spoofed upstream hue.
        */}
        <span className="ensemble-above-chip-role">
          <ParticipantLeadingRoleIcon
            stageRole={participant.stageRole}
            isBossman={isBossman}
            isSecondInCommand={isSecondInCommand}
          />
          <ProviderGlyph
            provider={participant.provider}
            accentProvider={providerClass}
            className="ensemble-above-chip-provider-glyph"
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
          hasLeadership={hasLeadership}
          autoApprovalsEnabled={autoApprovalsEnabled}
          onSetAuthority={onSetAuthority}
          onToggleBossmanAutoApprovals={onToggleBossmanAutoApprovals}
          locked={locked}
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
              : 'Assign a Boss or Captain before enabling Auto Approvals.'
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
            title: 'Assign as the thread\'s only Boss.',
            label: (
              <span className="ensemble-above-overflow-authority-label">
                <BossmanCrownIcon className="ensemble-above-overflow-crown" />
                Boss
              </span>
            )
          },
          {
            value: 'captain',
            title: 'Assign as the thread\'s only Captain.',
            label: (
              <span className="ensemble-above-overflow-authority-label">
                <CaptainHatIcon className="ensemble-above-overflow-captain-hat" />
                Captain
              </span>
            )
          },
          {
            value: 'agent',
            title: 'Use standard Agent authority.',
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
  locked: boolean
  onStageRoleChange: (stageRole: EnsembleParticipant['stageRole'] | undefined) => void
}

/** Shared four-way staged-dispatch selector for the participant popover. */
export function EnsembleParticipantStageControl({
  participantLabel,
  stageRole,
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
        options={ENSEMBLE_PARTICIPANT_STAGE_OPTIONS}
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
  hasLeadership,
  autoApprovalsEnabled,
  onSetAuthority,
  onToggleBossmanAutoApprovals,
  locked,
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
        {locked
          ? 'Participant membership is locked while a round is running.'
          : 'Model, provider, reasoning, fast mode, and permissions live in the composer pickers below — they apply to the chip selected here.'}
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

function nextRoleLabel(baseRole: string, participants: EnsembleParticipant[]): string {
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
