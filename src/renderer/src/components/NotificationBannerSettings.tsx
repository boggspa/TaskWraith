import { useEffect, useMemo, useState } from 'react'
import {
  ACTIVITY_ARCHETYPE_PRESETS,
  BANNER_PRESETS,
  BANNER_STATUS_KEYS,
  DEFAULT_ACTIVITY_ARCHETYPE,
  DEFAULT_BANNER_TEMPLATE,
  matchBannerPreset,
  renderBannerPreview,
  sanitizeBannerTemplate,
  type ActivityArchetype,
  type BannerStatusKey,
  type BannerTemplate
} from '../../../shared/bannerTemplate'

/** Sample run used for the preview. Fixed rather than pulled from a real chat:
 * the point is to compare presets, and a preview that changes underneath you as
 * runs finish makes that impossible. */
const SAMPLE = {
  title: 'Codex',
  preview: 'Refactored the completion banner renderer. Tests pass.',
  filesChanged: 3,
  additions: 128,
  deletions: 44
} as const

const STATUS_LABELS: Record<BannerStatusKey, string> = {
  success: 'Finished',
  warning: 'Warnings',
  error: 'Failed',
  quota: 'Quota wall',
  cancelled: 'Cancelled'
}

export function NotificationBannerSettings(): React.JSX.Element {
  const [template, setTemplate] = useState<BannerTemplate>(DEFAULT_BANNER_TEMPLATE)
  const [status, setStatus] = useState<BannerStatusKey>('success')
  const [archetype, setArchetype] = useState<ActivityArchetype>(DEFAULT_ACTIVITY_ARCHETYPE)
  const [activityEnabled, setActivityEnabled] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void window.api
      .getSettings()
      .then((settings) => {
        if (cancelled) return
        setTemplate(sanitizeBannerTemplate(settings.iosBannerTemplate))
        setArchetype(settings.iosActivityArchetype ?? DEFAULT_ACTIVITY_ARCHETYPE)
        setActivityEnabled(settings.iosActivityEnabled !== false)
      })
      .catch(() => {
        if (!cancelled) setError('Banner preference is unavailable.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const selectedPresetId = useMemo(() => matchBannerPreset(template), [template])
  const rendered = useMemo(
    () => renderBannerPreview({ ...SAMPLE, status }, template),
    [template, status]
  )

  const choosePreset = (presetId: string): void => {
    const preset = BANNER_PRESETS.find((p) => p.id === presetId)
    if (!preset) return
    const next = sanitizeBannerTemplate(preset.template)
    setTemplate(next)
    setError('')
    // 'default' persists as undefined rather than a copy of the built-in: an
    // absent value keeps following the built-in wording if it ever changes,
    // where a stored copy would pin this build's strings forever.
    void window.api
      .updateSettings({ iosBannerTemplate: preset.id === 'default' ? undefined : next })
      .catch(() => setError('Could not save. Your phone still has the previous wording.'))
  }

  const chooseArchetype = (next: ActivityArchetype): void => {
    setArchetype(next)
    setError('')
    void window.api
      .updateSettings({ iosActivityArchetype: next })
      .catch(() => setError('Could not save. Your phone still has the previous layout.'))
  }

  const toggleActivities = (next: boolean): void => {
    setActivityEnabled(next)
    setError('')
    void window.api
      .updateSettings({ iosActivityEnabled: next })
      .catch(() => setError('Could not save. Your phone still has the previous setting.'))
  }

  return (
    <div className="settings-section">
      <h3>Notification banners</h3>
      <p className="settings-description">
        How run-complete notifications are worded on your paired iPhone or iPad. Applies to both the
        banner you see with TaskWraith open and the one that arrives while it is closed — they use
        the same renderer. Changes reach paired devices immediately, and again next time a device
        reconnects.
      </p>

      {error ? <p className="settings-error">{error}</p> : null}

      <div className="settings-banner-preview" aria-live="polite">
        <div className="settings-banner-preview__chrome">
          <div className="settings-banner-preview__title">{rendered.title}</div>
          {rendered.body.split('\n').map((line, i) => (
            <div key={i} className="settings-banner-preview__body">
              {line}
            </div>
          ))}
        </div>
        <div className="settings-banner-preview__statuses" role="group" aria-label="Preview state">
          {BANNER_STATUS_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className={status === key ? 'is-selected' : undefined}
              aria-pressed={status === key}
              onClick={() => setStatus(key)}
            >
              {STATUS_LABELS[key]}
            </button>
          ))}
        </div>
      </div>

      <fieldset className="settings-banner-presets" disabled={loading}>
        <legend>Style</legend>
        {BANNER_PRESETS.map((preset) => (
          <label key={preset.id} className="settings-banner-presets__option">
            <input
              type="radio"
              name="banner-preset"
              value={preset.id}
              checked={selectedPresetId === preset.id}
              onChange={() => choosePreset(preset.id)}
            />
            <span>
              <strong>{preset.label}</strong>
              <span className="settings-description">{preset.description}</span>
            </span>
          </label>
        ))}
        {selectedPresetId === null ? (
          <p className="settings-description">
            Your current wording is a custom template that doesn&apos;t match any style above —
            picking one will replace it.
          </p>
        ) : null}
      </fieldset>

      <h3>Live Activities</h3>
      <p className="settings-description">
        A live card on your iPhone&apos;s lock screen and Dynamic Island while a run is working.
        Success and failure use your diff colours, so the palette matches the app. Your phone&apos;s
        own Settings &rsaquo; TaskWraith &rsaquo; Live Activities switch still has the final say.
      </p>
      <p className="settings-description">
        Updates only reach the card while your phone can talk to this Mac. If it loses contact the
        card says so rather than leaving a timer running.
      </p>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={activityEnabled}
          disabled={loading}
          onChange={(e) => toggleActivities(e.target.checked)}
        />
        <span className="settings-toggle-label">{activityEnabled ? 'On' : 'Off'}</span>
      </label>

      <fieldset className="settings-banner-presets" disabled={loading || !activityEnabled}>
        <legend>Layout</legend>
        {ACTIVITY_ARCHETYPE_PRESETS.map((preset) => (
          <label key={preset.id} className="settings-banner-presets__option">
            <input
              type="radio"
              name="activity-archetype"
              value={preset.id}
              checked={archetype === preset.id}
              onChange={() => chooseArchetype(preset.id)}
            />
            <span>
              <strong>{preset.label}</strong>
              <span className="settings-description">{preset.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  )
}
