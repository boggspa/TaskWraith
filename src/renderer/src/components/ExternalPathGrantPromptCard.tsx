import type { ProviderId } from '../../../main/store/types'
import { getProviderLabel } from '../lib/providerLabels'
import type { ExternalPathGrantGap } from '../lib/externalPathGrantPreflight'
import { PillButton } from './PillButton'

export interface ExternalPathGrantPromptCardProps {
  gaps: ExternalPathGrantGap[]
  trigger: 'preflight' | 'attach'
  onGrant: () => void
  onDismiss: () => void
  busy?: boolean
}

function formatMissingProviders(providers: ProviderId[]): string {
  return providers.map((provider) => getProviderLabel(provider)).join(', ')
}

export function ExternalPathGrantPromptCard({
  gaps,
  trigger,
  onGrant,
  onDismiss,
  busy = false
}: ExternalPathGrantPromptCardProps): React.JSX.Element | null {
  if (gaps.length === 0) return null

  const title =
    trigger === 'attach'
      ? 'Attach additional workspace'
      : 'Additional workspace access required'

  const message =
    trigger === 'attach'
      ? 'Confirm this workspace for the active panelists before it is attached to the chat.'
      : 'Some panelists still need signed grants for additional workspaces before this round can run.'

  return (
    <div className="composer-permission-card provider-external-path">
      <div className="composer-permission-title">
        <span>{title}</span>
        <span className="composer-permission-source">Secondary workspace</span>
      </div>
      <div className="composer-permission-message">{message}</div>
      <div className="composer-permission-paths">
        {gaps.map((gap) => (
          <div key={gap.path} className="composer-permission-external-path">
            <span className="composer-permission-external-path-label">
              Needs {formatMissingProviders(gap.missingProviders)}
            </span>
            <code className="composer-permission-external-path-value">{gap.path}</code>
          </div>
        ))}
      </div>
      <div className="composer-permission-actions">
        <PillButton
          variant="primary"
          size="compact"
          disabled={busy}
          onClick={onGrant}
        >
          {trigger === 'attach' ? 'Attach workspace' : 'Grant workspace access'}
        </PillButton>
        <PillButton size="compact" disabled={busy} onClick={onDismiss}>
          {trigger === 'attach' ? 'Cancel' : 'Dismiss'}
        </PillButton>
      </div>
    </div>
  )
}
