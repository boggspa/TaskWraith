import type { JSX } from 'react'
import type {
  AgenticServicesSettings,
  ComposerStyle,
  EnsembleParticipant,
  PermissionPresetId,
  ProviderId
} from '../../../main/store/types'
import {
  buildProviderChangeParticipantPatch,
  getEnsembleModelDefaults,
  getEnsembleReasoningOptions,
  resolveEnsembleParticipantSettings
} from '../lib/ensembleProviderDefaults'
import {
  buildParticipantToolGrantPatch,
  getParticipantToolGrantIds
} from '../lib/ensembleParticipantToolGrants'
import {
  READ_ONLY_RECON_LABEL,
  TRUSTED_SESSION_LABEL,
  WORKSPACE_WRITE_LABEL
} from '../lib/planModeLabels'
import { WORKSPACE_POLICY_SERVICES } from '../lib/workspacePolicyServices'
import { CombinedModelPicker, type CombinedModelPickerModelOption } from './CombinedModelPicker'
import { CombinedPermissionsPicker, type PermissionOption } from './CombinedPermissionsPicker'
import { ComposerProviderPicker } from './ComposerProviderPicker'
import { isCursorGrok45ModelId } from '../../../shared/grok45Models'

// Lossless permission options: the values ARE the PermissionPresetId, so
// full_access + custom survive a round-trip (unlike the composer's 3-mode
// collapse, which is fine for ephemeral live edits but not persisted data).
export const PERMISSION_PRESET_OPTIONS: PermissionOption[] = [
  { value: 'read_only', label: READ_ONLY_RECON_LABEL },
  { value: 'default', label: 'Default approval' },
  { value: 'workspace_write', label: WORKSPACE_WRITE_LABEL }
]

interface ParticipantPickerClusterProps {
  participant: EnsembleParticipant
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

/**
 * The provider + model/reasoning + permissions picker trio shared by the
 * Settings → Roster participant row AND the Agent-Pool editor. Extracted so the
 * non-trivial provider→model→reasoning→fast-mode interplay lives in ONE place
 * and can't drift between the two surfaces. Renders exactly the three pickers;
 * the caller supplies the surrounding row chrome (enable / boss / remove) and
 * the role / brief text fields, which have surface-specific commit semantics.
 */
export function ParticipantPickerCluster({
  participant,
  composerStyle,
  agenticServices,
  grokAvailable,
  cursorAvailable,
  showApplyToAll = false,
  onPatch,
  onApplyPermissionsToAll
}: ParticipantPickerClusterProps): JSX.Element {
  const resolved = resolveEnsembleParticipantSettings(participant)
  const defaults = getEnsembleModelDefaults(participant.provider)
  // Callers always supply agenticServices; the empty-object fallback only guards
  // a hypothetical caller that doesn't (the grants column reads it for
  // sub-labels). Avoids a runtime crash without coupling a literal default to
  // the churning AgenticServicesSettings shape.
  const services = agenticServices ?? ({} as AgenticServicesSettings)
  const modelOptions: CombinedModelPickerModelOption[] = defaults.modelOptions
  // Display the participant's model, mapping the agnostic 'cli-default' seed to
  // the provider's preferred id so the chip reads cleanly. The stored value is
  // untouched until the user actually picks a model.
  const selectedModelId =
    participant.model && participant.model !== 'cli-default'
      ? participant.model
      : defaults.defaultModelId

  const onSelectModel = (nextModel: string): void => {
    const patch: Partial<EnsembleParticipant> = { model: nextModel }
    if (
      participant.provider === 'claude' ||
      participant.provider === 'cursor' ||
      participant.provider === 'grok'
    ) {
      const nextReasoningOptions = getEnsembleReasoningOptions(participant.provider, nextModel)
      const enabledReasoningOptions = nextReasoningOptions.filter((option) => !option.disabled)
      const nextReasoningValues = new Set(enabledReasoningOptions.map((option) => option.value))
      patch.reasoningEffort =
        enabledReasoningOptions.length === 0
          ? undefined
          : nextReasoningValues.has(defaults.defaultReasoning)
            ? defaults.defaultReasoning
            : enabledReasoningOptions[0]?.value
    }
    // Drop fast mode when the new model can't support it (mirrors composer).
    if (
      (participant.provider === 'codex' ||
        participant.provider === 'claude' ||
        participant.provider === 'cursor') &&
      !defaults.fastModeCapableModelIds.has(nextModel)
    ) {
      patch.fastModeEnabled = false
      if (participant.provider === 'codex') patch.serviceTier = ''
    }
    onPatch(patch)
  }

  const selectedReasoning =
    participant.provider === 'kimi'
      ? resolved.thinkingEnabled
        ? 'on'
        : 'off'
      : resolved.reasoningEffort
  const reasoningOptions = getEnsembleReasoningOptions(participant.provider, selectedModelId)
  const onSelectReasoning = (value: string): void => {
    if (participant.provider === 'kimi') {
      onPatch({ thinkingEnabled: value !== 'off' })
    } else {
      onPatch({ reasoningEffort: value })
    }
  }

  const fastModeEnabled =
    participant.provider === 'codex'
      ? resolved.serviceTier === 'fast'
      : participant.provider === 'claude'
        ? resolved.fastModeEnabled
        : participant.provider === 'cursor'
          ? selectedModelId === 'composer-2.5-fast' || resolved.fastModeEnabled
          : false
  const onToggleFastMode =
    participant.provider === 'codex'
      ? (): void => {
          const nextTier = resolved.serviceTier === 'fast' ? '' : 'fast'
          onPatch({ serviceTier: nextTier, fastModeEnabled: nextTier === 'fast' })
        }
      : participant.provider === 'claude'
        ? (): void => onPatch({ fastModeEnabled: !resolved.fastModeEnabled })
        : participant.provider === 'cursor'
          ? (): void => {
              if (selectedModelId === 'composer-2.5' || selectedModelId === 'composer-2.5-fast') {
                onPatch({
                  model: selectedModelId === 'composer-2.5-fast' ? 'composer-2.5' : 'composer-2.5-fast',
                  fastModeEnabled: selectedModelId !== 'composer-2.5-fast'
                })
                return
              }
              if (!isCursorGrok45ModelId(selectedModelId)) return
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
  const enabledGrantIds = getParticipantToolGrantIds(participant)

  return (
    <>
      <ComposerProviderPicker
        provider={participant.provider}
        composerStyle={composerStyle}
        grokAvailable={grokAvailable}
        cursorAvailable={cursorAvailable}
        onSelect={(next: ProviderId) => onPatch(buildProviderChangeParticipantPatch(next))}
        activeModelId={selectedModelId}
        title="Participant provider"
        repositionOnScroll
      />
      <CombinedModelPicker
        provider={participant.provider}
        composerStyle={composerStyle}
        modelOptions={modelOptions}
        selectedModelId={selectedModelId}
        onSelectModel={onSelectModel}
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
        grantServices={WORKSPACE_POLICY_SERVICES}
        enabledGrantIds={enabledGrantIds}
        agenticServices={services}
        onToggleGrant={(service, enabled) =>
          onPatch(buildParticipantToolGrantPatch(participant, service, enabled))
        }
        grantScopeLabel="participant"
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
