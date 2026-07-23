import { useEffect, useState } from 'react'
import { PillButton } from './PillButton'
import { ProviderLogoTile } from './ProviderLogoTile'
import type {
  AntigravityGeminiApiSecretMutationResult,
  AntigravityGeminiApiSecretStatus
} from '../../../main/antigravity/AntigravityGeminiApiSecretStore'
import { notifyAntigravityGeminiApiSecretMutation } from '../hooks/useConfiguredProviderSnapshot'

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
    antigravityGeminiApiDisclosureAcceptedAt?: number | null
  }) => void
  onOpenLogin?: () => void
  geminiApiDisclosureAcceptedAt?: number | null
}

const GEMINI_API_ERROR_MESSAGE =
  'The Gemini API key could not be saved. Check the key and try again.'

function safeMutationMessage(result: AntigravityGeminiApiSecretMutationResult): string | null {
  if (result.ok) return null
  // Never surface a main-process error string: only these fixed, nonsecret messages
  // may cross into the renderer UI.
  return result.error === 'invalidApiKey'
    ? 'Enter a non-empty Gemini API key.'
    : GEMINI_API_ERROR_MESSAGE
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
  onOpenLogin,
  geminiApiDisclosureAcceptedAt = null
}: AntigravityOptInCardProps): React.JSX.Element {
  const [riskAcknowledged, setRiskAcknowledged] = useState(false)
  const [geminiApiAcknowledged, setGeminiApiAcknowledged] = useState(
    typeof geminiApiDisclosureAcceptedAt === 'number' && geminiApiDisclosureAcceptedAt > 0
  )
  const [geminiApiKey, setGeminiApiKey] = useState('')
  const [geminiApiStatus, setGeminiApiStatus] = useState<AntigravityGeminiApiSecretStatus | null>(
    null
  )
  const [geminiApiBusy, setGeminiApiBusy] = useState(false)
  const [geminiApiMessage, setGeminiApiMessage] = useState<string | null>(null)
  const consentRecorded = enabled && typeof acceptedAt === 'number' && acceptedAt > 0

  useEffect(() => {
    let active = true
    void window.api
      .getAntigravityGeminiApiSecretStatus()
      .then((status) => {
        if (active) setGeminiApiStatus(status)
      })
      .catch(() => {
        if (active) setGeminiApiStatus(null)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    setGeminiApiAcknowledged(
      typeof geminiApiDisclosureAcceptedAt === 'number' && geminiApiDisclosureAcceptedAt > 0
    )
  }, [geminiApiDisclosureAcceptedAt])

  const updateGeminiApiAcknowledgement = (checked: boolean) => {
    setGeminiApiAcknowledged(checked)
    setGeminiApiMessage(null)
    onChange({
      antigravityGeminiApiDisclosureAcceptedAt: checked ? Date.now() : null
    })
  }

  const saveGeminiApiKey = async () => {
    if (!geminiApiKey || !geminiApiAcknowledged) return
    setGeminiApiBusy(true)
    setGeminiApiMessage(null)
    try {
      const result = await window.api.setAntigravityGeminiApiSecret(geminiApiKey)
      if (result.ok) {
        setGeminiApiStatus(result.status)
        notifyAntigravityGeminiApiSecretMutation()
        setGeminiApiMessage('Gemini API key saved securely in the desktop main process.')
      } else {
        setGeminiApiMessage(safeMutationMessage(result))
      }
    } catch {
      setGeminiApiMessage(GEMINI_API_ERROR_MESSAGE)
    } finally {
      // The key must not remain in renderer state after the mutation completes.
      setGeminiApiKey('')
      setGeminiApiBusy(false)
    }
  }

  const clearGeminiApiKey = async () => {
    setGeminiApiBusy(true)
    setGeminiApiMessage(null)
    try {
      const result = await window.api.clearAntigravityGeminiApiSecret()
      setGeminiApiStatus(result.status)
      if (result.ok) {
        notifyAntigravityGeminiApiSecretMutation()
      }
      setGeminiApiMessage(result.ok ? 'Gemini API key cleared.' : GEMINI_API_ERROR_MESSAGE)
    } catch {
      setGeminiApiMessage(GEMINI_API_ERROR_MESSAGE)
    } finally {
      setGeminiApiKey('')
      setGeminiApiBusy(false)
    }
  }

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
        <span>
          {consentRecorded ? 'Risk acceptance recorded' : 'Disabled — explicit consent required'}
        </span>
      </div>

      <p>
        Google&apos;s Antigravity Additional Terms state: “Using third party software, tools, or
        services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of
        this Agreement. Such actions may be grounds for suspension or termination of your account.”
      </p>
      <p className="settings-provider-auth-hint">
        Using TaskWraith with AntiGravity can therefore breach Google&apos;s terms and can suspend
        or terminate your Google account. In February 2026, users publicly reported 403 errors and
        account suspensions after using third-party Antigravity tools or proxies. This is not
        ToS-approved or ban-safe.
      </p>
      <p className="settings-provider-auth-hint">
        TaskWraith only opens the official user-installed <code>agy</code> CLI. Its browser and
        OS-keyring sign-in stay under your control; TaskWraith never reads, copies, or stores Google
        or AntiGravity OAuth credentials.
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

      <section
        className="settings-antigravity-gemini-api-section"
        aria-labelledby="antigravity-gemini-api-heading"
      >
        <h4 id="antigravity-gemini-api-heading">Gemini API (separate billing)</h4>
        <p className="settings-provider-auth-hint">
          Gemini-only. This mode uses a Google project API key that you supply for a later official
          Google API/SDK connection. It is separately metered and billed under that project and is
          subject to the project&apos;s tier and rate limits. It does not consume AntiGravity
          subscription quota and does not expose AntiGravity Claude or GPT models.
        </p>
        <p className="settings-provider-auth-hint">
          Gemini API Free Tier content may be used to improve Google products. Paid Services content
          is not used to improve Google products. TaskWraith cannot determine your tier; verify it
          in AI Studio.
        </p>
        <label className="settings-antigravity-risk-acknowledgement">
          <input
            type="checkbox"
            checked={geminiApiAcknowledged}
            onChange={(event) => updateGeminiApiAcknowledgement(event.target.checked)}
          />
          <span>
            I understand the separate Gemini API billing, project limits, and data-use terms.
          </span>
        </label>
        <div className="settings-provider-auth-status">
          <span
            className={`settings-provider-auth-status-dot settings-provider-auth-status-dot-${
              geminiApiStatus?.configured ? 'connected' : 'not-available'
            }`}
            aria-hidden
          />
          <span>
            {geminiApiStatus?.configured ? 'API key configured' : 'No API key configured'}
          </span>
        </div>
        <label className="settings-provider-auth-field">
          <span>Google project API key</span>
          <input
            data-testid="antigravity-gemini-api-key"
            type="password"
            value={geminiApiKey}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setGeminiApiKey(event.target.value)}
            placeholder="Paste key to save securely"
            aria-label="Google project API key"
          />
        </label>
        <div className="settings-provider-auth-actions">
          <PillButton
            data-testid="antigravity-gemini-api-save"
            size="compact"
            variant="primary"
            disabled={!geminiApiAcknowledged || !geminiApiKey || geminiApiBusy}
            onClick={() => void saveGeminiApiKey()}
          >
            Save Gemini API key
          </PillButton>
          <PillButton
            data-testid="antigravity-gemini-api-clear"
            size="compact"
            variant="danger"
            disabled={!geminiApiStatus?.configured || geminiApiBusy}
            onClick={() => void clearGeminiApiKey()}
          >
            Clear Gemini API key
          </PillButton>
        </div>
        {geminiApiMessage && <p className="settings-provider-auth-footnote">{geminiApiMessage}</p>}
      </section>
    </article>
  )
}
