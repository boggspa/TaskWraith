import { useCallback, useEffect, useRef, useState } from 'react'
import type { OutlookConnectionStatus } from '../../../main/outlook/OutlookCredentialStore'

/**
 * Connect / disconnect a Microsoft account for the Outlook mail + calendar
 * lane. Sign-in is device code: this card shows the short code and the
 * Microsoft URL, and the user completes it in their own browser. The card
 * never sees a token — connection state is a status projection.
 *
 * Read-only scopes by default. Write access (drafts, sending, calendar
 * writes) is a separate, explicit opt-in, and even then every send stays
 * behind a per-action approval prompt.
 */

export interface OutlookConnectionCardProps {
  /** Test seam: preloaded status, skipping the initial fetch. */
  initialStatus?: OutlookConnectionStatus | null
  /** Test seam: renders the pending device-code state. */
  initialPending?: { userCode: string; verificationUri: string; message: string } | null
  /** Test seam: preset error copy. */
  initialError?: string | null
}

const POLL_INTERVAL_MS = 5_000

export function OutlookConnectionCard({
  initialStatus = null,
  initialPending = null,
  initialError = null
}: OutlookConnectionCardProps) {
  const [status, setStatus] = useState<OutlookConnectionStatus | null>(initialStatus)
  const [clientId, setClientId] = useState('')
  const [tenant, setTenant] = useState('')
  const [wantsWrite, setWantsWrite] = useState(false)
  const [pending, setPending] = useState(initialPending)
  const [error, setError] = useState<string | null>(initialError)
  const [busy, setBusy] = useState(false)
  const pollTimerRef = useRef<number | null>(null)

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await window.api.getOutlookStatus())
    } catch {
      // Status is best-effort; the card still renders its connect form.
    }
  }, [])

  useEffect(() => {
    if (!initialStatus) void refreshStatus()
    return () => {
      if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current)
    }
  }, [initialStatus, refreshStatus])

  // Self-scheduling poll: a ref breaks the reference cycle the callback
  // would otherwise have with itself.
  const pollRef = useRef<() => Promise<void>>(async () => undefined)

  const poll = useCallback(async () => {
    try {
      const result = await window.api.pollOutlookSignIn()
      if (result.status === 'pending') {
        pollTimerRef.current = window.setTimeout(() => void pollRef.current(), POLL_INTERVAL_MS)
        return
      }
      setPending(null)
      setBusy(false)
      if (result.status === 'connected') {
        setStatus(result.connection)
        setClientId('')
        return
      }
      if (result.status === 'declined') setError('Sign-in was declined in the browser.')
      else if (result.status === 'expired') setError('The sign-in code expired. Try again.')
      else if (result.status === 'error') setError(result.message)
    } catch {
      setPending(null)
      setBusy(false)
      setError('Sign-in could not be completed.')
    }
  }, [])
  pollRef.current = poll

  const startSignIn = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const started = await window.api.startOutlookSignIn({
        clientId: clientId.trim(),
        tenant: tenant.trim() || undefined,
        scopeMode: wantsWrite ? 'write' : 'read'
      })
      if (!started.ok) {
        setError(started.error)
        setBusy(false)
        return
      }
      setPending({
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        message: started.message
      })
      pollTimerRef.current = window.setTimeout(() => void poll(), POLL_INTERVAL_MS)
    } catch {
      setError('Sign-in could not start.')
      setBusy(false)
    }
  }, [clientId, poll, tenant, wantsWrite])

  const disconnect = useCallback(async () => {
    setBusy(true)
    try {
      setStatus(await window.api.disconnectOutlook())
      setPending(null)
      setError(null)
    } finally {
      setBusy(false)
    }
  }, [])

  const encryptionUnavailable = status !== null && !status.encryptionAvailable

  return (
    <section className="outlook-connection-card">
      <header className="outlook-card-header">
        <div>
          <h3>Microsoft account</h3>
          <p className="outlook-card-subtitle">
            Read Outlook mail and calendar in the Office panel and, when connected, through
            approval-gated agent tools.
          </p>
        </div>
        <span
          className={`outlook-status-dot ${status?.connected ? 'connected' : 'not-available'}`}
          aria-hidden="true"
        />
      </header>

      {encryptionUnavailable ? (
        <p className="outlook-card-warning">
          This device cannot encrypt stored credentials, so a Microsoft account cannot be connected
          here. Nothing is ever written in plain text.
        </p>
      ) : null}

      {status?.connected ? (
        <div className="outlook-connected">
          <p>
            Connected{status.account ? ` as ${status.account}` : ''}
            {status.scopeMode === 'write' ? ' · read + write' : ' · read-only'}
            {status.updatedAt ? ` · since ${status.updatedAt.slice(0, 10)}` : ''}
          </p>
          <button type="button" disabled={busy} onClick={() => void disconnect()}>
            Disconnect
          </button>
        </div>
      ) : pending ? (
        <div className="outlook-pending">
          <p>
            Open <strong>{pending.verificationUri}</strong> and enter this code:
          </p>
          <p className="outlook-user-code">{pending.userCode}</p>
          <p className="outlook-card-subtitle">
            Waiting for you to finish signing in… Microsoft asks for your credentials in your own
            browser; nothing is typed here.
          </p>
        </div>
      ) : (
        <div className="outlook-connect-form">
          <label className="outlook-field">
            <span>Application (client) ID</span>
            <input
              value={clientId}
              autoComplete="off"
              spellCheck={false}
              placeholder="00000000-0000-0000-0000-000000000000"
              onChange={(event) => setClientId(event.target.value)}
            />
          </label>
          <label className="outlook-field">
            <span>Tenant (optional)</span>
            <input
              value={tenant}
              autoComplete="off"
              spellCheck={false}
              placeholder="common"
              onChange={(event) => setTenant(event.target.value)}
            />
          </label>
          <label className="outlook-field-inline">
            <input
              type="checkbox"
              checked={wantsWrite}
              onChange={(event) => setWantsWrite(event.target.checked)}
            />
            <span>
              Also allow creating drafts and calendar entries. Nothing is ever sent — drafts wait
              in Outlook for you to send them, and TaskWraith never requests permission to send.
            </span>
          </label>
          <p className="outlook-card-subtitle">
            Requires your own Microsoft Entra app registration with public client flows enabled.
            TaskWraith stores no client secret.
          </p>
          <button
            type="button"
            disabled={busy || encryptionUnavailable || clientId.trim().length === 0}
            onClick={() => void startSignIn()}
          >
            Connect Microsoft account
          </button>
        </div>
      )}

      {error ? (
        <p className="outlook-card-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}
