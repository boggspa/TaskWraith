import { useEffect, useState } from 'react'
import { useAppVersion } from '../hooks/useAppVersion'

const REPORT_FIELDS = [
  ['schema', '1'],
  ['event', 'app_active'],
  ['day', 'UTC day only'],
  ['appVersion', 'TaskWraith version'],
  ['platform', 'macos, windows, or linux'],
  ['architecture', 'arm64, x64, universal, or unknown'],
  ['channel', 'stable or nightly']
] as const

const PRESENCE_FIELDS = [
  ['schema', '1'],
  ['event', 'app_presence'],
  ['lease', 'random for this app run only']
] as const

export function ActivityReportingSettings(): React.JSX.Element {
  const appVersion = useAppVersion()
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const endpointConfigured = __TASKWRAITH_ACTIVITY_REPORTING_CONFIGURED__

  useEffect(() => {
    let cancelled = false
    void window.api
      .getSettings()
      .then((settings) => {
        if (!cancelled) setEnabled(Boolean(settings.activityReportingEnabled))
      })
      .catch(() => {
        if (!cancelled) setError('Activity reporting preference is unavailable.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const updateEnabled = (next: boolean): void => {
    setEnabled(next)
    setLoading(true)
    setError('')
    void window.api
      .updateSettings({ activityReportingEnabled: next })
      .catch(() => {
        setEnabled(!next)
        setError('TaskWraith could not save this preference.')
      })
      .finally(() => setLoading(false))
  }

  return (
    <div className="settings-group span-all">
      <div className="settings-safety-section-title">
        <h4 className="sidebar-section-title" style={{ margin: 0 }}>
          Product observation
        </h4>
        <p className="settings-hint">
          Privacy-minimised activity reporting helps measure release adoption, update health, and an
          approximate live app count. It is never used for advertising or individual profiling.
        </p>
      </div>

      <label className="settings-service-row">
        <span>
          <strong>Share privacy-minimised activity and live presence</strong>
          <small style={{ display: 'block' }}>
            At most one no-ID check-in per UTC day, plus a short-lived lease while TaskWraith is
            running. No prompts, workspaces, provider choices, or stable installation identifier.
          </small>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          disabled={loading || (!endpointConfigured && !enabled)}
          onChange={(event) => updateEnabled(event.target.checked)}
        />
      </label>
      <p className="settings-hint" role="note">
        TaskWraith enables this minimal reporting by default to help the maintainer understand
        demand and sustain the free, open-source project. You can switch it off at any time; doing
        so does not limit any feature.
      </p>

      {!endpointConfigured && (
        <p className="settings-hint" role="status">
          This build has no TaskWraith activity endpoint configured, so it sends no activity reports
          even when the preference is on. You can still switch the preference off here.
        </p>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}

      <details>
        <summary>Inspect the complete data contracts</summary>
        <p className="settings-hint">
          The running version is {appVersion}. The day, platform, architecture, and release channel
          are resolved only for the daily check-in.
        </p>
        <strong>Daily check-in</strong>
        <div className="settings-safety-policy-list">
          {REPORT_FIELDS.map(([field, value]) => (
            <div className="settings-safety-policy-row tone-safe" key={field}>
              <code>{field}</code>
              <span>{value}</span>
            </div>
          ))}
        </div>
        <p className="settings-hint">
          A separate live-presence lease uses only the fields below. Its random value exists for one
          app run, is held only in receiver memory, and expires within about three minutes. It is
          never written into the analytics database or exposed to the dashboard.
        </p>
        <strong>Volatile live presence</strong>
        <div className="settings-safety-policy-list">
          {PRESENCE_FIELDS.map(([field, value]) => (
            <div className="settings-safety-policy-row tone-safe" key={field}>
              <code>{field}</code>
              <span>{value}</span>
            </div>
          ))}
        </div>
        <p className="settings-hint">
          Read the full{' '}
          <a href="https://github.com/boggspa/TaskWraith/blob/master/PRIVACY.md">privacy notice</a>.
        </p>
      </details>
    </div>
  )
}
