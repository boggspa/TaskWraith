import { useState } from 'react'
import { PillButton } from './PillButton'
import { ProviderLogoTile } from './ProviderLogoTile'

export type AntigravityOptInPatch = {
  antigravityEnabled: true
  antigravityOptInAcceptedAt: number
}

export function createAntigravityOptInPatch(now = Date.now()): AntigravityOptInPatch {
  return {
    antigravityEnabled: true,
    antigravityOptInAcceptedAt: now
  }
}

interface AntigravityOptInCardProps {
  enabled: boolean
  acceptedAt?: number | null
  onChange: (partial: {
    antigravityEnabled?: boolean
    antigravityOptInAcceptedAt?: number | null
  }) => void
  onOpenLogin?: () => void
}

/**
 * Deliberately buried, explicitly risky setup for the distinct AntiGravity
 * provider. It stays outside generic provider ordering and picker surfaces,
 * records an informed choice, and opens only the user's official `agy` CLI.
 */
export function AntigravityOptInCard({
  enabled,
  acceptedAt,
  onChange,
  onOpenLogin
}: AntigravityOptInCardProps): React.JSX.Element {
  const [riskAcknowledged, setRiskAcknowledged] = useState(false)
  const consentRecorded = enabled && typeof acceptedAt === 'number' && acceptedAt > 0

  return (
    <article
      className="settings-provider-auth-card settings-antigravity-opt-in-card provider-antigravity"
      data-provider="antigravity"
    >
      <div className="settings-provider-auth-card-header">
        <ProviderLogoTile provider="antigravity" />
        <strong>AntiGravity</strong>
        <span className="settings-provider-auth-optional">Experimental</span>
      </div>
      <div className="settings-provider-auth-status">
        <span
          className={`settings-provider-auth-status-dot settings-provider-auth-status-dot-${
            consentRecorded ? 'partial' : 'not-available'
          }`}
          aria-hidden
        />
        <span>{consentRecorded ? 'Risk acceptance recorded' : 'Disabled — explicit consent required'}</span>
      </div>

      <p>
        Google&apos;s Antigravity Additional Terms state: “Using third party software, tools,
        or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a
        breach of this Agreement. Such actions may be grounds for suspension or termination
        of your account.”
      </p>
      <p className="settings-provider-auth-hint">
        Using TaskWraith with AntiGravity can therefore breach Google&apos;s terms and can suspend
        or terminate your Google account. In February 2026, users publicly reported 403 errors
        and account suspensions after using third-party Antigravity tools or proxies. This is not
        ToS-approved or ban-safe.
      </p>
      <p className="settings-provider-auth-hint">
        TaskWraith only opens the official user-installed <code>agy</code> CLI. Its browser and
        OS-keyring sign-in stay under your control; TaskWraith never reads, copies, or stores
        Google or AntiGravity OAuth credentials.
      </p>

      {!consentRecorded ? (
        <>
          <label className="settings-antigravity-risk-acknowledgement">
            <input
              type="checkbox"
              checked={riskAcknowledged}
              onChange={(event) => setRiskAcknowledged(event.target.checked)}
            />
            <span>
              I understand that this may breach Google&apos;s terms and may suspend or terminate my
              account. I still choose to enable AntiGravity.
            </span>
          </label>
          <div className="settings-provider-auth-actions">
            <PillButton
              size="compact"
              variant="danger"
              disabled={!riskAcknowledged}
              onClick={() => onChange(createAntigravityOptInPatch())}
            >
              Accept risk and enable
            </PillButton>
          </div>
        </>
      ) : (
        <>
          <div className="settings-provider-auth-command">
            <code>agy</code>
            <span>
              Opens the official CLI&apos;s own browser/keyring sign-in. Completing sign-in does not
              make this provider ToS-approved or ban-safe.
            </span>
          </div>
          <div className="settings-provider-auth-actions">
            <PillButton
              size="compact"
              variant="primary"
              disabled={!onOpenLogin}
              onClick={onOpenLogin}
            >
              Open Terminal to sign in
            </PillButton>
            <PillButton
              size="compact"
              variant="danger"
              onClick={() => onChange({ antigravityEnabled: false })}
            >
              Disable AntiGravity
            </PillButton>
          </div>
        </>
      )}
    </article>
  )
}
