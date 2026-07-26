import { useEffect, useState } from 'react'

const PRIVACY_NOTICE_URL = 'https://github.com/boggspa/TaskWraith/blob/master/PRIVACY.md'

export interface ProductObservationSettingsApi {
  getSettings: () => Promise<{ activityReportingEnabled?: boolean }>
  updateSettings: (patch: { activityReportingEnabled: boolean }) => Promise<void>
  openExternalOrPath?: (href: string) => Promise<unknown>
}

const defaultApi: ProductObservationSettingsApi = {
  getSettings: () => window.api.getSettings(),
  updateSettings: (patch) => window.api.updateSettings(patch),
  openExternalOrPath: (href) => window.api.openExternalOrPath(href)
}

export async function readProductObservationChoice(
  api: ProductObservationSettingsApi
): Promise<boolean> {
  const settings = await api.getSettings()
  return settings.activityReportingEnabled === true
}

export async function saveProductObservationChoice(
  api: ProductObservationSettingsApi,
  enabled: boolean
): Promise<boolean> {
  await api.updateSettings({ activityReportingEnabled: enabled })
  return enabled
}

export function FirstLaunchProductObservation({
  api = defaultApi
}: {
  api?: ProductObservationSettingsApi
}): React.JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void readProductObservationChoice(api)
      .then((current) => {
        if (!cancelled) setEnabled(current)
      })
      .catch(() => {
        if (!cancelled) {
          setEnabled(false)
          setError('TaskWraith could not load this privacy choice. Reporting remains off.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [api])

  const choose = (next: boolean): void => {
    const previous = enabled
    setEnabled(next)
    setSaving(true)
    setError('')
    void saveProductObservationChoice(api, next)
      .then(setEnabled)
      .catch(() => {
        setEnabled(previous)
        setError('TaskWraith could not save this privacy choice.')
      })
      .finally(() => setSaving(false))
  }

  const openPrivacyNotice = (event: React.MouseEvent<HTMLAnchorElement>): void => {
    if (!api.openExternalOrPath) return
    event.preventDefault()
    void api.openExternalOrPath(PRIVACY_NOTICE_URL)
  }

  const disabled = enabled === null || saving

  return (
    <section
      className="first-launch-sheet-section first-launch-observation"
      aria-labelledby="first-launch-observation-title"
    >
      <div className="first-launch-observation-heading">
        <div>
          <h3 className="first-launch-sheet-section-title" id="first-launch-observation-title">
            Product observation — choose now
          </h3>
          <p className="first-launch-sheet-section-helper">
            Help the maintainer understand adoption and release health with a tiny, fixed,
            no-content report, or keep first-party observation off. Both choices keep every
            TaskWraith feature.
          </p>
        </div>
        <span className="first-launch-observation-badge">Optional</span>
      </div>

      <div
        className="first-launch-observation-choices"
        role="group"
        aria-label="Product observation choice"
        aria-busy={saving}
      >
        <button
          className="first-launch-observation-choice"
          type="button"
          aria-pressed={enabled === true}
          disabled={disabled}
          onClick={() => choose(true)}
        >
          <span className="first-launch-observation-choice-mark" aria-hidden>
            {enabled === true ? '✓' : ''}
          </span>
          <span>
            <strong>Share minimal activity</strong>
            <small>
              At most one daily check-in with app version, OS family, processor family, and release
              channel, plus a short-lived RAM-only live-presence lease.
            </small>
          </span>
        </button>

        <button
          className="first-launch-observation-choice"
          type="button"
          aria-pressed={enabled === false}
          disabled={disabled}
          onClick={() => choose(false)}
        >
          <span className="first-launch-observation-choice-mark" aria-hidden>
            {enabled === false ? '✓' : ''}
          </span>
          <span>
            <strong>Don&apos;t share</strong>
            <small>
              Send no first-party activity check-ins or live-presence requests. TaskWraith works
              exactly the same.
            </small>
          </span>
        </button>
      </div>

      <p className="first-launch-observation-boundary" role="note">
        <strong>Off until you choose Share.</strong> Reports never include prompts, conversations,
        code, filenames, workspace paths, provider or model choices, token usage, location, or a
        stable installation ID. If you share, the endpoint necessarily handles connection metadata
        such as an IP address for the request; it is not stored in the analytics database.
      </p>
      <p className="first-launch-sheet-section-helper">
        Change this any time in <strong>Settings → Safety &amp; Privacy</strong>. Read the complete{' '}
        <a href={PRIVACY_NOTICE_URL} onClick={openPrivacyNotice}>
          privacy notice
        </a>
        .
      </p>

      {enabled === null && !error && (
        <p className="first-launch-observation-status" role="status">
          Loading your current choice…
        </p>
      )}
      {enabled !== null && (
        <p className="first-launch-observation-status" role="status">
          Current choice: {enabled ? 'Share minimal activity' : 'Don’t share'}
          {saving ? ' — saving…' : ''}
        </p>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
