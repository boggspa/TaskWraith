import React, { useCallback, useEffect, useState } from 'react'
import { PillButton } from './PillButton'

const OLLAMA_CLOUD_SETTINGS_URL = 'https://ollama.com/settings'

export interface OllamaApiKeyStatus {
  apiKeyConfigured: boolean
  encryptionAvailable: boolean
}

export interface OllamaApiKeyControlsViewProps {
  status: OllamaApiKeyStatus | null
  draft: string
  busy: boolean
  error: string | null
  onDraftChange: (value: string) => void
  onSave: () => void
  onClear: () => void
}

export function OllamaApiKeyControlsView({
  status,
  draft,
  busy,
  error,
  onDraftChange,
  onSave,
  onClear
}: OllamaApiKeyControlsViewProps): React.JSX.Element {
  const configured = status?.apiKeyConfigured === true
  return (
    <>
      <div className="settings-pi-upstream-row">
        <label className="settings-pi-upstream-name" htmlFor="ollama-cloud-api-key">
          <span
            className={`settings-provider-auth-status-dot settings-provider-auth-status-dot-${configured ? 'signed-in' : 'not-available'}`}
            aria-hidden
          />
          <strong>Ollama Cloud API key</strong>
          <span className="settings-pi-upstream-hint">
            {configured
              ? 'Stored for direct Cloud requests'
              : 'Optional alternative to CLI sign-in'}
          </span>
        </label>
        <div className="settings-pi-upstream-controls">
          <input
            id="ollama-cloud-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={configured ? 'Key stored — replace…' : 'API key'}
            value={draft}
            disabled={busy || status?.encryptionAvailable === false}
            onChange={(event) => onDraftChange(event.target.value)}
          />
          <PillButton
            size="compact"
            variant="primary"
            disabled={busy || !draft.trim() || status?.encryptionAvailable === false}
            onClick={onSave}
          >
            Save
          </PillButton>
          <PillButton
            size="compact"
            variant="danger"
            disabled={busy || !configured}
            onClick={onClear}
          >
            Clear
          </PillButton>
        </div>
      </div>
      {status?.encryptionAvailable === false && (
        <p className="settings-provider-auth-footnote">
          System keychain encryption is unavailable, so the API key cannot be stored here.
        </p>
      )}
      {error && <p className="settings-provider-auth-footnote">{error}</p>}
      <p className="settings-provider-auth-footnote">
        The key is encrypted with the system keychain and sent only to the direct Ollama Cloud API;
        local model requests never receive it. Ollama currently exposes exact session and weekly
        usage only on its{' '}
        <a href={OLLAMA_CLOUD_SETTINGS_URL} target="_blank" rel="noreferrer">
          Cloud usage dashboard
        </a>
        , not through a supported API, CLI, or local-daemon quota endpoint. TaskWraith does not
        import browser cookies to scrape that page.
      </p>
    </>
  )
}

export function OllamaApiKeyControls({
  onChanged
}: {
  onChanged?: () => void | Promise<void>
} = {}): React.JSX.Element {
  const [status, setStatus] = useState<OllamaApiKeyStatus | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await window.api.getOllamaAuthStatus()
      setStatus({
        apiKeyConfigured: next.apiKeyConfigured === true,
        encryptionAvailable: next.encryptionAvailable === true
      })
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.storeOllamaApiKey(draft)
      if (!result.stored) {
        setError(result.error || 'Could not store the Ollama API key.')
      } else {
        setDraft('')
        await refresh()
        await onChanged?.()
      }
    } catch {
      setError('Could not store the Ollama API key.')
    } finally {
      setBusy(false)
    }
  }, [draft, onChanged, refresh])

  const clear = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await window.api.clearOllamaApiKey()
      setDraft('')
      await refresh()
      await onChanged?.()
    } catch {
      setError('Could not clear the Ollama API key.')
    } finally {
      setBusy(false)
    }
  }, [onChanged, refresh])

  return (
    <OllamaApiKeyControlsView
      status={status}
      draft={draft}
      busy={busy}
      error={error}
      onDraftChange={setDraft}
      onSave={() => void save()}
      onClear={() => void clear()}
    />
  )
}
