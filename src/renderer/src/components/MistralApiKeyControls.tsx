import React, { useCallback, useEffect, useState } from 'react'
import { PillButton } from './PillButton'

export interface MistralApiKeyStatus {
  configured: boolean
  encryptionAvailable: boolean
}

export interface MistralApiKeyControlsViewProps {
  status: MistralApiKeyStatus | null
  draft: string
  busy: boolean
  error: string | null
  onDraftChange: (value: string) => void
  onSave: () => void
  onClear: () => void
}

export function MistralApiKeyControlsView({
  status,
  draft,
  busy,
  error,
  onDraftChange,
  onSave,
  onClear
}: MistralApiKeyControlsViewProps): React.JSX.Element {
  const configured = status?.configured === true
  return (
    <>
      <div className="settings-pi-upstream-row">
        <label className="settings-pi-upstream-name" htmlFor="mistral-byok-api-key">
          <span
            className={`settings-provider-auth-status-dot settings-provider-auth-status-dot-${configured ? 'signed-in' : 'not-available'}`}
            aria-hidden
          />
          <strong>Mistral API key (BYOK)</strong>
          <span className="settings-pi-upstream-hint">
            {configured
              ? 'Stored for metered API runs'
              : 'Optional alternative to Vibe subscription'}
          </span>
        </label>
        <div className="settings-pi-upstream-controls">
          <input
            id="mistral-byok-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={configured ? 'Key stored — replace…' : 'api.mistral.ai key…'}
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
        The key is encrypted with the system keychain and passed to Mistral for direct metered API
        billing, unlocking Mistral Large 3, GLM 5.2, Codestral, Devstral 2, and Ministral models.
        When configured, Vibe resolves credentials API-key-first.
      </p>
    </>
  )
}

export function MistralApiKeyControls({
  onChanged
}: {
  onChanged?: () => void | Promise<void>
} = {}): React.JSX.Element {
  const [status, setStatus] = useState<MistralApiKeyStatus | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await window.api.getMistralApiKeyStatus()
      if (next) {
        setStatus({
          configured: next.configured === true,
          encryptionAvailable: next.encryptionAvailable === true
        })
      } else {
        setStatus(null)
      }
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
      const result = await window.api.setMistralApiKey(draft)
      if (!result.ok) {
        setError(result.error || 'Could not store the Mistral API key.')
      } else {
        setDraft('')
        await refresh()
        await onChanged?.()
      }
    } catch {
      setError('Could not store the Mistral API key.')
    } finally {
      setBusy(false)
    }
  }, [draft, onChanged, refresh])

  const clear = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await window.api.clearMistralApiKey()
      setDraft('')
      await refresh()
      await onChanged?.()
    } catch {
      setError('Could not clear the Mistral API key.')
    } finally {
      setBusy(false)
    }
  }, [onChanged, refresh])

  return (
    <MistralApiKeyControlsView
      status={status}
      draft={draft}
      busy={busy}
      error={error}
      onDraftChange={setDraft}
      onSave={save}
      onClear={clear}
    />
  )
}
