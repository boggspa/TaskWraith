export type LicenseNoticeKind = 'taskwraith' | 'third-party' | 'chromium'

export interface LicenseNoticeSummary {
  packageIdentityCount: number
  packageInstanceCount: number
  reviewedOverrideCount: number
  upstreamLimitationCount: number
}

export interface LicenseNoticeStatus {
  exactPackagedTree: boolean
  appVersion: string | null
  appLicense: string | null
  summary: LicenseNoticeSummary | null
  available: Record<LicenseNoticeKind, boolean>
  message: string | null
}

export interface OpenLicenseNoticeResult {
  ok: boolean
  error?: string
}
