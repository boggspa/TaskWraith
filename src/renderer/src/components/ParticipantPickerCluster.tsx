import type { JSX } from 'react'
import type {
  AgenticServicesSettings,
  ComposerStyle,
  EnsembleParticipant,
  PermissionPresetId,
  ProviderId
} from '../../../main/store/types'
import {
  buildProviderModelChangeParticipantPatch,
  buildSameProviderModelChangeParticipantPatch,
  buildKimiReasoningPickerPatch,
  getEnsembleModelDefaults,
  getEnsembleReasoningOptions,
  resolveKimiReasoningPickerSelection,
  resolveEnsembleParticipantSettings
} from '../lib/ensembleProviderDefaults'
import {
  READ_ONLY_RECON_LABEL,
  TRUSTED_SESSION_LABEL,
  WORKSPACE_WRITE_LABEL
} from '../lib/planModeLabels'
import {
  CombinedModelPicker,
  type CombinedModelPickerModelOption,
  type CombinedModelPickerProviderGroup
} from './CombinedModelPicker'
import { CombinedPermissionsPicker, type PermissionOption } from './CombinedPermissionsPicker'
import { resolveProviderRows } from './ComposerProviderPicker'
import type { ConfiguredProviderSnapshot } from '../hooks/useConfiguredProviderSnapshot'
import { isCursorGrokModelId } from '../../../shared/grok45Models'
import {
  FAST_MODEL_IDS,
  antigravityEffortForModelId,
  antigravityVariantGroupForModel,
  groupAntigravityModelRows
} from '../../../shared/antigravityAgyModelGrouping'

// Lossless permission options: the values ARE the PermissionPresetId, so
// full_access + custom survive a round-trip (unlike the composer's 3-mode
// collapse, which is fine for ephemeral live edits but not persisted data).
export const PERMISSION_PRESET_OPTIONS: PermissionOption[] = [
  { value: 'read_only', label: READ_ONLY_RECON_LABEL },
  { value: 'default', label: 'Accept Edits' },
  { value: 'workspace_write', label: WORKSPACE_WRITE_LABEL }
]

/**
 * Build one lossless provider+model patch for the roster and Agent Pool.
 *
 * A cross-provider choice starts from the canonical provider-change patch so
 * runtime profiles and linked sessions cannot leak across providers, while
 * permission preset/grants, reasoning (closest ladder), and Fast carry from
 * the previous seat when still applicable. A same-provider model choice leaves
 * permission/runtime fields absent from the patch and normalizes only
 * model/reasoning/Fast against the selected model.
 */
export function buildParticipantProviderModelPatch(
  participant: EnsembleParticipant,
  provider: ProviderId,
  model: string
): Partial<EnsembleParticipant> {
  if (provider !== participant.provider) {
    return buildProviderModelChangeParticipantPatch(provider, model, undefined, participant)
  }
  return buildSameProviderModelChangeParticipantPatch(participant, model)
}

/** Build the lossless participant patch for one reasoning-ladder selection.
 * AntiGravity carries real effort in its concrete model id, so UltraTask maps
 * the family to High and keeps the synthetic marker alongside it. */
export function buildParticipantReasoningSelectionPatch(
  participant: EnsembleParticipant,
  selectedModelId: string,
  value: string,
  antigravityModels: ReadonlyArray<{ id: string; label?: string }> = []
): Partial<EnsembleParticipant> {
  if (participant.provider === 'antigravity') {
    const variantGroup = antigravityVariantGroupForModel(
      antigravityModels,
      selectedModelId
    )
    const targetEffort = value === 'ultraTask' ? 'high' : value
    const target = variantGroup?.variants.find((variant) => variant.effort === targetEffort)
    if (value === 'ultraTask') {
      return {
        ...(target && target.id !== selectedModelId
          ? buildParticipantProviderModelPatch(participant, 'antigravity', target.id)
          : {}),
        reasoningEffort: 'ultraTask'
      }
    }
    if (target && target.id !== selectedModelId) {
      return {
        ...buildParticipantProviderModelPatch(participant, 'antigravity', target.id),
        reasoningEffort: ''
      }
    }
    return participant.reasoningEffort === 'ultraTask' ? { reasoningEffort: '' } : {}
  }
  if (participant.provider === 'kimi') {
    return buildKimiReasoningPickerPatch(selectedModelId, value)
  }
  return { reasoningEffort: value }
}

interface ParticipantPickerClusterProps {
  participant: EnsembleParticipant
  configuredProviderSnapshot?: ConfiguredProviderSnapshot
  composerStyle: ComposerStyle
  agenticServices?: AgenticServicesSettings
  grokAvailable: boolean
  cursorAvailable: boolean
  showApplyToAll?: boolean
  /** Patch the participant. The caller binds the participant id; structural
   *  edits (model/provider/permissions) persist immediately. */
  onPatch: (patch: Partial<EnsembleParticipant>) => void
  onApplyPermissionsToAll?: (source: EnsembleParticipant) => void
}

export function buildParticipantPickerProviderGroups(
  grokAvailable: boolean,
  cursorAvailable: boolean,
  configuredProviderSnapshot: ConfiguredProviderSnapshot,
  currentProvider: ProviderId,
  selectedModelId?: string
): CombinedModelPickerProviderGroup[] {
  return resolveProviderRows(grokAvailable, cursorAvailable, undefined, {
    snapshot: configuredProviderSnapshot,
    pendingFallbackProvider: currentProvider
  }).map((row) => {
    const providerDefaults = getEnsembleModelDefaults(row.id)
    const modelOptions: CombinedModelPickerModelOption[] =
      row.id === 'antigravity'
        ? groupAntigravityModelRows(
            configuredProviderSnapshot.modelsByProvider?.antigravity || [],
            row.id === currentProvider ? selectedModelId : undefined
          )
        : providerDefaults.modelOptions
    return {
      provider: row.id,
      label: row.label,
      modelOptions,
      fastModeCapableModelIds: providerDefaults.fastModeCapableModelIds,
      ...(row.pauseLabel ? { pauseLabel: row.pauseLabel } : {}),
      ...(row.rerouteLabel ? { rerouteLabel: row.rerouteLabel } : {})
    }
  })
}

/**
 * The provider/model/reasoning/Fast + permissions picker pair shared by the
 * Settings → Roster participant row AND the Agent-Pool editor. Extracted so the
 * non-trivial provider→model→reasoning→fast-mode interplay lives in ONE place
 * and can't drift between the two surfaces. Renders exactly the two pickers;
 * the caller supplies the surrounding row chrome (enable / boss / remove) and
 * the role / brief text fields, which have surface-specific commit semantics.
 */
export function ParticipantPickerCluster({
  participant,
  configuredProviderSnapshot = { ready: false, providerIds: [] },
  composerStyle,
  grokAvailable,
  cursorAvailable,
  showApplyToAll = false,
  onPatch,
  onApplyPermissionsToAll
}: ParticipantPickerClusterProps): JSX.Element {
  const resolved = resolveEnsembleParticipantSettings(participant)
  const defaults = getEnsembleModelDefaults(participant.provider)
  const antigravityModels = configuredProviderSnapshot.modelsByProvider?.antigravity || []
  const modelOptions: CombinedModelPickerModelOption[] =
    participant.provider === 'antigravity'
      ? groupAntigravityModelRows(antigravityModels, participant.model)
      : defaults.modelOptions
  // Display the participant's model, mapping the agnostic 'cli-default' seed to
  // the provider's preferred id so the chip reads cleanly. The stored value is
  // untouched until the user actually picks a model.
  const selectedModelId =
    participant.model && participant.model !== 'cli-default'
      ? participant.model
      : modelOptions[0]?.id || defaults.defaultModelId
  const providerGroups = buildParticipantPickerProviderGroups(
    grokAvailable,
    cursorAvailable,
    configuredProviderSnapshot,
    participant.provider,
    selectedModelId
  )

  const onSelectProviderModel = (provider: ProviderId, model: string): void => {
    onPatch(buildParticipantProviderModelPatch(participant, provider, model))
  }

  const antigravityVariantGroup =
    participant.provider === 'antigravity'
      ? antigravityVariantGroupForModel(antigravityModels, selectedModelId)
      : null
  const selectedReasoning =
    participant.provider === 'antigravity'
      ? resolved.reasoningEffort === 'ultraTask'
        ? 'ultraTask'
        : (antigravityEffortForModelId(selectedModelId) ?? '')
      : participant.provider === 'kimi'
        ? resolveKimiReasoningPickerSelection(selectedModelId, resolved.reasoningEffort)
        : resolved.reasoningEffort
  const selectedModelOption = modelOptions.find((option) => option.id === selectedModelId)
  const baseReasoningOptions =
    participant.provider === 'antigravity'
      ? (antigravityVariantGroup?.variants.map((variant) => ({
          value: variant.effort,
          label: variant.effort.charAt(0).toUpperCase() + variant.effort.slice(1)
        })) ?? [])
      : getEnsembleReasoningOptions(
          participant.provider,
          selectedModelId,
          selectedModelOption
        )
  const reasoningOptions = [...baseReasoningOptions]
  if (selectedModelOption?.ultraTaskSupported === true) {
    if (reasoningOptions.length === 0) {
      reasoningOptions.push({ value: 'off', label: 'Off' })
    }
    reasoningOptions.push({ value: 'ultraTask', label: 'UltraTask' })
  }
  const onSelectReasoning = (value: string): void => {
    onPatch(
      buildParticipantReasoningSelectionPatch(
        participant,
        selectedModelId,
        value,
        antigravityModels
      )
    )
  }

  const fastModeEnabled =
    participant.provider === 'codex'
      ? resolved.serviceTier === 'fast'
      : participant.provider === 'claude'
        ? resolved.fastModeEnabled
        : participant.provider === 'kimi'
          ? resolved.fastModeEnabled
          : participant.provider === 'cursor'
            ? selectedModelId === 'composer-2.5-fast' || resolved.fastModeEnabled
            : participant.provider === 'grok'
              ? true
              : participant.provider === 'antigravity'
                ? FAST_MODEL_IDS.has(selectedModelId)
                : false
  const onToggleFastMode =
    participant.provider === 'codex'
      ? (): void => {
          const nextTier = resolved.serviceTier === 'fast' ? '' : 'fast'
          onPatch({ serviceTier: nextTier, fastModeEnabled: nextTier === 'fast' })
        }
      : participant.provider === 'claude'
        ? (): void => onPatch({ fastModeEnabled: !resolved.fastModeEnabled })
        : participant.provider === 'kimi'
          ? (): void => {
              const nextFast = !resolved.fastModeEnabled
              onPatch({
                fastModeEnabled: nextFast,
                serviceTier: nextFast ? 'fast' : 'standard'
              })
            }
          : participant.provider === 'cursor'
            ? (): void => {
                if (selectedModelId === 'composer-2.5' || selectedModelId === 'composer-2.5-fast') {
                  onPatch({
                    model:
                      selectedModelId === 'composer-2.5-fast'
                        ? 'composer-2.5'
                        : 'composer-2.5-fast',
                    fastModeEnabled: selectedModelId !== 'composer-2.5-fast'
                  })
                  return
                }
                if (!isCursorGrokModelId(selectedModelId)) return
                onPatch({ fastModeEnabled: !resolved.fastModeEnabled })
              }
            : undefined

  const permissionOptions: PermissionOption[] = [
    ...PERMISSION_PRESET_OPTIONS,
    ...(resolved.permissionPresetId === 'full_access'
      ? [
          {
            value: 'full_access',
            label: TRUSTED_SESSION_LABEL,
            description: 'Active for this participant only; lower the permission to revoke.',
            danger: true
          }
        ]
      : []),
    ...(resolved.permissionPresetId === 'custom' ? [{ value: 'custom', label: 'Custom' }] : [])
  ]
  return (
    <>
      <CombinedModelPicker
        provider={participant.provider}
        composerStyle={composerStyle}
        modelOptions={modelOptions}
        selectedModelId={selectedModelId}
        onSelectModel={(model) => onSelectProviderModel(participant.provider, model)}
        providerGroups={providerGroups}
        onSelectProviderModel={onSelectProviderModel}
        reasoningOptions={reasoningOptions}
        selectedReasoning={selectedReasoning}
        onSelectReasoning={onSelectReasoning}
        codexReasoningEffort={participant.provider === 'codex' ? resolved.reasoningEffort : undefined}
        claudeReasoningEffort={
          participant.provider === 'claude' ? resolved.reasoningEffort : undefined
        }
        grokReasoningEffort={participant.provider === 'grok' ? resolved.reasoningEffort : undefined}
        cursorReasoningEffort={
          participant.provider === 'cursor' ? resolved.reasoningEffort : undefined
        }
        kimiThinkingEnabled={participant.provider === 'kimi' ? resolved.thinkingEnabled : undefined}
        kimiReasoningEffort={participant.provider === 'kimi' ? resolved.reasoningEffort : undefined}
        fastModeCapableModelIds={defaults.fastModeCapableModelIds}
        fastModeEnabled={fastModeEnabled}
        onToggleFastMode={onToggleFastMode}
        repositionOnScroll
      />
      <CombinedPermissionsPicker
        provider={participant.provider}
        composerStyle={composerStyle}
        permissionOptions={permissionOptions}
        selectedPermission={resolved.permissionPresetId}
        onSelectPermission={(value) =>
          value === 'full_access'
            ? undefined
            : onPatch({ permissionPresetId: value as PermissionPresetId })
        }
        onApplyToAllParticipants={
          showApplyToAll && onApplyPermissionsToAll
            ? () => onApplyPermissionsToAll(participant)
            : undefined
        }
        repositionOnScroll
      />
    </>
  )
}
