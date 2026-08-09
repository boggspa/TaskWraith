import type { ReactElement } from 'react'
import type { AgenticServicesSettings } from '../../../main/store/types'
import {
  applyPolicyPostureOverride,
  type PolicyPostureRow,
  type PolicyPostureValue
} from '../lib/policyPosture'
import {
  RiskAcknowledgementSheet,
  RiskAcknowledgementSheetSurface
} from './RiskAcknowledgementSheet'

interface PolicyPostureSettingsProps {
  agenticServices: AgenticServicesSettings
  rows: readonly PolicyPostureRow[]
  overrideUnlocked: boolean
  managedLocked: boolean
  onChange: (next: AgenticServicesSettings) => void
}

export function PolicyPostureSettings({
  agenticServices,
  rows,
  overrideUnlocked,
  managedLocked,
  onChange
}: PolicyPostureSettingsProps): ReactElement {
  const editable = overrideUnlocked && !managedLocked

  return (
    <div className="settings-safety-policy-list">
      {rows.map((row) => (
        <article key={row.id} className={`settings-safety-policy-row tone-${row.tone}`}>
          <div className="settings-safety-policy-main">
            <strong>{row.label}</strong>
            <p>{row.description}</p>
          </div>
          <div className="settings-safety-policy-meta">
            <span className="settings-scope-pill">{row.scope}</span>
            {editable ? (
              <select
                className="settings-select"
                aria-label={`${row.label} policy`}
                value={row.value}
                onChange={(event) =>
                  onChange(
                    applyPolicyPostureOverride(
                      agenticServices,
                      row.policyKey,
                      event.target.value as PolicyPostureValue
                    )
                  )
                }
              >
                {row.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <span className="settings-risk-pill">{row.display}</span>
            )}
            <span
              className="settings-scope-pill"
              data-policy-origin={row.isSuggested ? 'suggested' : 'override'}
            >
              {row.isSuggested ? 'Suggested' : 'Override'}
            </span>
          </div>
        </article>
      ))}
    </div>
  )
}

export const POLICY_POSTURE_OVERRIDE_ACKNOWLEDGEMENT_ID = 'policy-posture-override-ack'
const POLICY_POSTURE_OVERRIDE_TITLE_ID = 'policy-posture-override-title'

interface PolicyPostureOverrideSheetProps {
  onCancel: () => void
  onConfirm: () => void
}

function policyPostureOverrideSheetProps({ onCancel, onConfirm }: PolicyPostureOverrideSheetProps) {
  return {
    titleId: POLICY_POSTURE_OVERRIDE_TITLE_ID,
    eyebrow: 'Policy override',
    title: 'Open the policy override hatch?',
    description: (
      <>
        These global policies apply across providers and workspaces. Choosing{' '}
        <strong>Always allow</strong> can let agents use a service without an individual approval
        prompt; choosing <strong>Block</strong> can prevent permission postures from using it.
      </>
    ),
    caution:
      'Permission-posture boundaries, external-path checks, per-call-only prompts, non-grantable services, and organization-managed policy still apply.',
    acknowledgementId: POLICY_POSTURE_OVERRIDE_ACKNOWLEDGEMENT_ID,
    acknowledgementLabel:
      'I understand that policy overrides can bypass some TaskWraith approval prompts across every workspace.',
    onCancel,
    onConfirm,
    cancelTitle: 'Keep the suggested policy defaults protected.',
    confirmLabel: 'Open override hatch',
    confirmTitle: 'Unlock policy controls for this Settings session.',
    riskLevel: 'high' as const
  }
}

export function PolicyPostureOverrideSheetSurface({
  acknowledged,
  onAcknowledgedChange,
  onCancel,
  onConfirm
}: PolicyPostureOverrideSheetProps & {
  acknowledged: boolean
  onAcknowledgedChange: (next: boolean) => void
}): ReactElement {
  return (
    <RiskAcknowledgementSheetSurface
      {...policyPostureOverrideSheetProps({ onCancel, onConfirm })}
      acknowledged={acknowledged}
      onAcknowledgedChange={onAcknowledgedChange}
    />
  )
}

export function PolicyPostureOverrideSheet({
  onCancel,
  onConfirm
}: PolicyPostureOverrideSheetProps): ReactElement {
  return <RiskAcknowledgementSheet {...policyPostureOverrideSheetProps({ onCancel, onConfirm })} />
}
