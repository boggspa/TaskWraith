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
import {
  CombinedModelPicker,
  type CombinedModelPickerModelOption,
  type CombinedModelPickerProviderGroup
} from './CombinedModelPicker'
import { CombinedPermissionsPicker, type PermissionOption } from './CombinedPermissionsPicker'
import { resolveProviderRows } from './ComposerProviderPicker'
import type { ConfiguredProviderSnapshot } from '../hooks/useConfiguredProviderSnapshot'
import { isCursorGrok45ModelId } from '../../../shared/grok45Models'
import { supportsTaskWraithToolGrants } from '../../../shared/providerToolGrantSupport'

// Lossless permission options: the values ARE the PermissionPresetId, so
// full_access + custom survive a round-trip (unlike the composer's 3-mode
// collapse, which is fine for ephemeral live edits but not persisted data).
export const PERMISSION_PRESET_OPTIONS: PermissionOption[] = [
  { value: 'read_only', label: READ_ONLY_RECON_LABEL },
  { value: 'default', label: 'Default approval' },
  { value: 'workspace_write', label: WORKSPACE_WRITE_LABEL }
]

/**
 * Build one lossless provider+model patch for the roster and Agent Pool.
 *
 * A cross-provider choice starts from the canonical provider-change patch so
 * runtime profiles, linked sessions, permission presets, and tool-grant
 * overrides cannot leak across providers. A same-provider model choice leaves
 * those fields absent from the patch, preserving the row's existing runtime
 * and permission configuration. In both cases reasoning and Fast are then
 * normalized against the selected model before the caller shallow-merges the
 * patch into the participant.
 */
export function buildParticipantProviderModelPatch(
  participant: EnsembleParticipant,
  provider: ProviderId,
  model: string
): Partial<EnsembleParticipant> {
  const providerChanged = provider !== participant.provider
  if (providerChanged) {
    return buildProviderModelChangeParticipantPatch(provider, model)
  }
  const defaults = getEnsembleModelDefaults(provider)
  const patch: Partial<EnsembleParticipant> = {
    provider,
    model
  }

  if (provider !== 'kimi') {
    const enabledReasoning = getEnsembleReasoningOptions(provider, model).filter(
      (option) => !option.disabled
    )
    const enabledReasoningValues = new Set(enabledReasoning.map((option) => option.value))
    const seededReasoning = participant.reasoningEffort
    patch.reasoningEffort =
      enabledReasoning.length === 0
        ? undefined
        : seededReasoning && enabledReasoningValues.has(seededReasoning)
          ? seededReasoning
          : enabledReasoningValues.has(defaults.defaultReasoning)
            ? defaults.defaultReasoning
            : enabledReasoning[0]?.value
  }

  if (provider === 'codex') {
    const seededFast =
      participant.serviceTier === 'fast' ||
      (participant.serviceTier == null && participant.fastModeEnabled === true)
    const nextFast = defaults.fastModeCapableModelIds.has(model) && seededFast
    patch.fastModeEnabled = nextFast
    patch.serviceTier = nextFast ? 'fast' : ''
  } else if (provider === 'claude') {
    const seededFast = participant.fastModeEnabled === true
    patch.fastModeEnabled = defaults.fastModeCapableModelIds.has(model) && seededFast
  } else if (provider === 'kimi') {
    const seededFast = participant.fastModeEnabled === true
    const nextFast = defaults.fastModeCapableModelIds.has(model) && seededFast
    patch.fastModeEnabled = nextFast
    patch.serviceTier = nextFast ? 'fast' : 'standard'
  } else if (provider === 'cursor') {
    const seededFast = participant.fastModeEnabled === true
    patch.fastModeEnabled =
      model === 'composer-2.5-fast'
        ? true
        : model === 'composer-2.5'
          ? false
          : defaults.fastModeCapableModelIds.has(model) && seededFast
  }

  return patch
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
  currentProvider: ProviderId
): CombinedModelPickerProviderGroup[] {
  return resolveProviderRows(grokAvailable, cursorAvailable, undefined, {
    snapshot: configuredProviderSnapshot,
    pendingFallbackProvider: currentProvider
  }).map((row) => {
    const providerDefaults = getEnsembleModelDefaults(row.id)
    const modelOptions: CombinedModelPickerModelOption[] =
      row.id === 'antigravity'
        ? (configuredProviderSnapshot.modelsByProvider?.antigravity || []).map((model) => ({
            id: model.id,
            label: model.label
          }))
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
  const modelOptions: CombinedModelPickerModelOption[] =
    participant.provider === 'antigravity'
      ? (configuredProviderSnapshot.modelsByProvider?.antigravity || []).map((model) => ({
          id: model.id,
          label: model.label
        }))
      : defaults.modelOptions
  const providerGroups = buildParticipantPickerProviderGroups(
    grokAvailable,
    cursorAvailable,
    configuredProviderSnapshot,
    participant.provider
  )
  // Display the participant's model, mapping the agnostic 'cli-default' seed to
  // the provider's preferred id so the chip reads cleanly. The stored value is
  // untouched until the user actually picks a model.
  const selectedModelId =
    participant.model && participant.model !== 'cli-default'
      ? participant.model
      : modelOptions[0]?.id || defaults.defaultModelId

  const onSelectProviderModel = (provider: ProviderId, model: string): void => {
    onPatch(buildParticipantProviderModelPatch(participant, provider, model))
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
        : participant.provider === 'kimi'
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
        grantServices={
          supportsTaskWraithToolGrants(participant.provider) ? WORKSPACE_POLICY_SERVICES : []
        }
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
