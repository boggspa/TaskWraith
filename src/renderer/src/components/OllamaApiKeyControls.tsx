import React, { useCallback, useEffect, useState } from 'react'
import { PillButton } from './PillButton'

const OLLAMA_CLOUD_SETTINGS_URL = 'https://ollama.com/settings'

export interface OllamaApiKeyStatus {
  apiKeyConfigured: boolean
  encryptionAvailable: boolean
  webSessionConfigured: boolean
  webSessionUpdatedAt?: string
}

export interface OllamaApiKeyControlsViewProps {
  status: OllamaApiKeyStatus | null
  draft: string
  busy: boolean
  error: string | null
  onDraftChange: (value: string) => void
  onSave: () => void
  onClear: () => void
  /** Manual paste of the __Secure-session cookie; the imported flow never
   *  round-trips the cookie through the renderer. */
  webSessionDraft: string
  onWebSessionChange: (value: string) => void
  onSaveWebSession: () => void
  onImportWebSession: () => void
  onClearWebSession: () => void
}

export function OllamaApiKeyControlsView({
  status,
  draft,
  busy,
  error,
  onDraftChange,
  onSave,
  onClear,
  webSessionDraft,
  onWebSessionChange,
  onSaveWebSession,
  onImportWebSession,
  onClearWebSession
}: OllamaApiKeyControlsViewProps): React.JSX.Element {
  const configured = status?.apiKeyConfigured === true
  const webSessionConfigured = status?.webSessionConfigured === true
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
      <div className="settings-pi-upstream-row">
        <label className="settings-pi-upstream-name" htmlFor="ollama-web-session-cookie">
          <span
            className={`settings-provider-auth-status-dot settings-provider-auth-status-dot-${webSessionConfigured ? 'signed-in' : 'not-available'}`}
            aria-hidden
          />
          <strong>Ollama web session</strong>
          <span className="settings-pi-upstream-hint">
            {webSessionConfigured
              ? 'Tracking Session (5H) and Weekly usage'
              : 'Needed to track Session (5H) and Weekly usage'}
          </span>
        </label>
        <div className="settings-pi-upstream-controls settings-web-session-controls">
          <input
            id="ollama-web-session-cookie"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={
              webSessionConfigured ? 'Session stored — replace…' : '__Secure-session cookie…'
            }
            value={webSessionDraft}
            disabled={busy || status?.encryptionAvailable === false}
            onChange={(event) => onWebSessionChange(event.target.value)}
          />
          <PillButton
            size="compact"
            disabled={busy || !webSessionDraft.trim() || status?.encryptionAvailable === false}
            onClick={onSaveWebSession}
          >
            Save
          </PillButton>
          <PillButton
            size="compact"
            variant="primary"
            disabled={busy || status?.encryptionAvailable === false}
            onClick={onImportWebSession}
          >
            Import web session…
          </PillButton>
          <PillButton
            size="compact"
            variant="danger"
            disabled={busy || !webSessionConfigured}
            onClick={onClearWebSession}
          >
            Clear
          </PillButton>
        </div>
      </div>
      {status?.encryptionAvailable === false && (
        <p className="settings-provider-auth-footnote">
          System keychain encryption is unavailable, so the web session cookie cannot be stored
          here.
        </p>
      )}
      {error && <p className="settings-provider-auth-footnote">{error}</p>}
      <p className="settings-provider-auth-footnote">
        Both secrets are encrypted with the system keychain and never shown again. The API key is
        sent only to the direct Ollama Cloud API; the web session lets TaskWraith read your exact
        Session (5H) and Weekly usage from the{' '}
        <a href={OLLAMA_CLOUD_SETTINGS_URL} target="_blank" rel="noreferrer">
          Cloud usage dashboard
        </a>{' '}
        — use Import to sign in, or paste the <code>__Secure-session</code> cookie from your
        browser&rsquo;s DevTools.
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
  const [webSessionDraft, setWebSessionDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await window.api.getOllamaAuthStatus()
      setStatus({
        apiKeyConfigured: next.apiKeyConfigured === true,
        encryptionAvailable: next.encryptionAvailable === true,
        webSessionConfigured: next.webSessionConfigured === true,
        ...(typeof next.webSessionUpdatedAt === 'string'
          ? { webSessionUpdatedAt: next.webSessionUpdatedAt }
          : {})
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

  const saveWebSession = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.setOllamaWebSession(webSessionDraft)
      if (!result.ok) {
        setError(
          result.error === 'invalidCookie'
            ? 'That does not look like a session cookie.'
            : 'Could not store the web session.'
        )
      } else {
        // Never keep the cookie in renderer state once it is stored.
        setWebSessionDraft('')
        await refresh()
        await onChanged?.()
      }
    } catch {
      setError('Could not store the web session.')
    } finally {
      setBusy(false)
    }
  }, [onChanged, refresh, webSessionDraft])

  const importWebSession = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const outcome = await window.api.importOllamaWebSession()
      if (outcome?.ok) {
        setWebSessionDraft('')
        await refresh()
        await onChanged?.()
      } else if (outcome && outcome.reason !== 'cancelled') {
        // Closing the sign-in window without finishing is not an error.
        setError('Could not import the web session.')
      }
    } catch {
      setError('Could not import the web session.')
    } finally {
      setBusy(false)
    }
  }, [onChanged, refresh])

  const clearWebSession = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.clearOllamaWebSession()
      if (!result.ok) setError('Could not clear the web session.')
      setWebSessionDraft('')
      await refresh()
      await onChanged?.()
    } catch {
      setError('Could not clear the web session.')
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
      webSessionDraft={webSessionDraft}
      onWebSessionChange={setWebSessionDraft}
      onSaveWebSession={() => void saveWebSession()}
      onImportWebSession={() => void importWebSession()}
      onClearWebSession={() => void clearWebSession()}
    />
  )
}
