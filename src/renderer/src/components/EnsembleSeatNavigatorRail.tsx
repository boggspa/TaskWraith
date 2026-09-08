/*
 * EnsembleSeatNavigatorRail — horizontal seat tabs for the composer's
 * CombinedModelPicker / CombinedPermissionsPicker popovers (bottomContent).
 *
 * The Ensemble add-participant picker already has a bottom rail (the
 * Duplicate row) for seeding a new seat from an existing one. This rail is
 * its navigation sibling for the two per-seat pickers: selecting a tab
 * retargets the composer's ACTIVE participant chip (the same
 * onSelectParticipant the above-row chips call), so the open picker rebinds
 * to that seat in place — no close → click another chip → reopen loop when
 * sweeping model or permission changes across a roster.
 *
 * Behaviour notes, deliberately mirroring the above-row chips:
 *   - Disabled seats render dimmed but stay selectable (their config is
 *     still editable; the roster popover can re-enable them).
 *   - Selecting the already-active seat is a no-op — the rail navigates,
 *     it never deselects (the composer would only fall back to the first
 *     enabled seat anyway; see effectiveSelectedParticipantId in App).
 *   - Buttons are plain aria-pressed toggles, not a role="tablist": both
 *     host popovers own arrow-key navigation at the document level, so
 *     tablist arrow semantics could not be honoured here.
 */
import type { EnsembleParticipant } from '../../../main/store/types'
import { resolveProviderHueClass } from '../lib/ollamaDisplayBrand'
import { humaniseModelId } from '../lib/modelDisplayName'
import { getProviderName } from './Sidebar'
import { ProviderBrandLogoIcon } from './icons/ProviderBrandLogo'

export function EnsembleSeatNavigatorRail({
  participants,
  selectedParticipantId,
  onSelectParticipant
}: {
  participants: readonly EnsembleParticipant[]
  selectedParticipantId: string | null
  onSelectParticipant: (participantId: string) => void
}): React.JSX.Element {
  return (
    <div className="ensemble-seat-navigator-rail">
      <span className="ensemble-seat-navigator-label">Seats</span>
      <div
        className="ensemble-seat-navigator-list"
        aria-label="Switch which participant this picker configures"
      >
        {participants.map((participant) => {
          const role = participant.role || getProviderName(participant.provider)
          const model = participant.model
            ? humaniseModelId(participant.provider, participant.model)
            : getProviderName(participant.provider)
          const selected = participant.id === selectedParticipantId
          const providerHue = resolveProviderHueClass(participant.provider, participant.model)
          return (
            <button
              key={participant.id}
              type="button"
              className={`ensemble-seat-navigator-chip${selected ? ' is-selected' : ''}${
                participant.enabled ? '' : ' is-disabled-seat'
              }`}
              data-participant-id={participant.id}
              data-provider={participant.provider}
              style={
                {
                  '--seat-navigator-accent': `var(--provider-${providerHue}-color, var(--accent))`
                } as React.CSSProperties
              }
              aria-pressed={selected}
              aria-label={`Configure ${role}`}
              title={
                selected
                  ? `${role} is the selected participant.`
                  : `Select ${role} and retarget this picker to its configuration.`
              }
              onClick={() => {
                if (!selected) onSelectParticipant(participant.id)
              }}
            >
              <ProviderBrandLogoIcon
                provider={participant.provider}
                accentProvider={providerHue}
                wrapperClassName="ensemble-seat-navigator-provider"
              />
              <span className="ensemble-seat-navigator-role">{role}</span>
              <span className="ensemble-seat-navigator-model">{model}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
