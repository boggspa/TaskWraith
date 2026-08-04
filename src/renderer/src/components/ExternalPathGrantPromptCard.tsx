import type { ExternalPathGrantGap } from '../lib/externalPathGrantPreflight'
import { PillButton } from './PillButton'

export interface ExternalPathGrantPromptCardProps {
  gaps: ExternalPathGrantGap[]
  trigger: 'preflight' | 'attach'
  onGrant: () => void
  onDismiss: () => void
  /** Last grant attempt's failure — rendered instead of failing silently. */
  error?: { reason: string; path?: string }
  /** Remove every grant for a path that no longer exists on disk. */
  onRemoveMissingPath?: (path: string) => void
  busy?: boolean
}

export function ExternalPathGrantPromptCard({
  gaps,
  trigger,
  onGrant,
  onDismiss,
  error,
  onRemoveMissingPath,
  busy = false
}: ExternalPathGrantPromptCardProps): React.JSX.Element | null {
  if (gaps.length === 0) return null

  const missingPath = error?.reason === 'missing-path' ? error.path : undefined

  const title =
    trigger === 'attach'
      ? 'Attach additional workspace'
      : 'Additional workspace access required'

  const message =
    trigger === 'attach'
      ? 'Confirm access before attaching this workspace to the chat.'
      : 'Confirm access to the additional workspace before this run can start.'

  return (
    <div className="composer-permission-card provider-external-path">
      <div className="composer-permission-title">
        <span>{title}</span>
        <span className="composer-permission-source">Additional workspace</span>
      </div>
      <div className="composer-permission-message">{message}</div>
      <div className="composer-permission-paths">
        {gaps.map((gap) => (
          <div key={gap.path} className="composer-permission-external-path">
            <code className="composer-permission-external-path-value">{gap.path}</code>
          </div>
        ))}
      </div>
      {error && (
        <div className="composer-permission-message composer-permission-error">
          {missingPath
            ? 'This workspace path no longer exists on disk. Remove it from the chat to continue.'
            : `Couldn't grant access (${error.reason}). Re-select the folder from the workspace picker to re-consent.`}
        </div>
      )}
      <div className="composer-permission-actions">
        {missingPath && onRemoveMissingPath ? (
          <PillButton
            variant="primary"
            size="compact"
            disabled={busy}
            onClick={() => onRemoveMissingPath(missingPath)}
          >
            Remove missing workspace
          </PillButton>
        ) : (
          <PillButton
            variant="primary"
            size="compact"
            disabled={busy}
            onClick={onGrant}
          >
            {trigger === 'attach' ? 'Attach workspace' : 'Grant workspace access'}
          </PillButton>
        )}
        <PillButton size="compact" disabled={busy} onClick={onDismiss}>
          {trigger === 'attach' ? 'Cancel' : 'Dismiss'}
        </PillButton>
      </div>
    </div>
  )
}
