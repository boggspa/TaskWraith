/*
 * ApiUsageKeyField — the "API usage reporting" block on a provider's Settings
 * card: the Anthropic Admin API key on the Claude card, the OpenAI admin key
 * (plus an optional project id) on the Codex card. Saving a key makes the
 * Console / organisation month-to-date bill appear in the Model Usage card's
 * Usage Credits stack as "Claude · Console API  $x spent".
 *
 * Deliberately separate from the seat's own credential controls: this key
 * READS a bill, it never runs anything, and it is stored in its own
 * safeStorage envelope rather than the settings file. Pure view
 * (`ApiUsageKeyFieldView`, SSR-testable) plus a thin shell over the preload
 * bridge; only the status projection ever reaches the renderer.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import {
  normalizeApiUsageBillingSettings,
  normalizeOpenAiProjectId,
  type ApiUsageBillingSettings
} from '../../../shared/apiUsageBilling'
import { PillButton } from './PillButton'

export type ApiUsageKeyProvider = 'anthropic' | 'openai'

export const API_USAGE_KEY_COPY: Record<
  ApiUsageKeyProvider,
  { label: string; placeholder: string; hint: string; unauthorizedHint: string }
> = {
  anthropic: {
    label: 'Anthropic Admin API key (usage reporting)',
    placeholder: 'sk-ant-admin01-…',
    hint: 'Reads the Console organisation’s month-to-date cost report so API spend shows under Usage Credits as “Claude · Console API”. An Admin API key from Console → Settings → Organization, not the seat key above; stored encrypted on this Mac and never sent to a run.',
    unauthorizedHint:
      'Anthropic rejected this key. Usage reporting needs an organisation Admin API key (sk-ant-admin01-…); a workspace or seat key cannot read the cost report.'
  },
  openai: {
    label: 'OpenAI admin API key (usage reporting)',
    placeholder: 'sk-admin-…',
    hint: 'Reads the organisation’s month-to-date costs so API spend shows under Usage Credits as “Codex · OpenAI API”. An admin key from platform.openai.com → Settings → Organization → Admin keys; stored encrypted on this Mac and never sent to a run.',
    unauthorizedHint:
      'OpenAI rejected this key. Usage reporting needs an organisation admin key; a project key cannot read costs.'
  }
}

export interface ApiUsageKeyFieldViewProps {
  provider: ApiUsageKeyProvider
  configured: boolean
  encryptionAvailable: boolean
  updatedAt?: string
  draft: string
  busy: boolean
  error: string | null
  onDraftChange: (value: string) => void
  onSave: () => void
  onClear: () => void
  /** OpenAI only: the optional project id that narrows the bill. */
  projectId?: string
  onProjectIdCommit?: (value: string) => void
}

export function ApiUsageKeyFieldView({
  provider,
  configured,
  encryptionAvailable,
  updatedAt,
  draft,
  busy,
  error,
  onDraftChange,
  onSave,
  onClear,
  projectId,
  onProjectIdCommit
}: ApiUsageKeyFieldViewProps): ReactElement {
  const copy = API_USAGE_KEY_COPY[provider]
  const [projectDraft, setProjectDraft] = useState(projectId ?? '')
  useEffect(() => {
    setProjectDraft(projectId ?? '')
  }, [projectId])
  const storageUnavailable = !encryptionAvailable
  return (
    <section className="settings-api-usage-key" data-provider={provider} aria-label={copy.label}>
      <label className="settings-label">{copy.label}</label>
      <div style={{ display: 'flex', gap: 'var(--space-sm)', marginBottom: 'var(--space-xs)' }}>
        <input
          className="settings-select"
          type="password"
          autoComplete="off"
          value={draft}
          disabled={busy || storageUnavailable}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder={configured ? '••••••••••• (saved)' : copy.placeholder}
          style={{ flex: 1 }}
        />
        <PillButton
          size="compact"
          variant="primary"
          disabled={busy || storageUnavailable || !draft.trim()}
          onClick={onSave}
        >
          Save
        </PillButton>
        {configured && (
          <PillButton size="compact" variant="danger" disabled={busy} onClick={onClear}>
            Clear
          </PillButton>
        )}
      </div>
      {provider === 'openai' && onProjectIdCommit && (
        <>
          <label className="settings-label">OpenAI project ID (optional)</label>
          <input
            className="settings-select"
            type="text"
            autoComplete="off"
            value={projectDraft}
            disabled={busy}
            placeholder="proj_… — leave blank for the whole organisation"
            onChange={(event) => setProjectDraft(event.target.value)}
            onBlur={() => onProjectIdCommit(projectDraft.trim())}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onProjectIdCommit(projectDraft.trim())
            }}
            style={{ width: '100%', marginBottom: 'var(--space-xs)' }}
          />
        </>
      )}
      <p className="settings-hint">
        {storageUnavailable
          ? 'Secure storage is unavailable on this system, so usage-reporting keys cannot be saved here.'
          : copy.hint}
        {configured && updatedAt ? ` Saved ${new Date(updatedAt).toLocaleString()}.` : ''}
      </p>
      {error ? <p className="settings-provider-auth-error">{error}</p> : null}
    </section>
  )
}

interface ApiUsageKeyStatus {
  configured: boolean
  encryptionAvailable: boolean
  updatedAt?: string
}

export interface ApiUsageKeyFieldProps {
  provider: ApiUsageKeyProvider
}

export function ApiUsageKeyField({ provider }: ApiUsageKeyFieldProps): ReactElement {
  const [status, setStatus] = useState<ApiUsageKeyStatus>({
    configured: false,
    encryptionAvailable: true
  })
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // OpenAI only: the optional project id is a plain (non-secret) setting under
  // `apiUsageBilling.openai`, self-fetched and merged the way the API usage
  // anchors card does, so no new Settings prop plumbing is needed.
  const [billing, setBilling] = useState<ApiUsageBillingSettings | undefined>()
  useEffect(() => {
    if (provider !== 'openai') return
    const api = typeof window === 'undefined' ? undefined : window.api
    if (typeof api?.getSettings !== 'function') return
    let cancelled = false
    void api
      .getSettings()
      .then((settings) => {
        if (!cancelled) setBilling(normalizeApiUsageBillingSettings(settings.apiUsageBilling))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [provider])
  const commitProjectId = useCallback(
    async (value: string) => {
      const api = typeof window === 'undefined' ? undefined : window.api
      if (typeof api?.updateSettings !== 'function') return
      const projectId = normalizeOpenAiProjectId(value)
      const { openai: _previous, ...rest } = billing ?? {}
      const next = normalizeApiUsageBillingSettings({
        ...rest,
        ...(projectId ? { openai: { projectId } } : {})
      })
      try {
        await api.updateSettings({ apiUsageBilling: next ?? null })
        setBilling(next)
      } catch {
        setError('The project ID could not be saved.')
      }
    },
    [billing]
  )

  const refresh = useCallback(async () => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (typeof api?.getApiUsageKeyStatus !== 'function') return
    try {
      const next = await api.getApiUsageKeyStatus(provider)
      if (next) setStatus(next)
    } catch {
      // Status is advisory; leave the last projection in place.
    }
  }, [provider])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = useCallback(async () => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (typeof api?.setApiUsageKey !== 'function' || !draft.trim()) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.setApiUsageKey(provider, draft.trim())
      if (result?.ok) {
        setDraft('')
        setStatus(result.status)
      } else {
        setError(describeMutationError(result?.error))
      }
    } catch {
      setError('The key could not be saved.')
    } finally {
      setBusy(false)
      void refresh()
    }
  }, [draft, provider, refresh])

  const clear = useCallback(async () => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (typeof api?.clearApiUsageKey !== 'function') return
    setBusy(true)
    setError(null)
    try {
      const result = await api.clearApiUsageKey(provider)
      if (result?.ok) setStatus(result.status)
      else setError(describeMutationError(result?.error))
    } catch {
      setError('The key could not be removed.')
    } finally {
      setBusy(false)
      void refresh()
    }
  }, [provider, refresh])

  return (
    <ApiUsageKeyFieldView
      provider={provider}
      configured={status.configured}
      encryptionAvailable={status.encryptionAvailable}
      updatedAt={status.updatedAt}
      draft={draft}
      busy={busy}
      error={error}
      onDraftChange={setDraft}
      onSave={() => void save()}
      onClear={() => void clear()}
      projectId={billing?.openai?.projectId}
      onProjectIdCommit={provider === 'openai' ? (value) => void commitProjectId(value) : undefined}
    />
  )
}

export function describeMutationError(error: string | undefined): string {
  switch (error) {
    case 'invalidApiKey':
      return 'Enter a key before saving.'
    case 'encryptionUnavailable':
      return 'Secure storage is unavailable, so the key was not saved.'
    case 'existingRecordUnreadable':
      return 'The stored key could not be read. Clear it, then save the new one.'
    case 'unavailable':
      return 'Key storage is not ready yet. Try again in a moment.'
    default:
      return 'The key could not be saved.'
  }
}
