import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type {
  UsageWebSessionProviderId,
  UsageWebSessionStatus
} from '../../../shared/usageWebSession'
import { PillButton } from './PillButton'

const LABELS: Record<UsageWebSessionProviderId, string> = {
  meta: 'Meta API',
  muse: 'Muse Code subscription',
  cerebras: 'Cerebras API',
  qwen: 'Qwen Token Plan',
  mimo: 'Xiaomi MiMo Token Plan'
}

const HOSTS: Record<UsageWebSessionProviderId, string> = {
  meta: 'dev.meta.ai/billing',
  muse: 'dev.meta.ai/usage',
  cerebras: 'cloud.cerebras.ai/platform',
  qwen: 'modelstudio.console.alibabacloud.com',
  mimo: 'platform.xiaomimimo.com'
}

export interface UsageWebSessionControlViewProps {
  provider: UsageWebSessionProviderId
  status: UsageWebSessionStatus | null
  busy: boolean
  error: string | null
  onImport: () => void
  onClear: () => void
}

export function UsageWebSessionControlView({
  provider,
  status,
  busy,
  error,
  onImport,
  onClear
}: UsageWebSessionControlViewProps): ReactElement {
  const configured = status?.configured === true
  return (
    <div className="settings-provider-web-session" data-usage-web-session={provider}>
      <p className="settings-provider-auth-footnote">
        Sign in to {HOSTS[provider]} in an isolated browser window. TaskWraith stores the captured
        session with system encryption and returns only display-ready usage to this page.
      </p>
      <div className="settings-provider-auth-actions">
        <PillButton size="compact" variant="primary" onClick={onImport} disabled={busy}>
          {configured ? 'Re-import web session…' : 'Import web session…'}
        </PillButton>
        <PillButton
          size="compact"
          variant="danger"
          onClick={onClear}
          disabled={busy || !configured}
        >
          Clear session
        </PillButton>
      </div>
      {configured ? (
        <p className="settings-provider-auth-footnote">
          {LABELS[provider]} session imported
          {status?.updatedAt
            ? ` ${new Date(status.updatedAt).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric'
              })}`
            : ''}
          .
        </p>
      ) : status && !status.encryptionAvailable ? (
        <p className="settings-provider-auth-error">
          System encryption is unavailable, so this browser session cannot be stored.
        </p>
      ) : null}
      {error ? <p className="settings-provider-auth-error">{error}</p> : null}
    </div>
  )
}

export function UsageWebSessionControls({
  provider
}: {
  provider: UsageWebSessionProviderId
}): ReactElement {
  const [status, setStatus] = useState<UsageWebSessionStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const api = window.api
    if (typeof api?.getUsageWebSessionStatus === 'function') {
      void api
        .getUsageWebSessionStatus(provider)
        .then((nextStatus) => {
          if (!cancelled) setStatus(nextStatus)
        })
        .catch(() => {
          if (!cancelled) setStatus(null)
        })
    }
    return () => {
      cancelled = true
    }
  }, [provider])

  const importSession = useCallback(async () => {
    if (typeof window.api?.importUsageWebSession !== 'function') return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.importUsageWebSession(provider)
      if (result.ok) setStatus(result.status)
      else if (result.reason !== 'cancelled') {
        setError(
          result.reason === 'storeFailed'
            ? 'The validated session could not be stored securely.'
            : `Could not import the ${LABELS[provider]} browser session.`
        )
      }
    } catch {
      setError(`Could not import the ${LABELS[provider]} browser session.`)
    } finally {
      setBusy(false)
    }
  }, [provider])

  const clearSession = useCallback(async () => {
    if (typeof window.api?.clearUsageWebSession !== 'function') return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.clearUsageWebSession(provider)
      if (result.ok) setStatus(result.status)
      else setError(`Could not clear the ${LABELS[provider]} browser session.`)
    } catch {
      setError(`Could not clear the ${LABELS[provider]} browser session.`)
    } finally {
      setBusy(false)
    }
  }, [provider])

  return (
    <UsageWebSessionControlView
      provider={provider}
      status={status}
      busy={busy}
      error={error}
      onImport={() => void importSession()}
      onClear={() => void clearSession()}
    />
  )
}
