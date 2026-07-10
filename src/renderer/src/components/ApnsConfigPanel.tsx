import React, { useCallback, useEffect, useState } from 'react'
import { PillButton } from './PillButton'

/**
 * ApnsConfigPanel — Phase E1 (iOS bridge gap #1) Settings UI for the
 * Apple Push Notification credentials used to wake a paired iPhone.
 *
 * Design constraints:
 *   - Cleartext .p8 PEM NEVER reaches the renderer. We only ever
 *     hand main a file path; main reads + encrypts via `safeStorage`
 *     and persists the encrypted blob in `AppSettings.apnsConfig`.
 *   - The redacted `get-apns-config` response tells us whether the
 *     key is configured, when, and the most recent test-push outcome.
 *   - "Test push" iterates registered iOS device tokens (via
 *     `BridgeApnsTokenStore.list()` in main) and sends a silent
 *     notification per device, reporting delivered/failed counts.
 *
 * This panel lives in the Bridge Networking Settings tab alongside
 * `BridgeNetworkingPanel` because the two concerns are coupled: APNs
 * is how a paired iPhone gets woken when off-LAN.
 */

type LastTestResult = {
  at: string
  delivered: number
  failed: number
  error?: string
}

type ApnsStatus = {
  configured: boolean
  keyId?: string
  teamId?: string
  bundleId?: string
  defaultBundleId: string
  configuredAt?: string
  lastTestResult?: LastTestResult
  encryptionAvailable: boolean
  registeredDeviceCount: number
  pusherIsNoop: boolean
}

const HELP_BLURB =
  'Required: an Auth Key (.p8) created in Apple Developer → Keys, the 10-character Key ID it was issued under, and your 10-character Team ID. The bundle ID defaults to the iOS companion app and only needs changing if you ship a custom build.'

export function ApnsConfigPanel(): React.JSX.Element {
  const [status, setStatus] = useState<ApnsStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const [keyIdDraft, setKeyIdDraft] = useState('')
  const [teamIdDraft, setTeamIdDraft] = useState('')
  const [bundleIdDraft, setBundleIdDraft] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [clearing, setClearing] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const result = await window.api.getApnsConfig()
      setStatus(result)
      // Seed the form drafts from the current persisted values so the
      // user can edit incrementally without retyping everything.
      setKeyIdDraft(result.keyId ?? '')
      setTeamIdDraft(result.teamId ?? '')
      setBundleIdDraft(result.bundleId ?? result.defaultBundleId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(() => refresh())
  }, [refresh])

  const pickFile = useCallback(async () => {
    try {
      const path = await window.api.selectApnsKeyFile()
      if (path) {
        setSelectedPath(path)
        setInfo(null)
        setError(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const save = useCallback(async () => {
    setSaving(true)
    setError(null)
    setInfo(null)
    try {
      const response = await window.api.setApnsConfig({
        authKeyPath: selectedPath ?? undefined,
        keyId: keyIdDraft.trim(),
        teamId: teamIdDraft.trim(),
        bundleId: bundleIdDraft.trim() || undefined
      })
      if (!response.ok) {
        setError(response.error || 'Failed to save APNs configuration.')
        return
      }
      setInfo(selectedPath ? 'Saved. Auth key encrypted via macOS Keychain.' : 'Saved.')
      setSelectedPath(null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [bundleIdDraft, keyIdDraft, refresh, selectedPath, teamIdDraft])

  const clear = useCallback(async () => {
    if (
      !window.confirm(
        'Clear the saved APNs auth key and IDs? Paired iPhones will stop receiving push notifications until you reconfigure.'
      )
    ) {
      return
    }
    setClearing(true)
    setError(null)
    setInfo(null)
    try {
      const response = await window.api.clearApnsConfig()
      if (!response.ok) {
        setError('Failed to clear APNs configuration.')
        return
      }
      setSelectedPath(null)
      setInfo('Cleared.')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setClearing(false)
    }
  }, [refresh])

  const testPush = useCallback(async () => {
    setTesting(true)
    setError(null)
    setInfo(null)
    try {
      const result = await window.api.testApnsPush()
      if (!result.ok) {
        setError(
          result.error ||
            `Test push failed (delivered=${result.delivered ?? 0}, failed=${result.failed ?? 0}).`
        )
      } else {
        setInfo(
          `Test push delivered to ${result.delivered ?? 0} device(s).` +
            (result.failed ? ` ${result.failed} failed.` : '')
        )
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setTesting(false)
    }
  }, [refresh])

  const hasUnsavedChanges =
    selectedPath !== null ||
    keyIdDraft.trim() !== (status?.keyId ?? '') ||
    teamIdDraft.trim() !== (status?.teamId ?? '') ||
    bundleIdDraft.trim() !== (status?.bundleId ?? status?.defaultBundleId ?? '')

  const canSave = Boolean(
    keyIdDraft.trim() &&
    teamIdDraft.trim() &&
    // Either we already have a stored key, OR the user just picked a new one.
    (status?.configured || selectedPath)
  )

  return (
    <div className="bridge-networking-panel apns-config-panel">
      <div className="bridge-networking-header">
        <label className="settings-label">Apple Push Notifications (APNs)</label>
        <div className="settings-hint">
          Wakes a paired iPhone when an approval is needed off-LAN. {HELP_BLURB}
        </div>
      </div>

      {error && <div className="settings-error">{error}</div>}
      {info && <div className="settings-hint apns-config-info">{info}</div>}

      {/* Live "inert but devices registered" warning: the persisted config can
          read as configured while the running pusher is the Noop (e.g. the .p8
          failed to decrypt at startup), so paired phones silently get no push. */}
      {status?.pusherIsNoop && (status?.registeredDeviceCount ?? 0) > 0 && (
        <div className="settings-warning">
          APNs is not active — {status.registeredDeviceCount} paired device
          {status.registeredDeviceCount === 1 ? '' : 's'} will not receive push
          notifications. Add your .p8 key, Key ID, and Team ID below.
        </div>
      )}

      <section className="bridge-networking-section">
        <header className="bridge-networking-section-header">
          <span className="bridge-networking-section-title">Status</span>
          <StatusPill
            kind={status?.pusherIsNoop ? 'warn' : status?.configured ? 'ok' : 'idle'}
            label={status?.configured ? 'Configured' : 'Not configured'}
          />
        </header>
        <dl className="bridge-networking-fields">
          <Field
            label="Encryption"
            value={
              status?.encryptionAvailable
                ? 'macOS Keychain available'
                : 'Unavailable — cannot save key securely'
            }
          />
          <Field label="Registered devices" value={String(status?.registeredDeviceCount ?? 0)} />
          {status?.configuredAt && (
            <Field label="Last saved" value={new Date(status.configuredAt).toLocaleString()} />
          )}
          {status?.lastTestResult && (
            <Field
              label="Last test push"
              value={`${new Date(status.lastTestResult.at).toLocaleString()} — delivered ${status.lastTestResult.delivered}, failed ${status.lastTestResult.failed}${status.lastTestResult.error ? ` (${status.lastTestResult.error})` : ''}`}
            />
          )}
        </dl>
      </section>

      <section className="bridge-networking-section">
        <header className="bridge-networking-section-header">
          <span className="bridge-networking-section-title">Credentials</span>
          {hasUnsavedChanges && <StatusPill kind="warn" label="Unsaved changes" />}
        </header>

        <div className="apns-config-form">
          <label className="apns-config-field">
            <span className="apns-config-field-label">Auth Key (.p8)</span>
            <div className="apns-config-file-row">
              <PillButton
                size="compact"
                onClick={() => void pickFile()}
                disabled={saving || !status?.encryptionAvailable}
              >
                Choose .p8…
              </PillButton>
              <span className="apns-config-file-path">
                {selectedPath
                  ? selectedPath
                  : status?.configured
                    ? 'Auth key on file (encrypted)'
                    : 'No file selected'}
              </span>
            </div>
          </label>

          <label className="apns-config-field">
            <span className="apns-config-field-label">Key ID</span>
            <input
              type="text"
              className="settings-input apns-config-input"
              value={keyIdDraft}
              maxLength={10}
              placeholder="ABCDE12345"
              onChange={(e) => setKeyIdDraft(e.target.value.trim().toUpperCase())}
              disabled={saving}
            />
          </label>

          <label className="apns-config-field">
            <span className="apns-config-field-label">Team ID</span>
            <input
              type="text"
              className="settings-input apns-config-input"
              value={teamIdDraft}
              maxLength={10}
              placeholder="ABCDE12345"
              onChange={(e) => setTeamIdDraft(e.target.value.trim().toUpperCase())}
              disabled={saving}
            />
          </label>

          <label className="apns-config-field">
            <span className="apns-config-field-label">Bundle ID</span>
            <input
              type="text"
              className="settings-input apns-config-input"
              value={bundleIdDraft}
              placeholder={status?.defaultBundleId}
              onChange={(e) => setBundleIdDraft(e.target.value.trim())}
              disabled={saving}
            />
          </label>
        </div>

        <div className="bridge-networking-actions apns-config-actions">
          <PillButton
            variant="primary"
            size="compact"
            onClick={() => void save()}
            disabled={saving || !canSave}
          >
            {saving ? 'Saving…' : 'Save credentials'}
          </PillButton>
          <PillButton
            size="compact"
            onClick={() => void testPush()}
            disabled={testing || !status?.configured}
            title={
              !status?.configured
                ? 'Save credentials first.'
                : status.registeredDeviceCount === 0
                  ? 'No paired iPhones have registered an APNs device token yet — pair an iPhone first.'
                  : 'Send a silent test push to every registered device.'
            }
          >
            {testing ? 'Sending…' : 'Send test push'}
          </PillButton>
          <PillButton
            variant="danger"
            size="compact"
            onClick={() => void clear()}
            disabled={clearing || !status?.configured}
          >
            {clearing ? 'Clearing…' : 'Clear'}
          </PillButton>
          <PillButton
            size="compact"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </PillButton>
        </div>
      </section>
    </div>
  )
}

function StatusPill({
  kind,
  label
}: {
  kind: 'ok' | 'warn' | 'idle'
  label: string
}): React.JSX.Element {
  return <span className={`bridge-networking-pill bridge-networking-pill-${kind}`}>{label}</span>
}

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="bridge-networking-field">
      <dt className="bridge-networking-field-label">{label}</dt>
      <dd className="bridge-networking-field-value">
        <span>{value}</span>
      </dd>
    </div>
  )
}
