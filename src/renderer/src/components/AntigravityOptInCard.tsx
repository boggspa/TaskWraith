import { useEffect, useState } from 'react'
import { PillButton } from './PillButton'
import { ProviderLogoTile } from './ProviderLogoTile'
import type {
  AntigravityGeminiApiSecretMutationResult,
  AntigravityGeminiApiSecretStatus
} from '../../../main/antigravity/AntigravityGeminiApiSecretStore'
import type { AntigravityGeminiApiDiscoveryOutcome } from '../../../main/antigravity/AntigravityGeminiApiDiscoveryOutcome'
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
    antigravityGeminiApiMonthlySpendCapUsd?: number | null
  }) => void
  onOpenLogin?: () => void
  geminiApiDisclosureAcceptedAt?: number | null
  /** Soft monthly budget (USD) for the key lane's Model Usage spend meter. */
  geminiApiMonthlySpendCapUsd?: number | null
}

const GEMINI_API_ERROR_MESSAGE =
  'The Gemini API key could not be saved. Check the key and try again.'

interface GeminiApiDiscoveryLine {
  readonly tone: 'connected' | 'partial' | 'not-available'
  readonly text: string
}

const GEMINI_API_DISCOVERY_PENDING: GeminiApiDiscoveryLine = {
  tone: 'partial',
  text: 'Checking this key against the Gemini API…'
}

/**
 * Turns the last nonsecret discovery outcome into one honest line. A stored key
 * is not a working key: the secret status only proves an envelope exists on
 * disk, so without this the card reported a green "API key configured" even
 * when Google was rejecting the key on every probe. Every branch here is fixed
 * local copy — the main process deliberately never sends error text to quote.
 */
function describeGeminiApiDiscovery(
  outcome: AntigravityGeminiApiDiscoveryOutcome | null
): GeminiApiDiscoveryLine {
  if (!outcome) return GEMINI_API_DISCOVERY_PENDING
  switch (outcome.status) {
    case 'ok':
      // Curation can legitimately filter every discovered row; claiming "0
      // models available" next to an empty picker would not be an answer.
      return outcome.modelCount > 0
        ? {
            tone: 'connected',
            text: `${outcome.modelCount} Gemini API model${
              outcome.modelCount === 1 ? '' : 's'
            } available`
          }
        : { tone: 'not-available', text: 'This key returned no usable Gemini models' }
    case 'unauthorized':
      return { tone: 'not-available', text: 'Google rejected this API key' }
    case 'rateLimited':
      return { tone: 'partial', text: 'Rate limited — retrying' }
    case 'projectLimited':
      return {
        tone: 'not-available',
        text: 'This key’s project is over its limit or has no billing enabled'
      }
    case 'timedOut':
      // The lane's 900ms budget sits inside a 1s overall probe deadline, so a
      // merely slow network lands here with a perfectly good key. Say so.
      return {
        tone: 'partial',
        text: 'Discovery timed out within the 1s startup probe budget; showing the built-in model list'
      }
    case 'unavailable':
      return {
        tone: 'partial',
        text: 'Could not reach the Gemini API; showing the built-in model list'
      }
    case 'invalidResponse':
      return {
        tone: 'partial',
        text: 'The Gemini API returned an unexpected response; showing the built-in model list'
      }
    case 'empty':
      return { tone: 'not-available', text: 'This key returned no usable Gemini models' }
    case 'disclosureRequired':
      return { tone: 'not-available', text: 'Accept the disclosure above to check this key' }
    case 'keyUnavailable':
      return {
        tone: 'not-available',
        text: 'The stored key could not be read — clear it and save it again'
      }
    case 'sdkUnavailable':
      return { tone: 'not-available', text: 'The Gemini API client is unavailable in this build' }
    case 'cancelled':
      return { tone: 'partial', text: 'The last check was interrupted; it will retry' }
    default:
      return GEMINI_API_DISCOVERY_PENDING
  }
}

function safeMutationMessage(result: AntigravityGeminiApiSecretMutationResult): string | null {
  if (result.ok) return null
  // Never surface a main-process error string: only these fixed, nonsecret messages
  // may cross into the renderer UI.
  return result.error === 'invalidApiKey'
    ? 'Enter a non-empty Gemini API key.'
    : GEMINI_API_ERROR_MESSAGE
}

/**
 * Deliberately buried setup card for the distinct AntiGravity provider, with
 * two independent admission lanes. The official `agy` CLI lane stays
 * explicitly risky: it requires an informed ban-risk consent before it opens
 * anything. The Gemini API (BYO key) lane is a normal auth card: saving a
 * valid key is sufficient to enable it, with no ban-risk framing, only the
 * separate (non-ban-risk) Gemini data-use/billing disclosure. The card
 * header/status reflect whichever lane is actually admitted.
 */
export function AntigravityOptInCard({
  enabled,
  acceptedAt,
  onChange,
  onOpenLogin,
  geminiApiDisclosureAcceptedAt = null,
  geminiApiMonthlySpendCapUsd = null
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
  const [geminiApiDiscovery, setGeminiApiDiscovery] =
    useState<AntigravityGeminiApiDiscoveryOutcome | null>(null)
  const consentRecorded = enabled && typeof acceptedAt === 'number' && acceptedAt > 0
  // A configured Gemini API key is an independent, first-class admission lane
  // (A1). The card header/status must reflect that lane neutrally instead of
  // always describing the separate agy/CLI ban-risk consent state.
  const geminiApiConfigured = Boolean(geminiApiStatus?.configured)
  const geminiApiDiscoveryLine = describeGeminiApiDiscovery(geminiApiDiscovery)

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

  // Polled rather than pushed: a discovery pass is kicked off by a key mutation
  // or a settings generation change, both of which land a beat after the action
  // that caused them. The loop stops with the card, which only exists while the
  // provider settings tab is open.
  useEffect(() => {
    if (typeof window.api.getAntigravityGeminiApiDiscoveryOutcome !== 'function') return
    let cancelled = false
    let timer: number | null = null
    const poll = async (): Promise<void> => {
      try {
        const outcome = await window.api.getAntigravityGeminiApiDiscoveryOutcome()
        if (!cancelled) setGeminiApiDiscovery(outcome ?? null)
      } catch {
        if (!cancelled) setGeminiApiDiscovery(null)
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 1_000)
    }
    void poll()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
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

  const [spendCapInput, setSpendCapInput] = useState(
    typeof geminiApiMonthlySpendCapUsd === 'number' && geminiApiMonthlySpendCapUsd > 0
      ? String(geminiApiMonthlySpendCapUsd)
      : ''
  )
  useEffect(() => {
    setSpendCapInput(
      typeof geminiApiMonthlySpendCapUsd === 'number' && geminiApiMonthlySpendCapUsd > 0
        ? String(geminiApiMonthlySpendCapUsd)
        : ''
    )
  }, [geminiApiMonthlySpendCapUsd])

  // Commit-on-blur/Enter so half-typed numbers never hit settings. Empty
  // clears the cap; anything unparseable reverts to the persisted value.
  const commitSpendCap = () => {
    const trimmed = spendCapInput.trim()
    if (!trimmed) {
      if (geminiApiMonthlySpendCapUsd !== null) {
        onChange({ antigravityGeminiApiMonthlySpendCapUsd: null })
      }
      return
    }
    const value = Number(trimmed)
    if (Number.isFinite(value) && value > 0) {
      onChange({ antigravityGeminiApiMonthlySpendCapUsd: Math.min(value, 1_000_000) })
      return
    }
    setSpendCapInput(
      typeof geminiApiMonthlySpendCapUsd === 'number' && geminiApiMonthlySpendCapUsd > 0
        ? String(geminiApiMonthlySpendCapUsd)
        : ''
    )
  }

  const saveGeminiApiKey = async () => {
    if (!geminiApiKey || !geminiApiAcknowledged) return
    setGeminiApiBusy(true)
    setGeminiApiMessage(null)
    try {
      const result = await window.api.setAntigravityGeminiApiSecret(geminiApiKey)
      if (result.ok) {
        setGeminiApiStatus(result.status)
        // The previous key's verdict says nothing about this one; the poll
        // refills it once the mutation's fresh discovery pass lands.
        setGeminiApiDiscovery(null)
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
        setGeminiApiDiscovery(null)
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
        <span className="settings-provider-auth-optional" data-testid="antigravity-card-badge">
          {geminiApiConfigured ? 'BYO key' : 'Experimental'}
        </span>
      </div>
      <div className="settings-provider-auth-status">
        <span
          className={`settings-provider-auth-status-dot settings-provider-auth-status-dot-${
            geminiApiConfigured ? 'connected' : consentRecorded ? 'partial' : 'not-available'
          }`}
          aria-hidden
        />
        <span data-testid="antigravity-card-status">
          {geminiApiConfigured
            ? 'Gemini API key configured'
            : consentRecorded
              ? 'Risk acceptance recorded'
              : 'Disabled — explicit consent required'}
        </span>
      </div>

      <h4 className="settings-antigravity-agy-heading">
        Official <code>agy</code> CLI (ban-risk; requires explicit consent)
      </h4>
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
        TaskWraith runs the official user-installed <code>agy</code> CLI. Its browser and OS-keyring
        sign-in stay under your control; TaskWraith never reads, copies, or stores Google or
        AntiGravity OAuth credentials, and never reads your AntiGravity conversation transcripts.
      </p>
      <p className="settings-provider-auth-hint">
        For completeness, it does a few other things on your machine: enabling this lane runs{' '}
        <code>agy models</code> to list what your account can use; continuing a conversation reads
        one non-secret entry from <code>agy</code>&apos;s own cache — the workspace-to-
        conversation-ID map it writes at <code>~/.gemini/antigravity-cli/cache/</code> — so a
        follow-up turn resumes instead of starting over; each run temporarily writes this run&apos;s
        signed permissions into <code>agy</code>&apos;s settings file at{' '}
        <code>~/.gemini/antigravity-cli/settings.json</code>, restoring your original settings when
        the run ends (or at the next TaskWraith launch after a crash); and each run temporarily adds
        one TaskWraith-named entry to the workspace&apos;s <code>.agents/hooks.json</code> —{' '}
        <code>agy</code>&apos;s official lifecycle-hook file — so the CLI&apos;s shell-command
        confirmations route to TaskWraith&apos;s own approval system on this machine, removed again
        with the run. No credentials and no transcripts are read, and nothing calls out beyond your
        machine.
      </p>
      <p className="settings-provider-auth-hint">
        With that hook in place, TaskWraith&apos;s per-command permission gate applies inside{' '}
        <code>agy</code>: read-only inspection commands (<code>git status</code> /{' '}
        <code>git log</code> / <code>git diff</code>, <code>ls</code>, <code>cat</code>,{' '}
        <code>grep</code>, …) are pre-authorized inside <code>agy</code>&apos;s sandbox at every
        permission tier, the Ask tier genuinely asks with an approval card, and a declined command
        is reported back to the model instead of ending the turn. On the Full Access tier — and only
        there — <code>agy</code>&apos;s own duplicate confirmation layer is skipped (its terminal
        sandbox stays on, and TaskWraith&apos;s always-ask holds for network egress and recursive
        deletion still apply). TaskWraith still owns run admission, cancellation and the audit
        trail, and if you set Shell commands or File changes to <strong>Deny</strong> under Agentic
        services, this lane launches read-only rather than ignoring you.
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
        <h4 id="antigravity-gemini-api-heading">Gemini API (BYO key; separate billing)</h4>
        <p className="settings-provider-auth-hint">
          Use your own Google project API key to enable Gemini API models. Saving a valid key is
          sufficient for this Gemini-only mode; it does not enable the separate official{' '}
          <code>agy</code> CLI lane above.
        </p>
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
        <label className="settings-antigravity-gemini-api-disclosure">
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
        {geminiApiStatus?.configured && (
          <div className="settings-provider-auth-status settings-antigravity-gemini-api-discovery-status">
            <span
              className={`settings-provider-auth-status-dot settings-provider-auth-status-dot-${geminiApiDiscoveryLine.tone}`}
              aria-hidden
            />
            <span
              data-testid="antigravity-gemini-api-discovery"
              data-tone={geminiApiDiscoveryLine.tone}
            >
              {geminiApiDiscoveryLine.text}
            </span>
          </div>
        )}
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
        {geminiApiConfigured && (
          <>
            <label className="settings-provider-auth-field">
              <span>Monthly budget — soft cap, USD</span>
              <input
                data-testid="antigravity-gemini-api-spend-cap"
                type="number"
                min={0}
                step="1"
                inputMode="decimal"
                value={spendCapInput}
                onChange={(event) => setSpendCapInput(event.target.value)}
                onBlur={commitSpendCap}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitSpendCap()
                }}
                placeholder="e.g. 20 — leave empty for no cap"
                aria-label="Monthly Gemini API budget in US dollars (soft cap)"
              />
            </label>
            <p className="settings-provider-auth-footnote">
              Advisory only: fills the Model Usage spend meter and warns as estimated spend
              approaches it — never blocks a run. For a hard limit, set a budget in your Google
              Cloud billing console.
            </p>
          </>
        )}
      </section>
    </article>
  )
}
