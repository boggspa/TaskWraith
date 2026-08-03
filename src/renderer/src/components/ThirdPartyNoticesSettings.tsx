import { useEffect, useState } from 'react'
import type {
  LicenseNoticeKind,
  LicenseNoticeStatus,
  OpenLicenseNoticeResult
} from '../../../shared/licenseNotices'
import { PillButton } from './PillButton'
import './ThirdPartyNoticesSettings.css'

interface LicenseNoticeApi {
  getStatus: () => Promise<LicenseNoticeStatus>
  open: (kind: LicenseNoticeKind) => Promise<OpenLicenseNoticeResult>
}

const defaultApi: LicenseNoticeApi = {
  getStatus: () => window.api.getLicenseNoticeStatus(),
  open: (kind) => window.api.openLicenseNotice(kind)
}

export interface ThirdPartyNoticesSettingsProps {
  api?: LicenseNoticeApi
}

function formatLicenseCoverage(status: LicenseNoticeStatus | null): string {
  if (!status?.summary) return 'Checking the packaged legal-notice inventory…'
  const identities = status.summary.packageIdentityCount
  const instances = status.summary.packageInstanceCount
  return `${identities.toLocaleString()} unique dependencies across ${instances.toLocaleString()} packaged instances.`
}

export function ThirdPartyNoticesSettings({ api = defaultApi }: ThirdPartyNoticesSettingsProps) {
  const [status, setStatus] = useState<LicenseNoticeStatus | null>(null)
  const [pendingKind, setPendingKind] = useState<LicenseNoticeKind | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void api
      .getStatus()
      .then((next) => {
        if (alive) setStatus(next)
      })
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      alive = false
    }
  }, [api])

  const openNotice = async (kind: LicenseNoticeKind): Promise<void> => {
    setError(null)
    setPendingKind(kind)
    try {
      const result = await api.open(kind)
      if (!result.ok) setError(result.error || 'The legal notice could not be opened.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPendingKind(null)
    }
  }

  const available = status?.available
  const summary = status?.summary
  return (
    <div className="settings-license-page">
      <section className="settings-group settings-license-overview">
        <div className="settings-section-title-row">
          <h4 className="sidebar-section-title">Licenses & Attribution</h4>
          <span className="settings-scope-pill">
            {status?.exactPackagedTree ? 'Verified package' : 'Package-time gate'}
          </span>
        </div>
        <p className="settings-hint">
          TaskWraith generates these notices from the exact dependency tree staged in the
          application. Packaging fails when a dependency has neither retained legal text nor an
          explicit version-and-hash-pinned coverage mapping.
        </p>
        <div className="settings-license-summary" aria-live="polite">
          <strong>{formatLicenseCoverage(status)}</strong>
          {summary && (
            <span>
              {summary.reviewedOverrideCount} reviewed mapping
              {summary.reviewedOverrideCount === 1 ? '' : 's'}; {summary.upstreamLimitationCount}{' '}
              recorded upstream attribution limitation
              {summary.upstreamLimitationCount === 1 ? '' : 's'}.
            </span>
          )}
        </div>
        {status?.message && <p className="settings-hint">{status.message}</p>}
        {error && (
          <p className="settings-error" role="status">
            {error}
          </p>
        )}
      </section>

      <div className="settings-license-grid">
        <article className="settings-license-card">
          <div>
            <h4>TaskWraith</h4>
            <p>
              Application license: {status?.appLicense || 'Apache-2.0'}
              {status?.appVersion ? ` · version ${status.appVersion}` : ''}
            </p>
          </div>
          <PillButton
            size="compact"
            variant="secondary"
            disabled={!available?.taskwraith}
            loading={pendingKind === 'taskwraith'}
            onClick={() => void openNotice('taskwraith')}
          >
            Open app license
          </PillButton>
        </article>

        <article className="settings-license-card">
          <div>
            <h4>Packaged dependencies</h4>
            <p>Copyright, license, NOTICE, and reviewed parent-package attribution.</p>
          </div>
          <PillButton
            size="compact"
            variant="secondary"
            disabled={!available?.['third-party']}
            loading={pendingKind === 'third-party'}
            onClick={() => void openNotice('third-party')}
          >
            Open third-party notices
          </PillButton>
        </article>

        <article className="settings-license-card">
          <div>
            <h4>Electron & Chromium</h4>
            <p>
              Electron&apos;s license is in the package notices; Chromium notices remain intact.
            </p>
          </div>
          <PillButton
            size="compact"
            variant="secondary"
            disabled={!available?.chromium}
            loading={pendingKind === 'chromium'}
            onClick={() => void openNotice('chromium')}
          >
            Open Chromium notices
          </PillButton>
        </article>
      </div>
    </div>
  )
}
